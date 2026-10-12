"""TAL-913: workspace checkpoints go through the Agent's own ``CheckpointManager`` (``checkpoints.*``), and a Web turn
takes them when the profile's ``checkpoints.enabled`` is set. Real sidecar, pinned Agent, disposable homes."""

from __future__ import annotations

import json
import pathlib
import subprocess
import textwrap
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SidecarProcess, isolated_env, requires_agent

pytestmark = requires_agent


def _git(*args: str, cwd: pathlib.Path) -> None:
    env = {"PATH": "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}
    subprocess.run(["git", *args], cwd=cwd, env=env, check=True, capture_output=True)


def _take_checkpoint(home: pathlib.Path, workspace: pathlib.Path, reason: str) -> None:
    """The Agent's ``CheckpointManager`` snapshots ``workspace`` into ``home``'s store, as a CLI turn would."""
    script = textwrap.dedent(
        f"""
        from tools.checkpoint_manager import CheckpointManager
        assert CheckpointManager(enabled=True).ensure_checkpoint({str(workspace)!r}, {reason!r})
        """
    )
    subprocess.run([AGENT_PYTHON, "-c", script], env=isolated_env(home, PYTHONPATH=str(AGENT_DIR)), check=True, timeout=60)


@pytest.fixture
def workspace(hermes_home: pathlib.Path) -> pathlib.Path:
    path = hermes_home.parent / "project"
    path.mkdir()
    (path / "notes.txt").write_text("original text\n")
    return path.resolve()


def test_a_checkpoint_the_agent_took_is_listed_diffed_and_restored(handshaken: SidecarProcess, hermes_home: pathlib.Path, workspace: pathlib.Path) -> None:
    _take_checkpoint(hermes_home, workspace, "before edit")
    (workspace / "notes.txt").write_text("edited by the agent\n")
    params = {"profile_home": str(hermes_home), "workspace": str(workspace)}

    listed = handshaken.result("checkpoints.list", params)
    assert [c["reason"] for c in listed["checkpoints"]] == ["before edit"]
    checkpoint = listed["checkpoints"][0]
    assert len(checkpoint["hash"]) == 40 and checkpoint["timestamp"]
    assert pathlib.Path(listed["store"]).parent == hermes_home / "checkpoints"

    diff = handshaken.result("checkpoints.diff", {**params, "checkpoint": checkpoint["hash"]})
    assert "-original text" in diff["diff"] and "+edited by the agent" in diff["diff"]

    restored = handshaken.result("checkpoints.restore", {**params, "checkpoint": checkpoint["hash"]})
    assert restored["restored_to"] == checkpoint["hash"][:8]
    assert (workspace / "notes.txt").read_text() == "original text\n"
    # The Agent snapshots the edited tree first, so the restore itself can be undone.
    assert [c["reason"] for c in handshaken.result("checkpoints.list", params)["checkpoints"]][0].startswith("pre-rollback snapshot")


def test_an_unknown_checkpoint_is_the_agents_refusal(handshaken: SidecarProcess, hermes_home: pathlib.Path, workspace: pathlib.Path) -> None:
    _take_checkpoint(hermes_home, workspace, "before edit")
    message, _ = handshaken.call("checkpoints.diff", {"profile_home": str(hermes_home), "workspace": str(workspace), "checkpoint": "0" * 40})
    assert message["error"]["data"]["condition"] == "checkpoint_failed"
    assert "not a checkpoint of this workspace" in message["error"]["message"]
    message, _ = handshaken.call("checkpoints.restore", {"profile_home": str(hermes_home), "workspace": str(workspace), "checkpoint": "--patch"})
    assert message["error"]["data"]["condition"] == "checkpoint_failed"


def test_a_checkpoint_of_another_workspace_is_refused(handshaken: SidecarProcess, hermes_home: pathlib.Path, workspace: pathlib.Path) -> None:
    other = hermes_home.parent / "other"
    other.mkdir()
    (other / "notes.txt").write_text("other project\n")
    _take_checkpoint(hermes_home, other.resolve(), "before other edit")
    _take_checkpoint(hermes_home, workspace, "before edit")
    foreign = handshaken.result("checkpoints.list", {"profile_home": str(hermes_home), "workspace": str(other.resolve())})["checkpoints"][0]["hash"]
    params = {"profile_home": str(hermes_home), "workspace": str(workspace), "checkpoint": foreign}
    for method in ("checkpoints.diff", "checkpoints.restore"):
        message, _ = handshaken.call(method, params)
        assert message["error"]["data"]["condition"] == "checkpoint_failed", (method, message)
        assert "not a checkpoint of this workspace" in message["error"]["message"]
    assert sorted(p.name for p in workspace.iterdir()) == ["notes.txt"]
    assert (workspace / "notes.txt").read_text() == "original text\n"


@pytest.mark.skipif(AGENT_DIR is None or "were not captured" not in (AGENT_DIR / "tools" / "checkpoint_manager.py").read_text(),
                    reason="this Agent release predates the nested-repository restore refusal")
def test_a_restore_over_an_uncaptured_nested_repository_is_refused(handshaken: SidecarProcess, hermes_home: pathlib.Path, workspace: pathlib.Path) -> None:
    nested = workspace / "vendor"
    nested.mkdir()
    (nested / "lib.txt").write_text("nested\n")
    _git("init", "-q", cwd=nested)
    _git("add", "-A", cwd=nested)
    _git("commit", "-q", "-m", "nested", cwd=nested)
    _take_checkpoint(hermes_home, workspace, "before edit")
    (workspace / "notes.txt").write_text("edited by the agent\n")
    params = {"profile_home": str(hermes_home), "workspace": str(workspace)}
    checkpoint = handshaken.result("checkpoints.list", params)["checkpoints"][0]["hash"]

    message, _ = handshaken.call("checkpoints.restore", {**params, "checkpoint": checkpoint})
    assert message["error"]["data"]["condition"] == "checkpoint_failed"
    assert "nested git repositories" in message["error"]["message"] and "vendor" in message["error"]["message"]
    assert (workspace / "notes.txt").read_text() == "edited by the agent\n"


class _WriteFileStub(BaseHTTPRequestHandler):
    """An OpenAI-compatible model that answers the first request with one ``write_file`` call, then with text."""

    target = ""

    def log_message(self, *args):  # noqa: D102 - quiet
        pass

    def do_GET(self):  # noqa: N802 - model probes: no metadata
        self.send_response(404)
        self.end_headers()

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        answered = any(m.get("role") == "tool" for m in body.get("messages", []))
        call = {"index": 0, "id": "call_1", "type": "function", "function": {"name": "write_file", "arguments": json.dumps({"path": self.target, "content": "written by the turn\n"})}}
        delta, finish = ({"role": "assistant", "content": "done"}, "stop") if answered else ({"role": "assistant", "content": None, "tool_calls": [call]}, "tool_calls")
        if body.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for chunk_delta, chunk_finish in ((delta, None), ({}, finish)):
                chunk = {"id": "c1", "object": "chat.completion.chunk", "created": 0, "model": "stub", "choices": [{"index": 0, "delta": chunk_delta, "finish_reason": chunk_finish}]}
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
            return
        message = {k: v for k, v in delta.items()}
        if "tool_calls" in message:
            message["tool_calls"] = [{k: v for k, v in c.items() if k != "index"} for c in message["tool_calls"]]
        payload = {"id": "c1", "object": "chat.completion", "created": 0, "model": "stub", "choices": [{"index": 0, "message": message, "finish_reason": finish}], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture
def llm(workspace: pathlib.Path):
    handler = type("Stub", (_WriteFileStub,), {"target": str(workspace / "new.txt")})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}/v1"
    server.shutdown()


@pytest.mark.parametrize("section, taken", [("checkpoints:\n  enabled: true\n", True), ("checkpoints: true\n", True), ("", False), ("checkpoints:\n  enabled: 'false'\n", False)],
                         ids=["enabled", "legacy-bool", "default-off", "quoted-false"])
def test_a_web_turn_takes_a_checkpoint_only_when_the_profile_enables_them(hermes_home: pathlib.Path, workspace: pathlib.Path, llm: str, section: str, taken: bool) -> None:
    (hermes_home / "config.yaml").write_text(f"model:\n  provider: custom\n  default: stub-model\n  base_url: {llm}\n  api_key: sk-stub\n{section}")
    proc = SidecarProcess(hermes_home)
    try:
        params = {"profile_home": str(hermes_home), "session_id": "web-ckpt", "stream_id": "st-ckpt", "user_message": "write the file", "conversation_history": [],
                  "model": "stub-model", "model_provider": "custom", "workspace": str(workspace), "enabled_toolsets": ["file"]}
        result = proc.result("chat.start", params, timeout=120)
        assert result["status"] == "completed", (result, proc.stderr_lines[-20:])
        assert (workspace / "new.txt").read_text() == "written by the turn\n"
        listed = proc.result("checkpoints.list", {"profile_home": str(hermes_home), "workspace": str(workspace)})
        assert [c["reason"] for c in listed["checkpoints"]] == (["before write_file"] if taken else [])
    finally:
        proc.close()
