"""TAL-2303: a direct Web chat's terminal directory survives a sidecar restart. The Agent keeps each session's ``cd`` in a
process-local record; ``chat.start`` reports it and seeds it back from the server's saved value. Real sidecar, pinned
Agent, disposable homes, stub model issuing real terminal calls."""

from __future__ import annotations

import io
import json
import os
import pathlib
import sys
import types

import pytest

from conftest import OneToolCallModel, SidecarProcess, requires_agent, serve_model
from talaria_sidecar.methods import chat


class _Terminal(OneToolCallModel):
    """Answers with one ``terminal`` call of ``shell``; records every request body."""

    shell = ""
    bodies: list = []

    def first_call(self, body: dict) -> dict:
        return {"name": "terminal", "arguments": json.dumps({"command": self.shell})}

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        type(self).bodies.append(json.loads(raw or b"{}"))
        self.rfile = io.BytesIO(raw)
        super().do_POST()


def _output(bodies: list) -> str:
    """The terminal call's printed output, from the tool row the Agent sent back to the model."""
    rows = [json.loads(m["content"]) for body in bodies for m in body.get("messages", []) if m.get("role") == "tool"]
    assert rows, bodies
    return str(rows[-1].get("output", "")).strip()


@requires_agent
def test_a_chats_terminal_directory_survives_a_restart_and_stays_its_own(hermes_home: pathlib.Path) -> None:
    workspace = (hermes_home.parent / "project")
    (workspace / "sub").mkdir(parents=True)
    sub = os.path.realpath(workspace / "sub")
    stub = type("Stub", (_Terminal,), {"shell": "", "bodies": []})

    def turn(proc: SidecarProcess, session: str, command: str, terminal_cwd: str | None) -> tuple[str, dict]:
        stub.shell = command
        stub.bodies.clear()
        params = {"profile_home": str(hermes_home), "session_id": session, "stream_id": f"st-{session}-{len(command)}-{os.urandom(3).hex()}",
                  "user_message": "run it", "conversation_history": [], "model": "stub-model", "model_provider": "custom",
                  "workspace": str(workspace), "workspace_local": True, "enabled_toolsets": ["terminal"], "terminal_cwd": terminal_cwd}
        result = proc.result("chat.start", params, timeout=120)
        assert result["status"] == "completed", (result, proc.stderr_lines[-20:])
        return _output(stub.bodies), result

    with serve_model(stub) as url:
        (hermes_home / "config.yaml").write_text(f"model:\n  provider: custom\n  default: stub-model\n  base_url: {url}\n  api_key: sk-stub\n")
        proc = SidecarProcess(hermes_home)
        try:
            printed, result = turn(proc, "web-cwd", f"cd {sub} && pwd -P", None)
            assert printed == sub
            saved = result.get("terminal_cwd")
            printed, result = turn(proc, "web-cwd", "pwd -P", saved)
            assert printed == sub
            saved = result.get("terminal_cwd")
        finally:
            proc.close()
        proc = SidecarProcess(hermes_home)
        try:
            # The restarted sidecar has no record of its own: the chat's next command runs where its last one ended.
            printed, _ = turn(proc, "web-cwd", "pwd -P", saved)
            assert printed == sub, (saved, printed)
            # Another chat on the same profile starts where the terminal is configured, not in this chat's directory.
            printed, _ = turn(proc, "web-other", "pwd -P", None)
            assert printed != sub
        finally:
            proc.close()


@pytest.fixture
def records(monkeypatch) -> dict:
    """The Agent terminal tool's per-session cwd record, as a dict."""
    store: dict = {}
    tool = types.ModuleType("tools.terminal_tool")
    tool.record_session_cwd = lambda key, cwd: store.__setitem__(key, cwd)
    tool.get_session_cwd = lambda key: store.get(key)
    tool.clear_session_cwd = lambda key: store.pop(key, None)
    monkeypatch.setitem(sys.modules, "tools", types.ModuleType("tools"))
    monkeypatch.setitem(sys.modules, "tools.terminal_tool", tool)
    return store


def test_the_servers_saved_directory_decides_where_a_local_chats_terminal_starts(records: dict, tmp_path: pathlib.Path) -> None:
    kept, gone = tmp_path / "kept", tmp_path / "gone"
    kept.mkdir()
    for saved, expected in ((str(kept), str(kept)), (None, None), (str(gone), None), ("relative/dir", None)):
        records["s1"] = "/somewhere/from/the/last/turn"
        read = chat._seed_terminal_cwd("s1", {"workspace_local": True, "terminal_cwd": saved})
        # A new chat or a workspace move sends none, and a removed directory is dropped: the terminal starts where configured.
        assert records.get("s1") == expected, saved
        assert read is not None and read() == expected


def test_a_remote_terminal_or_an_older_server_leaves_the_record_alone(records: dict, tmp_path: pathlib.Path) -> None:
    records["s1"] = str(tmp_path)
    # A remote terminal's directory cannot be checked on the host, and the result reports none.
    assert chat._seed_terminal_cwd("s1", {"workspace_local": False, "terminal_cwd": None}) is None
    assert records["s1"] == str(tmp_path)
    # An older server sends no saved directory: the process-local record still holds, and the turn reports it.
    read = chat._seed_terminal_cwd("s1", {"workspace_local": True})
    assert records["s1"] == str(tmp_path) and read is not None and read() == str(tmp_path)
