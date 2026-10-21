"""TAL-913: workspace checkpoints go through the Agent's own ``CheckpointManager`` (``checkpoints.*``), and a Web turn
takes them when the profile's ``checkpoints.enabled`` is set. Real sidecar, pinned Agent, disposable homes."""

from __future__ import annotations

import json
import pathlib
import subprocess
import textwrap

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, OneToolCallModel, SidecarProcess, isolated_env, requires_agent, serve_model

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


def _agent_writes(home: pathlib.Path, workspace: pathlib.Path, files: dict[str, str]) -> None:
    """The Agent writes ``files`` and records each in its agent-write ledger, as its file tools do after a write."""
    script = textwrap.dedent(
        f"""
        import pathlib
        from tools.checkpoint_manager import CheckpointManager
        manager = CheckpointManager(enabled=True)
        for name, text in {files!r}.items():
            path = pathlib.Path({str(workspace)!r}) / name
            path.write_text(text)
            manager.record_agent_write(str(path))
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


def test_a_restore_keeps_the_users_hand_edits_unless_all_is_set(handshaken: SidecarProcess, hermes_home: pathlib.Path, workspace: pathlib.Path) -> None:
    """TAL-1260: a whole-tree restore reverts only what the Agent wrote, and reports the hand-edited files it kept."""
    (workspace / "agent.txt").write_text("original agent file\n")
    _take_checkpoint(hermes_home, workspace, "before edit")
    _agent_writes(hermes_home, workspace, {"agent.txt": "written by the agent\n", "notes.txt": "written by the agent\n"})
    (workspace / "notes.txt").write_text("edited by hand\n")
    params = {"profile_home": str(hermes_home), "workspace": str(workspace)}
    checkpoint = handshaken.result("checkpoints.list", params)["checkpoints"][0]["hash"]

    kept = handshaken.result("checkpoints.restore", {**params, "checkpoint": checkpoint})
    assert (workspace / "agent.txt").read_text() == "original agent file\n"
    assert (workspace / "notes.txt").read_text() == "edited by hand\n"
    assert kept["kept_user_edits"] == ["notes.txt"]
    assert kept["restored_files"] == ["agent.txt"]
    assert kept["skipped_oversize"] == [] and kept["failed_deletes"] == []

    everything = handshaken.result("checkpoints.restore", {**params, "checkpoint": checkpoint, "all": True})
    assert (workspace / "notes.txt").read_text() == "original text\n"
    assert everything["kept_user_edits"] == [] and everything["restored_files"] is None


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


class _WriteFile(OneToolCallModel):
    """Answers with one ``write_file`` call."""

    target = ""

    def first_call(self, body: dict) -> dict:
        return {"name": "write_file", "arguments": json.dumps({"path": self.target, "content": "written by the turn\n"})}


@pytest.fixture
def llm(workspace: pathlib.Path):
    with serve_model(type("Stub", (_WriteFile,), {"target": str(workspace / "new.txt")})) as url:
        yield url


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
