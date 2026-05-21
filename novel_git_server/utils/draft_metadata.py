import json
import os
import subprocess
from datetime import datetime, timezone
from typing import Any

from utils.git_utils import run_git


DRAFT_BRANCH_NAME = "draft/sandbox"
LEGACY_DRAFT_BRANCH_NAME = "draft/world_model"
DRAFT_META_DIR = ".loregit"
DRAFT_META_FILE_NAME = "draft_meta.json"
DRAFT_META_REL_PATH = f"{DRAFT_META_DIR}/{DRAFT_META_FILE_NAME}"
DRAFT_META_SCHEMA_VERSION = 1
RESERVED_DRAFT_BRANCHES = {DRAFT_BRANCH_NAME, LEGACY_DRAFT_BRANCH_NAME}


def _now_utc() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _metadata_path(repo_dir: str) -> str:
    return os.path.join(repo_dir, DRAFT_META_DIR, DRAFT_META_FILE_NAME)


def _ensure_local_git_exclude(repo_dir: str) -> None:
    exclude_path = os.path.join(repo_dir, ".git", "info", "exclude")
    if not os.path.exists(os.path.dirname(exclude_path)):
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


def _list_local_heads(repo_dir: str) -> list[str]:
    try:
        output = run_git(repo_dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).stdout
    except subprocess.CalledProcessError:
        return []
    return [line.strip() for line in output.splitlines() if line.strip()]


def _branch_head_commit(repo_dir: str, branch_name: str) -> str | None:
    try:
        return run_git(repo_dir, ["rev-parse", "--verify", f"{branch_name}^{{commit}}"]).stdout.strip()
    except subprocess.CalledProcessError:
        return None


def _merge_base(repo_dir: str, left_ref: str, right_ref: str) -> str | None:
    try:
        return run_git(repo_dir, ["merge-base", left_ref, right_ref]).stdout.strip()
    except subprocess.CalledProcessError:
        return None


def _diff_name_count(repo_dir: str, base_ref: str, draft_ref: str) -> int:
    try:
        output = run_git(repo_dir, ["diff", "--name-only", base_ref, draft_ref]).stdout
    except subprocess.CalledProcessError:
        return 10**9
    return len([line for line in output.splitlines() if line.strip()])


def _commit_distance(repo_dir: str, base_ref: str, draft_ref: str) -> int:
    try:
        return int(run_git(repo_dir, ["rev-list", "--count", f"{base_ref}..{draft_ref}"]).stdout.strip() or "0")
    except (subprocess.CalledProcessError, ValueError):
        return 10**9


def read_draft_metadata(repo_dir: str) -> dict[str, Any] | None:
    _ensure_local_git_exclude(repo_dir)
    path = _metadata_path(repo_dir)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def write_draft_metadata(
    repo_dir: str,
    *,
    base_branch: str,
    draft_branch: str = DRAFT_BRANCH_NAME,
    source: str = "explicit",
    base_commit: str | None = None,
    draft_commit: str | None = None,
) -> dict[str, Any]:
    base_commit = base_commit or _branch_head_commit(repo_dir, base_branch) or ""
    draft_commit = draft_commit or _branch_head_commit(repo_dir, draft_branch) or ""
    existing = read_draft_metadata(repo_dir) or {}
    now = _now_utc()
    metadata = {
        "schema_version": DRAFT_META_SCHEMA_VERSION,
        "draft_branch": draft_branch,
        "base_branch": base_branch,
        "base_commit": base_commit,
        "draft_commit": draft_commit,
        "source": source,
        "created_at": existing.get("created_at") if isinstance(existing.get("created_at"), str) else now,
        "updated_at": now,
    }
    _ensure_local_git_exclude(repo_dir)
    meta_dir = os.path.join(repo_dir, DRAFT_META_DIR)
    os.makedirs(meta_dir, exist_ok=True)
    with open(_metadata_path(repo_dir), "w", encoding="utf-8", newline="") as handle:
        json.dump(metadata, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return metadata


def delete_draft_metadata(repo_dir: str) -> None:
    path = _metadata_path(repo_dir)
    try:
        if os.path.exists(path):
            os.remove(path)
        meta_dir = os.path.dirname(path)
        if os.path.isdir(meta_dir) and not os.listdir(meta_dir):
            os.rmdir(meta_dir)
    except OSError:
        return


def _normalize_valid_metadata(repo_dir: str, metadata: dict[str, Any]) -> dict[str, Any] | None:
    draft_branch = metadata.get("draft_branch") if isinstance(metadata.get("draft_branch"), str) else DRAFT_BRANCH_NAME
    base_branch = metadata.get("base_branch")
    if not isinstance(base_branch, str) or not base_branch.strip():
        return None
    base_branch = base_branch.strip()
    draft_branch = draft_branch.strip() or DRAFT_BRANCH_NAME
    if not _branch_head_commit(repo_dir, draft_branch):
        return None
    if not _branch_head_commit(repo_dir, base_branch):
        return None

    base_commit = metadata.get("base_commit") if isinstance(metadata.get("base_commit"), str) else ""
    draft_commit = metadata.get("draft_commit") if isinstance(metadata.get("draft_commit"), str) else ""
    source = metadata.get("source") if isinstance(metadata.get("source"), str) else "metadata"
    return {
        **metadata,
        "schema_version": DRAFT_META_SCHEMA_VERSION,
        "draft_branch": draft_branch,
        "base_branch": base_branch,
        "base_commit": base_commit or (_branch_head_commit(repo_dir, base_branch) or ""),
        "draft_commit": draft_commit or (_branch_head_commit(repo_dir, draft_branch) or ""),
        "source": source,
        "status": "success",
    }


def _infer_branch_from_stored_base_commit(repo_dir: str, metadata: dict[str, Any]) -> dict[str, Any] | None:
    base_commit = metadata.get("base_commit")
    if not isinstance(base_commit, str) or not base_commit.strip():
        return None
    matches = [
        branch
        for branch in _list_local_heads(repo_dir)
        if branch not in RESERVED_DRAFT_BRANCHES and _branch_head_commit(repo_dir, branch) == base_commit.strip()
    ]
    if len(matches) != 1:
        return None
    return write_draft_metadata(
        repo_dir,
        base_branch=matches[0],
        draft_branch=str(metadata.get("draft_branch") or DRAFT_BRANCH_NAME),
        source="renamed_from_base_commit",
        base_commit=base_commit.strip(),
    )


def infer_draft_base_branch(repo_dir: str, *, draft_branch: str = DRAFT_BRANCH_NAME) -> dict[str, Any]:
    draft_commit = _branch_head_commit(repo_dir, draft_branch)
    if not draft_commit:
        return {
            "status": "missing",
            "code": "DRAFT_BRANCH_NOT_FOUND",
            "draft_branch": draft_branch,
            "candidates": [],
        }

    candidates: list[dict[str, Any]] = []
    for branch in _list_local_heads(repo_dir):
        if branch in RESERVED_DRAFT_BRANCHES:
            continue
        branch_head = _branch_head_commit(repo_dir, branch)
        if not branch_head:
            continue
        merge_base = _merge_base(repo_dir, branch, draft_branch)
        if not merge_base:
            continue
        is_branch_head_ancestor = merge_base == branch_head
        candidates.append(
            {
                "branch": branch,
                "head_commit": branch_head,
                "merge_base": merge_base,
                "ancestor_rank": 0 if is_branch_head_ancestor else 1,
                "diff_name_count": _diff_name_count(repo_dir, branch, draft_branch),
                "commit_distance": _commit_distance(repo_dir, branch, draft_branch),
            }
        )

    if not candidates:
        return {
            "status": "unresolved",
            "code": "DRAFT_BASE_BRANCH_UNRESOLVED",
            "draft_branch": draft_branch,
            "draft_commit": draft_commit,
            "candidates": [],
        }

    candidates.sort(key=lambda row: (row["ancestor_rank"], row["diff_name_count"], row["commit_distance"], row["branch"]))
    best = candidates[0]
    best_key = (best["ancestor_rank"], best["diff_name_count"], best["commit_distance"])
    tied = [row for row in candidates if (row["ancestor_rank"], row["diff_name_count"], row["commit_distance"]) == best_key]
    if len(tied) > 1:
        return {
            "status": "ambiguous",
            "code": "DRAFT_BASE_BRANCH_AMBIGUOUS",
            "draft_branch": draft_branch,
            "draft_commit": draft_commit,
            "candidates": tied,
        }

    return {
        "status": "success",
        "draft_branch": draft_branch,
        "draft_commit": draft_commit,
        "base_branch": best["branch"],
        "base_commit": best["head_commit"],
        "source": "inferred",
        "candidates": candidates,
    }


def resolve_draft_metadata(
    repo_dir: str,
    *,
    allow_infer: bool = True,
    write_inferred: bool = False,
    draft_branch: str = DRAFT_BRANCH_NAME,
) -> dict[str, Any]:
    existing = read_draft_metadata(repo_dir)
    if existing is not None:
        normalized = _normalize_valid_metadata(repo_dir, existing)
        if normalized is not None:
            current_draft_commit = _branch_head_commit(repo_dir, normalized["draft_branch"]) or ""
            if current_draft_commit and current_draft_commit != normalized.get("draft_commit"):
                return write_draft_metadata(
                    repo_dir,
                    base_branch=normalized["base_branch"],
                    draft_branch=normalized["draft_branch"],
                    source=str(normalized.get("source") or "metadata"),
                    base_commit=str(normalized.get("base_commit") or ""),
                    draft_commit=current_draft_commit,
                ) | {"status": "success"}
            return normalized

        renamed = _infer_branch_from_stored_base_commit(repo_dir, existing)
        if renamed is not None:
            return {**renamed, "status": "success"}

    if not allow_infer:
        return {
            "status": "missing",
            "code": "DRAFT_METADATA_MISSING",
            "draft_branch": draft_branch,
            "candidates": [],
        }

    inferred = infer_draft_base_branch(repo_dir, draft_branch=draft_branch)
    if inferred.get("status") == "success" and write_inferred:
        return {
            **write_draft_metadata(
                repo_dir,
                base_branch=str(inferred["base_branch"]),
                draft_branch=draft_branch,
                source="inferred",
                base_commit=str(inferred.get("base_commit") or ""),
                draft_commit=str(inferred.get("draft_commit") or ""),
            ),
            "status": "success",
            "candidates": inferred.get("candidates", []),
        }
    return inferred


def refresh_draft_metadata(repo_dir: str, *, source: str | None = None) -> dict[str, Any]:
    resolved = resolve_draft_metadata(repo_dir, allow_infer=True, write_inferred=True)
    if resolved.get("status") != "success":
        return resolved
    return {
        **write_draft_metadata(
            repo_dir,
            base_branch=str(resolved["base_branch"]),
            draft_branch=str(resolved.get("draft_branch") or DRAFT_BRANCH_NAME),
            source=source or str(resolved.get("source") or "metadata"),
            base_commit=str(resolved.get("base_commit") or ""),
        ),
        "status": "success",
    }


def update_draft_metadata_base_branch(repo_dir: str, *, old_name: str, new_name: str) -> dict[str, Any] | None:
    metadata = read_draft_metadata(repo_dir)
    if not metadata or metadata.get("base_branch") != old_name:
        return None
    return write_draft_metadata(
        repo_dir,
        base_branch=new_name,
        draft_branch=str(metadata.get("draft_branch") or DRAFT_BRANCH_NAME),
        source="branch_renamed",
        base_commit=str(metadata.get("base_commit") or ""),
        draft_commit=str(metadata.get("draft_commit") or ""),
    )
