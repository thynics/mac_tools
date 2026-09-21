#!/usr/bin/env python3
"""A loopback-only HTTP UI for compiling private Overleaf ZIP projects."""

from __future__ import annotations

import argparse
import fcntl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
from urllib.parse import parse_qs, quote, unquote, urlsplit

from core import DEFAULT_DATA, MAX_UPLOAD, Store, TexRuntime, UserError, contained


STATIC = Path(__file__).resolve().parent / "static"


class PaperServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple, store: Store):
        self.store = store
        self.token = secrets.token_urlsafe(32)
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server_version = "PaperStudio/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def log_message(self, fmt, *args):
        # URLs may contain user filenames; don't copy request bodies or tokens to logs.
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def _check_request(self, writing=False):
        port = self.server.server_address[1]
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        host = self.headers.get("Host", "")
        if host not in hosts:
            raise UserError("仅支持通过本机 localhost 或 127.0.0.1 访问。", 403)
        if writing:
            origin = self.headers.get("Origin")
            if origin and origin not in {"http://" + h for h in hosts}:
                raise UserError("不允许跨站请求。", 403)
            if not secrets.compare_digest(self.headers.get("X-Latex-Token", "").encode(), self.server.token.encode()):
                raise UserError("页面会话已更新，请刷新页面后重试。", 403)

    def _headers(self, status, content_type, length, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Paper-Studio", "1")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self' blob:; object-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'")
        if extra:
            for key, value in extra.items():
                self.send_header(key, value)
        self.end_headers()

    def _send(self, data, content_type="application/json; charset=utf-8", status=200, extra=None):
        if isinstance(data, (dict, list)):
            data = json.dumps(data, ensure_ascii=False).encode("utf-8")
        elif isinstance(data, str):
            data = data.encode("utf-8")
        self._headers(status, content_type, len(data), extra)
        if self.command != "HEAD":
            self.wfile.write(data)

    def _file(self, path, content_type, extra=None):
        with path.open("rb") as stream:
            self._headers(200, content_type, os.fstat(stream.fileno()).st_size, extra)
            if self.command != "HEAD":
                while chunk := stream.read(1024 * 1024):
                    self.wfile.write(chunk)

    def _body(self, maximum):
        if self.headers.get("Transfer-Encoding"):
            raise UserError("不支持分块上传。", 400)
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise UserError("无效的 Content-Length。") from exc
        if size < 0 or size > maximum:
            raise UserError("请求内容过大。", 413)
        result = self.rfile.read(size)
        if len(result) != size:
            raise UserError("上传未完成，请重试。")
        return result

    def _json_body(self):
        try:
            value = json.loads(self._body(16384) or b"{}")
        except (ValueError, UnicodeError) as exc:
            raise UserError("JSON 请求无效。") from exc
        if not isinstance(value, dict):
            raise UserError("JSON 请求必须是对象。")
        return value

    def _route(self):
        writing = self.command in {"POST", "PATCH"}
        self._check_request(writing=writing)
        url = urlsplit(self.path)
        path = unquote(url.path)
        query = parse_qs(url.query)
        parts = path.strip("/").split("/")
        store = self.server.store
        if self.command in {"GET", "HEAD"}:
            if path == "/":
                return self._file(STATIC / "index.html", "text/html; charset=utf-8")
            if path == "/favicon.ico":
                return self._send(b"", "image/x-icon", 204)
            if path.startswith("/static/"):
                target = contained(STATIC, path.removeprefix("/static/"))
                if not target.is_file():
                    raise UserError("资源不存在。", 404)
                content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
                return self._file(target, content_type + ("; charset=utf-8" if content_type.startswith("text/") or content_type == "application/javascript" else ""))
            if path == "/api/state":
                return self._send({"app": "paper-studio", "data_dir": str(store.data_dir), "projects": store.list_projects(), "engines": store.runtime.engines(), "runtime": store.runtime.public(), "csrf_token": self.server.token, "max_upload_bytes": MAX_UPLOAD})
            if len(parts) >= 3 and parts[:2] == ["api", "projects"]:
                project_id = parts[2]
                if len(parts) == 3:
                    return self._send({"project": store.describe(project_id)})
                if len(parts) == 4:
                    if parts[3] == "log":
                        return self._send(store.read_log(project_id), "text/plain; charset=utf-8")
                    if parts[3] == "source":
                        return self._send(store.read_source(project_id, query.get("path", [""])[0]), "text/plain; charset=utf-8")
                    if parts[3] == "pdf":
                        project = store.describe(project_id, details=False)
                        filename = Path(project["main_file"]).stem + ".pdf"
                        disposition = "attachment" if query.get("download") == ["1"] else "inline"
                        return self._file(store.pdf_path(project_id), "application/pdf", {"Content-Disposition": f"{disposition}; filename=paper.pdf; filename*=UTF-8''{quote(filename, safe='')}"})
        if self.command == "POST":
            if path == "/api/projects":
                payload = self._body(MAX_UPLOAD)
                return self._send({"project": store.import_zip(payload, query.get("name", ["Overleaf project"])[0])}, status=201)
            if len(parts) == 4 and parts[:2] == ["api", "projects"]:
                self._json_body()
                if parts[3] == "compile":
                    return self._send({"project": store.compile(parts[2])}, status=202)
                if parts[3] == "reveal":
                    directory = store.project_dir(parts[2]) / "source"
                    if sys.platform != "darwin":
                        raise UserError("请在本地编辑器中打开源码目录：" + str(directory), 400)
                    result = subprocess.run(["/usr/bin/open", str(directory)], capture_output=True, timeout=10)
                    if result.returncode:
                        raise UserError("无法打开 Finder：" + result.stderr.decode(errors="replace"), 500)
                    return self._send({"ok": True})
        if self.command == "PATCH" and len(parts) == 3 and parts[:2] == ["api", "projects"]:
            return self._send({"project": store.update(parts[2], self._json_body())})
        raise UserError("接口不存在。", 404)

    def _handle(self):
        try:
            self._route()
        except UserError as exc:
            self._send({"error": str(exc)}, status=exc.status)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        except Exception as exc:
            self.log_error("%s: %s", type(exc).__name__, str(exc))
            self._send({"error": "本地服务遇到错误，请查看服务日志。"}, status=500)

    do_GET = _handle
    do_HEAD = _handle
    do_POST = _handle
    do_PATCH = _handle


def main():
    parser = argparse.ArgumentParser(description="Paper Studio — local TeX Live rendering server")
    parser.add_argument("--host", default="127.0.0.1", choices=["127.0.0.1", "localhost"])
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--tex-bin", default=None)
    parser.add_argument("--compile-timeout", type=float, default=180)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or args.compile_timeout <= 0:
        parser.error("port must be 1–65535 and timeout must be positive")
    os.umask(0o077)
    data_dir = args.data_dir.expanduser().resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    with (data_dir / "server.lock").open("a") as lockfile:
        try:
            fcntl.flock(lockfile, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.exit(1, "This data directory is already in use by another Paper Studio server.\n")
        runtime = TexRuntime(args.tex_bin)
        store = Store(data_dir, runtime, timeout=args.compile_timeout)
        try:
            server = PaperServer((args.host, args.port), store)
        except OSError as exc:
            store.close()
            parser.exit(1, f"Cannot start on {args.host}:{args.port}: {exc}\n")
        def stop(_signum, _frame):
            raise KeyboardInterrupt
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        print(f"Paper Studio: http://127.0.0.1:{args.port}\nProjects: {data_dir / 'projects'}", flush=True)
        try:
            server.serve_forever(poll_interval=0.4)
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
            store.close()


if __name__ == "__main__":
    main()
