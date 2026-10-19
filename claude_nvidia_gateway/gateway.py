#!/usr/bin/env python3
"""Loopback gateway that gives NVIDIA's Claude route its canonical model ID."""

import argparse
import hashlib
import hmac
import json
import socket
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MODEL = "claude-opus-5-5"
UPSTREAM_MODEL = "aws/anthropic/eccn-claude-opus-5-5"
UPSTREAM_ORIGIN = "https://inference-api.nvidia.com"
MAX_BODY = 64 * 1024 * 1024
HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
    "accept-encoding",
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def canonical_response(value):
    if isinstance(value, dict) and value.get("model") == UPSTREAM_MODEL:
        value["model"] = MODEL
    return value


def canonical_event(line):
    if not line.startswith(b"data: "):
        return line
    try:
        event = json.loads(line[6:])
    except (ValueError, UnicodeDecodeError):
        return line
    if event.get("type") != "message_start":
        return line
    message = event.get("message")
    if isinstance(message, dict) and message.get("model") == UPSTREAM_MODEL:
        canonical_response(message)
        return b"data: " + json.dumps(event, separators=(",", ":")).encode() + b"\n"
    return line


class Gateway(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, config, opener=None):
        self.config = config
        self.opener = opener or urllib.request.build_opener(NoRedirect())
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        # Never log headers, prompts, URL query strings, or credentials.
        pass

    def json_response(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def error_response(self, status, message):
        self.close_connection = True
        self.json_response(status, {
            "type": "error", "error": {"type": "invalid_request_error", "message": message},
        })

    def authenticated(self):
        parts = self.headers.get("Authorization", "").split(None, 1)
        if len(parts) != 2 or parts[0].lower() != "bearer":
            return False
        digest = hashlib.sha256(parts[1].encode()).hexdigest()
        return hmac.compare_digest(digest, self.server.config["credential_sha256"])

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/health":
            self.json_response(200, {"status": "ok", "model": MODEL})
        elif not self.authenticated():
            self.error_response(401, "A valid API key is required.")
        elif path == "/v1/models":
            self.json_response(200, {
                "data": [{"id": MODEL, "type": "model", "display_name": "Claude Opus 5.5"}],
                "has_more": False, "first_id": MODEL, "last_id": MODEL,
            })
        else:
            self.error_response(404, "Unknown endpoint.")

    def do_POST(self):
        if not self.authenticated():
            self.error_response(401, "A valid API key is required.")
            return
        path = urllib.parse.urlsplit(self.path).path
        if path not in ("/v1/messages", "/v1/messages/count_tokens"):
            self.error_response(404, "Unknown endpoint.")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY:
                raise ValueError("invalid length")
            self.connection.settimeout(60)
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("incomplete body")
            body = json.loads(raw)
            if not isinstance(body, dict):
                raise ValueError("expected object")
        except (ValueError, socket.timeout, UnicodeDecodeError):
            self.error_response(400, "A complete JSON request body is required (maximum 64 MiB).")
            return
        if body.get("model") not in (MODEL, UPSTREAM_MODEL):
            self.error_response(400, "This gateway serves Claude Opus 5.5 only.")
            return
        body["model"] = UPSTREAM_MODEL
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_HEADERS}
        headers["Accept-Encoding"] = "identity"
        request = urllib.request.Request(
            UPSTREAM_ORIGIN + self.path,
            data=json.dumps(body).encode(), headers=headers, method="POST",
        )
        try:
            try:
                upstream = self.server.opener.open(request, timeout=600)
            except urllib.error.HTTPError as error:
                upstream = error
        except (urllib.error.URLError, OSError):
            self.error_response(502, "Could not connect to the NVIDIA inference endpoint.")
            return
        output_config = body.get("output_config")
        effort = output_config.get("effort") if isinstance(output_config, dict) else None
        if effort not in ("low", "medium", "high", "xhigh", "max"):
            effort = "unspecified"
        print("NVIDIA upstream: status={} effort={}".format(upstream.code, effort), flush=True)
        try:
            with upstream:
                content_type = upstream.headers.get("Content-Type", "application/json")
                if "text/event-stream" in content_type:
                    self.send_response(upstream.code)
                    self.copy_response_headers(upstream)
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.close_connection = True
                    for line in upstream:
                        self.wfile.write(canonical_event(line))
                        self.wfile.flush()
                else:
                    response = upstream.read()
                    if upstream.code == 200 and "json" in content_type:
                        try:
                            response = json.dumps(canonical_response(json.loads(response))).encode()
                        except (ValueError, UnicodeDecodeError):
                            pass
                    self.send_response(upstream.code)
                    self.copy_response_headers(upstream)
                    self.send_header("Content-Length", str(len(response)))
                    self.end_headers()
                    self.wfile.write(response)
        except (BrokenPipeError, ConnectionResetError, socket.timeout, OSError):
            self.close_connection = True

    def copy_response_headers(self, upstream):
        for key, value in upstream.headers.items():
            if key.lower() not in HOP_HEADERS and key.lower() != "content-encoding":
                self.send_header(key, value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    server = Gateway(("127.0.0.1", config["port"]), config)
    print("Claude NVIDIA gateway listening on 127.0.0.1:{}".format(config["port"]), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
