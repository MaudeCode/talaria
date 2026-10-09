"""TAL-258: the handoff dock's sidecar methods against the pinned Agent: ``aux.complete`` asking an explicit model
(reasoning off, no tools, the provider's ``finish_reason``) through a stub OpenAI-compatible endpoint, and
``state_db.append_message`` through the Agent's ``SessionDB``."""

from __future__ import annotations

import json
import sqlite3
import subprocess
import textwrap
import threading
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SidecarProcess, assert_matches, isolated_env, requires_agent

pytestmark = requires_agent


class _Stub(BaseHTTPRequestHandler):
    bodies: list[dict] = []

    def log_message(self, *args):  # noqa: D102 - quiet
        pass

    def do_GET(self):  # noqa: N802 - model probes: no metadata
        self.send_response(404)
        self.end_headers()

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        _Stub.bodies.append(body)
        message = {"role": "assistant", "content": "- You decided to ship"}
        if body.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for delta, finish in ((message, None), ({}, "length")):
                chunk = {"id": "c1", "object": "chat.completion.chunk", "created": 0, "model": "stub", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
            return
        payload = {"id": "c1", "object": "chat.completion", "created": 0, "model": "stub", "choices": [{"index": 0, "message": message, "finish_reason": "length"}],
                   "usage": {"prompt_tokens": 3, "completion_tokens": 5, "total_tokens": 8}}
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture
def llm():
    _Stub.bodies = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Stub)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}/v1"
    server.shutdown()


PROMPT = [{"role": "system", "content": "Summarize."}, {"role": "user", "content": "Conversation transcript:\nship it?\nyes"}]


def test_an_explicit_model_answers_with_its_finish_reason_reasoning_off_and_no_tools(hermes_home, llm) -> None:
    (hermes_home / "config.yaml").write_text(f"model:\n  provider: custom\n  default: stub-model\n  base_url: {llm}\n  api_key: sk-stub\n")
    proc = SidecarProcess(hermes_home)
    try:
        params = {"profile_home": str(hermes_home), "task": "handoff_summary", "messages": PROMPT, "model": "stub-model", "provider": "custom", "max_tokens": 700, "temperature": 0.2}
        result = proc.result("aux.complete", params, timeout=60)
        assert_matches("aux.complete", result)
        assert result["text"] == "- You decided to ship"
        assert result["finish_reason"] == "length"
        assert result["model"] == "stub-model"
        (body,) = _Stub.bodies
        assert body["model"] == "stub-model"
        assert body["messages"] == PROMPT
        assert not body.get("tools")
        assert body["reasoning_effort"] == "none"
    finally:
        proc.close()


def test_an_explicit_model_without_a_credential_is_credential_missing(hermes_home) -> None:
    (hermes_home / "config.yaml").write_text("model:\n  provider: openrouter\n  default: openai/gpt-5\n")
    proc = SidecarProcess(hermes_home)
    try:
        message, _ = proc.call("aux.complete", {"profile_home": str(hermes_home), "task": "handoff_summary", "messages": PROMPT, "model": "openai/gpt-5", "provider": "openrouter", "max_tokens": 700}, timeout=60)
        assert message["error"]["data"]["condition"] == "credential_missing", message
    finally:
        proc.close()


def _seed(home, session_id: str) -> None:
    script = textwrap.dedent(
        f"""
        from hermes_state import SessionDB
        from pathlib import Path
        db = SessionDB(db_path=Path({str(home / "state.db")!r}))
        db.create_session(session_id={session_id!r}, source="telegram")
        db.append_message({session_id!r}, "user", "Need help")
        db.close()
        """
    )
    subprocess.run([AGENT_PYTHON, "-c", script], env=isolated_env(home, PYTHONPATH=str(AGENT_DIR)), check=True, timeout=60)


def test_append_message_writes_one_row_and_bumps_message_count(hermes_home) -> None:
    _seed(hermes_home, "gw-1")
    card = json.dumps({"_handoff_summary_card": True, "session_id": "gw-1", "summary": "- Ship it."})
    proc = SidecarProcess(hermes_home)
    try:
        params = {"profile_home": str(hermes_home), "session_id": "gw-1", "role": "tool", "content": card, "tool_name": "handoff_summary", "timestamp": 1234.5}
        result = proc.result("state_db.append_message", params)
        assert_matches("state_db.append_message", result)
        assert result == {"ok": True}
    finally:
        proc.close()
    with closing(sqlite3.connect(hermes_home / "state.db")) as db:
        rows = db.execute("SELECT role, content, tool_name, timestamp FROM messages WHERE session_id = 'gw-1' ORDER BY id").fetchall()
        count = db.execute("SELECT message_count FROM sessions WHERE id = 'gw-1'").fetchone()[0]
    assert rows == [("user", "Need help", None, rows[0][3]), ("tool", card, "handoff_summary", 1234.5)]
    assert count == 2


def test_append_message_without_a_state_db_is_not_ok(hermes_home) -> None:
    proc = SidecarProcess(hermes_home)
    try:
        assert proc.result("state_db.append_message", {"profile_home": str(hermes_home), "session_id": "gw-2", "role": "tool", "content": "{}"}) == {"ok": False}
    finally:
        proc.close()
