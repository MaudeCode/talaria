"""TAL-905: a Web turn sends the profile's ``prefill_messages_file`` rows ahead of the user turn, like the CLI, gateway
and Desktop, and an edit to the file applies on the next turn. Real sidecar, pinned Agent, and a stub
OpenAI-compatible endpoint that records each request."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from conftest import SidecarProcess, requires_agent

pytestmark = requires_agent


class _Recorder(BaseHTTPRequestHandler):
    requests: list[list[tuple[str, str]]] = []

    def log_message(self, *args):  # noqa: D102 - quiet
        pass

    def do_GET(self):  # noqa: N802 - model probes: no metadata
        self.send_response(404)
        self.end_headers()

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        if self.path.endswith("/chat/completions"):  # not the Ollama ``/api/show`` probe
            _Recorder.requests.append([(m.get("role"), m.get("content")) for m in body.get("messages", []) if m.get("role") != "system"])
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for delta, finish in (({"role": "assistant", "content": "pong"}, None), ({}, "stop")):
            chunk = {"id": "c1", "object": "chat.completion.chunk", "created": 0, "model": "stub", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")


@pytest.fixture
def llm():
    _Recorder.requests = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Recorder)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}/v1"
    server.shutdown()


def _sent(proc: SidecarProcess, home, text: str) -> list[list[tuple[str, str]]]:
    """The turn's model requests that end on its user message (the title request may also run)."""
    params = {"profile_home": str(home), "session_id": "web-1", "stream_id": f"st-{text}", "user_message": text, "conversation_history": [],
              "model": "stub-model", "model_provider": "custom", "workspace": str(home.parent), "enabled_toolsets": []}
    before = len(_Recorder.requests)
    result = proc.result("chat.start", params, timeout=120)
    assert result["status"] == "completed", (result, proc.stderr_lines[-20:])
    sent = [rows for rows in _Recorder.requests[before:] if rows and rows[-1] == ("user", text)]
    assert sent, _Recorder.requests[before:]
    return sent


def test_turns_send_the_profile_prefill_and_follow_its_edits(hermes_home, llm) -> None:
    (hermes_home / "config.yaml").write_text(f"model:\n  provider: custom\n  default: stub-model\n  base_url: {llm}\n  api_key: sk-stub\nprefill_messages_file: prefill.json\n")
    prefill = hermes_home / "prefill.json"
    prefill.write_text(json.dumps([{"role": "user", "content": "always answer in French"}, {"role": "assistant", "content": "compris"}]))
    proc = SidecarProcess(hermes_home)
    try:
        assert [("user", "always answer in French"), ("assistant", "compris"), ("user", "plan it")] in _sent(proc, hermes_home, "plan it")
        # The cached agent is rebuilt for an edited file.
        prefill.write_text(json.dumps([{"role": "user", "content": "answer in German"}, {"role": "assistant", "content": "verstanden"}]))
        assert [("user", "answer in German"), ("assistant", "verstanden"), ("user", "again")] in _sent(proc, hermes_home, "again")
        prefill.write_text("[]")
        assert {tuple(rows) for rows in _sent(proc, hermes_home, "empty")} == {(("user", "empty"),)}
        prefill.unlink()
        assert {tuple(rows) for rows in _sent(proc, hermes_home, "missing")} == {(("user", "missing"),)}
    finally:
        proc.close()
