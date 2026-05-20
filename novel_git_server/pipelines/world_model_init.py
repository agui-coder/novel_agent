"""Schema-locked world_model.md/status_card.md initialization from summary.md.

The model returns structured world facts. The backend validates those facts,
then deterministically renders book-facing Markdown artifacts.
"""

from __future__ import annotations

import json
import os
import re
import logging
from dataclasses import dataclass
from queue import Queue
from typing import Any

import git as gitmod
from langchain_core.messages import HumanMessage
from utils.model_provider import create_chat_model

from .batch_parser import parse_summary_batches

log = logging.getLogger(__name__)

WORLD_MODEL_HEADING = "# 世界模型"
LEGACY_WORLD_MODEL_HEADING = "# World Model"
LIFECYCLE_LEDGER_HEADING = "### 约束生命周期台账"

LIFECYCLE_MARKER_TRANSLATIONS = {
    "disabled-in-current-scope": "当前范围禁用",
    "inherited-residue": "历史残留",
    "legacy-unclassified": "旧格式待归类",
    "source-evidence-window": "证据窗口",
    "character-POV": "角色视角",
    "current-active": "当前生效",
    "historical-only": "仅作历史",
    "rule-system": "规则系统",
    "overridden": "被覆盖",
    "conditional": "有条件生效",
    "unresolved": "待解决",
    "disabled": "已禁用",
    "retired": "已退场",
    "timeline": "时间线",
    "faction": "势力",
    "location": "地点",
    "global": "全局",
    "stage": "阶段",
    "loop": "轮回",
    "arc": "篇章",
    "CONSTRAINT_LIFECYCLE_PROTOCOL": "约束生命周期协议",
    "Constraint Lifecycle Ledger": "约束生命周期台账",
    "required_lifecycle_values": "可用生命周期状态",
    "required_scope_values": "可用适用范围",
    "downstream_rule": "下游消费规则",
}

CONSTRAINT_LIFECYCLE_PROTOCOL = """约束生命周期协议（最高优先级）：
- 创作约束不只分硬约束与软假设，必须保留生命周期与适用范围。
- 生命周期状态可用值：当前生效、仅作历史、已退场、被覆盖、已禁用、当前范围禁用、有条件生效、历史残留、待解决、旧格式待归类。
- 适用范围可用值：全局、时间线、篇章、阶段、轮回、势力、角色视角、地点、规则系统、证据窗口。
- 当原文出现状态、能力、身份、关系、时间线、轮回、规则系统变化时，必须在「硬约束」小节内加入或保留「### 约束生命周期台账」。
- 不要把有原文依据的历史事实压平成当前仍生效的现实。历史事实可以真实存在，但未必仍在当前阶段生效。
- 轮回、时间重置、回归、无限流、分支时间线小说是最强同类场景：某能力在第五轮获得但第六轮被锁定或不可用时，必须标为「仅作历史」与「当前范围禁用」，不能标为「当前生效」。
- 非轮回小说同样适用：被封印的能力、解散的联盟、暴露的身份、死亡的敌人、改变的阵营、已完成的承诺、升级后的境界，除非当前范围仍明确生效，否则不能继续当作当前硬约束。
- 下游规则：续写只能把「当前生效」或条件已满足的「有条件生效」约束写成当前剧情现实；「仅作历史」「已退场」「已禁用」「历史残留」「待解决」只能作为记忆、债务、创伤、伏笔、读者反讽或审查风险，除非世界模型或状态卡重新标记为当前生效。
"""

CONSTRAINT_LIFECYCLE_LEDGER_TEMPLATE = """### 约束生命周期台账

- 旧格式待归类：本文件已有约束在被下游当作当前现实前，必须先补充生命周期分类。
- 可用生命周期状态：当前生效；仅作历史；已退场；被覆盖；已禁用；当前范围禁用；有条件生效；历史残留；待解决。
- 可用适用范围：全局；时间线；篇章；阶段；轮回；势力；角色视角；地点；规则系统；证据窗口。
- 下游消费规则：只有「当前生效」或条件已满足的「有条件生效」约束，才能作为当前剧情现实使用。
"""

EXTRACTION_PROMPT = CONSTRAINT_LIFECYCLE_PROTOCOL + "\n\n" + """你是后端世界状态蒸馏管线。你的任务不是写 Markdown 文档，而是从阅读档案中提取可校验的结构化世界事实。

硬性规则：
- 只返回一个合法 JSON 对象，不要 Markdown，不要代码块，不要寒暄，不要解释你做了什么。
- 所有键名、说明和条目内容都必须使用简体中文。
- 人名、队名、技能名、赛事名、型号名等专有名词可以保留原文写法，但说明句必须是中文。
- 不要发明原文没有的事实，不要写未来剧情，不要写续写正文，不要写大纲卡。
- 每条事实必须有证据锚点，证据锚点必须来自阅读档案中的批次、章节范围、章节号或原文摘要句。
- 每条事实必须说明生命周期、适用范围、置信度和下游影响。
- 轮回、重置、回归、阶段切换、能力禁用、阵营变化、承诺兑现等变化必须显式标注生命周期，不能把历史事实压平成当前仍生效。
- 如果事实只是历史记忆、债务、伏笔、读者反讽或审查风险，生命周期不能写成「当前生效」。

可用分类：
- 读者承诺与主轴
- 冲突发动机
- 硬约束
- 软假设
- 未回收承诺
- 矛盾与风险
- 下游工作流接口

可用生命周期：
- 当前生效
- 仅作历史
- 已退场
- 被覆盖
- 已禁用
- 当前范围禁用
- 有条件生效
- 历史残留
- 待解决

可用适用范围类型：
- 全局
- 时间线
- 篇章
- 阶段
- 轮回
- 势力
- 角色视角
- 地点
- 规则系统
- 证据窗口

JSON 形状：
{
  "事实列表": [
    {
      "分类": "硬约束",
      "主体": "被约束的人物、势力、规则、承诺或剧情对象",
      "内容": "可约束后续创作的一句话事实，必须是中文",
      "生命周期": "当前生效",
      "适用范围": {"类型": "全局", "说明": "适用范围说明"},
      "证据": "批次或章节证据锚点",
      "置信度": "高",
      "下游影响": "续写、审核、大纲或文风模块需要如何使用这条事实"
    }
  ]
}

最低质量要求：
- 至少输出 8 条事实；如果阅读档案很短，也要覆盖能确定的主轴、冲突、硬约束、承诺、风险和下游接口。
- 「硬约束」「未回收承诺」「下游工作流接口」至少各 1 条。
- 对同一事实的矛盾或状态变化不要静默覆盖，要写入「矛盾与风险」分类。

完整阅读档案：
{summary_text}"""

VERIFY_PROMPT = CONSTRAINT_LIFECYCLE_PROTOCOL + "\n\n" + """你是结构化世界事实校验器。下面是已经抽取的 JSON 世界事实和阅读档案尾部证据。

任务：
- 只返回一个合法 JSON 对象，不要 Markdown，不要代码块，不要寒暄。
- 保留能被证据支持的事实。
- 修正生命周期、适用范围、证据和下游影响不合格的事实。
- 删除没有证据的事实，或把它改成「软假设」且生命周期写「待解决」。
- 如果尾部证据显示状态已改变，必须把旧状态标成「仅作历史」「被覆盖」「已禁用」或「当前范围禁用」，并新增当前状态事实。
- 输出形状仍然是 {"事实列表": [...]}。

当前结构化事实：
{facts_json}

阅读档案尾部证据：
{summary_tail}"""


REQUIRED_SECTIONS = [
    "读者承诺与主轴",
    "冲突发动机",
    "硬约束",
    "软假设",
    "未回收承诺",
    "矛盾与风险",
    "下游工作流接口",
]

STATUS_CARD_REQUIRED_FIELDS = [
    "当前节奏阶段",
    "张力等级",
    "上次满足点位置及类型",
    "建议下个满足点距离",
    "当前驱动焦点",
    "读者预期方向",
    "未兑现承诺 Top3",
    "主角状态",
    "伏笔压力",
]

UNKNOWN_VALUE = "待确认"
STATUS_CARD_REPAIR_COMMIT_MESSAGE = "batch init: initialize status card"

WORLD_FACT_CATEGORIES = set(REQUIRED_SECTIONS)
WORLD_FACT_LIFECYCLES = {
    "当前生效",
    "仅作历史",
    "已退场",
    "被覆盖",
    "已禁用",
    "当前范围禁用",
    "有条件生效",
    "历史残留",
    "待解决",
}
WORLD_FACT_SCOPE_TYPES = {
    "全局",
    "时间线",
    "篇章",
    "阶段",
    "轮回",
    "势力",
    "角色视角",
    "地点",
    "规则系统",
    "证据窗口",
}
WORLD_FACT_CONFIDENCE_VALUES = {"高", "中", "低", "待确认"}
MIN_WORLD_FACTS = 6


class MalformedJsonError(ValueError):
    """Raised when model output cannot be parsed as JSON."""


@dataclass(frozen=True)
class WorldFact:
    category: str
    subject: str
    content: str
    lifecycle: str
    scope_type: str
    scope: str
    evidence: str
    confidence: str
    downstream_impact: str


def _build_llm(max_tokens: int = 32768):
    return create_chat_model(max_tokens=max_tokens, purpose="world_model_init")


def _invoke_llm_text(llm, prompt: str) -> str:
    response = llm.invoke([HumanMessage(content=prompt)])
    content = getattr(response, "content", "")
    if isinstance(content, list):
        return "\n".join(str(item) for item in content)
    return str(content)


def _strip_code_fence(text: str) -> str:
    match = re.search(r"```(?:json|markdown|md)?\s*\n(.*?)```", text, flags=re.DOTALL)
    if match:
        return match.group(1).strip()
    return text.strip()


def _extract_json_payload(text: str) -> dict[str, Any]:
    raw = _strip_code_fence(text)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as first_error:
        start = raw.find("{")
        end = raw.rfind("}")
        if start < 0 or end < start:
            raise MalformedJsonError("模型未返回 JSON 对象") from first_error
        try:
            data = json.loads(raw[start : end + 1])
        except json.JSONDecodeError as second_error:
            raise MalformedJsonError(f"模型返回的 JSON 语法无效：{second_error}") from second_error
    if not isinstance(data, dict):
        raise ValueError("模型返回的 JSON 根节点不是对象")
    return data


def _build_world_json_repair_prompt(
    *,
    malformed_answer: str,
    parse_error: Exception,
) -> str:
    return f"""你是后端 JSON 语法修复器。
任务：
- 下面是一段世界事实 JSON，但语法无效。
- 只修复语法，让它变成合法 JSON 对象。
- 不要新增事实，不要扩写内容，不要改写成 Markdown，不要输出代码块，不要寒暄。
- 所有键名必须继续使用中文。

必须保留的 JSON 形状：
{{
  "事实列表": [
    {{
      "分类": "硬约束",
      "主体": "主体",
      "内容": "事实内容",
      "生命周期": "当前生效",
      "适用范围": {{"类型": "全局", "说明": "范围说明"}},
      "证据": "证据锚点",
      "置信度": "高",
      "下游影响": "影响说明"
    }}
  ]
}}

解析错误：{parse_error}

待修复内容：
{malformed_answer}
"""


def _build_world_validation_repair_prompt(
    *,
    original_prompt: str,
    validation_error: Exception,
) -> str:
    return f"""{original_prompt}

---

上一轮输出没有通过后端结构化校验。
校验错误：{validation_error}

请重新输出完整、合法、可校验的 JSON 对象。
硬性要求：
- 只返回 JSON 对象，不要 Markdown，不要代码块，不要寒暄。
- 每条事实必须包含：分类、主体、内容、生命周期、适用范围、证据、置信度、下游影响。
- 生命周期和适用范围必须使用允许值。
- 证据和下游影响不能为空。
- 输出必须使用简体中文。
"""


def _clean_fact_text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).replace("\x00", " ")
    text = re.sub(r"^\s*(?:[-+]\s+|\*\s+|[0-9]+[.)]\s*)", "", text.strip())
    text = re.sub(r"(\*\*|__)(.*?)\1", r"\2", text)
    text = re.sub(r"\s+", " ", text).strip()
    if re.match(r"^(好的|以下是|下面是|我将|我会|已根据|作为.*?助手)", text):
        return ""
    return text


def _coerce_scope(value: Any) -> tuple[str, str]:
    if isinstance(value, dict):
        scope_type = _clean_fact_text(value.get("类型") or value.get("type") or value.get("scope_type"))
        scope = _clean_fact_text(value.get("说明") or value.get("范围") or value.get("scope") or value.get("description"))
    else:
        text = _clean_fact_text(value)
        if "：" in text:
            scope_type, scope = text.split("：", 1)
        elif ":" in text:
            scope_type, scope = text.split(":", 1)
        else:
            scope_type, scope = text, text
        scope_type = _clean_fact_text(scope_type)
        scope = _clean_fact_text(scope)
    if scope_type not in WORLD_FACT_SCOPE_TYPES:
        scope_type = "全局" if not scope_type else "证据窗口"
    return scope_type, scope or scope_type


def _parse_world_facts_answer(answer: str) -> list[WorldFact]:
    data = _extract_json_payload(answer)
    raw_facts = data.get("事实列表") or data.get("world_facts") or data.get("facts")
    if isinstance(raw_facts, dict):
        raw_facts = [raw_facts]
    if not isinstance(raw_facts, list):
        raise ValueError("世界事实 JSON 缺少「事实列表」数组")

    facts: list[WorldFact] = []
    for index, raw_fact in enumerate(raw_facts, start=1):
        if not isinstance(raw_fact, dict):
            raise ValueError(f"第 {index} 条世界事实不是对象")
        category = _clean_fact_text(raw_fact.get("分类") or raw_fact.get("category"))
        subject = _clean_fact_text(raw_fact.get("主体") or raw_fact.get("subject"))
        content = _clean_fact_text(raw_fact.get("内容") or raw_fact.get("content") or raw_fact.get("事实"))
        lifecycle = _clean_fact_text(raw_fact.get("生命周期") or raw_fact.get("lifecycle"))
        scope_type, scope = _coerce_scope(raw_fact.get("适用范围") or raw_fact.get("scope"))
        evidence = _clean_fact_text(raw_fact.get("证据") or raw_fact.get("evidence"))
        confidence = _clean_fact_text(raw_fact.get("置信度") or raw_fact.get("confidence"))
        downstream_impact = _clean_fact_text(raw_fact.get("下游影响") or raw_fact.get("downstream_impact") or raw_fact.get("影响"))

        if category not in WORLD_FACT_CATEGORIES:
            raise ValueError(f"第 {index} 条世界事实分类无效：{category or '空'}")
        if lifecycle not in WORLD_FACT_LIFECYCLES:
            raise ValueError(f"第 {index} 条世界事实生命周期无效：{lifecycle or '空'}")
        if confidence not in WORLD_FACT_CONFIDENCE_VALUES:
            raise ValueError(f"第 {index} 条世界事实置信度无效：{confidence or '空'}")
        for field_name, field_value in {
            "主体": subject,
            "内容": content,
            "适用范围说明": scope,
            "证据": evidence,
            "下游影响": downstream_impact,
        }.items():
            if not field_value:
                raise ValueError(f"第 {index} 条世界事实缺少{field_name}")
        if content in {UNKNOWN_VALUE, "无", "暂无"}:
            raise ValueError(f"第 {index} 条世界事实内容过空")
        if evidence in {UNKNOWN_VALUE, "无", "暂无"}:
            raise ValueError(f"第 {index} 条世界事实缺少有效证据")

        facts.append(
            WorldFact(
                category=category,
                subject=subject,
                content=content,
                lifecycle=lifecycle,
                scope_type=scope_type,
                scope=scope,
                evidence=evidence,
                confidence=confidence,
                downstream_impact=downstream_impact,
            )
        )

    if len(facts) < MIN_WORLD_FACTS:
        raise ValueError(f"世界事实数量不足：{len(facts)}")
    required_categories = {"硬约束", "未回收承诺", "下游工作流接口"}
    present = {fact.category for fact in facts}
    missing = sorted(required_categories - present)
    if missing:
        raise ValueError("世界事实缺少必要分类：" + "、".join(missing))
    return facts


def _extract_world_facts_with_repair(llm, prompt: str, *, max_retries: int = 1) -> list[WorldFact]:
    last_error: Exception | None = None
    for attempt in range(max(0, max_retries) + 1):
        try:
            answer = _invoke_llm_text(llm, prompt)
            if not answer.strip():
                raise RuntimeError("世界事实抽取返回为空")
            try:
                return _parse_world_facts_answer(answer)
            except MalformedJsonError as parse_error:
                repaired_answer = _invoke_llm_text(
                    llm,
                    _build_world_json_repair_prompt(
                        malformed_answer=answer,
                        parse_error=parse_error,
                    ),
                )
                return _parse_world_facts_answer(repaired_answer)
            except ValueError as validation_error:
                repaired_answer = _invoke_llm_text(
                    llm,
                    _build_world_validation_repair_prompt(
                        original_prompt=prompt,
                        validation_error=validation_error,
                    ),
                )
                return _parse_world_facts_answer(repaired_answer)
        except Exception as exc:
            last_error = exc
            if attempt >= max(0, max_retries):
                break
    raise RuntimeError(f"世界事实结构化抽取失败：{last_error}") from last_error


def _facts_to_json_for_prompt(facts: list[WorldFact]) -> str:
    payload = {
        "事实列表": [
            {
                "分类": fact.category,
                "主体": fact.subject,
                "内容": fact.content,
                "生命周期": fact.lifecycle,
                "适用范围": {"类型": fact.scope_type, "说明": fact.scope},
                "证据": fact.evidence,
                "置信度": fact.confidence,
                "下游影响": fact.downstream_impact,
            }
            for fact in facts
        ]
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)


def _merge_world_facts(primary: list[WorldFact], verified: list[WorldFact]) -> list[WorldFact]:
    merged: dict[tuple[str, str, str], WorldFact] = {}
    for fact in primary + verified:
        key = (fact.category, fact.subject, fact.content)
        merged[key] = fact
    return list(merged.values())


def _render_world_fact(fact: WorldFact) -> str:
    return (
        f"- **{fact.subject}**：{fact.content}"
        f"（生命周期：{fact.lifecycle}；适用范围：{fact.scope_type}/{fact.scope}；"
        f"证据：{fact.evidence}；置信度：{fact.confidence}；下游影响：{fact.downstream_impact}）"
    )


def _render_world_model_from_facts(facts: list[WorldFact], batches: list[dict]) -> str:
    lines: list[str] = [
        WORLD_MODEL_HEADING,
        "",
        "> 本文件由后端世界状态蒸馏管线根据结构化世界事实确定性渲染。模型只提供事实对象，最终章节、生命周期、证据和覆盖表由后端校验后写入。",
        "",
    ]
    for section in REQUIRED_SECTIONS:
        lines.extend([f"## {section}", ""])
        section_facts = [fact for fact in facts if fact.category == section]
        if section == "硬约束":
            lines.extend(CONSTRAINT_LIFECYCLE_LEDGER_TEMPLATE.strip().splitlines())
            lines.append("")
        if section_facts:
            lines.extend(_render_world_fact(fact) for fact in section_facts)
        else:
            lines.append(f"- **{section}待补充**：当前阅读档案中没有提取到可校验条目，后续重建或人工讨论时补充。（生命周期：待解决；适用范围：证据窗口/当前阅读档案；证据：后端校验未发现足够证据；置信度：待确认；下游影响：不得当作当前硬约束使用）")
        lines.append("")
    lines.extend(["---", "", _build_coverage_table(batches)])
    return "\n".join(lines).strip() + "\n"


def _extract_world_model_from_response(text: str) -> str:
    code_block_re = re.compile(r"```(?:markdown|md)?\s*\n(.*?)```", re.DOTALL)
    m = code_block_re.search(text)
    if m:
        candidate = m.group(1).strip()
        if candidate.startswith(WORLD_MODEL_HEADING):
            return _localize_world_model_markers(candidate)
        if candidate.startswith(LEGACY_WORLD_MODEL_HEADING):
            return _localize_world_model_markers(candidate)

    idx = text.find(WORLD_MODEL_HEADING)
    if idx >= 0:
        return _localize_world_model_markers(text[idx:].strip())

    legacy_idx = text.find(LEGACY_WORLD_MODEL_HEADING)
    if legacy_idx >= 0:
        return _localize_world_model_markers(text[legacy_idx:].strip())

    return _localize_world_model_markers(text.strip())


def _localize_world_model_markers(content: str) -> str:
    """Localize legacy world-model markers before writing book-facing markdown."""
    if not content:
        return content

    content = re.sub(r"^#\s+World Model\s*$", WORLD_MODEL_HEADING, content, flags=re.MULTILINE)
    for source, target in LIFECYCLE_MARKER_TRANSLATIONS.items():
        content = re.sub(
            rf"(?<![A-Za-z0-9_-]){re.escape(source)}(?![A-Za-z0-9_-])",
            target,
            content,
        )
    content = content.replace("Batch Archive", "批次归档")
    content = content.replace("backend world_model pipeline", "后端世界模型管线")
    return content


def _validate_sections(content: str) -> tuple[bool, list[str]]:
    missing = [s for s in REQUIRED_SECTIONS if f"## {s}" not in content]
    return len(missing) == 0, missing


def _repair_sections(content: str) -> str:
    existing = {l.strip()[3:] for l in content.split("\n") if l.strip().startswith("## ")}
    missing = [s for s in REQUIRED_SECTIONS if s not in existing]
    if not missing:
        return content
    result = content.rstrip() + "\n\n"
    for section in missing:
        result += f"## {section}\n\n（待补充）\n\n"
    return result


def _has_constraint_lifecycle_ledger(content: str) -> bool:
    return (
        ("约束生命周期台账" in content or "Constraint Lifecycle Ledger" in content)
        and ("当前生效" in content or "current-active" in content)
        and ("仅作历史" in content or "historical-only" in content)
        and ("已禁用" in content or "disabled" in content)
    )


def _insert_constraint_lifecycle_ledger(content: str) -> str:
    if _has_constraint_lifecycle_ledger(content):
        return content

    hard_heading = f"## {REQUIRED_SECTIONS[2]}"
    hard_idx = content.find(hard_heading)
    if hard_idx < 0:
        return content.rstrip() + "\n\n" + CONSTRAINT_LIFECYCLE_LEDGER_TEMPLATE

    line_end = content.find("\n", hard_idx)
    if line_end < 0:
        line_end = len(content)

    return (
        content[:line_end]
        + "\n\n"
        + CONSTRAINT_LIFECYCLE_LEDGER_TEMPLATE.rstrip()
        + "\n"
        + content[line_end:]
    )


def _replace_coverage_table(content: str, batches: list[dict]) -> str:
    """Replace LLM-generated coverage table with ground truth from summary batches."""
    table_header = "### 覆盖表格"
    table_idx = content.find(table_header)
    if table_idx < 0:
        # No existing table — append
        return content.rstrip() + "\n\n---\n\n" + _build_coverage_table(batches)

    # Find where the table ends (next ## heading or end of content)
    after_header = content[table_idx + len(table_header):]
    # Skip the header line and table separator lines
    next_section = re.search(r"\n## ", after_header)
    if next_section:
        end_idx = table_idx + len(table_header) + next_section.start()
    else:
        end_idx = len(content)

    return content[:table_idx] + _build_coverage_table(batches) + content[end_idx:]


def _build_coverage_table(batches: list[dict]) -> str:
    lines = [
        "### 覆盖表格",
        "",
        "| 批次归档 | 章节范围 | 已处理 |",
        "| --- | --- | --- |",
    ]
    for b in batches:
        cs, ce = b["chapter_start"], b["chapter_end"]
        if cs and ce:
            range_str = f"第{cs}-{ce}章"
        else:
            range_str = str(b["title"]).replace("Batch Archive: ", "").replace("批次归档：", "")
        lines.append(f"| {b['title']} | {range_str} | ✅ |")
    lines.append(f"\n**总数：{len(batches)}批次**")
    return "\n".join(lines)


def _commit_files(book_dir: str, filepaths: list[str], message: str) -> str | None:
    repo = gitmod.Repo(book_dir)
    paths = [p.replace("\\", "/") for p in filepaths]
    if not paths:
        return None

    status = repo.git.status("--short", "--", *paths)
    if not status.strip():
        return None

    repo.index.add(paths)
    commit = repo.index.commit(message)
    return commit.hexsha


def _commit_file(book_dir: str, filepath: str, message: str) -> None:
    _commit_files(book_dir, [filepath], message)


def _status_card_has_required_field_lines(content: str) -> bool:
    for field in STATUS_CARD_REQUIRED_FIELDS:
        pattern = rf"{re.escape(field)}\s*[：:]\s*(.+)"
        match = re.search(pattern, content)
        if not match:
            return False
        value = _normalize_status_value(match.group(1).strip())
        if not value or _is_status_category_label(value):
            return False
    return True


def _count_status_unknown_values(content: str) -> int:
    count = 0
    for field in STATUS_CARD_REQUIRED_FIELDS:
        pattern = rf"{re.escape(field)}\s*[：:]\s*(.+)"
        match = re.search(pattern, content)
        if match and _normalize_status_value(match.group(1).strip()) == UNKNOWN_VALUE:
            count += 1
    return count


def _count_status_required_field_values(content: str) -> int:
    count = 0
    for field in STATUS_CARD_REQUIRED_FIELDS:
        pattern = rf"{re.escape(field)}\s*[：:]\s*(.+)"
        match = re.search(pattern, content)
        if match and _normalize_status_value(match.group(1).strip()):
            count += 1
    return count


def _status_card_evidence_anchor_count(content: str) -> int:
    evidence_section = _extract_summary_section(content, "证据锚点")
    if not evidence_section:
        return 0
    count = 0
    for line in evidence_section.splitlines():
        value = _clean_status_value(line)
        if value == UNKNOWN_VALUE:
            continue
        if any(marker in value for marker in ("CH", "第", "批次", "证据", "依据")):
            count += 1
    return count


def _assert_status_card_quality(content: str, *, latest_batch_label: str | None = None) -> None:
    if not _status_card_has_required_field_lines(content):
        raise ValueError("status_card.md 缺少必要字段或字段值无效")
    unknown_count = _count_status_unknown_values(content)
    if unknown_count > 2:
        raise ValueError(f"status_card.md 待确认字段过多：{unknown_count}")
    if _count_status_required_field_values(content) < len(STATUS_CARD_REQUIRED_FIELDS):
        raise ValueError("status_card.md 必要字段覆盖不足")
    evidence_count = _status_card_evidence_anchor_count(content)
    if evidence_count < 3:
        raise ValueError(f"status_card.md 证据锚点不足：{evidence_count}")
    if latest_batch_label and latest_batch_label not in content:
        raise ValueError(f"status_card.md 缺少最新批次证据锚点：{latest_batch_label}")
    generic_markers = ("本批没有明确新增", "暂无", "无明确", "没有足够证据")
    generic_count = sum(content.count(marker) for marker in generic_markers)
    if generic_count >= 4:
        raise ValueError("status_card.md 内容过于空泛")


def _status_card_has_required_fields(content: str) -> bool:
    if not _status_card_has_required_field_lines(content):
        return False
    # A mostly placeholder card should not block rebuilding from a richer summary.
    return _count_status_unknown_values(content) < max(4, len(STATUS_CARD_REQUIRED_FIELDS) // 2)


def _is_extraction_done(book_dir: str) -> bool:
    """Check if a verified extraction commit already exists."""
    repo = gitmod.Repo(book_dir)
    for commit in repo.iter_commits(max_count=50):
        if "verified full extraction" in commit.message:
            return True
    return False


def _get_summary_tail(summary_path: str, batches: list[dict], n: int = 3) -> str:
    """Extract text from the last n batches of summary."""
    if not batches:
        return ""
    tail_batches = batches[-n:]
    parts = []
    with open(summary_path, "r", encoding="utf-8") as f:
        all_lines = f.readlines()
    for b in tail_batches:
        start = b["start_line"] - 1  # 0-based
        end = b["end_line"]  # exclusive
        parts.append("".join(all_lines[start:end]).strip())
    return "\n\n---\n\n".join(parts)


def _extract_summary_section(text: str, heading: str) -> str:
    return _extract_summary_section_any(text, (heading,))


def _extract_summary_section_any(text: str, headings: tuple[str, ...]) -> str:
    heading_set = {item.strip() for item in headings if item.strip()}
    if not heading_set:
        return ""

    lines = text.splitlines()
    collected: list[str] = []
    capturing = False
    capture_level = 0

    for line in lines:
        match = re.match(r"^(#{1,6})\s+(.+?)\s*$", line.strip())
        if match:
            level = len(match.group(1))
            title = match.group(2).strip()
            if capturing and level <= capture_level:
                break
            if title in heading_set:
                capturing = True
                capture_level = level
                continue
        if capturing:
            collected.append(line)

    return "\n".join(collected).strip()


def _extract_legacy_summary_section(text: str, heading: str) -> str:
    pattern = rf"^###\s+{re.escape(heading)}\s*\n(.*?)(?=^###\s+|^##\s+|\Z)"
    match = re.search(pattern, text, re.DOTALL | re.MULTILINE)
    return match.group(1).strip() if match else ""


def _clean_status_value(line: str) -> str:
    line = _normalize_status_value(line)
    if _is_status_category_label(line):
        return UNKNOWN_VALUE
    return line or UNKNOWN_VALUE


def _normalize_status_value(line: str) -> str:
    line = re.sub(r"^\s*(?:[-+]\s+|\*\s+|[0-9]+[.)]\s*|[一二三四五六七八九十]+[、.]\s*)", "", line)
    line = re.sub(r"(\*\*|__)(.*?)\1", r"\2", line)
    line = re.sub(r"(\*|_)(.*?)\1", r"\2", line)
    line = re.sub(r"^[*_]+|[*_]+$", "", line)
    return re.sub(r"\s+", " ", line).strip()


def _is_status_category_label(line: str) -> bool:
    return bool(re.fullmatch(r"[^：:\n]{1,24}[：:]", line.strip()))


def _collect_status_lines(section_text: str, limit: int = 3) -> list[str]:
    lines: list[str] = []
    for raw_line in section_text.splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("|") or set(stripped) <= {"-", " ", "|"}:
            continue
        value = _clean_status_value(stripped)
        if value != UNKNOWN_VALUE:
            lines.append(value)
        if len(lines) >= limit:
            break
    return lines


def _shorten_status_value(value: str, limit: int = 160) -> str:
    value = _normalize_status_value(value)
    if len(value) <= limit:
        return value
    cut = value[:limit].rstrip()
    best = max(cut.rfind(mark) for mark in ("。", "；", "，", "、"))
    if best >= 60:
        cut = cut[: best + 1]
    return cut.rstrip("，、；。") + "..."


def _first_status_line(*section_texts: str, predicate: str | None = None) -> str:
    for section_text in section_texts:
        for line in _collect_status_lines(section_text, limit=20):
            if predicate and predicate not in line:
                continue
            return line
    return UNKNOWN_VALUE


def _first_status_line_short(*section_texts: str, predicate: str | None = None) -> str:
    value = _first_status_line(*section_texts, predicate=predicate)
    if value == UNKNOWN_VALUE:
        return UNKNOWN_VALUE
    return _shorten_status_value(value)


def _last_status_line(*section_texts: str, predicate: str | None = None) -> str:
    for section_text in section_texts:
        candidates: list[str] = []
        for line in _collect_status_lines(section_text, limit=200):
            if predicate and predicate not in line:
                continue
            candidates.append(line)
        if candidates:
            return candidates[-1]
    return UNKNOWN_VALUE


def _last_status_line_short(*section_texts: str, predicate: str | None = None) -> str:
    value = _last_status_line(*section_texts, predicate=predicate)
    if value == UNKNOWN_VALUE:
        return UNKNOWN_VALUE
    return _shorten_status_value(value)


def _latest_chapter_index_line(section_text: str) -> str:
    latest_chapter = -1
    latest_line = UNKNOWN_VALUE
    for raw_line in section_text.splitlines():
        line = _clean_status_value(raw_line.strip())
        if line == UNKNOWN_VALUE:
            continue
        match = re.match(r"CH(\d+)(?:\s*-\s*(\d+))?", line, flags=re.IGNORECASE)
        if not match:
            continue
        chapter_no = int(match.group(2) or match.group(1))
        if chapter_no >= latest_chapter:
            latest_chapter = chapter_no
            latest_line = line
    return latest_line


def _latest_chapter_index_line_short(section_text: str) -> str:
    value = _latest_chapter_index_line(section_text)
    if value == UNKNOWN_VALUE:
        return UNKNOWN_VALUE
    return _shorten_status_value(value)


def _fallback_status(value: str, *fallback_sections: str) -> str:
    if value != UNKNOWN_VALUE:
        return _shorten_status_value(value)
    for section_text in fallback_sections:
        candidate = _first_status_line_short(section_text)
        if candidate != UNKNOWN_VALUE:
            return candidate
    return UNKNOWN_VALUE


def _batch_range_label(batch: dict) -> str:
    chapter_start = batch.get("chapter_start")
    chapter_end = batch.get("chapter_end")
    if chapter_start and chapter_end:
        return f"第{chapter_start}-{chapter_end}章"
    return str(batch.get("title", UNKNOWN_VALUE)).replace("Batch Archive: ", "").replace("批次归档：", "") or UNKNOWN_VALUE


def _infer_tension_level(text: str) -> str:
    if not text.strip():
        return UNKNOWN_VALUE

    high_keywords = [
        "决战",
        "危机",
        "追杀",
        "死亡",
        "大战",
        "倒计时",
        "终局",
        "高压",
        "灾难",
        "失控",
        "决裂",
        "反噬",
    ]
    competition_keywords = ["淘汰", "败者组", "焦灼", "失利", "正赛", "八强", "预选赛", "赛事", "比赛"]
    medium_keywords = ["推进", "揭示", "冲突", "压力", "目标", "伏笔", "承诺", "阻力"]

    for keyword in high_keywords:
        if keyword in text:
            return f"高（最新批次出现「{keyword}」压力信号）"
    for keyword in competition_keywords:
        if keyword in text:
            return f"高（最新批次出现「{keyword}」竞争压力）"
    for keyword in medium_keywords:
        if keyword in text:
            return f"中（最新批次出现「{keyword}」推进信号）"
    return "中（最新批次仍有剧情推进记录）"


def _infer_satisfaction_point(batch: dict, text: str) -> str:
    range_label = _batch_range_label(batch)
    signal_groups = [
        ("真相揭示", ["真相", "揭示", "身份", "答案"]),
        ("承诺回收", ["回收", "兑现", "解决"]),
        ("战斗/能力满足", ["击败", "胜利", "突破", "晋升", "升级"]),
        ("赛事/目标满足", ["出线", "晋级", "夺冠", "冠军", "获胜", "打入", "进入", "签下"]),
        ("情绪满足", ["团聚", "告白", "释然", "和解"]),
        ("反转满足", ["反转", "逆转", "翻盘"]),
    ]
    for label, keywords in signal_groups:
        if any(keyword in text for keyword in keywords):
            return f"{range_label}：{label}"
    return UNKNOWN_VALUE


def _suggest_next_satisfaction_distance(tension_level: str, pressure: str) -> str:
    if tension_level == UNKNOWN_VALUE and pressure == UNKNOWN_VALUE:
        return UNKNOWN_VALUE
    if tension_level.startswith("高") or pressure.startswith("高"):
        return "1-2章内"
    return "2-4章内"


def _format_top3(values: list[str]) -> str:
    filled = (values + [UNKNOWN_VALUE, UNKNOWN_VALUE, UNKNOWN_VALUE])[:3]
    return "；".join(f"{idx}. {value}" for idx, value in enumerate(filled, start=1))


def _current_active_world_fact_lines(facts: list[WorldFact] | None, *, limit: int = 4) -> list[str]:
    if not facts:
        return []
    selected: list[str] = []
    for fact in facts:
        if fact.lifecycle not in {"当前生效", "有条件生效", "待解决"}:
            continue
        selected.append(f"{fact.subject}：{fact.content}（证据：{fact.evidence}）")
        if len(selected) >= limit:
            break
    return selected


def _build_status_card(book_dir: str, summary_path: str, world_facts: list[WorldFact] | None = None) -> str:
    """Build a short, complete status_card.md from the latest summary batch."""
    import json

    batches = parse_summary_batches(summary_path)
    if not batches:
        raise ValueError("No summary batches available for status_card.md")

    last_batch = batches[-1]
    with open(summary_path, "r", encoding="utf-8") as f:
        all_lines = f.readlines()
    last_text = "".join(all_lines[last_batch["start_line"] - 1:last_batch["end_line"]])

    # Read metadata for book name
    meta_path = os.path.join(book_dir, "metadata.json")
    book_name = UNKNOWN_VALUE
    if os.path.exists(meta_path):
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
        book_name = meta.get("book_name") or UNKNOWN_VALUE

    story_stage = _extract_summary_section(last_text, "故事阶段")
    core_driver = _extract_summary_section(last_text, "核心驱动进度")
    clues = _extract_summary_section(last_text, "线索状态")
    foreshadow = _extract_summary_section(last_text, "伏笔台账")
    promises_section = _extract_summary_section(last_text, "未兑现承诺")
    relationships = _extract_summary_section(last_text, "关系变化")
    constraints = _extract_summary_section(last_text, "本段约束增量")
    batch_overview = _extract_summary_section_any(last_text, ("Batch Overview", "批次概览", "本批总览"))
    batch_index = _extract_summary_section_any(last_text, ("Batch Index", "章节索引", "本批索引"))
    irreversible_facts = _extract_summary_section_any(last_text, ("Irreversible Facts", "不可逆事实", "不可撤销事实"))
    open_loops = _extract_summary_section_any(last_text, ("Open Loops And Promises", "未闭合线索与承诺", "开放循环与承诺"))
    relationship_changes = _extract_summary_section_any(
        last_text,
        ("Relationship And State Changes", "关系与状态变化"),
    )
    downstream_constraints = _extract_summary_section_any(last_text, ("Downstream Constraints", "下游创作约束", "下游约束"))

    combined_latest = "\n".join(
        [
            story_stage,
            core_driver,
            clues,
            foreshadow,
            promises_section,
            relationships,
            constraints,
            batch_overview,
            batch_index,
            irreversible_facts,
            open_loops,
            relationship_changes,
            downstream_constraints,
        ]
    )
    promise_lines = _collect_status_lines(promises_section or open_loops, limit=3)
    if len(promise_lines) < 3:
        for candidate in (
            _collect_status_lines(foreshadow, limit=3)
            + _collect_status_lines(clues, limit=3)
            + _collect_status_lines(downstream_constraints, limit=3)
        ):
            if candidate not in promise_lines:
                promise_lines.append(candidate)
            if len(promise_lines) >= 3:
                break

    current_stage = _fallback_status(
        _first_status_line_short(story_stage),
        _latest_chapter_index_line_short(batch_index),
        batch_overview,
    )
    tension_level = _infer_tension_level(combined_latest)
    satisfaction_point = _infer_satisfaction_point(last_batch, combined_latest)
    driver_focus = _fallback_status(
        _first_status_line_short(core_driver),
        downstream_constraints,
        batch_index,
        batch_overview,
        story_stage,
    )
    reader_expectation = _fallback_status(
        _first_status_line_short(promises_section),
        open_loops,
        constraints,
        downstream_constraints,
        core_driver,
    )
    protagonist_state = _fallback_status(
        _first_status_line_short(relationships, predicate="主角"),
        relationship_changes,
        irreversible_facts,
        batch_overview,
    )
    foreshadow_count = (
        len(_collect_status_lines(foreshadow, limit=20))
        + len(_collect_status_lines(clues, limit=20))
        + len(_collect_status_lines(open_loops, limit=20))
    )
    if foreshadow_count >= 3:
        foreshadow_pressure = f"高（最新批次保留{foreshadow_count}条线索/伏笔）"
    elif foreshadow_count > 0:
        foreshadow_pressure = f"中（最新批次保留{foreshadow_count}条线索/伏笔）"
    else:
        foreshadow_pressure = UNKNOWN_VALUE
    next_distance = _suggest_next_satisfaction_distance(tension_level, foreshadow_pressure)

    content_parts = ["# 状态卡片", ""]
    content_parts.append(
        f"> 本书「{book_name}」初始化运行态，由后端世界模型管线依据最新批次归档和已校验世界事实自动生成；证据不足写作「待确认」。"
    )
    content_parts.append("")
    content_parts.extend(
        [
            "## 核心运行态",
            "",
            f"- 当前节奏阶段：{current_stage}",
            f"- 张力等级：{tension_level}",
            f"- 上次满足点位置及类型：{satisfaction_point}",
            f"- 建议下个满足点距离：{next_distance}",
            f"- 当前驱动焦点：{driver_focus}",
            f"- 读者预期方向：{reader_expectation}",
            "",
            "## 角色与承诺",
            "",
            f"- 主角状态：{protagonist_state}",
            f"- 未兑现承诺 Top3：{_format_top3(promise_lines)}",
            f"- 伏笔压力：{foreshadow_pressure}",
            "",
            "## 证据锚点",
            "",
            f"- 最新批次：{_batch_range_label(last_batch)}",
            f"- 批次概览：{_first_status_line_short(batch_overview)}",
            f"- 阶段依据：{current_stage}",
            f"- 驱动依据：{driver_focus}",
            f"- 承诺/伏笔依据：{foreshadow_pressure}",
        ]
    )
    active_world_lines = _current_active_world_fact_lines(world_facts)
    if active_world_lines:
        content_parts.extend(["", "## 当前生效世界事实", ""])
        content_parts.extend(f"- {line}" for line in active_world_lines)

    content = "\n".join(content_parts).strip() + "\n"
    if not _status_card_has_required_field_lines(content):
        raise ValueError("Generated status_card.md is missing required initialized fields")
    _assert_status_card_quality(content, latest_batch_label=_batch_range_label(last_batch))
    return content


def _populate_status_card(
    book_dir: str,
    summary_path: str,
    *,
    force: bool = False,
    world_facts: list[WorldFact] | None = None,
) -> str | None:
    """Auto-fill status_card.md from latest summary batch data."""
    status_card_path = os.path.join(book_dir, "status_card.md")
    existing = ""
    if os.path.exists(status_card_path):
        with open(status_card_path, "r", encoding="utf-8") as f:
            existing = f.read()

    if existing and not force and _status_card_has_required_fields(existing):
        return None

    content = _build_status_card(book_dir, summary_path, world_facts=world_facts)
    if existing == content:
        return None

    with open(status_card_path, "w", encoding="utf-8") as f:
        f.write(content)
    return "status_card.md"


def run_pipeline(
    book_id: str,
    book_dir: str,
    summary_path: str,
    sse_queue: Queue | None = None,
    *,
    force_rebuild: bool = False,
) -> dict:
    """Run two-phase world_model extraction from summary.md.

    Phase 1: Extract world model from full summary.
    Phase 2: Verify extracted facts against summary tail batches.

    Returns dict with completed_batches, failed_batches.
    """
    # Read summary
    with open(summary_path, "r", encoding="utf-8") as f:
        summary_text = f.read()

    batches = parse_summary_batches(summary_path)
    batch_titles = [b["title"] for b in batches]

    if _is_extraction_done(book_dir) and not force_rebuild:
        log.info("Verified extraction already done.")
        try:
            _populate_status_card(book_dir, summary_path, force=False)
            status_commit = _commit_files(
                book_dir,
                ["status_card.md"],
                STATUS_CARD_REPAIR_COMMIT_MESSAGE,
            )
        except Exception as e:
            log.error("Status card repair failed after verified extraction skip: %s", e, exc_info=True)
            if sse_queue:
                sse_queue.put(
                    {
                        "event": "batch_error",
                        "data": {"batch_index": 0, "title": "status_card", "error": str(e)},
                    }
                )
                sse_queue.put({"event": "done", "data": {"completed": 0, "failed": 1, "skipped": True, "force_rebuild": force_rebuild}})
            return {
                "completed_batches": [],
                "failed_batches": [{"error": str(e), "target": "status_card.md"}],
                "skipped": True,
            }

        if sse_queue:
            sse_queue.put(
                {
                    "event": "done",
                    "data": {
                        "completed": 0,
                        "failed": 0,
                        "skipped": True,
                        "status_card_committed": bool(status_commit),
                        "force_rebuild": force_rebuild,
                    },
                }
            )
        return {
            "completed_batches": [],
            "failed_batches": [],
            "skipped": True,
            "status_card_commit": status_commit,
            "force_rebuild": force_rebuild,
        }

    if sse_queue:
        sse_queue.put({"event": "ack", "data": {"total_batches": len(batches), "book_id": book_id}})

    llm = _build_llm(max_tokens=32768)

    # ── Phase 1: Extract ──
    if sse_queue:
        sse_queue.put({"event": "progress", "data": {"batch_index": 0, "total": 2, "title": "extract", "status": "processing"}})

    try:
        prompt = EXTRACTION_PROMPT.replace("{summary_text}", summary_text)
        log.info("Phase 1 extract: prompt %d chars, %d batches", len(prompt), len(batches))

        facts = _extract_world_facts_with_repair(llm, prompt, max_retries=1)
        content = _render_world_model_from_facts(facts, batches)

        log.info("Phase 1 done: %d chars", len(content))

    except Exception as e:
        log.error("Phase 1 extraction failed: %s", e)
        if sse_queue:
            sse_queue.put({"event": "batch_error", "data": {"batch_index": 0, "title": "extract", "error": str(e)}})
            sse_queue.put({"event": "done", "data": {"completed": 0, "failed": 1, "force_rebuild": force_rebuild}})
        return {"completed_batches": [], "failed_batches": [{"error": str(e)}]}

    # ── Phase 2: Verify ──
    if sse_queue:
        sse_queue.put({"event": "progress", "data": {"batch_index": 1, "total": 2, "title": "verify", "status": "processing"}})

    try:
        summary_tail = _get_summary_tail(summary_path, batches, n=3)
        verify_prompt = (
            VERIFY_PROMPT
            .replace("{facts_json}", _facts_to_json_for_prompt(facts))
            .replace("{summary_tail}", summary_tail)
        )
        log.info("Phase 2 verify: prompt %d chars", len(verify_prompt))

        verified_facts = _extract_world_facts_with_repair(llm, verify_prompt, max_retries=1)
        facts = _merge_world_facts(facts, verified_facts)
        content = _render_world_model_from_facts(facts, batches)
        log.info("Phase 2 done: %d chars", len(content))

    except Exception as e:
        log.warning("Phase 2 verify failed (using phase 1 result): %s", e)
        # Non-fatal: use phase 1 result

    # ── Post-processing: coverage table + status card ──
    content = _insert_constraint_lifecycle_ledger(content)
    content = _replace_coverage_table(content, batches)

    wm_path = os.path.join(book_dir, "world_model.md")
    with open(wm_path, "w", encoding="utf-8") as f:
        f.write(content)

    try:
        _populate_status_card(book_dir, summary_path, force=True, world_facts=facts)
    except Exception as e:
        log.error("Status card initialization failed: %s", e, exc_info=True)
        if sse_queue:
            sse_queue.put(
                {
                    "event": "batch_error",
                    "data": {"batch_index": 1, "title": "status_card", "error": str(e)},
                }
            )
            sse_queue.put({"event": "done", "data": {"completed": 0, "failed": 1, "force_rebuild": force_rebuild}})
        return {"completed_batches": [], "failed_batches": [{"error": str(e), "target": "status_card.md"}]}

    commit_id = _commit_files(book_dir, ["world_model.md", "status_card.md"], "batch init: verified full extraction")

    log.info(
        "Verified extraction committed: %d chars, %d lines, commit=%s",
        len(content),
        content.count("\n") + 1,
        commit_id or "unchanged",
    )

    if sse_queue:
        sse_queue.put({"event": "batch_done", "data": {"batch_index": 1, "total": 2, "title": "verify"}})
        sse_queue.put({"event": "done", "data": {"completed": len(batches), "failed": 0, "force_rebuild": force_rebuild}})

    return {
        "completed_batches": batch_titles,
        "failed_batches": [],
        "commit_id": commit_id,
        "force_rebuild": force_rebuild,
    }
