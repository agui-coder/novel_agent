"""Outline Agent — DISCUSS (divergent ideation) + COMMIT (landing/writing outline files).

Uses a lightweight LLM classifier to route user intent to the correct sub-agent.
"""

from engine.base import AgentConfig, LoreAgent
from engine.tools import (
    draft_append_markdown_section,
    draft_replace_markdown_section,
    get_archive_range,
    get_core_archive,
    get_markdown_outline,
    get_markdown_section,
)

# ── DISCUSS Agent ──────────────────────────────────────────

DISCUSS_SYSTEM_PROMPT = """# Role: OUTLINE_DISCUSS_AGENT / 灵感大纲讨论编辑器

你是大纲创意引擎，负责和作者一起发散、对比、推敲创作方向。你有读取权限但没有写入权限。

OUTLINE_PRODUCTION_CONTROL_PROTOCOL:
- 当前处在"讨论"阶段。你只能读取和搜索，不能写入或修改任何大纲文件。
- 如果作者想落档/保存/初始化大纲，引导作者切换到"落档"模式。
- 讨论时给出 3-5 条候选路线，每条包含：路线名、卖点、冲突压力、留存钩子、兑现形式、风险/红线、建议落脚层级。

三种证据模式:
- SOURCE_FACT: 原文中已存在的事实或背景
- AUTHOR_PROPOSAL: 作者提出的创意方案
- WORLD_MODEL_REQUIRED: 需世界模型确认后才能使用的设定

NONEXISTENT_EVIDENCE_GUARD:
- 只能读取以下文件：summary.md, world_model.md, status_card.md, style_constraints_for_continuation.md, brainstorm.md, master_outline.md, arc_outline.md, chapter_outline.md, chapters/*.md
- 不要虚构不存在的文件路径

RED_LINE_REVERSAL_PROTOCOL:
- 如果作者想在讨论中推翻已有约束（已确认的大纲、世界规则、角色定位），先明确告知风险，再协助探索替代方案。

输出纪律：
- 用自然中文和作者对话
- 每条建议标注证据模式和建议落脚层级
- 不要展示内部协议名或推理链
"""

DISCUSS_TOOLS = [
    get_markdown_section,
    get_markdown_outline,
    get_archive_range,
    get_core_archive,
]


# ── COMMIT Agent ───────────────────────────────────────────

COMMIT_SYSTEM_PROMPT = """# Role: OUTLINE_COMMIT_AGENT / 灵感大纲落档编辑器

你是大纲落档引擎，负责把讨论结果写入四层大纲文件。

OUTLINE_LANDING_ENGINE_PROTOCOL:
- 在写入前形成 landing_plan：每条创意对应到具体的大纲层级文件
- 四层大纲定义：
  - brainstorm.md: 创意池——发散主题、卖点、路线候选
  - master_outline.md: 读者合约——总纲、终局、长期伏笔
  - arc_outline.md: 留存单元计划——卷/篇/阶段目标
  - chapter_outline.md: 生产卡——逐章可执行任务
- 初始化/重建时必须产生全部四个文件

OUTLINE_TOOL_ARGUMENT_SAFETY_PROTOCOL:
- content 参数必须 JSON 安全：避免半角双引号、反斜杠、代码块、花括号不匹配
- 中文书名号优先于英文引号

OUTLINE_FLAT_WRITE_PROTOCOL:
- file_name 只能是裸文件名（如 brainstorm.md）
- 每次工具调用只写一个文件
- origin 必须为 explicit_user_write
- base_etag 来自最近一次读取

硬边界：
- 只能写 brainstorm.md, master_outline.md, arc_outline.md, chapter_outline.md
- 禁止写 chapter_draft.md, summary.md, world_model.md, status_card.md, style 文件, error_archive.md, domain_rules.md

上下文读取协议（初始化/重建时）：
- 先读 summary.md, world_model.md, status_card.md 获取已确认事实
- 再读错误档案和文风约束
- 最后读已有大纲（如果存在）以便增量更新

输出纪律：
- 简单说明更新了哪些文件，各文件的核心变化
- 不要展示工具参数、协议名或内部推理
"""

COMMIT_TOOLS = [
    get_markdown_section,
    get_archive_range,
    get_markdown_outline,
    get_core_archive,
    draft_append_markdown_section,
    draft_replace_markdown_section,
]


# ── Intent Classification ──────────────────────────────────

INTENT_CLASSIFIER_PROMPT = """你是一个意图分类器。根据用户的消息，判断用户当前意图是 "discuss" 还是 "commit"。

分类规则：
- "discuss": 用户在发散、对比、追问某个想法应该落在大纲四层中的哪一层、说"继续"/"沿这个继续"/"重新发散"/"先不要落档"、询问大纲理论。只要没有明确写/保存/归档/初始化/重建的请求，都归此类。
- "commit": 用户明确要写/保存/归档、要求"初始化大纲"/"重建大纲"/"生成四层大纲"、要把讨论结果写到大纲文件。

只回复一个单词：discuss 或 commit。不要加任何其他文字。"""


def classify_intent(query: str) -> str:
    """Classify user intent as 'discuss' or 'commit' using a lightweight LLM call."""
    from langchain_core.messages import HumanMessage, SystemMessage
    from utils.model_provider import create_chat_model

    llm = create_chat_model(max_tokens=10)
    messages = [
        SystemMessage(content=INTENT_CLASSIFIER_PROMPT),
        HumanMessage(content=query),
    ]
    response = llm.invoke(messages)
    raw = getattr(response, "content", "")
    if isinstance(raw, list):
        raw = "".join(str(c) for c in raw)
    result = str(raw).strip().lower()
    if "commit" in result:
        return "commit"
    return "discuss"


def create_discuss_agent() -> LoreAgent:
    config = AgentConfig.from_env(
        agent_key="outline_discuss",
        system_prompt=DISCUSS_SYSTEM_PROMPT,
        max_iterations=30,
        thinking=True,
    )
    return LoreAgent(config=config, tools=DISCUSS_TOOLS)


def create_commit_agent() -> LoreAgent:
    config = AgentConfig.from_env(
        agent_key="outline_commit",
        system_prompt=COMMIT_SYSTEM_PROMPT,
        max_iterations=45,
        thinking=True,
    )
    return LoreAgent(config=config, tools=COMMIT_TOOLS)


def create_outline_agent(query: str) -> LoreAgent:
    """Route to the correct sub-agent based on intent classification."""
    intent = classify_intent(query)
    if intent == "commit":
        return create_commit_agent()
    return create_discuss_agent()
