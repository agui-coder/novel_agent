from __future__ import annotations

import json
import os
import re
import subprocess
from datetime import datetime, timezone
from typing import Any

from utils.draft_metadata import DRAFT_META_DIR, resolve_draft_metadata


PROSE_DELIVERY_STATE_FILE_NAME = "prose_delivery_state.json"
PROSE_DELIVERY_STATE_REL_PATH = f"{DRAFT_META_DIR}/{PROSE_DELIVERY_STATE_FILE_NAME}"
PROSE_DELIVERY_STATE_SCHEMA_VERSION = 1
PROSE_DELIVERY_TARGET_FILE = "chapter_draft.md"

FENCE_RE = re.compile(r"^[ \t]*(`{3,}|~{3,})")
ZH_CHAPTER_HEADING_RE = re.compile(
    r"^[ \t]*(?:#{1,6}[ \t]+)?第[ \t]*(?P<number>[0-9０-９一二两三四五六七八九十百千万零〇]+)"
    r"[ \t]*(?P<unit>[章节回卷篇])(?P<suffix>[ \t]*(?:[：:—\-、.．]?[ \t]*)?(?P<title>.*?))[ \t]*#*[ \t]*$"
)
LATIN_CHAPTER_HEADING_RE = re.compile(
    r"^[ \t]*(?:#{1,6}[ \t]+)?(?:CH|Chapter)[ \t]*([0-9０-９]+)[ \t]*(?:[：:—\-、.．]?[ \t]*)?(.*?)[ \t]*#*[ \t]*$",
    re.IGNORECASE,
)

FULLWIDTH_DIGITS = str.maketrans("０１２３４５６７８９", "0123456789")
CHINESE_DIGITS = {
    "零": 0,
    "〇": 0,
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
}
CHINESE_UNITS = {"十": 10, "百": 100, "千": 1000}


def _now_utc() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _state_path(repo_dir: str) -> str:
    return os.path.join(repo_dir, DRAFT_META_DIR, PROSE_DELIVERY_STATE_FILE_NAME)


def _ensure_loregit_excluded(repo_dir: str) -> None:
    exclude_path = os.path.join(repo_dir, ".git", "info", "exclude")
    if not os.path.isdir(os.path.dirname(exclude_path)):
        return
    try:
        current = ""
        if os.path.exists(exclude_path):
            with open(exclude_path, "r", encoding="utf-8") as handle:
                current = handle.read()
        entries = {line.strip() for line in current.splitlines() if line.strip() and not line.lstrip().startswith("#")}
        if f"{DRAFT_META_DIR}/" in entries:
            return
        next_text = current
        if next_text and not next_text.endswith("\n"):
            next_text += "\n"
        next_text += f"{DRAFT_META_DIR}/\n"
        with open(exclude_path, "w", encoding="utf-8", newline="") as handle:
            handle.write(next_text)
    except OSError:
        return


def _strip_line_ending(line: str) -> str:
    if line.endswith("\r\n"):
        return line[:-2]
    if line.endswith("\n") or line.endswith("\r"):
        return line[:-1]
    return line


def parse_chapter_number(raw: str) -> int | None:
    value = str(raw or "").strip().translate(FULLWIDTH_DIGITS)
    if not value:
        return None
    if value.isdigit():
        return int(value)

    total = 0
    section = 0
    number = 0
    for char in value:
        if char in CHINESE_DIGITS:
            number = CHINESE_DIGITS[char]
            continue
        if char == "万":
            section += number
            total += (section or 1) * 10000
            section = 0
            number = 0
            continue
        unit = CHINESE_UNITS.get(char)
        if unit is None:
            return None
        section += (number or 1) * unit
        number = 0
    return total + section + number


def _match_chapter_heading(line: str) -> tuple[int, str] | None:
    zh_match = ZH_CHAPTER_HEADING_RE.match(line)
    if zh_match:
        unit = zh_match.group("unit")
        suffix_start = zh_match.start("suffix")
        next_char = line[suffix_start : suffix_start + 1]
        if unit == "回" and next_char and next_char not in {" ", "\t", "\u3000", "：", ":", "—", "-", "、", ".", "．", "#"}:
            return None
        number = parse_chapter_number(zh_match.group("number"))
        if number is None:
            return None
        title = str(zh_match.group("title") or "").strip(" \t#：:—-、.．")
        return number, title

    latin_match = LATIN_CHAPTER_HEADING_RE.match(line)
    if not latin_match:
        return None
    number = parse_chapter_number(latin_match.group(1))
    if number is None:
        return None
    title = str(latin_match.group(2) or "").strip(" \t#：:—-、.．")
    return number, title


def _chapter_headings(markdown: str) -> list[dict[str, Any]]:
    headings: list[dict[str, Any]] = []
    in_fence = False
    active_fence_char = ""
    active_fence_len = 0

    for line_number, raw_line in enumerate(markdown.splitlines(keepends=True), start=1):
        line = _strip_line_ending(raw_line)
        fence_match = FENCE_RE.match(line)
        if fence_match:
            marker = fence_match.group(1)
            marker_char = marker[0]
            marker_len = len(marker)
            if not in_fence:
                in_fence = True
                active_fence_char = marker_char
                active_fence_len = marker_len
            elif marker_char == active_fence_char and marker_len >= active_fence_len:
                in_fence = False
                active_fence_char = ""
                active_fence_len = 0
            continue
        if in_fence:
            continue

        matched = _match_chapter_heading(line)
        if matched is None:
            continue
        number, title = matched
        headings.append(
            {
                "number": number,
                "title": title,
                "heading": line.strip(),
                "heading_line": line_number,
            }
        )
    return headings


def parse_chapter_spans(markdown: str) -> list[dict[str, Any]]:
    lines = markdown.splitlines()
    headings = _chapter_headings(markdown)
    spans: list[dict[str, Any]] = []
    for index, heading in enumerate(headings):
        next_heading_line = headings[index + 1]["heading_line"] if index + 1 < len(headings) else len(lines) + 1
        heading_line = int(heading["heading_line"])
        spans.append(
            {
                "number": int(heading["number"]),
                "title": str(heading["title"]),
                "heading": str(heading["heading"]),
                "heading_line": heading_line,
                "content_start_line": heading_line + 1,
                "end_line": max(heading_line, int(next_heading_line) - 1),
                "review_status": "pending",
                "author_status": "pending",
            }
        )
    return spans


def _read_chapter_draft(repo_dir: str) -> str:
    draft_path = os.path.join(repo_dir, PROSE_DELIVERY_TARGET_FILE)
    try:
        with open(draft_path, "r", encoding="utf-8") as handle:
            return handle.read()
    except OSError:
        return ""


def _identity_from_state(state: dict[str, Any]) -> dict[str, str]:
    return {
        "draft_branch": str(state.get("draft_branch") or ""),
        "base_branch": str(state.get("base_branch") or ""),
        "base_commit": str(state.get("base_commit") or ""),
        "draft_commit": str(state.get("draft_commit") or ""),
    }


def _identity_from_metadata(metadata: dict[str, Any]) -> dict[str, str]:
    return {
        "draft_branch": str(metadata.get("draft_branch") or ""),
        "base_branch": str(metadata.get("base_branch") or ""),
        "base_commit": str(metadata.get("base_commit") or ""),
        "draft_commit": str(metadata.get("draft_commit") or ""),
    }


def build_initial_state(
    repo_dir: str,
    book_id: str,
    draft_markdown: str,
    *,
    draft_meta: dict[str, Any] | None = None,
    source_agent: str = "continuation",
    created_by: str = "system",
    existing_state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    metadata = draft_meta or resolve_draft_metadata(repo_dir, allow_infer=True, write_inferred=True)
    if metadata.get("status") != "success":
        code = metadata.get("code") or metadata.get("status") or "DRAFT_METADATA_UNRESOLVED"
        raise ValueError(f"cannot build prose delivery state: {code}")

    now = _now_utc()
    identity = _identity_from_metadata(metadata)
    existing_identity = _identity_from_state(existing_state or {})
    created_at = (
        existing_state.get("created_at")
        if existing_state and existing_identity == identity and isinstance(existing_state.get("created_at"), str)
        else now
    )
    chapter_spans = parse_chapter_spans(draft_markdown)
    draft_commit = identity["draft_commit"]
    prior_rewrite_requests = (
        existing_state.get("rewrite_requests")
        if existing_state and isinstance(existing_state.get("rewrite_requests"), list)
        else []
    )
    rewrite_requests = _carry_rewrite_requests(prior_rewrite_requests, draft_commit)
    _apply_rewrite_request_status_to_spans(chapter_spans, rewrite_requests)
    return {
        "schema_version": PROSE_DELIVERY_STATE_SCHEMA_VERSION,
        "book_id": book_id,
        **identity,
        "source_agent": source_agent,
        "created_by": created_by,
        "status": "draft_ready" if chapter_spans else "blocked",
        "created_at": created_at,
        "updated_at": now,
        "draft_package": {
            "file": PROSE_DELIVERY_TARGET_FILE,
            "chapter_count": len(chapter_spans),
            "chapter_spans": chapter_spans,
        },
        "review_report": {
            "status": "not_started",
            "stale": False,
            "draft_commit": draft_commit,
            "findings": [],
            "updated_at": None,
        },
        "rewrite_requests": rewrite_requests,
        "manual_edit": {
            "dirty": False,
            "saved": False,
            "edit_base_commit": draft_commit,
            "saved_draft_commit": "",
            "review_required": False,
        },
        "archive_state": {
            "eligible": False,
            "status": "not_started",
            "archived_files": [],
            "error": None,
            "post_confirm_bridge_status": "not_started",
            "review_gate": "not_started",
            "blocked_reason": "review_required_before_archive" if chapter_spans else "draft_package_empty",
        },
        "handoff_state": {
            "summary_status": "not_started",
            "status_card_status": "not_started",
            "world_model_status": "not_started",
            "errors": [],
        },
    }


def _carry_rewrite_requests(raw_requests: list[Any], draft_commit: str) -> list[dict[str, Any]]:
    carried: list[dict[str, Any]] = []
    for raw in raw_requests:
        if not isinstance(raw, dict):
            continue
        request_entry = dict(raw)
        status = str(request_entry.get("status") or "").strip()
        prior_commit = str(request_entry.get("prior_draft_commit") or "").strip()
        if status in {"requested", "running"} and draft_commit and prior_commit and draft_commit != prior_commit:
            request_entry["status"] = "completed"
            request_entry["completed_draft_commit"] = draft_commit
            request_entry["completed_at"] = _now_utc()
        carried.append(request_entry)
    return carried[-8:]


def _apply_rewrite_request_status_to_spans(
    chapter_spans: list[dict[str, Any]],
    rewrite_requests: list[dict[str, Any]],
) -> None:
    for request_entry in rewrite_requests:
        status = str(request_entry.get("status") or "").strip()
        if status not in {"requested", "running", "completed"}:
            continue
        chapter_number = request_entry.get("chapter_number")
        next_author_status = "rewrite_completed" if status == "completed" else "rewrite_requested"
        for span in chapter_spans:
            if not isinstance(span, dict):
                continue
            if isinstance(chapter_number, int) and span.get("number") != chapter_number:
                continue
            span["author_status"] = next_author_status


def _archive_blocked_reason(review_status: str, has_chapters: bool, review_stale: bool) -> str:
    if not has_chapters:
        return "draft_package_empty"
    if review_stale or review_status == "stale":
        return "review_required_after_draft_change"
    if review_status == "problem":
        return "review_findings_require_rewrite_or_author_approval"
    return "review_required_before_archive"


def normalize_prose_delivery_state(state: dict[str, Any]) -> dict[str, Any]:
    next_state = dict(state)
    review_report = next_state.get("review_report") if isinstance(next_state.get("review_report"), dict) else {}
    review_status = str(review_report.get("status") or "not_started")
    review_stale = bool(review_report.get("stale"))
    spans = ((next_state.get("draft_package") or {}).get("chapter_spans") or [])
    has_chapters = bool(spans)
    archive_state = dict(next_state.get("archive_state")) if isinstance(next_state.get("archive_state"), dict) else {}
    eligible = review_status == "passed" and has_chapters and not review_stale
    archive_state["eligible"] = eligible
    archive_state["review_gate"] = review_status
    if eligible:
        archive_state.pop("blocked_reason", None)
    else:
        archive_state["blocked_reason"] = _archive_blocked_reason(review_status, has_chapters, review_stale)
    next_state["archive_state"] = archive_state
    return next_state


def read_prose_delivery_state(repo_dir: str) -> dict[str, Any] | None:
    _ensure_loregit_excluded(repo_dir)
    path = _state_path(repo_dir)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None
    return normalize_prose_delivery_state(data) if isinstance(data, dict) else None


def write_prose_delivery_state(repo_dir: str, state: dict[str, Any]) -> dict[str, Any]:
    _ensure_loregit_excluded(repo_dir)
    state_dir = os.path.join(repo_dir, DRAFT_META_DIR)
    os.makedirs(state_dir, exist_ok=True)
    next_state = normalize_prose_delivery_state({**state, "updated_at": _now_utc()})
    with open(_state_path(repo_dir), "w", encoding="utf-8", newline="") as handle:
        json.dump(next_state, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return next_state


def create_or_refresh_prose_delivery_state(
    repo_dir: str,
    book_id: str,
    *,
    draft_markdown: str | None = None,
    source_agent: str = "continuation",
    created_by: str = "system",
) -> dict[str, Any]:
    existing_state = read_prose_delivery_state(repo_dir)
    state = build_initial_state(
        repo_dir,
        book_id,
        _read_chapter_draft(repo_dir) if draft_markdown is None else draft_markdown,
        source_agent=source_agent,
        created_by=created_by,
        existing_state=existing_state,
    )
    return write_prose_delivery_state(repo_dir, state)


def delete_prose_delivery_state(repo_dir: str) -> None:
    path = _state_path(repo_dir)
    try:
        if os.path.exists(path):
            os.remove(path)
        state_dir = os.path.dirname(path)
        if os.path.isdir(state_dir) and not os.listdir(state_dir):
            os.rmdir(state_dir)
    except OSError:
        return


def state_staleness(repo_dir: str, state: dict[str, Any] | None = None) -> dict[str, Any]:
    active_state = state or read_prose_delivery_state(repo_dir)
    if not active_state:
        return {"stale": True, "reasons": ["state_missing"], "current": None}

    try:
        metadata = resolve_draft_metadata(repo_dir, allow_infer=False)
    except subprocess.CalledProcessError:
        metadata = {"status": "error", "code": "DRAFT_METADATA_ERROR"}
    if metadata.get("status") != "success":
        return {
            "stale": True,
            "reasons": [str(metadata.get("code") or "draft_metadata_unresolved")],
            "current": metadata,
        }

    expected = _identity_from_state(active_state)
    current = _identity_from_metadata(metadata)
    reasons = [field for field, expected_value in expected.items() if expected_value != current.get(field)]
    return {"stale": bool(reasons), "reasons": reasons, "current": current}


def is_state_stale(repo_dir: str, state: dict[str, Any] | None = None) -> bool:
    return bool(state_staleness(repo_dir, state).get("stale"))
