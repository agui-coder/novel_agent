"""Backend-owned schema-locked summary archive pipeline.

This pipeline replaces the retired Dify reading_archive_agent path for fixed
Tomato import summary generation. It summarizes imported source chapters into
validated structured batch data, then renders `summary.md` deterministically.
It does not generate continuation prose or outline cards.
"""

from __future__ import annotations

import json
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from threading import Event
from typing import Any, Callable

from utils.git_utils import (
    ensure_repo,
    ensure_repo_identity,
    is_nothing_to_commit_error,
    resolve_head,
    run_git,
)


ARCHIVE_MARKER = "LONGFORM_LAYERED_ARCHIVE_V1"
DEFAULT_MAX_BATCH_BYTES = 240_000
DEFAULT_MAX_BATCH_CHAPTERS = 25
DEFAULT_MAX_WORKERS = 4
DEFAULT_MAX_RETRIES = 1
SUMMARY_COMMIT_MESSAGE_PREFIX = "[AI_Summary]"

REQUIRED_ARCHIVE_FIELDS = (
    "批次概览",
    "不可逆事实",
    "未闭合线索与承诺",
    "关系与状态变化",
    "下游创作约束",
)

ProgressCallback = Callable[[dict[str, Any]], None]
ModelInvoker = Callable[[str], str]


@dataclass(frozen=True)
class ChapterInput:
    index: int
    title: str
    file_name: str
    markdown: str


@dataclass(frozen=True)
class ChapterArchiveItem:
    index: int
    title: str
    summary: str


@dataclass(frozen=True)
class BatchArchive:
    batch_index: int
    total_batches: int
    chapter_start: int
    chapter_end: int
    overview: list[str]
    chapter_index: list[ChapterArchiveItem]
    irreversible_facts: list[str]
    open_loops_and_promises: list[str]
    relationship_and_status_changes: list[str]
    downstream_constraints: list[str]


def _chapter_sort_key(path: Path) -> tuple[int, str]:
    match = re.match(r"^(\d+)", path.name)
    if match:
        return int(match.group(1)), path.name
    return 10**9, path.name


def load_chapters(book_dir: str | Path) -> list[ChapterInput]:
    chapters_dir = Path(book_dir) / "chapters"
    if not chapters_dir.is_dir():
        return []

    chapters: list[ChapterInput] = []
    for fallback_index, path in enumerate(sorted(chapters_dir.glob("*.md"), key=_chapter_sort_key), start=1):
        markdown = path.read_text(encoding="utf-8", errors="replace").strip()
        if not markdown:
            continue
        prefix_match = re.match(r"^(\d+)", path.name)
        index = int(prefix_match.group(1)) if prefix_match else fallback_index
        first_line = markdown.splitlines()[0].strip() if markdown.splitlines() else ""
        title = first_line[2:].strip() if first_line.startswith("# ") else f"第{index}章"
        chapters.append(ChapterInput(index=index, title=title, file_name=path.name, markdown=markdown))
    return chapters


def split_chapter_batches(
    chapters: list[ChapterInput],
    *,
    max_batch_bytes: int = DEFAULT_MAX_BATCH_BYTES,
    max_batch_chapters: int = DEFAULT_MAX_BATCH_CHAPTERS,
) -> list[list[ChapterInput]]:
    batches: list[list[ChapterInput]] = []
    current: list[ChapterInput] = []
    current_bytes = 0
    max_batch_chapters = max(1, int(max_batch_chapters or DEFAULT_MAX_BATCH_CHAPTERS))

    for chapter in chapters:
        chapter_bytes = len(chapter.markdown.encode("utf-8"))
        if current and (
            current_bytes + chapter_bytes > max_batch_bytes
            or len(current) >= max_batch_chapters
        ):
            batches.append(current)
            current = []
            current_bytes = 0
        current.append(chapter)
        current_bytes += chapter_bytes

    if current:
        batches.append(current)
    return batches


def _build_llm(max_tokens: int = 8192):
    from utils.model_provider import create_chat_model

    return create_chat_model(max_tokens=max_tokens, purpose="summary_archive")


def _invoke_langchain(prompt: str) -> str:
    from langchain_core.messages import HumanMessage

    response = _build_llm().invoke([HumanMessage(content=prompt)])
    content = getattr(response, "content", "")
    if isinstance(content, list):
        return "\n".join(str(item) for item in content)
    return str(content)


def _build_batch_prompt(
    *,
    book_name: str,
    batch: list[ChapterInput],
    batch_index: int,
    total_batches: int,
) -> str:
    start = batch[0].index
    end = batch[-1].index
    chapter_block = "\n\n---CHAPTER---\n\n".join(
        f"【第{chapter.index}章｜{chapter.title}｜文件：{chapter.file_name}】\n\n{chapter.markdown}"
        for chapter in batch
    )
    expected_chapters = "、".join(f"第{chapter.index}章" for chapter in batch)
    return f"""你是网文创作工作台的后端阅读归档管线。

任务：
- 把输入的原文章节蒸馏为可复用的阅读档案，供世界模型、文风、大纲、续写、审查等后续模块读取。
- 保留剧情事实、不可逆事实、未闭合线索、人物关系变化、承诺、约束、回收点。
- 不要发明新剧情，不要写大纲卡，不要写续写正文。
- 无论原文包含多少英文专名，所有解释、总结、项目内容都必须使用简体中文。
- 队名、人名、赛事名、技能名、型号名等专有名词可以保留原文，例如 G2、CS2、AWP、donk；但句子说明必须是中文。

输出要求：
- 只返回一个 JSON 对象，不要 Markdown，不要代码块，不要寒暄，不要解释你做了什么。
- JSON 键名必须使用下面的中文键名。
- “章节索引”必须覆盖本批每一章，一章一条，不得合并章节范围。
- 每个列表至少写一条；如果本批没有明显变化，也要写“本批没有明确新增，但保留前文状态。”这类中文占位。

JSON 形状：
{{
  "批次概览": ["用中文概括本批故事阶段、主要推进、核心风险。"],
  "章节索引": [
    {{"章号": {start}, "标题": "章节标题", "简述": "该章发生了什么，必须是中文句子。"}}
  ],
  "不可逆事实": ["已经发生且后续不能随意改写的事实。"],
  "未闭合线索与承诺": ["仍需兑现、解释、回收或延续的线索。"],
  "关系与状态变化": ["人物、阵营、资源、比赛状态或情绪关系的变化。"],
  "下游创作约束": ["后续续写、审查、大纲或世界模型必须注意的约束。"]
}}

书名：{book_name}
批次：{batch_index}/{total_batches}
章节范围：第{start}-{end}章
必须覆盖章节：{expected_chapters}

原文章节：
{chapter_block}
"""


def _strip_code_fence(text: str) -> str:
    match = re.search(r"```(?:json|markdown|md)?\s*\n(.*?)```", text, flags=re.DOTALL)
    if match:
        return match.group(1).strip()
    return text.strip()


def _extract_json_payload(text: str) -> dict[str, Any]:
    raw = _strip_code_fence(text)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        start = raw.find("{")
        end = raw.rfind("}")
        if start < 0 or end < start:
            raise ValueError("模型未返回 JSON 对象") from None
        data = json.loads(raw[start : end + 1])
    if not isinstance(data, dict):
        raise ValueError("模型返回的 JSON 根节点不是对象")
    nested = data.get("批次归档")
    if isinstance(nested, dict):
        return nested
    return data


_CONVERSATIONAL_PREFIX_RE = re.compile(
    r"^(好的|已收到|收到|以下是|下面是|我将|我会|作为.*?助手|根据您的要求|已经按照)([，,。！!：:]|$)"
)


def _clean_text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value)
    text = text.replace(ARCHIVE_MARKER, "")
    text = re.sub(r"^\s*[-*]\s+", "", text.strip())
    text = re.sub(r"^\s*\d+\s*[.、]\s*", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    if _CONVERSATIONAL_PREFIX_RE.match(text):
        return ""
    return text


def _coerce_text_list(data: dict[str, Any], key: str, *, batch_label: str) -> list[str]:
    value = data.get(key)
    if isinstance(value, str):
        raw_items: list[Any] = value.splitlines()
    elif isinstance(value, list):
        raw_items = value
    else:
        aliases = {
            "批次概览": ("batch_overview", "overview", "Batch Overview"),
            "不可逆事实": ("irreversible_facts", "Irreversible Facts"),
            "未闭合线索与承诺": ("open_loops", "open_loops_and_promises", "Open Loops And Promises"),
            "关系与状态变化": ("relationship_changes", "relationship_and_status_changes"),
            "下游创作约束": ("downstream_constraints", "Downstream Constraints"),
        }
        raw_items = []
        for alias in aliases.get(key, ()):
            alias_value = data.get(alias)
            if isinstance(alias_value, str):
                raw_items = alias_value.splitlines()
                break
            if isinstance(alias_value, list):
                raw_items = alias_value
                break
    items = [_clean_text(item) for item in raw_items]
    items = [item for item in items if item]
    if not items:
        raise ValueError(f"{batch_label} 缺少有效字段：{key}")
    return items


def _coerce_chapter_number(value: Any) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        match = re.search(r"\d+", value)
        if match:
            return int(match.group(0))
    return None


def _parse_chapter_line(raw: str) -> tuple[int | None, str]:
    text = _clean_text(raw)
    match = re.match(r"^第\s*(\d+)\s*章(?:[《：:](.*?)[》：:]?)?\s*(?:：|:)?\s*(.+)$", text)
    if match:
        chapter_number = int(match.group(1))
        title_part = _clean_text(match.group(2) or "")
        summary_part = _clean_text(match.group(3) or title_part)
        return chapter_number, summary_part
    match = re.match(r"^(?:CH)?\s*(\d+)\s*(?:：|:|-)\s*(.+)$", text, flags=re.IGNORECASE)
    if match:
        return int(match.group(1)), _clean_text(match.group(2))
    return None, text


def _parse_chapter_index(
    data: dict[str, Any],
    batch: list[ChapterInput],
    *,
    batch_label: str,
) -> list[ChapterArchiveItem]:
    value = data.get("章节索引")
    if value is None:
        value = data.get("batch_index") or data.get("Batch Index") or data.get("chapter_index")
    if isinstance(value, str):
        raw_items: list[Any] = value.splitlines()
    elif isinstance(value, list):
        raw_items = value
    else:
        raise ValueError(f"{batch_label} 缺少有效字段：章节索引")

    expected = {chapter.index: chapter for chapter in batch}
    parsed: dict[int, ChapterArchiveItem] = {}
    for raw_item in raw_items:
        if isinstance(raw_item, dict):
            chapter_number = _coerce_chapter_number(
                raw_item.get("章号")
                or raw_item.get("章节")
                or raw_item.get("chapter")
                or raw_item.get("chapter_number")
            )
            title = _clean_text(raw_item.get("标题") or raw_item.get("title") or "")
            summary = _clean_text(
                raw_item.get("简述")
                or raw_item.get("摘要")
                or raw_item.get("summary")
                or raw_item.get("内容")
                or ""
            )
        else:
            chapter_number, summary = _parse_chapter_line(str(raw_item))
            title = ""

        if chapter_number is None:
            continue
        if chapter_number not in expected:
            raise ValueError(f"{batch_label} 章节索引包含批次外章节：第{chapter_number}章")
        if chapter_number in parsed:
            raise ValueError(f"{batch_label} 章节索引重复：第{chapter_number}章")
        if not summary:
            raise ValueError(f"{batch_label} 第{chapter_number}章缺少简述")
        source_title = expected[chapter_number].title
        parsed[chapter_number] = ChapterArchiveItem(
            index=chapter_number,
            title=source_title or title,
            summary=summary,
        )

    missing = [chapter.index for chapter in batch if chapter.index not in parsed]
    if missing:
        missing_text = "、".join(f"第{idx}章" for idx in missing)
        raise ValueError(f"{batch_label} 章节索引未覆盖：{missing_text}")
    return [parsed[chapter.index] for chapter in batch]


def _parse_batch_answer(
    answer: str,
    batch: list[ChapterInput],
    *,
    batch_index: int,
    total_batches: int,
) -> BatchArchive:
    start = batch[0].index
    end = batch[-1].index
    batch_label = f"摘要批次 {batch_index}/{total_batches}（第{start}-{end}章）"
    data = _extract_json_payload(answer)
    return BatchArchive(
        batch_index=batch_index,
        total_batches=total_batches,
        chapter_start=start,
        chapter_end=end,
        overview=_coerce_text_list(data, "批次概览", batch_label=batch_label),
        chapter_index=_parse_chapter_index(data, batch, batch_label=batch_label),
        irreversible_facts=_coerce_text_list(data, "不可逆事实", batch_label=batch_label),
        open_loops_and_promises=_coerce_text_list(data, "未闭合线索与承诺", batch_label=batch_label),
        relationship_and_status_changes=_coerce_text_list(data, "关系与状态变化", batch_label=batch_label),
        downstream_constraints=_coerce_text_list(data, "下游创作约束", batch_label=batch_label),
    )


def _run_batch_with_retries(
    *,
    invoker: ModelInvoker,
    prompt: str,
    batch: list[ChapterInput],
    batch_index: int,
    total_batches: int,
    max_retries: int,
    cancel_event: Event | None,
) -> BatchArchive:
    last_error: Exception | None = None
    for attempt in range(max(0, max_retries) + 1):
        if cancel_event is not None and cancel_event.is_set():
            raise RuntimeError("summary pipeline cancelled")
        try:
            answer = invoker(prompt)
            if not isinstance(answer, str) or not answer.strip():
                raise RuntimeError(f"summary archive batch {batch_index}/{total_batches} returned empty output")
            return _parse_batch_answer(
                answer,
                batch,
                batch_index=batch_index,
                total_batches=total_batches,
            )
        except Exception as exc:  # retry only inside the bounded batch worker
            last_error = exc
            if attempt >= max(0, max_retries):
                break
    raise RuntimeError(f"summary archive batch {batch_index}/{total_batches} failed: {last_error}") from last_error


def _render_bullets(items: list[str]) -> list[str]:
    return [f"- {item}" for item in items]


def _render_chapter_index(items: list[ChapterArchiveItem]) -> list[str]:
    rendered: list[str] = []
    for item in items:
        title = f"《{item.title}》" if item.title else ""
        rendered.append(f"- 第{item.index}章{title}：{item.summary}")
    return rendered


def _render_batch_archive(batch: BatchArchive) -> str:
    lines: list[str] = [
        f"## 批次归档：第{batch.chapter_start}-{batch.chapter_end}章",
        "",
        "## 批次概览",
        *_render_bullets(batch.overview),
        "",
        "## 章节索引",
        *_render_chapter_index(batch.chapter_index),
        "",
        "## 不可逆事实",
        *_render_bullets(batch.irreversible_facts),
        "",
        "## 未闭合线索与承诺",
        *_render_bullets(batch.open_loops_and_promises),
        "",
        "## 关系与状态变化",
        *_render_bullets(batch.relationship_and_status_changes),
        "",
        "## 下游创作约束",
        *_render_bullets(batch.downstream_constraints),
    ]
    return "\n".join(lines).strip()


def _assert_complete_coverage(chapters: list[ChapterInput], batch_archives: list[BatchArchive]) -> None:
    expected = [chapter.index for chapter in chapters]
    covered = [item.index for batch in batch_archives for item in batch.chapter_index]
    if covered != expected:
        missing = sorted(set(expected) - set(covered))
        extras = sorted(set(covered) - set(expected))
        duplicate = sorted({idx for idx in covered if covered.count(idx) > 1})
        details: list[str] = []
        if missing:
            details.append("缺失：" + "、".join(f"第{idx}章" for idx in missing))
        if extras:
            details.append("越界：" + "、".join(f"第{idx}章" for idx in extras))
        if duplicate:
            details.append("重复：" + "、".join(f"第{idx}章" for idx in duplicate))
        raise ValueError("summary.md 章节覆盖校验失败：" + "；".join(details))


def compose_summary(batch_archives: list[BatchArchive], *, chapter_count: int | None = None) -> str:
    ordered = sorted(batch_archives, key=lambda batch: (batch.chapter_start, batch.chapter_end))
    body = "\n\n".join(_render_batch_archive(batch) for batch in ordered)
    total_chapters = chapter_count if chapter_count is not None else sum(len(batch.chapter_index) for batch in ordered)
    lines = [
        ARCHIVE_MARKER,
        "",
        "# 全书阅读档案索引",
        "",
        f"- 批次数量：{len(ordered)}",
        f"- 章节数量：{total_chapters}",
        "- 生成归属：后端摘要归档管线",
        "- 生成方式：并发结构化抽取，后端确定性渲染",
        "- 用途：基于原文章节生成阅读档案，供世界模型、文风、大纲、续写、审查模块读取。",
        "",
    ]
    for idx, batch in enumerate(ordered, start=1):
        lines.extend([f"## 第{idx}批：第{batch.chapter_start}-{batch.chapter_end}章", ""])
        lines.append("### 批次概览摘录")
        lines.extend(_render_bullets(batch.overview[:4]))
        lines.append("")
        lines.append("### 章节索引摘录")
        lines.extend(_render_chapter_index(batch.chapter_index[:6]))
        lines.append("")

    return "\n".join(lines).strip() + "\n\n---\n\n# 批次归档正文\n\n" + body.strip() + "\n"


def _update_summary_metadata(book_dir: Path, chapter_count: int, total_batches: int) -> bool:
    meta_path = book_dir / "metadata.json"
    if not meta_path.exists():
        return False
    metadata = json.loads(meta_path.read_text(encoding="utf-8"))
    next_metadata = dict(metadata)
    next_metadata["summary_complete"] = True
    next_metadata["total_chapters"] = chapter_count
    next_metadata["processed_batches"] = total_batches
    if next_metadata == metadata:
        return False
    meta_path.write_text(json.dumps(next_metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return True


def _commit_summary(book_dir: Path, book_name: str, commit_paths: list[str]) -> str | None:
    ensure_repo(str(book_dir))
    ensure_repo_identity(str(book_dir))
    status = run_git(str(book_dir), ["status", "--porcelain", "--", *commit_paths]).stdout
    if not status.strip():
        return None
    run_git(str(book_dir), ["add", "--", *commit_paths])
    try:
        run_git(str(book_dir), ["commit", "-m", f"{SUMMARY_COMMIT_MESSAGE_PREFIX} {book_name}", "--", *commit_paths])
    except subprocess.CalledProcessError as exc:
        if not is_nothing_to_commit_error(exc):
            raise
    return resolve_head(str(book_dir), "summary archive")


def run_pipeline(
    *,
    book_id: str,
    book_dir: str | Path,
    book_name: str | None = None,
    cancel_event: Event | None = None,
    progress_callback: ProgressCallback | None = None,
    max_batch_bytes: int = DEFAULT_MAX_BATCH_BYTES,
    max_batch_chapters: int = DEFAULT_MAX_BATCH_CHAPTERS,
    max_workers: int = DEFAULT_MAX_WORKERS,
    max_retries: int = DEFAULT_MAX_RETRIES,
    invoke_model: ModelInvoker | None = None,
) -> dict[str, Any]:
    """Generate, write, and commit summary.md from imported chapter files."""
    resolved_book_dir = Path(book_dir)
    resolved_book_name = book_name or book_id

    def emit(payload: dict[str, Any]) -> None:
        if progress_callback is not None:
            progress_callback(payload)

    emit({"status": "reading", "book_id": book_id, "book_name": resolved_book_name})
    chapters = load_chapters(resolved_book_dir)
    if not chapters:
        return {"status": "no_chapters", "book_id": book_id, "book_name": resolved_book_name}

    batches = split_chapter_batches(
        chapters,
        max_batch_bytes=max_batch_bytes,
        max_batch_chapters=max_batch_chapters,
    )
    total_batches = len(batches)
    invoker = invoke_model or _invoke_langchain
    batch_archives: dict[int, BatchArchive] = {}
    worker_count = max(1, min(int(max_workers or 1), total_batches))

    emit(
        {
            "status": "generating",
            "batch": 0,
            "completed_batches": 0,
            "total_batches": total_batches,
            "chapter_count": len(chapters),
            "book_name": resolved_book_name,
            "max_workers": worker_count,
        }
    )

    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        future_to_index = {}
        for batch_index, batch in enumerate(batches, start=1):
            if cancel_event is not None and cancel_event.is_set():
                return {"status": "cancelled", "book_id": book_id, "book_name": resolved_book_name}
            prompt = _build_batch_prompt(
                book_name=resolved_book_name,
                batch=batch,
                batch_index=batch_index,
                total_batches=total_batches,
            )
            future = executor.submit(
                _run_batch_with_retries,
                invoker=invoker,
                prompt=prompt,
                batch=batch,
                batch_index=batch_index,
                total_batches=total_batches,
                max_retries=max_retries,
                cancel_event=cancel_event,
            )
            future_to_index[future] = batch_index

        completed = 0
        for future in as_completed(future_to_index):
            if cancel_event is not None and cancel_event.is_set():
                for pending in future_to_index:
                    pending.cancel()
                return {"status": "cancelled", "book_id": book_id, "book_name": resolved_book_name}
            batch_index = future_to_index[future]
            archive = future.result()
            batch_archives[batch_index] = archive
            completed += 1
            emit(
                {
                    "status": "generating",
                    "batch": completed,
                    "completed_batches": completed,
                    "current_batch": batch_index,
                    "total_batches": total_batches,
                    "chapter_count": len(chapters),
                    "book_name": resolved_book_name,
                    "max_workers": worker_count,
                }
            )

    ordered_archives = [batch_archives[index] for index in sorted(batch_archives)]
    _assert_complete_coverage(chapters, ordered_archives)
    summary_content = compose_summary(ordered_archives, chapter_count=len(chapters))
    emit({"status": "writing", "book_name": resolved_book_name, "chars": len(summary_content)})
    if cancel_event is not None and cancel_event.is_set():
        return {"status": "cancelled", "book_id": book_id, "book_name": resolved_book_name, "chars": len(summary_content)}

    summary_path = resolved_book_dir / "summary.md"
    summary_path.write_text(summary_content, encoding="utf-8")
    commit_paths = ["summary.md"]
    if _update_summary_metadata(resolved_book_dir, len(chapters), total_batches):
        commit_paths.append("metadata.json")
    commit_id = _commit_summary(resolved_book_dir, resolved_book_name, commit_paths)
    result = {
        "status": "success",
        "book_id": book_id,
        "book_name": resolved_book_name,
        "chapter_count": len(chapters),
        "total_batches": total_batches,
        "chars": len(summary_content),
        "commit_id": commit_id,
        "updated_files": commit_paths,
    }
    emit({**result, "status": "done"})
    return result
