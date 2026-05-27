#!/usr/bin/env python3
"""Novel Agent deployment doctor.

This tool is intentionally stdlib-only so it can run from a release ZIP,
a cloned repository, or a small Linux server before project dependencies are
installed.
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import platform
import shutil
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


SECRET_MARKERS = ("KEY", "TOKEN", "SECRET", "PASSWORD", "PASS")
LOCAL_REQUIRED_TOOLS = ("git", "python")
LOCAL_OPTIONAL_TOOLS = ("node", "npm", "docker")
DIFY_AGENT_KEYS = (
    "DIFY_WORLD_MODEL_API_KEY",
    "DIFY_STYLE_GUIDE_API_KEY",
    "DIFY_OUTLINE_API_KEY",
    "DIFY_CONTINUATION_API_KEY",
    "DIFY_REVIEW_API_KEY",
)


@dataclass
class Check:
    name: str
    status: str
    detail: str
    hints: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "status": self.status,
            "detail": self.detail,
            "hints": self.hints,
        }


class Doctor:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.env = load_env(Path(args.env)) if args.env else {}
        self.checks: list[Check] = []

    def add(self, name: str, status: str, detail: str, hints: list[str] | None = None) -> None:
        self.checks.append(Check(name=name, status=status, detail=detail, hints=hints or []))

    def run(self) -> int:
        self.check_host_runtime()
        self.check_env_shape()
        self.check_url_reachability()
        if self.args.profile == "public-demo":
            self.check_public_demo_contract()
        return self.exit_code()

    def exit_code(self) -> int:
        if any(check.status == "fail" for check in self.checks):
            return 1
        if self.args.strict and any(check.status == "warn" for check in self.checks):
            return 2
        return 0

    def check_host_runtime(self) -> None:
        py_version = ".".join(str(part) for part in sys.version_info[:3])
        min_ok = sys.version_info >= (3, 10)
        self.add(
            "python",
            "pass" if min_ok else "fail",
            f"{py_version} on {platform.system()} {platform.release()}",
            [] if min_ok else ["Use Python 3.10+; Python 3.11 is recommended."],
        )

        for tool in LOCAL_REQUIRED_TOOLS:
            found = shutil.which(tool)
            self.add(
                f"tool:{tool}",
                "pass" if found else "fail",
                found or "not found in PATH",
                [] if found else [f"Install {tool} or add it to PATH before deployment."],
            )

        for tool in LOCAL_OPTIONAL_TOOLS:
            found = shutil.which(tool)
            status = "pass" if found else "warn"
            hint = f"{tool} is optional for some routes, but required for frontend build or compose startup."
            self.add(f"tool:{tool}", status, found or "not found in PATH", [] if found else [hint])

    def check_env_shape(self) -> None:
        if not self.args.env:
            self.add("env:file", "warn", "not provided", ["Pass --env deploy/demo/.env for configuration checks."])
            return

        env_path = Path(self.args.env)
        if not env_path.exists():
            self.add("env:file", "fail", str(env_path), ["Copy the matching .env.example first, then fill local secrets outside Git."])
            return

        configured = sorted(key for key, value in self.env.items() if value.strip())
        redacted_names = [key for key in configured if is_secret_name(key)]
        self.add(
            "env:file",
            "pass",
            f"{env_path} loaded; {len(configured)} non-empty keys, {len(redacted_names)} secret-like keys redacted",
        )

        if self.args.profile == "local":
            self.check_local_env()
        else:
            self.check_public_env()

    def check_local_env(self) -> None:
        dify_base = self.env.get("DIFY_BASE_URL") or self.args.dify_url
        self.add(
            "env:local-dify-base",
            "pass" if dify_base else "warn",
            dify_base or "empty",
            [] if dify_base else ["Set DIFY_BASE_URL after importing active Dify apps."],
        )

        missing_agents = [key for key in DIFY_AGENT_KEYS if not self.env.get(key)]
        self.add(
            "env:local-dify-keys",
            "pass" if not missing_agents else "warn",
            "all active agent keys configured" if not missing_agents else "missing: " + ", ".join(missing_agents),
            [] if not missing_agents else ["Local UI can open without these keys, but active Dify agent calls will fail."],
        )

    def check_public_env(self) -> None:
        expected = {
            "PUBLIC_DEMO_MODE": "1",
            "PUBLIC_DEMO_IMPORT_CHAPTER_LIMIT": "25",
            "PUBLIC_DEMO_WORLD_INIT_LIMIT": "1",
        }
        for key, expected_value in expected.items():
            actual = self.env.get(key)
            self.add(
                f"env:{key}",
                "pass" if actual == expected_value else "warn",
                f"{actual or 'empty'} (expected {expected_value})",
                [] if actual == expected_value else ["This is a public-demo guardrail; verify the server env before exposing the demo."],
            )

        ttl = self.env.get("PUBLIC_DEMO_SESSION_TTL_SECONDS")
        ttl_ok = ttl is not None and ttl.isdigit() and int(ttl) <= 1800
        self.add(
            "env:PUBLIC_DEMO_SESSION_TTL_SECONDS",
            "pass" if ttl_ok else "warn",
            ttl or "empty",
            [] if ttl_ok else ["Use a short TTL such as 600 seconds for controlled resume demos."],
        )

    def check_url_reachability(self) -> None:
        if self.args.backend_url:
            backend = normalize_url(self.args.backend_url)
            self.check_tcp("backend:tcp", backend)
            response = request_json(join_url(backend, "/health"), timeout=self.args.timeout)
            if response["ok"] and isinstance(response["json"], dict):
                body = response["json"]
                detail = f"{response['status']} status={body.get('status')} public_demo={body.get('public_demo')}"
                self.add("backend:/health", "pass" if body.get("status") == "ok" else "warn", detail)
            else:
                self.add(
                    "backend:/health",
                    "fail",
                    response["detail"],
                    ["Check backend process, host/port, firewall, or reverse proxy path."],
                )

        if self.args.frontend_url:
            frontend = normalize_url(self.args.frontend_url)
            self.check_tcp("frontend:tcp", frontend)
            page = request_text(join_url(frontend, "/bookshelf.html"), timeout=self.args.timeout)
            self.add(
                "frontend:/bookshelf.html",
                "pass" if page["ok"] else "fail",
                page["detail"],
                [] if page["ok"] else ["Rebuild frontend/dist or restart the Vite/static proxy service."],
            )
            api = request_json(join_url(frontend, "/api/demo/session"), timeout=self.args.timeout)
            self.add(
                "frontend:api-proxy",
                "pass" if api["ok"] else "fail",
                api["detail"],
                [] if api["ok"] else ["The frontend server must proxy /api/* to the Flask backend."],
            )

        dify_url = self.args.dify_url or self.env.get("DIFY_BASE_URL")
        if dify_url:
            dify = normalize_url(dify_url)
            self.check_tcp("dify:tcp", dify, required=self.args.require_dify)
            response = request_text(dify, timeout=self.args.timeout)
            status = response.get("status")
            reachable = response["ok"] or isinstance(status, int)
            if reachable and isinstance(status, int) and status >= 500:
                check_status = "warn"
            elif reachable:
                check_status = "pass"
            else:
                check_status = "warn" if not self.args.require_dify else "fail"
            self.add(
                "dify:http",
                check_status,
                response["detail"],
                [] if check_status == "pass" else ["Verify DIFY_BASE_URL from the process that calls Dify; container localhost is usually not the host."],
            )
        elif self.args.require_dify:
            self.add("dify:http", "fail", "no --dify-url provided", ["Pass --dify-url or set DIFY_BASE_URL in --env."])

    def check_tcp(self, name: str, url: str, *, required: bool = True) -> None:
        parsed = urllib.parse.urlparse(url)
        host = parsed.hostname
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        if not host:
            self.add(name, "fail", f"invalid URL: {url}")
            return
        try:
            with socket.create_connection((host, port), timeout=self.args.timeout):
                self.add(name, "pass", f"{host}:{port}")
        except OSError as exc:
            status = "fail" if required else "warn"
            self.add(name, status, f"{host}:{port} {exc}", ["Check process bind address, firewall, security group, and port conflicts."])

    def check_public_demo_contract(self) -> None:
        base_url = self.args.frontend_url or self.args.backend_url
        if not base_url:
            self.add("public-demo:entrypoint", "fail", "no frontend/backend URL", ["Pass --frontend-url for the public demo entrypoint."])
            return

        base_url = normalize_url(base_url)
        opener = cookie_opener()
        session = opener_json(opener, join_url(base_url, "/api/demo/session"), timeout=self.args.timeout)
        body = session.get("json") if session["ok"] else None
        enabled = isinstance(body, dict) and bool(body.get("enabled"))
        session_id = body.get("session_id") if isinstance(body, dict) else None
        self.add(
            "public-demo:session",
            "pass" if enabled and session_id else "fail",
            session["detail"],
            [] if enabled and session_id else ["PUBLIC_DEMO_MODE must be enabled and /api/demo/session must set a visitor cookie."],
        )
        if not enabled:
            return

        config_write = opener_json(
            opener,
            join_url(base_url, "/api/runtime/config"),
            method="POST",
            payload={"values": {}},
            timeout=self.args.timeout,
        )
        readonly = config_write.get("status") == 403
        self.add(
            "public-demo:config-readonly",
            "pass" if readonly else "fail",
            config_write["detail"],
            [] if readonly else ["Public demos must not expose runtime configuration writes."],
        )

        book_id = self.args.public_book_id or self.find_public_demo_book(opener, base_url)
        if not book_id:
            self.add(
                "public-demo:book",
                "warn",
                "no demo book found",
                ["Open the bookshelf once or configure PUBLIC_DEMO_TEMPLATE_BOOK_ID so a session book is materialized."],
            )
            return

        no_cookie = cookie_opener()
        callback_url = join_url(base_url, "/books/ping") + "?" + urllib.parse.urlencode({"book_id": book_id})
        callback = opener_json(no_cookie, callback_url, timeout=self.args.timeout)
        callback_body = callback.get("json") if callback["ok"] else None
        same_book = isinstance(callback_body, dict) and callback_body.get("book_id") == book_id
        self.add(
            "public-demo:dify-callback-without-cookie",
            "pass" if same_book else "fail",
            callback["detail"],
            [] if same_book else ["Dify tool callbacks do not carry the browser cookie; valid demo_<sid>_<book> IDs must bind back to the live session."],
        )

        conflict_url = join_url(base_url, "/books/ping") + "?" + urllib.parse.urlencode(
            {"book_id": book_id, "book_name": "__doctor_conflict_probe__"}
        )
        conflict = opener_json(no_cookie, conflict_url, timeout=self.args.timeout)
        conflict_body = conflict.get("json") if conflict["ok"] else None
        book_id_wins = isinstance(conflict_body, dict) and conflict_body.get("book_id") == book_id
        self.add(
            "public-demo:book-id-priority",
            "pass" if book_id_wins else "fail",
            conflict["detail"],
            [] if book_id_wins else ["Tool callbacks should prefer explicit book_id over book_name to avoid cross-session writes."],
        )

    def find_public_demo_book(self, opener: urllib.request.OpenerDirector, base_url: str) -> str | None:
        books = opener_json(opener, join_url(base_url, "/books/list"), timeout=self.args.timeout)
        body = books.get("json") if books["ok"] else None
        if not isinstance(body, dict):
            return None
        for book in body.get("books") or []:
            book_id = book.get("book_id") if isinstance(book, dict) else None
            if isinstance(book_id, str) and book_id.startswith("demo_"):
                self.add("public-demo:book-list", "pass", f"found {book_id}")
                return book_id
        self.add("public-demo:book-list", "warn", books["detail"])
        return None


def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def is_secret_name(name: str) -> bool:
    upper = name.upper()
    return any(marker in upper for marker in SECRET_MARKERS)


def normalize_url(url: str) -> str:
    value = url.strip().rstrip("/")
    if not urllib.parse.urlparse(value).scheme:
        value = "http://" + value
    return value


def join_url(base: str, path: str) -> str:
    return normalize_url(base) + "/" + path.lstrip("/")


def request_text(url: str, *, timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={"User-Agent": "novel-agent-deploy-doctor/1.0"})
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            elapsed = int((time.perf_counter() - started) * 1000)
            body = response.read(512).decode("utf-8", errors="replace")
            return {"ok": True, "status": response.status, "detail": f"{response.status} in {elapsed}ms", "text": body}
    except urllib.error.HTTPError as exc:
        elapsed = int((time.perf_counter() - started) * 1000)
        return {"ok": False, "status": exc.code, "detail": f"HTTP {exc.code} in {elapsed}ms"}
    except urllib.error.URLError as exc:
        return {"ok": False, "status": None, "detail": str(exc.reason)}


def request_json(url: str, *, timeout: float) -> dict[str, Any]:
    response = request_text_full(url, timeout=timeout)
    if not response["ok"]:
        return response
    try:
        response["json"] = json.loads(response.get("text") or "{}")
    except json.JSONDecodeError:
        response["ok"] = False
        response["detail"] = response["detail"] + "; response was not JSON"
    return response


def request_text_full(url: str, *, timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={"User-Agent": "novel-agent-deploy-doctor/1.0"})
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            elapsed = int((time.perf_counter() - started) * 1000)
            body = response.read().decode("utf-8", errors="replace")
            return {"ok": True, "status": response.status, "detail": f"{response.status} in {elapsed}ms", "text": body}
    except urllib.error.HTTPError as exc:
        elapsed = int((time.perf_counter() - started) * 1000)
        body = exc.read().decode("utf-8", errors="replace")
        return {"ok": False, "status": exc.code, "detail": f"HTTP {exc.code} in {elapsed}ms", "text": body}
    except urllib.error.URLError as exc:
        return {"ok": False, "status": None, "detail": str(exc.reason), "text": ""}


def cookie_opener() -> urllib.request.OpenerDirector:
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def opener_json(
    opener: urllib.request.OpenerDirector,
    url: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    timeout: float,
) -> dict[str, Any]:
    data = None
    headers = {"User-Agent": "novel-agent-deploy-doctor/1.0"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    started = time.perf_counter()
    try:
        with opener.open(request, timeout=timeout) as response:
            elapsed = int((time.perf_counter() - started) * 1000)
            text = response.read().decode("utf-8", errors="replace")
            result = {"ok": True, "status": response.status, "detail": f"{response.status} in {elapsed}ms", "text": text}
    except urllib.error.HTTPError as exc:
        elapsed = int((time.perf_counter() - started) * 1000)
        text = exc.read().decode("utf-8", errors="replace")
        result = {"ok": 200 <= exc.code < 500, "status": exc.code, "detail": f"HTTP {exc.code} in {elapsed}ms", "text": text}
    except urllib.error.URLError as exc:
        return {"ok": False, "status": None, "detail": str(exc.reason), "text": ""}
    try:
        result["json"] = json.loads(result["text"] or "{}")
    except json.JSONDecodeError:
        result["ok"] = False
        result["detail"] = result["detail"] + "; response was not JSON"
    return result


def print_report(checks: list[Check], *, as_json: bool) -> None:
    if as_json:
        print(json.dumps({"checks": [check.as_dict() for check in checks]}, ensure_ascii=False, indent=2))
        return
    width = max([len(check.name) for check in checks] + [10])
    for check in checks:
        marker = {"pass": "PASS", "warn": "WARN", "fail": "FAIL"}.get(check.status, check.status.upper())
        print(f"{marker:<4} {check.name:<{width}} {check.detail}")
        for hint in check.hints:
            print(f"     hint: {hint}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Check Novel Agent local or public-demo deployment readiness.")
    parser.add_argument("--profile", choices=("local", "public-demo"), default="local", help="Deployment profile to validate.")
    parser.add_argument("--env", help="Path to deploy/demo/.env or /etc/novel-agent-demo.env.")
    parser.add_argument("--backend-url", help="Backend base URL, for example http://127.0.0.1:8000.")
    parser.add_argument("--frontend-url", help="Frontend or static-proxy base URL, for example http://127.0.0.1:5173.")
    parser.add_argument("--dify-url", help="Dify API/base URL reachable from this machine.")
    parser.add_argument("--require-dify", action="store_true", help="Treat Dify HTTP reachability as required.")
    parser.add_argument("--public-book-id", help="Existing demo_<session>_<book> id to probe public-demo callback binding.")
    parser.add_argument("--timeout", type=float, default=5.0, help="HTTP/TCP timeout in seconds.")
    parser.add_argument("--strict", action="store_true", help="Exit non-zero for warnings as well as failures.")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON.")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    doctor = Doctor(args)
    code = doctor.run()
    print_report(doctor.checks, as_json=args.json)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
