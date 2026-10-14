"""TAL-829: a turn on a session whose previous turn has not returned would build a second agent while the first still
holds the Agent's durable turn lease (every turn takes it since v0.21.6; a turn on an existing state.db row before), and
that agent waits on the lease for up to 30 minutes. Real sidecar, pinned Agent, a plugin tool that ignores interrupts,
and a stub OpenAI-compatible endpoint."""

from __future__ import annotations

import json
import queue
import sqlite3
import threading
import time
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from conftest import SidecarProcess, requires_agent

pytestmark = requires_agent

_PLUGIN = '''import os, pathlib, time

def _wedge(args, **kwargs):
    # A tool that ignores its interrupt: it returns only when the test releases it.
    flag = pathlib.Path(os.environ["HERMES_HOME"])
    (flag / "wedged").write_text("1")
    deadline = time.monotonic() + 120
    while not (flag / "release").exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    return "{}"

def register(ctx):
    ctx.register_tool(name="wedge", toolset="wedge",
        schema={"name": "wedge", "description": "Synthetic tool that ignores interrupts", "parameters": {"type": "object", "properties": {}}},
        handler=_wedge)
'''


class _Stub(BaseHTTPRequestHandler):
    """Answers a ``stuck`` user turn with one ``wedge`` call, and everything else with text."""

    def log_message(self, *args):  # noqa: D102 - quiet
        pass

    def do_GET(self):  # noqa: N802 - model probes: no metadata
        self.send_response(404)
        self.end_headers()

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        messages = body.get("messages", [])
        last = messages[-1] if messages else {}
        if last.get("role") == "user" and "stuck" in json.dumps(last.get("content")):
            # Newer Agents defer plugin tools behind the tool-search bridge.
            direct = any((t.get("function") or {}).get("name") == "wedge" for t in body.get("tools") or [])
            name, arguments = ("wedge", {}) if direct else ("tool_call", {"calls": [{"name": "wedge", "arguments": {}}]})
            call = {"index": 0, "id": "call_wedge", "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}}
            delta, finish = {"role": "assistant", "content": None, "tool_calls": [call]}, "tool_calls"
        else:
            delta, finish = {"role": "assistant", "content": "pong"}, "stop"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for chunk_delta, chunk_finish in ((delta, None), ({}, finish)):
            chunk = {"id": "c1", "object": "chat.completion.chunk", "created": 0, "model": "stub", "choices": [{"index": 0, "delta": chunk_delta, "finish_reason": chunk_finish}]}
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")


@pytest.fixture
def home(hermes_home):
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Stub)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    plugin = hermes_home / "plugins" / "wedge"
    plugin.mkdir(parents=True)
    (plugin / "plugin.yaml").write_text("name: wedge\nversion: 0.0.1\n")
    (plugin / "__init__.py").write_text(_PLUGIN)
    (hermes_home / "config.yaml").write_text(
        f"model:\n  provider: custom\n  default: stub-model\n  base_url: http://127.0.0.1:{server.server_address[1]}/v1\n  api_key: sk-stub\n"
        "plugins:\n  isolation: in_process\n  enabled: [wedge]\n")
    yield hermes_home
    (hermes_home / "release").write_text("1")
    server.shutdown()


class _Mux:
    """Several requests in flight on one sidecar: frames and replies routed by request id."""

    def __init__(self, proc: SidecarProcess):
        self.proc = proc
        self.replies: dict[int, dict] = {}

    def wait(self, request_id: int, timeout: float) -> dict | None:
        deadline = time.monotonic() + timeout
        while request_id not in self.replies:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            try:
                message = self.proc.next_message(timeout=remaining)
            except queue.Empty:
                return None
            if message is None:
                raise RuntimeError(f"sidecar exited: {self.proc.stderr_lines[-10:]}")
            if "id" in message and message.get("method") is None:
                self.replies[message["id"]] = message
        return self.replies[request_id]


def _turn(home, stream_id: str, text: str, toolsets: list[str]) -> dict:
    return {"profile_home": str(home), "session_id": "s-lease", "stream_id": stream_id, "user_message": text, "conversation_history": [],
            "model": "stub-model", "model_provider": "custom", "workspace": str(home.parent), "enabled_toolsets": toolsets}


def _wedged_session(home):
    """A sidecar whose ``s-lease`` turn is stuck inside the ``wedge`` tool, holding the session's turn lease."""
    proc = SidecarProcess(home)
    mux = _Mux(proc)
    # Warm the session so its state.db row exists: every supported release leases a turn on an existing row.
    warm = mux.wait(proc.request("chat.start", _turn(home, "st-warm", "hello", [])), 120)
    assert (warm or {}).get("result", {}).get("status") == "completed", (warm, proc.stderr_lines[-20:])
    stuck = proc.request("chat.start", _turn(home, "st-stuck", "stuck", ["wedge"]))
    deadline = time.monotonic() + 60
    while not (home / "wedged").exists():
        assert time.monotonic() < deadline and mux.wait(stuck, 0.1) is None, (mux.replies.get(stuck), proc.stderr_lines[-20:])
    with closing(sqlite3.connect(home / "state.db")) as db:
        assert db.execute("SELECT COUNT(*) FROM session_turn_leases").fetchone()[0] == 1
    return proc, mux, stuck


def _rows(home) -> list[tuple[str, str]]:
    with closing(sqlite3.connect(home / "state.db")) as db:
        return db.execute("SELECT role, content FROM messages WHERE session_id = 's-lease' AND content IS NOT NULL ORDER BY id").fetchall()


def test_a_turn_right_after_stopping_a_stuck_turn_waits_only_until_the_agent_abandons_it(home) -> None:
    proc, mux, stuck = _wedged_session(home)
    try:
        assert mux.wait(proc.request("chat.interrupt", {"stream_id": "st-stuck"}), 10)["result"]["ok"] is True
        # Sent at once, like the server after a Stop: the wedge ignores the interrupt, so this is a busy-session turn
        # whose fresh agent waits on the stopped turn's lease until the Agent abandons the wedged tool and lets it go.
        reply = mux.wait(proc.request("chat.start", _turn(home, "st-next", "next", [])), 30)
        assert reply is not None, "the turn after a stopped stuck turn hung on its lease"
        assert reply.get("result", {}).get("status") == "completed", reply
        assert reply["result"]["final_response"] == "pong"
        assert mux.wait(stuck, 1)["result"]["status"] == "cancelled"
        assert _rows(home)[-2:] == [("user", "next"), ("assistant", "pong")]
    finally:
        (home / "release").write_text("1")
        proc.close()


def test_a_turn_while_the_previous_turn_is_still_running_is_refused_as_busy(home) -> None:
    proc, mux, stuck = _wedged_session(home)
    try:
        reply = mux.wait(proc.request("chat.start", _turn(home, "st-next", "next", [])), 30)
        assert reply is not None, "the turn beside a running turn hung on its lease"
        assert reply.get("error", {}).get("data", {}).get("condition") == "session_busy", reply
        # The running turn keeps its lease and finishes normally.
        (home / "release").write_text("1")
        assert mux.wait(stuck, 30)["result"]["status"] == "completed"
    finally:
        (home / "release").write_text("1")
        proc.close()
