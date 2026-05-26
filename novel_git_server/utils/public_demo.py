from __future__ import annotations

import json
import os
import re
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from secrets import token_hex
from typing import Any

from flask import Request, g

from utils.book_storage import get_book_metadata, validate_book_id


DEMO_COOKIE_NAME = "novel_agent_demo_session"
SESSION_ID_RE = re.compile(r"^[a-f0-9]{16}$")


def env_flag(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).strip().lower() in {"1", "true", "yes", "on"}


def public_demo_enabled() -> bool:
    return env_flag("PUBLIC_DEMO_MODE")


def public_demo_config() -> dict[str, Any]:
    return {
        "enabled": public_demo_enabled(),
        "template_book_id": os.environ.get("PUBLIC_DEMO_TEMPLATE_BOOK_ID", "").strip(),
        "session_ttl_seconds": _coerce_int(os.environ.get("PUBLIC_DEMO_SESSION_TTL_SECONDS"), 600),
        "import_chapter_limit": _coerce_int(os.environ.get("PUBLIC_DEMO_IMPORT_CHAPTER_LIMIT"), 25),
        "world_init_limit": _coerce_int(os.environ.get("PUBLIC_DEMO_WORLD_INIT_LIMIT"), 1),
    }


def _coerce_int(value: Any, default: int) -> int:
    try:
        parsed = int(str(value).strip())
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


@dataclass(frozen=True)
class DemoSession:
    session_id: str
    created_at: int
    expires_at: int
    state_path: Path
    state: dict[str, Any]
    is_new: bool = False

    @property
    def remaining_seconds(self) -> int:
        return max(0, self.expires_at - int(time.time()))


class PublicDemoManager:
    def __init__(
        self,
        *,
        storage_root: str,
        template_book_id: str,
        ttl_seconds: int = 600,
        import_chapter_limit: int = 25,
        world_init_limit: int = 1,
    ) -> None:
        self.storage_root = Path(storage_root).resolve()
        self.template_book_id = template_book_id.strip()
        self.ttl_seconds = max(60, int(ttl_seconds))
        self.import_chapter_limit = max(1, int(import_chapter_limit))
        self.world_init_limit = max(1, int(world_init_limit))
        self.session_root = self.storage_root / ".demo_sessions"
        self.session_root.mkdir(parents=True, exist_ok=True)
        self._last_cleanup = 0

    @classmethod
    def from_env(cls, storage_root: str) -> "PublicDemoManager | None":
        config = public_demo_config()
        if not config["enabled"]:
            return None
        return cls(
            storage_root=storage_root,
            template_book_id=config["template_book_id"],
            ttl_seconds=config["session_ttl_seconds"],
            import_chapter_limit=config["import_chapter_limit"],
            world_init_limit=config["world_init_limit"],
        )

    def get_or_create_session(self, request: Request) -> DemoSession:
        now = int(time.time())
        if now - self._last_cleanup >= 60:
            self.cleanup_expired(now=now)
            self._last_cleanup = now

        cookie_sid = request.cookies.get(DEMO_COOKIE_NAME, "").strip()
        if SESSION_ID_RE.fullmatch(cookie_sid):
            session = self._load_session(cookie_sid, now=now)
            if session is not None:
                g.public_demo_session = session
                return session

        session = self._create_session(now=now)
        g.public_demo_session = session
        g.public_demo_set_cookie = True
        return session

    def current_session(self) -> DemoSession:
        session = getattr(g, "public_demo_session", None)
        if isinstance(session, DemoSession):
            return session
        raise RuntimeError("public demo session has not been initialized for this request")

    def should_set_cookie(self) -> bool:
        return bool(getattr(g, "public_demo_set_cookie", False))

    def map_book_id(self, raw_book_id: Any) -> str:
        source_book_id = validate_book_id(str(raw_book_id or "").strip())
        session = self.current_session()
        prefix = f"demo_{session.session_id}_"
        if source_book_id.startswith(prefix):
            return source_book_id
        if source_book_id.startswith("demo_"):
            raise PermissionError("this demo session cannot access another session book")
        return self.session_book_id(source_book_id, session=session)

    def session_book_id(self, source_book_id: str, *, session: DemoSession | None = None) -> str:
        safe_source = validate_book_id(source_book_id)
        current = session or self.current_session()
        return validate_book_id(f"demo_{current.session_id}_{safe_source}"[:64])

    def is_session_book_id(self, book_id: str, *, session: DemoSession | None = None) -> bool:
        current = session or self.current_session()
        return str(book_id).startswith(f"demo_{current.session_id}_")

    def ensure_template_book_for_session(self) -> str | None:
        if not self.template_book_id:
            return None
        session = self.current_session()
        target_book_id = self.session_book_id(self.template_book_id, session=session)
        target_dir = self.storage_root / target_book_id
        if target_dir.exists():
            return target_book_id

        source_dir = self.storage_root / validate_book_id(self.template_book_id)
        if not source_dir.is_dir():
            return None

        shutil.copytree(
            source_dir,
            target_dir,
            ignore=shutil.ignore_patterns(".runtime", ".locks", ".loregit", "sessions", ".sessions", "conversations", ".conversations"),
        )
        self._rewrite_metadata_book_id(target_book_id, target_dir)
        return target_book_id

    def note_imported_book(self, original_book_id: str, imported_book_id: str) -> None:
        session = self.current_session()
        state = dict(session.state)
        imported = dict(state.get("imported_books") or {})
        imported[original_book_id] = imported_book_id
        state["imported_books"] = imported
        self._write_state(session.state_path, state)
        g.public_demo_session = DemoSession(
            session_id=session.session_id,
            created_at=session.created_at,
            expires_at=session.expires_at,
            state_path=session.state_path,
            state=state,
            is_new=session.is_new,
        )

    def record_world_init_once(self, book_id: str) -> tuple[bool, dict[str, Any]]:
        session = self.current_session()
        mapped_book_id = self.map_book_id(book_id)
        state = dict(session.state)
        world_runs = int(state.get("world_init_runs") or 0)
        if world_runs >= self.world_init_limit:
            return False, {
                "status": "error",
                "code": "PUBLIC_DEMO_WORLD_INIT_LIMIT",
                "message": "体验版每个临时会话只允许初始化一次世界观。完整版本请自行部署后使用。",
                "book_id": mapped_book_id,
                "world_init_limit": self.world_init_limit,
            }
        world_runs += 1
        state["world_init_runs"] = world_runs
        state["last_world_init_book_id"] = mapped_book_id
        self._write_state(session.state_path, state)
        g.public_demo_session = DemoSession(
            session_id=session.session_id,
            created_at=session.created_at,
            expires_at=session.expires_at,
            state_path=session.state_path,
            state=state,
            is_new=session.is_new,
        )
        return True, {
            "book_id": mapped_book_id,
            "world_init_runs": world_runs,
            "world_init_remaining": max(0, self.world_init_limit - world_runs),
        }

    def filter_visible_books(self, books: list[dict[str, Any]]) -> list[dict[str, Any]]:
        session = self.current_session()
        self.ensure_template_book_for_session()
        visible: list[dict[str, Any]] = []
        for row in books:
            book_id = str(row.get("book_id") or "")
            if self.is_session_book_id(book_id, session=session):
                visible.append(row)
        return visible

    def session_payload(self) -> dict[str, Any]:
        session = self.current_session()
        template_book_id = self.ensure_template_book_for_session()
        return {
            "enabled": True,
            "session_id": session.session_id,
            "expires_at": session.expires_at,
            "remaining_seconds": session.remaining_seconds,
            "template_book_id": template_book_id,
            "import_chapter_limit": self.import_chapter_limit,
            "world_init_limit": self.world_init_limit,
            "world_init_used": int(session.state.get("world_init_runs") or 0),
            "message": "这是 10 分钟临时体验版。数据会自动清理；完整版本请从 GitHub 自行部署。",
        }

    def cleanup_expired(self, *, now: int | None = None) -> int:
        current = now or int(time.time())
        removed = 0
        for state_path in self.session_root.glob("*.json"):
            try:
                state = json.loads(state_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            expires_at = int(state.get("expires_at") or 0)
            session_id = str(state.get("session_id") or state_path.stem)
            if expires_at > current:
                continue
            self._remove_session_books(session_id)
            try:
                state_path.unlink()
            except OSError:
                pass
            removed += 1
        return removed

    def _load_session(self, session_id: str, *, now: int) -> DemoSession | None:
        state_path = self.session_root / f"{session_id}.json"
        if not state_path.exists():
            return None
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        expires_at = int(state.get("expires_at") or 0)
        if expires_at <= now:
            self._remove_session_books(session_id)
            try:
                state_path.unlink()
            except OSError:
                pass
            return None
        created_at = int(state.get("created_at") or now)
        return DemoSession(session_id=session_id, created_at=created_at, expires_at=expires_at, state_path=state_path, state=state)

    def _create_session(self, *, now: int) -> DemoSession:
        session_id = token_hex(8)
        while (self.session_root / f"{session_id}.json").exists():
            session_id = token_hex(8)
        state_path = self.session_root / f"{session_id}.json"
        state = {
            "session_id": session_id,
            "created_at": now,
            "expires_at": now + self.ttl_seconds,
            "world_init_runs": 0,
            "imported_books": {},
        }
        self._write_state(state_path, state)
        return DemoSession(session_id=session_id, created_at=now, expires_at=now + self.ttl_seconds, state_path=state_path, state=state, is_new=True)

    def _write_state(self, state_path: Path, state: dict[str, Any]) -> None:
        state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = state_path.with_suffix(f".{os.getpid()}.tmp")
        tmp_path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp_path, state_path)

    def _remove_session_books(self, session_id: str) -> None:
        prefix = f"demo_{session_id}_"
        for path in self.storage_root.iterdir() if self.storage_root.exists() else []:
            if path.is_dir() and path.name.startswith(prefix):
                shutil.rmtree(path, ignore_errors=True)

    def _rewrite_metadata_book_id(self, book_id: str, book_dir: Path) -> None:
        metadata_path = book_dir / "metadata.json"
        try:
            metadata = get_book_metadata(book_id, str(self.storage_root))
        except Exception:
            metadata = {"book_id": book_id, "book_name": book_id, "updated_at": ""}
        metadata["book_id"] = book_id
        try:
            metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        except OSError:
            pass
