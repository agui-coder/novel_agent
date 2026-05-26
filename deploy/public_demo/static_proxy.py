from __future__ import annotations

import argparse
import http.client
import mimetypes
import os
import posixpath
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit


PROXY_PREFIXES = (
    "/api/",
    "/api",
    "/books/",
    "/books",
    "/tools/",
    "/tools",
    "/checkout",
)


class StaticProxyHandler(BaseHTTPRequestHandler):
    static_root: Path
    backend_host: str
    backend_port: int

    server_version = "NovelAgentPublicDemo/1.0"

    def do_GET(self) -> None:
        self._dispatch()

    def do_POST(self) -> None:
        self._dispatch()

    def do_PUT(self) -> None:
        self._dispatch()

    def do_PATCH(self) -> None:
        self._dispatch()

    def do_DELETE(self) -> None:
        self._dispatch()

    def do_OPTIONS(self) -> None:
        self._dispatch()

    def _dispatch(self) -> None:
        path = urlsplit(self.path).path
        if any(path == prefix or path.startswith(prefix) for prefix in PROXY_PREFIXES):
            self._proxy_to_backend()
            return
        if self.command not in {"GET", "HEAD"}:
            self.send_error(405, "method not allowed")
            return
        self._serve_static(path)

    def _proxy_to_backend(self) -> None:
        body = b""
        content_length = self.headers.get("Content-Length")
        if content_length:
            body = self.rfile.read(int(content_length))

        headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower() not in {"host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade"}
        }
        headers["Host"] = f"{self.backend_host}:{self.backend_port}"
        headers["X-Forwarded-Host"] = self.headers.get("Host", "")
        headers["X-Forwarded-Proto"] = "http"

        conn = http.client.HTTPConnection(self.backend_host, self.backend_port, timeout=120)
        try:
            conn.request(self.command, self.path, body=body, headers=headers)
            upstream = conn.getresponse()
            data = upstream.read()
        except Exception as exc:
            self.send_error(502, f"backend unavailable: {exc}")
            return
        finally:
            conn.close()

        self.send_response(upstream.status, upstream.reason)
        excluded = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade"}
        for key, value in upstream.getheaders():
            if key.lower() in excluded:
                continue
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _serve_static(self, request_path: str) -> None:
        normalized = posixpath.normpath(request_path.lstrip("/"))
        if normalized in {"", "."}:
            normalized = "bookshelf.html"
        candidate = (self.static_root / normalized).resolve()
        root = self.static_root.resolve()
        if not str(candidate).startswith(str(root)):
            self.send_error(403)
            return
        if candidate.is_dir():
            candidate = candidate / "index.html"
        if not candidate.exists():
            candidate = root / "index.html"
        if not candidate.exists():
            self.send_error(404)
            return

        content_type, _ = mimetypes.guess_type(str(candidate))
        data = candidate.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store" if candidate.name.endswith(".html") else "public, max-age=3600")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"{self.address_string()} - {fmt % args}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve Novel Agent static frontend and proxy API calls to Flask.")
    parser.add_argument("--static-root", default=os.environ.get("NOVEL_AGENT_STATIC_ROOT", "/opt/novel-agent-demo/app/frontend/dist"))
    parser.add_argument("--host", default=os.environ.get("NOVEL_AGENT_FRONTEND_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("NOVEL_AGENT_FRONTEND_PORT", "15173")))
    parser.add_argument("--backend-host", default=os.environ.get("NOVEL_AGENT_BACKEND_HOST", "127.0.0.1"))
    parser.add_argument("--backend-port", type=int, default=int(os.environ.get("NOVEL_AGENT_BACKEND_PORT", "18000")))
    args = parser.parse_args()

    StaticProxyHandler.static_root = Path(args.static_root)
    StaticProxyHandler.backend_host = args.backend_host
    StaticProxyHandler.backend_port = args.backend_port
    server = ThreadingHTTPServer((args.host, args.port), StaticProxyHandler)
    print(
        f"serving {StaticProxyHandler.static_root} on {args.host}:{args.port}, proxy backend {args.backend_host}:{args.backend_port}",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
