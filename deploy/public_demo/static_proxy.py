from __future__ import annotations

import argparse
import gzip
import http.client
import mimetypes
import os
import posixpath
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from threading import Lock
from urllib.parse import urlsplit


PROXY_EXACT_PATHS = {"/api", "/books", "/tools", "/checkout"}
PROXY_PREFIXES = ("/api/", "/books/", "/tools/")
HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
}
STREAMING_CONTENT_TYPES = (
    "text/event-stream",
    "application/x-ndjson",
    "application/stream+json",
)
CHUNK_SIZE = 64 * 1024
MIN_GZIP_SIZE = 1024
STATIC_CACHE_MAX_BYTES = 8 * 1024 * 1024
COMPRESSIBLE_CONTENT_TYPES = {
    "application/javascript",
    "application/json",
    "application/manifest+json",
    "application/xml",
    "image/svg+xml",
    "text/css",
    "text/html",
    "text/javascript",
    "text/plain",
    "text/xml",
}
ALREADY_COMPRESSED_EXTENSIONS = {
    ".br",
    ".gz",
    ".gif",
    ".jpg",
    ".jpeg",
    ".mp3",
    ".mp4",
    ".png",
    ".webm",
    ".webp",
    ".zip",
}
STATIC_CACHE: dict[str, tuple[int, int, bytes, str]] = {}
STATIC_CACHE_LOCK = Lock()


def should_proxy_path(path: str) -> bool:
    return path in PROXY_EXACT_PATHS or any(path.startswith(prefix) for prefix in PROXY_PREFIXES)


def is_streaming_content_type(content_type: str | None) -> bool:
    normalized = (content_type or "").split(";", 1)[0].strip().lower()
    return normalized in STREAMING_CONTENT_TYPES


def accepts_gzip(accept_encoding: str | None) -> bool:
    if not accept_encoding:
        return False
    return any(part.strip().lower().split(";", 1)[0] == "gzip" for part in accept_encoding.split(","))


def is_compressible_content_type(content_type: str | None) -> bool:
    normalized = (content_type or "").split(";", 1)[0].strip().lower()
    return normalized in COMPRESSIBLE_CONTENT_TYPES or normalized.endswith("+json")


def should_gzip_response(
    *,
    accept_encoding: str | None,
    content_type: str | None,
    body_size: int,
    file_suffix: str = "",
    existing_content_encoding: str | None = None,
) -> bool:
    if not accepts_gzip(accept_encoding):
        return False
    if existing_content_encoding:
        return False
    if body_size < MIN_GZIP_SIZE:
        return False
    if file_suffix.lower() in ALREADY_COMPRESSED_EXTENSIONS:
        return False
    if is_streaming_content_type(content_type):
        return False
    return is_compressible_content_type(content_type)


def gzip_body(data: bytes) -> bytes:
    return gzip.compress(data, compresslevel=6)


class StaticProxyHandler(BaseHTTPRequestHandler):
    static_root: Path
    backend_host: str
    backend_port: int

    server_version = "NovelAgentPublicDemo/1.0"

    def do_GET(self) -> None:
        self._dispatch()

    def do_HEAD(self) -> None:
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
        if should_proxy_path(path):
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
            if key.lower() not in HOP_BY_HOP_HEADERS | {"host", "accept-encoding"}
        }
        headers["Host"] = f"{self.backend_host}:{self.backend_port}"
        headers["X-Forwarded-Host"] = self.headers.get("Host", "")
        headers["X-Forwarded-Proto"] = "http"
        headers["Accept-Encoding"] = "identity"

        conn = http.client.HTTPConnection(self.backend_host, self.backend_port, timeout=120)
        try:
            conn.request(self.command, self.path, body=body, headers=headers)
            upstream = conn.getresponse()
        except Exception as exc:
            self.send_error(502, f"backend unavailable: {exc}")
            conn.close()
            return

        is_streaming = is_streaming_content_type(upstream.getheader("Content-Type"))
        try:
            if self.command != "HEAD":
                if is_streaming:
                    self.send_response(upstream.status, upstream.reason)
                    for key, value in upstream.getheaders():
                        if key.lower() in HOP_BY_HOP_HEADERS | {"content-length"}:
                            continue
                        self.send_header(key, value)
                    self.send_header("X-Accel-Buffering", "no")
                    self.end_headers()
                    while True:
                        chunk = upstream.readline()
                        if not chunk:
                            break
                        try:
                            self.wfile.write(chunk)
                            self.wfile.flush()
                        except (BrokenPipeError, ConnectionResetError, TimeoutError):
                            break
                else:
                    data = upstream.read()
                    self._send_buffered_upstream_response(upstream, data)
            else:
                self._send_head_upstream_response(upstream, is_streaming=is_streaming)
        finally:
            conn.close()

    def _send_head_upstream_response(self, upstream: http.client.HTTPResponse, *, is_streaming: bool) -> None:
        self.send_response(upstream.status, upstream.reason)
        excluded = HOP_BY_HOP_HEADERS | ({"content-length"} if is_streaming else set())
        for key, value in upstream.getheaders():
            if key.lower() in excluded:
                continue
            self.send_header(key, value)
        if is_streaming:
            self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

    def _send_buffered_upstream_response(self, upstream: http.client.HTTPResponse, data: bytes) -> None:
        content_type = upstream.getheader("Content-Type") or "application/octet-stream"
        should_gzip = should_gzip_response(
            accept_encoding=self.headers.get("Accept-Encoding"),
            content_type=content_type,
            body_size=len(data),
            existing_content_encoding=upstream.getheader("Content-Encoding"),
        )
        response_data = gzip_body(data) if should_gzip else data

        self.send_response(upstream.status, upstream.reason)
        excluded = HOP_BY_HOP_HEADERS | {"content-length"}
        if should_gzip:
            excluded.add("content-encoding")
        for key, value in upstream.getheaders():
            if key.lower() in excluded:
                continue
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(response_data)))
        if should_gzip:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.end_headers()
        self.wfile.write(response_data)

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

        content_type, data = self._read_static(candidate)
        should_gzip = should_gzip_response(
            accept_encoding=self.headers.get("Accept-Encoding"),
            content_type=content_type,
            body_size=len(data),
            file_suffix=candidate.suffix,
        )
        response_data = gzip_body(data) if should_gzip else data
        self.send_response(200)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(len(response_data)))
        self.send_header("Cache-Control", "no-store" if candidate.name.endswith(".html") else "public, max-age=3600")
        if should_gzip:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(response_data)

    def _read_static(self, candidate: Path) -> tuple[str, bytes]:
        stat = candidate.stat()
        content_type, _ = mimetypes.guess_type(str(candidate))
        cache_key = str(candidate)
        if stat.st_size > STATIC_CACHE_MAX_BYTES:
            return content_type or "application/octet-stream", candidate.read_bytes()

        with STATIC_CACHE_LOCK:
            cached = STATIC_CACHE.get(cache_key)
            if cached and cached[0] == stat.st_mtime_ns and cached[1] == stat.st_size:
                return cached[3], cached[2]

        data = candidate.read_bytes()
        resolved_content_type = content_type or "application/octet-stream"
        with STATIC_CACHE_LOCK:
            STATIC_CACHE[cache_key] = (stat.st_mtime_ns, stat.st_size, data, resolved_content_type)
        return resolved_content_type, data

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
