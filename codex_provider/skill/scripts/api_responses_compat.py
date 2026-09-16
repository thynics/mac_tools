"""Per-launch Responses compatibility bridge for the NVIDIA API provider.

Codex sends client_metadata, which this gateway currently rejects. Remove only
that top-level field; preserve request semantics and stream response bytes.
"""

from __future__ import annotations

from contextlib import contextmanager
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import secrets
import signal
import subprocess
import threading
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


LOCAL_KEY_ENV = "CODEX_API_COMPAT_KEY"
HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


@contextmanager
def compatibility_bridge(upstream: str, api_key: str, timeout: float = 300):
    """Bind loopback with a fresh credential, and clean up on launcher exit."""
    parsed = urlsplit(upstream)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("invalid API provider base_url")
    if parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise ValueError("API provider base_url must not contain credentials or a query")
    prefix = parsed.path.rstrip("/")
    origin = f"{parsed.scheme}://{parsed.netloc}"
    local_key = secrets.token_urlsafe(32)
    opener = build_opener(NoRedirect())

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass  # Never log request bodies, authorization, or response content.

        def fail(self, status, message):
            data = json.dumps({"error": {"message": message}}).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)
            self.close_connection = True

        def forward(self):
            auth = self.headers.get("Authorization", "")
            if not hmac.compare_digest(auth.encode(), ("Bearer " + local_key).encode()):
                self.fail(401, "API compatibility bridge authentication required")
                return
            target = urlsplit(self.path)
            if target.scheme or target.netloc or not (
                target.path == prefix + "/models"
                or target.path == prefix + "/responses"
                or target.path.startswith(prefix + "/responses/")
            ):
                self.fail(404, "Unsupported API compatibility bridge route")
                return
            if self.headers.get("Transfer-Encoding"):
                self.fail(400, "A Content-Length is required for request bodies")
                return
            if self.headers.get("Content-Encoding", "identity") != "identity":
                self.fail(415, "Compressed requests are disabled for this provider")
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 0:
                    raise ValueError
                body = self.rfile.read(length) if length else None
                if body and self.command == "POST" and target.path in {
                    prefix + "/responses", prefix + "/responses/compact",
                }:
                    payload = json.loads(body)
                    if not isinstance(payload, dict):
                        raise ValueError
                    if "client_metadata" in payload:
                        payload.pop("client_metadata")
                        body = json.dumps(payload, separators=(",", ":")).encode()
            except (ValueError, UnicodeDecodeError):
                self.fail(400, "Invalid Responses request body")
                return

            connection_headers = {
                part.strip().lower()
                for part in self.headers.get("Connection", "").split(",")
            }
            skip = HOP_HEADERS | connection_headers | {
                "host", "content-length", "authorization", "accept-encoding",
            }
            headers = {k: v for k, v in self.headers.items() if k.lower() not in skip}
            headers["Authorization"] = "Bearer " + api_key
            headers["Accept-Encoding"] = "identity"
            request = Request(origin + self.path, data=body, headers=headers, method=self.command)
            try:
                try:
                    response = opener.open(request, timeout=timeout)
                except HTTPError as exc:
                    response = exc  # Preserve upstream status and error body.
            except (URLError, OSError):
                self.fail(502, "Unable to connect to the API provider")
                return
            try:
                with response:
                    self.send_response(response.status)
                    response_skip = HOP_HEADERS | {
                        part.strip().lower()
                        for part in response.headers.get("Connection", "").split(",")
                    }
                    for name, value in response.headers.items():
                        if name.lower() not in response_skip:
                            self.send_header(name, value)
                    self.send_header("Connection", "close")
                    self.end_headers()
                    while chunk := response.read1(65536):
                        self.wfile.write(chunk)
                        self.wfile.flush()
            except OSError:
                pass  # A disconnected client or stream is handled by Codex retries.
            finally:
                self.close_connection = True

        do_POST = forward
        do_GET = forward
        do_DELETE = forward

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}{prefix}", local_key
    finally:
        server.shutdown()
        server.server_close()
        worker.join()


def run_api_codex(executable: str, arguments: list[str], provider: dict) -> int:
    """Keep Codex attached to its terminal while supervising the local bridge."""
    api_key = os.environ[provider["env_key"]]
    timeout = provider.get("stream_idle_timeout_ms", 300000) / 1000
    with compatibility_bridge(provider["base_url"], api_key, timeout) as (url, key):
        env = dict(os.environ, **{LOCAL_KEY_ENV: key})
        overrides = [
            "-c", "model_providers.nvidia.base_url=" + json.dumps(url),
            "-c", f'model_providers.nvidia.env_key="{LOCAL_KEY_ENV}"',
            "--disable", "enable_request_compression",
        ]
        # In Codex 0.154.0, root-level -c flags are not carried into exec.
        # Put these overrides in the selected subcommand, before an explicit
        # end-of-options marker if one exists (including for exec resume).
        boundary = arguments.index("--") if "--" in arguments else len(arguments)
        command = [executable, *arguments[:boundary], *overrides, *arguments[boundary:]]
        # SIGINT reaches Codex through the terminal process group. Do not tear
        # down the bridge when the user interrupts a turn inside the TUI.
        previous = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
        child = None

        def forward_signal(signum, frame):
            if child is not None and child.poll() is None and signum != signal.SIGINT:
                child.send_signal(signum)

        try:
            for sig in previous:
                signal.signal(sig, forward_signal)
            child = subprocess.Popen(command, env=env)
            result = child.wait()
            return result if result >= 0 else 128 - result
        finally:
            if child is not None and child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
            for sig, handler in previous.items():
                signal.signal(sig, handler)
