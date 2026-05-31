"""LangChain @tool wrappers for LoreGit backend operations.

Each tool mirrors a Dify ToolProvider API call but routes through
the same underlying utility functions used by the Flask route handlers.
"""

from __future__ import annotations

import hashlib
import logging
import os
import subprocess
from pathlib import Path
from typing import Any

from langchain_core.tools import tool

from utils.book_storage import ensure_book_layout, get_book_paths, get_storage_root
from utils.markdown_sections import (
    build_markdown_outline,
    extract_markdown_section,
)

logger = logging.getLogger(__name__)

STORAGE_ROOT = Path(__file__).resolve().parent.parent / "storage"


def _get_book_dir(book_id: str = "", book_name: str = "") -> tuple[str, str]:
    """Resolve book directory from book_id or book_name."""
    if book_id:
        book_dir = STORAGE_ROOT / book_id
        if book_dir.is_dir():
            return str(book_dir), book_id
    if book_name:
        storage_root = str(STORAGE_ROOT)
        for entry in os.listdir(storage_root):
            entry_path = os.path.join(storage_root, entry)
            if not os.path.isdir(entry_path) or entry.startswith("."):
                continue
            meta_path = os.path.join(entry_path, "metadata.json")
            if os.path.exists(meta_path):
                import json
                try:
                    with open(meta_path, "r", encoding="utf-8") as f:
                        meta = json.load(f)
                    if isinstance(meta, dict) and meta.get("book_name") == book_name:
                        return entry_path, entry
                except (json.JSONDecodeError, OSError):
                    continue
    raise ValueError("Book not found. Provide valid book_id or book_name.")


def _read_file(book_dir: str, file_name: str) -> tuple[str, str, bool]:
    """Read a file from book directory. Returns (content, etag, exists)."""
    file_path = os.path.join(book_dir, file_name)
    if not os.path.abspath(file_path).startswith(os.path.abspath(book_dir)):
        raise ValueError(f"File name escapes book directory: {file_name}")
    if not os.path.exists(file_path):
        return "", _compute_etag(""), False
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()
    return content, _compute_etag(content), True


def _write_file(book_dir: str, file_name: str, content: str) -> str:
    """Write content to file. Returns new etag."""
    file_path = os.path.join(book_dir, file_name)
    if not os.path.abspath(file_path).startswith(os.path.abspath(book_dir)):
        raise ValueError(f"File name escapes book directory: {file_name}")
    os.makedirs(os.path.dirname(file_path), exist_ok=True)
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content)
    _git_commit(book_dir, file_name, "Engine tool write")
    return _compute_etag(content)


def _git_commit(repo_dir: str, file_name: str, message: str = "Engine tool write") -> None:
    """Stage and commit a single file."""
    try:
        subprocess.run(
            ["git", "add", "--", file_name],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            check=True,
        )
        subprocess.run(
            ["git", "commit", "-m", f"[AI_Update] {message}", "--", file_name],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            check=True,
        )
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr if hasattr(exc, "stderr") else str(exc)
        if "nothing to commit" in stderr.lower() or "nothing added" in stderr.lower():
            return
        raise RuntimeError(f"Git commit failed: {stderr}") from exc


def _compute_etag(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


# ── Read Tools ──────────────────────────────────────────────


@tool
def get_markdown_outline(
    book_id: str = "",
    book_name: str = "",
    file_name: str = "chapter_draft.md",
) -> dict[str, Any]:
    """读取 Markdown 文件的标题结构、section_path 与 base_etag，用于安全定位章节和写入前校验。

    Parameters:
    - book_id: 书库 ID
    - book_name: 书名（book_id 优先）
    - file_name: 目标 Markdown 文件名
    """
    book_dir, resolved_id = _get_book_dir(book_id, book_name)
    content, etag, exists = _read_file(book_dir, file_name)
    outline = build_markdown_outline(content)
    return {
        "status": "success",
        "book_id": resolved_id,
        "file_name": file_name,
        "etag": etag,
        "outline": outline,
        "exists": exists,
        "virtual": not exists,
    }


@tool
def get_markdown_section(
    book_id: str = "",
    book_name: str = "",
    file_name: str = "chapter_draft.md",
    section_path: str = "",
) -> dict[str, Any]:
    """读取 Markdown 文件的局部章节内容，用于核对草稿、章卡、世界观、状态和错误档案证据。

    Parameters:
    - book_id: 书库 ID
    - book_name: 书名
    - file_name: 目标 Markdown 文件名
    - section_path: 章节路径，如 "续写草稿/第1章 标题"
    """
    book_dir, resolved_id = _get_book_dir(book_id, book_name)
    content, etag, exists = _read_file(book_dir, file_name)
    if not section_path:
        return {"status": "error", "message": "section_path is required"}
    try:
        section = extract_markdown_section(content, section_path.split("/"))
    except Exception as exc:
        return {"status": "error", "message": str(exc)}
    return {
        "status": "success",
        "book_id": resolved_id,
        "file_name": file_name,
        "etag": etag,
        "exists": exists,
        **section,
    }


@tool
def get_archive_range(
    book_id: str = "",
    book_name: str = "",
    file_name: str = "summary.md",
    start_line: int = 1,
    end_line: int = 100,
) -> dict[str, Any]:
    """按行范围读取书库归档内容，用于抽样核对原文、摘要、世界观、状态和大纲证据。

    Parameters:
    - book_id: 书库 ID
    - book_name: 书名
    - file_name: 目标文件名
    - start_line: 起始行号 (1-based)
    - end_line: 结束行号 (1-based, inclusive)
    """
    max_lines = 500
    book_dir, resolved_id = _get_book_dir(book_id, book_name)
    content, etag, exists = _read_file(book_dir, file_name)
    lines = content.splitlines(keepends=True)
    if end_line - start_line + 1 > max_lines:
        end_line = start_line + max_lines - 1
    start_idx = max(0, start_line - 1)
    end_idx = min(len(lines), end_line)
    selected = "".join(lines[start_idx:end_idx])
    return {
        "status": "success",
        "book_id": resolved_id,
        "file_name": file_name,
        "etag": etag,
        "start_line": start_idx + 1,
        "end_line": end_idx,
        "total_lines": len(lines),
        "content": selected,
        "truncated": end_idx < len(lines),
    }


@tool
def get_core_archive(
    book_id: str = "",
    book_name: str = "",
    file_name: str = "",
) -> dict[str, Any]:
    """读取书库核心档案，用于快速取得关键上下文；大文件只作兜底。

    Parameters:
    - book_id: 书库 ID
    - book_name: 书名
    - file_name: 核心档案文件名 (world_model.md, summary.md, status_card.md, error_archive.md 等)
    """
    book_dir, resolved_id = _get_book_dir(book_id, book_name)
    content, etag, exists = _read_file(book_dir, file_name)
    return {
        "status": "success",
        "book_id": resolved_id,
        "file_name": file_name,
        "etag": etag,
        "content": content,
        "exists": exists,
        "size_chars": len(content),
    }


@tool
def extract_chapter_highlights(
    book_id: str = "",
    book_name: str = "",
    chapter_index: int = 1,
    keywords: str = "",
    context_sentences: int = 2,
) -> dict[str, Any]:
    """只读抽取章节高价值片段作为证据，不写入任何文件。

    Parameters:
    - book_id: 书库 ID
    - book_name: 书名
    - chapter_index: 章节序号
    - keywords: 逗号分隔的关键词
    - context_sentences: 每个命中点保留的上下文句子数 (1-6)
    """
    book_dir, resolved_id = _get_book_dir(book_id, book_name)
    chapters_dir = os.path.join(book_dir, "chapters")
    if not os.path.isdir(chapters_dir):
        return {"status": "success", "book_id": resolved_id, "hits": [], "total_hits": 0}

    prefix = f"{chapter_index:04d}"
    candidates = sorted(
        [f for f in os.listdir(chapters_dir) if f.startswith(prefix) and f.endswith(".md")]
    )
    if not candidates:
        return {"status": "success", "book_id": resolved_id, "hits": [], "total_hits": 0}

    chapter_path = os.path.join(chapters_dir, candidates[0])
    with open(chapter_path, "r", encoding="utf-8") as f:
        text = f.read()

    kw_list = [k.strip() for k in keywords.split(",") if k.strip()] if keywords else []
    hits = []
    total_chars = 0
    max_chars = 1000
    context = max(0, min(context_sentences or 2, 6))

    for kw in kw_list[:20]:
        pos = 0
        while True:
            idx = text.find(kw, pos)
            if idx < 0 or total_chars >= max_chars:
                break
            start = max(0, idx - 200)
            end = min(len(text), idx + len(kw) + 200)
            for _ in range(context):
                for boundary in ["。", "！", "？", "\n"]:
                    bs = text.rfind(boundary, start, idx)
                    if bs > start:
                        start = bs + 1
                    be = text.find(boundary, end)
                    if 0 < be < len(text) - 1:
                        end = be + 1
            snippet = text[start:end].strip()
            if snippet:
                hits.append({"keyword": kw, "position": idx, "snippet": snippet})
                total_chars += len(snippet)
            pos = idx + len(kw)

    return {
        "status": "success",
        "book_id": resolved_id,
        "chapter_index": chapter_index,
        "hits": hits,
        "total_hits": len(hits),
        "truncated": total_chars >= max_chars,
    }


# ── Write Tools ─────────────────────────────────────────────


@tool
def draft_append_markdown_section(
    book_id: str = "",
    book_name: str = "",
    file_name: str = "chapter_draft.md",
    section_path: str = "",
    content: str = "",
    base_etag: str = "",
    origin: str = "explicit_user_write",
    message: str = "",
) -> dict[str, Any]:
    """在 draft/sandbox 分支向 Markdown 文件追加子章节。file_name 只能用裸文件名。

    Parameters:
    - book_id: 书库 ID
    - book_name: 书名
    - file_name: 目标文件名（仅裸文件名，如 chapter_draft.md 或 error_archive.md）
    - section_path: 父级章节路径，如 "续写草稿"
    - content: 要追加的完整 Markdown 内容（必须包含标题行）
    - base_etag: 从最近读取同一文件获得的 etag
    - origin: 必须为 explicit_user_write
    - message: 简短提交说明
    """
    book_dir, resolved_id = _get_book_dir(book_id, book_name)
    existing, current_etag, exists = _read_file(book_dir, file_name)

    if base_etag and current_etag and base_etag != current_etag:
        return {
            "status": "error",
            "code": "WRITE_CONFLICT",
            "message": f"ETag mismatch for {file_name}. File has been modified since last read.",
            "current_etag": current_etag,
        }

    if origin != "explicit_user_write":
        return {"status": "error", "code": "INVALID_ORIGIN", "message": "origin must be explicit_user_write"}

    if not section_path or not content:
        return {"status": "error", "code": "MISSING_FIELD", "message": "section_path and content are required"}

    # Append content after specified section, or at end of file
    if section_path == "续写草稿" or section_path == "错误档案":
        new_content = existing.rstrip("\n") + "\n\n" + content.strip() + "\n"
    else:
        new_content = existing.rstrip("\n") + "\n\n" + content.strip() + "\n"

    new_etag = _write_file(book_dir, file_name, new_content)

    return {
        "status": "success",
        "book_id": resolved_id,
        "file_name": file_name,
        "section_path": section_path,
        "new_etag": new_etag,
        "appended_chars": len(content),
        "new_size": len(new_content),
    }


@tool
def draft_replace_markdown_section(
    book_id: str = "",
    book_name: str = "",
    file_name: str = "chapter_draft.md",
    section_path: str = "",
    content: str = "",
    base_etag: str = "",
    origin: str = "explicit_user_write",
    message: str = "",
) -> dict[str, Any]:
    """在 draft/sandbox 分支替换指定 Markdown section。content 必须包含目标标题行。

    Parameters:
    - book_id: 书库 ID
    - book_name: 书名
    - file_name: 目标文件名
    - section_path: 要替换的章节路径
    - content: 替换后的完整 Markdown 内容（必须包含标题行）
    - base_etag: 从最近读取同一文件获得的 etag
    - origin: 必须为 explicit_user_write
    - message: 简短提交说明
    """
    book_dir, resolved_id = _get_book_dir(book_id, book_name)
    existing, current_etag, exists = _read_file(book_dir, file_name)

    if base_etag and current_etag and base_etag != current_etag:
        return {
            "status": "error",
            "code": "WRITE_CONFLICT",
            "message": f"ETag mismatch for {file_name}.",
            "current_etag": current_etag,
        }

    if origin != "explicit_user_write":
        return {"status": "error", "code": "INVALID_ORIGIN", "message": "origin must be explicit_user_write"}

    try:
        section_paths = section_path.split("/") if section_path else []
        existing_section = extract_markdown_section(existing, section_paths)
    except Exception:
        return {"status": "error", "code": "SECTION_NOT_FOUND", "message": f"Section not found: {section_path}"}

    start_line = existing_section.get("heading_line", 0)
    end_line = existing_section.get("end_line", len(existing.splitlines()))
    lines = existing.splitlines(keepends=True)
    before = "".join(lines[:start_line])
    after = "".join(lines[end_line:])
    new_full = before.rstrip("\n") + "\n" + content.strip() + "\n" + after.lstrip("\n")

    new_etag = _write_file(book_dir, file_name, new_full)

    return {
        "status": "success",
        "book_id": resolved_id,
        "file_name": file_name,
        "section_path": section_path,
        "new_etag": new_etag,
        "replaced_chars": len(content),
        "new_size": len(new_full),
    }


# ── Validation Tools ────────────────────────────────────────


@tool
def validate_chapter_lengths(
    book_id: str = "",
    book_name: str = "",
    file_name: str = "chapter_draft.md",
    min_chars: int = 2200,
    target_chars: int = 2500,
    max_chars: int = 3200,
) -> dict[str, Any]:
    """只读统计 chapter_draft.md 中各章的非空白字符数。不写入文件。

    Parameters:
    - book_id: 书库 ID
    - book_name: 书名
    - file_name: 草稿文件名
    - min_chars: 最低字符数阈值 (默认 2200)
    - target_chars: 目标字符数 (默认 2500)
    - max_chars: 最高字符数阈值 (默认 3200)
    """
    from utils.chapter_length import measure_chapter_lengths

    book_dir, resolved_id = _get_book_dir(book_id, book_name)
    content, etag, exists = _read_file(book_dir, file_name)
    if not exists:
        return {"status": "error", "message": f"File not found: {file_name}"}

    results = measure_chapter_lengths(content, min_chars=min_chars, target_chars=target_chars, max_chars=max_chars)
    return {"status": "success", "book_id": resolved_id, "file_name": file_name, **results}


@tool
def generate_style_diagnostics_tool(
    book_id: str = "",
    book_name: str = "",
    draft_file: str = "chapter_draft.md",
    source_count: int = 12,
    draft_chapters: str = "",
) -> dict[str, Any]:
    """只读生成文风诊断与打磨提示，结果作为 style_advisory。不写文件，不充当调度硬门。

    Parameters:
    - book_id: 书库 ID
    - book_name: 书名
    - draft_file: 草稿文件名
    - source_count: 用于诊断的样本章节数 (默认 12)
    - draft_chapters: 当前章号字符串
    """
    from utils.style_diagnostics import generate_style_diagnostics

    book_dir, resolved_id = _get_book_dir(book_id, book_name)
    result = generate_style_diagnostics(
        book_dir=Path(book_dir),
        source_count=source_count,
        draft_file=draft_file,
        draft_chapters=draft_chapters,
    )
    return {"status": "success", "book_id": resolved_id, "draft_file": draft_file, **result}
