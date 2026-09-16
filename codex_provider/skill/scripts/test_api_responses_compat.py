"""Offline regression checks for the API gateway compatibility bridge."""

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from api_responses_compat import compatibility_bridge, run_api_codex, LOCAL_KEY_ENV


@contextmanager
def upstream_server():
    received = []
    release_stream = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            received.append((self.path, json.loads(body), self.headers["Authorization"]))
            if self.path.endswith("/compact"):
                data = b'{"error":{"message":"upstream rejection"}}'
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            for data in (b'data: first\n\n', b'data: last\n\n'):
                self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
                self.wfile.flush()
                if data == b'data: first\n\n':
                    release_stream.wait(5)
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1", received, release_stream
    finally:
        release_stream.set()
        server.shutdown()
        server.server_close()
        thread.join()


def request(url, key, payload):
    return Request(url, data=json.dumps(payload).encode(), headers={
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
    })


class BridgeTest(unittest.TestCase):
    def test_only_top_level_metadata_is_removed_and_sse_streams(self):
        payload = {
            "model": "unchanged-model", "stream": True,
            "input": [{"role": "user", "content": "保留原文"}],
            "reasoning": {"effort": "xhigh"},
            "tools": [{"type": "function", "name": "test", "parameters": {
                "type": "object", "properties": {"client_metadata": {"type": "string"}},
            }}],
            "client_metadata": {"session_id": "remove-me"},
        }
        expected = {k: v for k, v in payload.items() if k != "client_metadata"}
        with upstream_server() as (upstream, received, release):
            with compatibility_bridge(upstream, "upstream-test-key") as (url, key):
                with urlopen(request(url + "/responses", key, payload), timeout=2) as response:
                    self.assertEqual(response.headers["Content-Type"], "text/event-stream")
                    self.assertIsNone(response.headers.get("Transfer-Encoding"))
                    first = response.read1(4096)
                    self.assertEqual(first, b'data: first\n\n')
                    self.assertFalse(release.is_set())
                    release.set()
                    self.assertEqual(response.read(), b'data: last\n\n')
                self.assertEqual(received, [("/v1/responses", expected, "Bearer upstream-test-key")])

    def test_upstream_error_and_compaction_are_preserved(self):
        with upstream_server() as (upstream, received, release):
            with compatibility_bridge(upstream, "test") as (url, key):
                with self.assertRaises(HTTPError) as caught:
                    urlopen(request(url + "/responses/compact", key, {"input": [], "client_metadata": {}}), timeout=2)
                self.assertEqual(caught.exception.code, 400)
                self.assertEqual(json.load(caught.exception), {"error": {"message": "upstream rejection"}})
                self.assertEqual(received[0][1], {"input": []})

    def test_local_auth_and_route_are_checked_before_upstream(self):
        with upstream_server() as (upstream, received, release):
            with compatibility_bridge(upstream, "test") as (url, key):
                for path, credential, status in (
                    ("/responses", "wrong-key", 401),
                    ("/unrelated", key, 404),
                ):
                    with self.assertRaises(HTTPError) as caught:
                        urlopen(request(url + path, credential, {}), timeout=2)
                    self.assertEqual(caught.exception.code, status)
                    caught.exception.close()
                self.assertEqual(received, [])

    def test_bridge_closes_listener_on_exit(self):
        from urllib.error import URLError
        with compatibility_bridge("http://127.0.0.1:1/v1", "test") as (url, key):
            pass
        with self.assertRaises(URLError):
            urlopen(request(url + "/responses", key, {}), timeout=1)

    def test_launch_overrides_reach_exec_resume_and_preserve_prompt(self):
        cases = [
            ["--profile", "api", "exec", "hello"],
            ["--profile", "api", "exec", "resume", "thread-uuid", "hello"],
            ["--profile", "api", "--", "-literal-prompt"],
        ]
        with patch.dict(os.environ, NVIDIA_API_KEY="upstream-test-key"):
            for arguments in cases:
                with self.subTest(arguments=arguments), patch("api_responses_compat.subprocess.Popen") as popen:
                    popen.return_value.wait.return_value = 0
                    popen.return_value.poll.return_value = 0
                    result = run_api_codex("codex", arguments, {
                        "base_url": "http://127.0.0.1:1/v1", "env_key": "NVIDIA_API_KEY",
                    })
                    self.assertEqual(result, 0)
                    command = popen.call_args.args[0]
                    position = command.index("-c")
                    if "exec" in arguments:
                        self.assertGreater(position, command.index("exec"))
                    if "resume" in arguments:
                        self.assertGreater(position, command.index("resume"))
                    if "--" in arguments:
                        self.assertLess(position, command.index("--"))
                        self.assertEqual(command[-1], "-literal-prompt")
                    token = popen.call_args.kwargs["env"][LOCAL_KEY_ENV]
                    self.assertNotEqual(token, "upstream-test-key")
                    self.assertNotIn(token, " ".join(command))
                    self.assertEqual(popen.call_args.kwargs["env"]["NVIDIA_API_KEY"], "upstream-test-key")

    def test_configured_api_sends_instructions_and_terminal_tools(self):
        executable = shutil.which("codex")
        root = Path(__file__).resolve().parents[3]
        if not executable or not (root / "api.config.toml").is_file():
            self.skipTest("installed Codex API profile is required")
        captured = []

        class Probe(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                captured.append({
                    "instructions": bool(payload.get("instructions")),
                    "tools": [(t.get("type"), t.get("name")) for t in payload.get("tools", [])],
                })
                body = b'{"error":{"message":"offline tool-catalog probe complete"}}'
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Probe)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            with tempfile.TemporaryDirectory(prefix="codex-offline-tools-") as cwd:
                command = [
                    executable, "--profile", "api", "exec", "--ephemeral",
                    "--skip-git-repo-check", "-C", cwd,
                    "--disable", "apps", "--disable", "plugins", "--disable", "hooks",
                    "--disable", "unbounded_connection_retries",
                    "-c", f'model_providers.nvidia.base_url="http://127.0.0.1:{server.server_port}/v1"',
                    "-c", 'model_providers.nvidia.env_key="CODEX_OFFLINE_TOOL_KEY"',
                    "Reply OK.",
                ]
                child = subprocess.Popen(
                    command, env=dict(os.environ, CODEX_OFFLINE_TOOL_KEY="offline-test"),
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    start_new_session=True,
                )
                try:
                    child.communicate(timeout=30)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.communicate()
                    self.fail("offline Codex tool-catalog probe timed out")
            self.assertTrue(captured, "Codex did not reach the offline probe")
            self.assertTrue(captured[0]["instructions"], "Responses Lite omitted instructions")
            tools = captured[0]["tools"]
            self.assertTrue({name for _, name in tools} & {"exec", "exec_command", "shell_command"},
                            "Responses Lite omitted terminal tools")
            self.assertFalse(any(kind and kind.startswith("web_search") for kind, _ in tools),
                             "NVIDIA gateway rejects built-in web search")
        finally:
            server.shutdown()
            server.server_close()
            worker.join()


if __name__ == "__main__":
    unittest.main()
