from __future__ import annotations

import os
import subprocess
from datetime import datetime, timezone
from typing import Any, Callable

from flask import Blueprint, jsonify, request

from agents.archive import _compute_text_etag
from utils.book_storage import get_book_paths, inspect_book_layout_integrity
from utils.draft_metadata import DRAFT_BRANCH_NAME, refresh_draft_metadata, resolve_draft_metadata
from utils.file_lock import exclusive_file_lock
from utils.git_utils import ensure_repo_identity, is_nothing_to_commit_error, run_git
from utils.prose_delivery_state import (
    PROSE_DELIVERY_TARGET_FILE,
    build_initial_state,
    create_or_refresh_prose_delivery_state,
    delete_prose_delivery_state,
    read_prose_delivery_state,
    state_staleness,
    write_prose_delivery_state,
)


LOCKS_DIR_NAME = ".locks"


def _now_utc() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _repo_lock(repo_dir: str):
    locks_dir = os.path.join(repo_dir, LOCKS_DIR_NAME)
    os.makedirs(locks_dir, exist_ok=True)
    lock_path = os.path.join(locks_dir, "prose_delivery.lock")
    return open(lock_path, "w", encoding="utf-8")


def _with_lock(lock_file):
    return exclusive_file_lock(lock_file)


def _book_ready(book_id: str, storage_root: str) -> tuple[dict[str, str] | None, tuple | None]:
    integrity = inspect_book_layout_integrity(book_id, storage_root)
    if not integrity["exists"]:
        return None, (
            jsonify(
                {
                    "status": "error",
                    "code": "BOOK_NOT_FOUND",
                    "message": f"book storage is missing for {book_id}; initialize or repair it first",
                }
            ),
            404,
        )
    if integrity["needs_repair"]:
        return None, (
            jsonify(
                {
                    "status": "error",
                    "code": "LAYOUT_REPAIR_REQUIRED",
                    "message": "repository layout is incomplete; call /books/repair_layout first",
                }
            ),
            409,
        )
    return get_book_paths(book_id, storage_root), None


def _branch_head_commit(repo_dir: str, branch_name: str) -> str | None:
    try:
        return run_git(repo_dir, ["rev-parse", "--verify", f"{branch_name}^{{commit}}"]).stdout.strip()
    except subprocess.CalledProcessError:
        return None


def _read_draft_from_branch(repo_dir: str) -> str:
    if not _branch_head_commit(repo_dir, DRAFT_BRANCH_NAME):
        return ""
    try:
        return run_git(repo_dir, ["show", f"{DRAFT_BRANCH_NAME}:{PROSE_DELIVERY_TARGET_FILE}"]).stdout
    except subprocess.CalledProcessError:
        return ""


def _checkout_draft_branch(repo_dir: str) -> None:
    if not _branch_head_commit(repo_dir, DRAFT_BRANCH_NAME):
        raise ValueError("draft branch does not exist")
    run_git(repo_dir, ["checkout", DRAFT_BRANCH_NAME])


def _public_state_payload(repo_dir: str, book_id: str, state: dict[str, Any] | None) -> dict[str, Any]:
    draft_content = _read_draft_from_branch(repo_dir)
    return {
        "status": "success",
        "book_id": book_id,
        "state": state,
        "staleness": state_staleness(repo_dir, state) if state else {"stale": True, "reasons": ["state_missing"]},
        "draft": {
            "file": PROSE_DELIVERY_TARGET_FILE,
            "branch": DRAFT_BRANCH_NAME,
            "commit_id": _branch_head_commit(repo_dir, DRAFT_BRANCH_NAME),
            "content": draft_content,
            "etag": _compute_text_etag(draft_content),
        },
    }


def _normalize_findings(raw_findings: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_findings, list):
        return []
    findings: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_findings, start=1):
        if not isinstance(raw, dict):
            continue
        chapter_number = raw.get("chapter_number")
        if isinstance(chapter_number, str) and chapter_number.strip().isdigit():
            chapter_number = int(chapter_number.strip())
        finding_id = raw.get("id")
        if not isinstance(finding_id, str) or not finding_id.strip():
            finding_id = f"F{index:03d}"
        severity = raw.get("severity") if isinstance(raw.get("severity"), str) else "info"
        status = raw.get("status") if isinstance(raw.get("status"), str) else "open"
        findings.append(
            {
                "id": finding_id.strip(),
                "chapter_number": chapter_number if isinstance(chapter_number, int) else None,
                "severity": severity.strip() or "info",
                "status": status.strip() or "open",
                "message": str(raw.get("message") or "").strip(),
                "suggestion": str(raw.get("suggestion") or "").strip(),
            }
        )
    return findings


def _finding_is_problem(finding: dict[str, Any]) -> bool:
    severity = str(finding.get("severity") or "").lower()
    status = str(finding.get("status") or "").lower()
    return severity in {"fail", "error", "blocking", "problem"} or status in {"open", "blocking", "problem"}


def _apply_review_status_to_spans(state: dict[str, Any], findings: list[dict[str, Any]]) -> None:
    problem_numbers = {
        finding.get("chapter_number")
        for finding in findings
        if isinstance(finding.get("chapter_number"), int) and _finding_is_problem(finding)
    }
    spans = ((state.get("draft_package") or {}).get("chapter_spans") or [])
    for span in spans:
        if not isinstance(span, dict):
            continue
        number = span.get("number")
        span["review_status"] = "problem" if number in problem_numbers else "passed"


def _mark_author_status(state: dict[str, Any], chapter_number: int | None, status: str) -> None:
    spans = ((state.get("draft_package") or {}).get("chapter_spans") or [])
    for span in spans:
        if not isinstance(span, dict):
            continue
        if chapter_number is None or span.get("number") == chapter_number:
            span["author_status"] = status


def create_blueprint(
    *,
    storage_root: str,
    parse_json_payload: Callable[[list[str] | None], tuple[dict | None, tuple | None]],
    require_book_id: Callable[[dict | None], tuple[str | None, tuple | None]],
    json_error: Callable[[str, str, int], tuple],
) -> Blueprint:
    bp = Blueprint("prose_delivery", __name__)

    @bp.get("/api/prose_delivery/state")
    def get_state():
        book_id, book_err = require_book_id(None)
        if book_err:
            return book_err
        assert book_id is not None
        paths, ready_err = _book_ready(book_id, storage_root)
        if ready_err:
            return ready_err
        assert paths is not None
        repo_dir = paths["book_dir"]
        state = read_prose_delivery_state(repo_dir)
        return jsonify(_public_state_payload(repo_dir, book_id, state)), 200

    @bp.post("/api/prose_delivery/refresh")
    def refresh_state():
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict):
            return json_error("INVALID_PAYLOAD", "request body must be application/json object", 400)
        book_id, book_err = require_book_id(payload)
        if book_err:
            return book_err
        assert book_id is not None
        paths, ready_err = _book_ready(book_id, storage_root)
        if ready_err:
            return ready_err
        assert paths is not None
        repo_dir = paths["book_dir"]
        with _repo_lock(repo_dir) as lock_file:
            with _with_lock(lock_file):
                metadata = resolve_draft_metadata(repo_dir, allow_infer=True, write_inferred=True)
                if metadata.get("status") != "success":
                    return json_error(
                        str(metadata.get("code") or "DRAFT_METADATA_UNRESOLVED"),
                        "draft metadata cannot be resolved; prose delivery is blocked",
                        409,
                    )
                state = create_or_refresh_prose_delivery_state(
                    repo_dir,
                    book_id,
                    draft_markdown=_read_draft_from_branch(repo_dir),
                    source_agent=str(payload.get("source_agent") or "continuation"),
                    created_by=str(payload.get("created_by") or "system"),
                )
        return jsonify(_public_state_payload(repo_dir, book_id, state)), 200

    @bp.post("/api/prose_delivery/manual_save")
    def manual_save():
        payload, err = parse_json_payload(["content"])
        if err:
            return err
        assert payload is not None
        book_id, book_err = require_book_id(payload)
        if book_err:
            return book_err
        assert book_id is not None
        paths, ready_err = _book_ready(book_id, storage_root)
        if ready_err:
            return ready_err
        assert paths is not None
        repo_dir = paths["book_dir"]
        content = payload.get("content")
        if not isinstance(content, str):
            return json_error("INVALID_PAYLOAD", "content must be a string", 400)
        base_etag = payload.get("base_etag")
        if base_etag is not None and not isinstance(base_etag, str):
            return json_error("INVALID_PAYLOAD", "base_etag must be a string when provided", 400)

        with _repo_lock(repo_dir) as lock_file:
            with _with_lock(lock_file):
                metadata = resolve_draft_metadata(repo_dir, allow_infer=True, write_inferred=True)
                if metadata.get("status") != "success":
                    return json_error(
                        str(metadata.get("code") or "DRAFT_METADATA_UNRESOLVED"),
                        "draft metadata cannot be resolved; manual save is blocked",
                        409,
                    )
                previous_state = read_prose_delivery_state(repo_dir)
                previous_draft_commit = str(metadata.get("draft_commit") or "")
                current_content = _read_draft_from_branch(repo_dir)
                current_etag = _compute_text_etag(current_content)
                if base_etag and base_etag != current_etag:
                    return (
                        jsonify(
                            {
                                "status": "error",
                                "code": "WRITE_CONFLICT",
                                "message": "chapter_draft.md changed after this edit started",
                                "book_id": book_id,
                                "current_etag": current_etag,
                                "base_etag": base_etag,
                            }
                        ),
                        409,
                    )

                _checkout_draft_branch(repo_dir)
                target_path = os.path.join(repo_dir, PROSE_DELIVERY_TARGET_FILE)
                with open(target_path, "w", encoding="utf-8", newline="") as handle:
                    handle.write(content)
                run_git(repo_dir, ["add", "--", PROSE_DELIVERY_TARGET_FILE])
                if run_git(repo_dir, ["status", "--porcelain", "--", PROSE_DELIVERY_TARGET_FILE]).stdout.strip():
                    ensure_repo_identity(repo_dir)
                    try:
                        run_git(repo_dir, ["commit", "-m", "save human-edited chapter draft", "--", PROSE_DELIVERY_TARGET_FILE])
                    except subprocess.CalledProcessError as exc:
                        if not is_nothing_to_commit_error(exc):
                            raise
                next_meta = refresh_draft_metadata(repo_dir, source="human_manual_edit")
                state = build_initial_state(
                    repo_dir,
                    book_id,
                    content,
                    draft_meta=next_meta,
                    source_agent=str((previous_state or {}).get("source_agent") or "continuation"),
                    created_by="human",
                    existing_state=previous_state,
                )
                next_draft_commit = str(next_meta.get("draft_commit") or "")
                state["status"] = "manual_edit_saved"
                state["review_report"] = {
                    **(state.get("review_report") if isinstance(state.get("review_report"), dict) else {}),
                    "status": "stale",
                    "stale": True,
                    "stale_reason": "manual_edit_changed_draft",
                    "draft_commit": next_draft_commit,
                    "previous_draft_commit": previous_draft_commit,
                    "findings": [],
                    "updated_at": _now_utc(),
                }
                state["manual_edit"] = {
                    "dirty": False,
                    "saved": True,
                    "edit_base_commit": previous_draft_commit,
                    "saved_draft_commit": next_draft_commit,
                    "review_required": True,
                    "saved_at": _now_utc(),
                }
                archive_state = state.get("archive_state") if isinstance(state.get("archive_state"), dict) else {}
                archive_state["eligible"] = False
                archive_state["blocked_reason"] = "review_required_after_manual_edit"
                state["archive_state"] = archive_state
                state = write_prose_delivery_state(repo_dir, state)
        return jsonify(_public_state_payload(repo_dir, book_id, state)), 200

    @bp.post("/api/prose_delivery/review_report")
    def review_report():
        payload, err = parse_json_payload(None)
        if err:
            return err
        assert payload is not None
        book_id, book_err = require_book_id(payload)
        if book_err:
            return book_err
        assert book_id is not None
        paths, ready_err = _book_ready(book_id, storage_root)
        if ready_err:
            return ready_err
        assert paths is not None
        repo_dir = paths["book_dir"]

        with _repo_lock(repo_dir) as lock_file:
            with _with_lock(lock_file):
                state = read_prose_delivery_state(repo_dir)
                if not state:
                    return json_error("PROSE_DELIVERY_STATE_NOT_FOUND", "refresh prose delivery state first", 404)
                stale = state_staleness(repo_dir, state)
                if stale.get("stale"):
                    return (
                        jsonify(
                            {
                                "status": "error",
                                "code": "PROSE_DELIVERY_STATE_STALE",
                                "message": "draft metadata changed; refresh state before attaching review",
                                "staleness": stale,
                            }
                        ),
                        409,
                    )
                findings = _normalize_findings(payload.get("findings"))
                review_status = "problem" if any(_finding_is_problem(item) for item in findings) else "passed"
                state["status"] = "review_ready"
                state["review_report"] = {
                    "status": review_status,
                    "stale": False,
                    "draft_commit": state.get("draft_commit") or "",
                    "findings": findings,
                    "summary": str(payload.get("summary") or "").strip(),
                    "updated_at": _now_utc(),
                    "review_is_author_approval": False,
                }
                _apply_review_status_to_spans(state, findings)
                archive_state = state.get("archive_state") if isinstance(state.get("archive_state"), dict) else {}
                archive_state["eligible"] = True
                archive_state["review_gate"] = review_status
                archive_state.pop("blocked_reason", None)
                state["archive_state"] = archive_state
                state = write_prose_delivery_state(repo_dir, state)
        return jsonify(_public_state_payload(repo_dir, book_id, state)), 200

    @bp.post("/api/prose_delivery/rewrite_request")
    def rewrite_request():
        payload, err = parse_json_payload(["finding_id"])
        if err:
            return err
        assert payload is not None
        book_id, book_err = require_book_id(payload)
        if book_err:
            return book_err
        assert book_id is not None
        paths, ready_err = _book_ready(book_id, storage_root)
        if ready_err:
            return ready_err
        assert paths is not None
        repo_dir = paths["book_dir"]
        finding_id = str(payload.get("finding_id") or "").strip()
        if not finding_id:
            return json_error("INVALID_PAYLOAD", "finding_id is required", 400)

        with _repo_lock(repo_dir) as lock_file:
            with _with_lock(lock_file):
                state = read_prose_delivery_state(repo_dir)
                if not state:
                    return json_error("PROSE_DELIVERY_STATE_NOT_FOUND", "refresh prose delivery state first", 404)
                stale = state_staleness(repo_dir, state)
                if stale.get("stale"):
                    return (
                        jsonify(
                            {
                                "status": "error",
                                "code": "PROSE_DELIVERY_STATE_STALE",
                                "message": "draft metadata changed; refresh state before rewrite request",
                                "staleness": stale,
                            }
                        ),
                        409,
                    )
                findings = (state.get("review_report") or {}).get("findings") if isinstance(state.get("review_report"), dict) else []
                finding = next((item for item in findings if isinstance(item, dict) and item.get("id") == finding_id), None)
                if finding is None:
                    return json_error("REVIEW_FINDING_NOT_FOUND", f"review finding not found: {finding_id}", 404)
                chapter_number = finding.get("chapter_number") if isinstance(finding.get("chapter_number"), int) else None
                request_entry = {
                    "id": f"rewrite_{len(state.get('rewrite_requests') or []) + 1:03d}",
                    "finding_id": finding_id,
                    "chapter_number": chapter_number,
                    "status": "requested",
                    "target_file": PROSE_DELIVERY_TARGET_FILE,
                    "prior_draft_commit": state.get("draft_commit") or "",
                    "instruction": str(payload.get("instruction") or finding.get("suggestion") or finding.get("message") or "").strip(),
                    "created_at": _now_utc(),
                    "route_agent_key": "continuation_agent",
                    "no_prose_written_by_backend": True,
                }
                state.setdefault("rewrite_requests", [])
                if not isinstance(state["rewrite_requests"], list):
                    state["rewrite_requests"] = []
                state["rewrite_requests"].append(request_entry)
                state["status"] = "rewrite_requested"
                finding["status"] = "rewrite_requested"
                _mark_author_status(state, chapter_number, "rewrite_requested")
                state = write_prose_delivery_state(repo_dir, state)
        response = _public_state_payload(repo_dir, book_id, state)
        response["rewrite_request"] = request_entry
        return jsonify(response), 200

    @bp.post("/api/prose_delivery/clear")
    def clear_state():
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict):
            return json_error("INVALID_PAYLOAD", "request body must be application/json object", 400)
        book_id, book_err = require_book_id(payload)
        if book_err:
            return book_err
        assert book_id is not None
        paths, ready_err = _book_ready(book_id, storage_root)
        if ready_err:
            return ready_err
        assert paths is not None
        repo_dir = paths["book_dir"]
        with _repo_lock(repo_dir) as lock_file:
            with _with_lock(lock_file):
                delete_prose_delivery_state(repo_dir)
        return jsonify({"status": "success", "book_id": book_id, "state": None}), 200

    return bp
