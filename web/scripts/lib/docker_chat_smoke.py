"""Run inside the disposable Web smoke container, on its staged Agent venv."""

import json
import os
from pathlib import Path
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.request

from run_agent import AIAgent  # noqa: F401 - health alone does not prove the Agent imports


class Provider(BaseHTTPRequestHandler):
    calls = 0

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.send_error(404)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        type(self).calls += 1
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream" if body.get("stream") else "application/json")
        self.end_headers()
        reply = {"role": "assistant", "content": "compose-pong"}
        if body.get("stream"):
            for delta, finish in ((reply, None), ({}, "stop")):
                chunk = {"id": "smoke", "object": "chat.completion.chunk", "created": 0, "model": "stub-model",
                         "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
        else:
            self.wfile.write(json.dumps({"id": "smoke", "object": "chat.completion", "created": 0,
                                        "model": "stub-model", "choices": [{"index": 0, "message": reply,
                                        "finish_reason": "stop"}], "usage": {"prompt_tokens": 1,
                                        "completion_tokens": 1, "total_tokens": 2}}).encode())


def post(path, body):
    request = urllib.request.Request("http://127.0.0.1:8787" + path, data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)


with ThreadingHTTPServer(("127.0.0.1", 0), Provider) as provider:
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    try:
        home = Path(os.environ.get("HERMES_HOME", "/home/hermeswebui/.hermes"))
        (home / "config.yaml").write_text(json.dumps({
            "model": {"provider": "custom", "default": "stub-model", "api_key": "sk-smoke",
                      "base_url": f"http://127.0.0.1:{provider.server_port}/v1"},
            "platform_toolsets": {"cli": []},
        }))
        session = post("/api/session/new", {"model": "stub-model", "model_provider": "custom", "enabled_toolsets": []})
        result = post("/api/chat", {"session_id": session["session"]["session_id"], "message": "compose-ping",
                                    "model": "stub-model", "model_provider": "custom"})
        assert result["status"] == "done" and result["answer"] == "compose-pong", result
        assert Provider.calls > 0, "chat never reached the stub provider"
        print("PASS staged Agent import and Web -> sidecar -> Agent -> stub provider chat", flush=True)
    finally:
        provider.shutdown()
