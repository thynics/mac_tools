import hashlib
import io
import json
import threading
import unittest
import urllib.error
import urllib.request
from email.message import Message

import gateway


class Response(io.BytesIO):
    def __init__(self, body, content_type="application/json", code=200):
        super().__init__(body)
        self.code = code
        self.headers = Message()
        self.headers["Content-Type"] = content_type


class Upstream:
    def __init__(self):
        self.requests = []
        self.response = Response(json.dumps({"type": "message", "model": gateway.UPSTREAM_MODEL}).encode())

    def open(self, request, timeout):
        self.requests.append(request)
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.upstream = Upstream()
        config = {"credential_sha256": hashlib.sha256(b"test-key").hexdigest()}
        self.server = gateway.Gateway(("127.0.0.1", 0), config, self.upstream)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = "http://127.0.0.1:{}".format(self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, body=None, path="/v1/messages", key="test-key"):
        request = urllib.request.Request(
            self.origin + path, data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": "Bearer " + key, "Content-Type": "application/json",
                     "anthropic-version": "2023-06-01", "anthropic-beta": "test-beta"},
        )
        try:
            return urllib.request.urlopen(request, timeout=3)
        except urllib.error.HTTPError as response:
            return response

    def test_preserves_effort_thinking_tools_and_auth(self):
        body = {"model": gateway.MODEL, "max_tokens": 256, "output_config": {"effort": "xhigh"},
                "thinking": {"type": "adaptive"}, "messages": [{"role": "user", "content": "test"}],
                "tools": [{"name": "test", "input_schema": {"type": "object"}}]}
        with self.request(body) as response:
            self.assertEqual(json.load(response)["model"], gateway.MODEL)
        forwarded = self.upstream.requests[0]
        self.assertEqual(forwarded.full_url, gateway.UPSTREAM_ORIGIN + "/v1/messages")
        self.assertEqual(json.loads(forwarded.data), dict(body, model=gateway.UPSTREAM_MODEL))
        self.assertEqual(forwarded.get_header("Authorization"), "Bearer test-key")
        self.assertEqual(forwarded.get_header("Anthropic-beta"), "test-beta")

    def test_stream_preserves_tool_deltas_and_maps_only_model(self):
        delta = b'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n'
        start = b'data: ' + json.dumps({"type": "message_start", "message": {"model": gateway.UPSTREAM_MODEL}}).encode() + b'\n\n'
        self.upstream.response = Response(start + delta, "text/event-stream")
        with self.request({"model": gateway.MODEL, "stream": True}) as response:
            raw = response.read()
            self.assertIn(delta, raw)
            self.assertIn(gateway.MODEL.encode(), raw)
            self.assertNotIn(gateway.UPSTREAM_MODEL.encode(), raw)

    def test_preserves_provider_error_status_and_body(self):
        body = b'{"type":"error","error":{"type":"rate_limit_error"}}'
        headers = Message()
        headers["Content-Type"] = "application/json"
        self.upstream.response = urllib.error.HTTPError("https://example.invalid", 429, "limited", headers, io.BytesIO(body))
        with self.request({"model": gateway.MODEL}) as response:
            self.assertEqual(response.code, 429)
            self.assertEqual(response.read(), body)

    def test_rejects_wrong_credentials_without_forwarding(self):
        with self.request({"model": gateway.MODEL}, key="wrong") as response:
            self.assertEqual(response.code, 401)
        self.assertEqual(self.upstream.requests, [])

    def test_model_discovery_offers_canonical_model(self):
        with self.request(path="/v1/models") as response:
            self.assertEqual(json.load(response)["data"][0]["id"], gateway.MODEL)

    def test_preserves_sdk_beta_query_string(self):
        with self.request({"model": gateway.MODEL}, path="/v1/messages?beta=true") as response:
            self.assertEqual(response.code, 200)
        self.assertEqual(self.upstream.requests[0].full_url,
                         gateway.UPSTREAM_ORIGIN + "/v1/messages?beta=true")

    def test_rejects_unknown_routes_and_models(self):
        with self.request({"model": "other"}) as response:
            self.assertEqual(response.code, 400)
        with self.request({"model": gateway.MODEL}, path="/arbitrary") as response:
            self.assertEqual(response.code, 404)
        self.assertEqual(self.upstream.requests, [])


if __name__ == "__main__":
    unittest.main()
