"""TAL-529: a Web turn's Agent writes the conversation to the profile's state.db under the Web session id, and an agent
rebuilt after a sidecar restart continues a compressed session on its live tip. Real sidecar, pinned Agent, and a stub
OpenAI-compatible endpoint."""

from __future__ import annotations

import json
import sqlite3
import subprocess
import textwrap
import threading
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SidecarProcess, isolated_env, requires_agent

pytestmark = requires_agent


class _Stub(BaseHTTPRequestHandler):
    def log_message(self, *args):  # noqa: D102 - quiet
        pass

    def do_GET(self):  # noqa: N802 - model probes: no metadata
        self.send_response(404)
        self.end_headers()

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        reply = "pong"
        if body.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for delta, finish in (({"role": "assistant", "content": reply}, None), ({}, "stop")):
                chunk = {"id": "c1", "object": "chat.completion.chunk", "created": 0, "model": "stub", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
            return
        payload = {"id": "c1", "object": "chat.completion", "created": 0, "model": "stub", "choices": [{"index": 0, "message": {"role": "assistant", "content": reply}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture
def llm():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Stub)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}/v1"
    server.shutdown()


@pytest.fixture
def home(hermes_home, llm):
    (hermes_home / "config.yaml").write_text(f"model:\n  provider: custom\n  default: stub-model\n  base_url: {llm}\n  api_key: sk-stub\n")
    return hermes_home


def _turn(proc: SidecarProcess, home, session_id: str, text: str, history: list | None = None, **extra) -> dict:
    params = {"profile_home": str(home), "session_id": session_id, "stream_id": f"st-{text}", "user_message": text, "conversation_history": history or [],
              "model": "stub-model", "model_provider": "custom", "workspace": str(home.parent), "enabled_toolsets": [], **extra}
    result = proc.result("chat.start", params, timeout=120)
    assert result["status"] == "completed", (result, proc.stderr_lines[-20:])
    return result


def _rows(home, session_id: str) -> list[tuple[str, str]]:
    with closing(sqlite3.connect(home / "state.db")) as db:
        return db.execute("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id", (session_id,)).fetchall()


def _session(home, session_id: str):
    with closing(sqlite3.connect(home / "state.db")) as db:
        return db.execute("SELECT source, ended_at FROM sessions WHERE id = ?", (session_id,)).fetchone()


def test_a_web_turn_writes_its_session_and_messages_to_state_db(home) -> None:
    proc = SidecarProcess(home)
    try:
        # The server sends the prompt with its workspace prefix and the user's own text to store.
        first = _turn(proc, home, "web-1", "ping", user_message="[Workspace::v1: /w]\nping", persist_user_message="ping")
        assert first["agent_session_id"] == "web-1"
        assert _session(home, "web-1") == ("webui", None)
        assert _rows(home, "web-1") == [("user", "ping"), ("assistant", "pong")]
        # The next turn carries the earlier one as history: only its own rows are appended.
        _turn(proc, home, "web-1", "again", [{"role": "user", "content": "ping"}, {"role": "assistant", "content": "pong"}])
        assert _rows(home, "web-1") == [("user", "ping"), ("assistant", "pong"), ("user", "again"), ("assistant", "pong")]
    finally:
        proc.close()


def test_a_btw_side_question_stays_out_of_state_db(home) -> None:
    proc = SidecarProcess(home)
    try:
        _turn(proc, home, "web-3", "ping")
        _turn(proc, home, "btw-3", "side question", [{"role": "user", "content": "ping"}, {"role": "assistant", "content": "pong"}], ephemeral=True)
        assert _session(home, "btw-3") is None
        assert _rows(home, "btw-3") == []
    finally:
        proc.close()


def _seed_compressed(home) -> None:
    """The Agent compressed ``web-2`` in a sidecar that is gone: the Web id ended, its continuation ``web-2-tip`` is live."""
    script = textwrap.dedent(
        f"""
        from hermes_state import SessionDB
        from pathlib import Path
        db = SessionDB(db_path=Path({str(home / "state.db")!r}))
        db.create_session(session_id="web-2", source="webui")
        db.append_message("web-2", "user", "ping")
        db.append_message("web-2", "assistant", "pong")
        db.end_session("web-2", "compression")
        db.create_session(session_id="web-2-tip", source="webui", parent_session_id="web-2")
        db.append_message("web-2-tip", "user", "[summary] ping/pong")
        db.close()
        """
    )
    env = isolated_env(home, PYTHONPATH=str(AGENT_DIR))
    subprocess.run([AGENT_PYTHON, "-c", script], env=env, check=True, timeout=60)


def test_an_agent_rebuilt_after_restart_runs_on_the_compression_tip(home) -> None:
    _seed_compressed(home)
    proc = SidecarProcess(home)
    try:
        # The server's history for the session, which differs from the tip's stored rows: the server owns the transcript.
        history = [{"role": "user", "content": "[summary] ping/pong"}, {"role": "assistant", "content": "ok"}, {"role": "user", "content": "web-only context"}, {"role": "assistant", "content": "noted"}]
        result = _turn(proc, home, "web-2", "after restart", history)
        assert result["agent_session_id"] == "web-2-tip"
        assert [m["content"] for m in result["messages"]][:4] == ["[summary] ping/pong", "ok", "web-only context", "noted"]
        # Only the turn's own rows land, on the tip; the closed Web id is untouched.
        assert _rows(home, "web-2-tip") == [("user", "[summary] ping/pong"), ("user", "after restart"), ("assistant", "pong")]
        assert _rows(home, "web-2") == [("user", "ping"), ("assistant", "pong")]
    finally:
        proc.close()
