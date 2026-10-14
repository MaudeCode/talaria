"""``config.env_write`` edits ``.env`` through the Agent's locked writer (TAL-797)."""

from __future__ import annotations

import pathlib
import subprocess
import threading
import time

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SidecarProcess, isolated_env, requires_agent

# The Agent's own ``save_env_value``, paused between its locked read and its atomic replace until ``go`` exists.
PAUSED_AGENT_WRITE = """
import os, sys, time
sys.path.insert(0, sys.argv[1])
from hermes_cli import config
ready, go = sys.argv[2], sys.argv[3]
if not hasattr(config, "_env_write_lock"):
    sys.exit(3)
original = config._write_env_lines
def paused(*args, **kwargs):
    open(ready, "w").close()
    deadline = time.monotonic() + 30
    while not os.path.exists(go) and time.monotonic() < deadline:
        time.sleep(0.02)
    return original(*args, **kwargs)
config._write_env_lines = paused
config.save_env_value("AGENT_WRITTEN_KEY", "from-agent")
"""


def paused_agent_write(home: pathlib.Path) -> tuple[subprocess.Popen, pathlib.Path]:
    ready, go = home / "agent-ready", home / "agent-go"
    proc = subprocess.Popen([AGENT_PYTHON, "-c", PAUSED_AGENT_WRITE, str(AGENT_DIR), str(ready), str(go)], env=isolated_env(home), stderr=subprocess.PIPE, text=True)
    deadline = time.monotonic() + 30
    while not ready.exists():
        if proc.poll() == 3:
            pytest.skip("Agent predates the locked .env writer")
        assert proc.poll() is None and time.monotonic() < deadline, proc.stderr.read() if proc.stderr else ""
        time.sleep(0.02)
    return proc, go


def env_lines(home: pathlib.Path) -> list[str]:
    return (home / ".env").read_text().splitlines()


@requires_agent
def test_env_write_waits_for_a_concurrent_agent_write(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    (hermes_home / ".env").write_text("EXISTING=1\n")
    agent, go = paused_agent_write(hermes_home)
    answer: dict = {}
    writer = threading.Thread(target=lambda: answer.update(handshaken.call("config.env_write", {"profile_home": str(hermes_home), "updates": {"TALARIA_WRITTEN_KEY": "from-talaria"}})[0]))
    writer.start()
    time.sleep(1)
    go.touch()
    writer.join(timeout=30)
    assert agent.wait(timeout=30) == 0
    assert "error" not in answer, answer
    assert set(env_lines(hermes_home)) >= {"EXISTING=1", "AGENT_WRITTEN_KEY=from-agent", "TALARIA_WRITTEN_KEY=from-talaria"}


@requires_agent
def test_env_write_keeps_comments_and_order_and_ends_owner_only(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    path = hermes_home / ".env"
    path.write_text("# keep me\nA=1\n\nB=2\n")
    path.chmod(0o644)
    params = {"profile_home": str(hermes_home)}
    handshaken.result("config.env_write", {**params, "updates": {"B": None, "C": " three ", "A": "one", "EMPTY": "  ", "ABSENT": None}})
    assert env_lines(hermes_home) == ["# keep me", "A=one", "", "C=three"]
    assert path.stat().st_mode & 0o777 == 0o600
    message, _ = handshaken.call("config.env_write", {**params, "updates": {"D": "x\ny"}})
    assert "newline" in message["error"]["message"]
    assert "D=" not in path.read_text()


@requires_agent
def test_env_write_refuses_an_administrator_managed_key_before_writing(hermes_home: pathlib.Path, tmp_path: pathlib.Path) -> None:
    managed = tmp_path / "managed"
    managed.mkdir()
    (managed / ".env").write_text("PINNED_KEY=admin\n")
    (hermes_home / ".env").write_text("EXISTING=1\n")
    proc = SidecarProcess(hermes_home, env={"HERMES_MANAGED_DIR": str(managed)})
    try:
        from talaria_sidecar import SIDECAR_RPC_VERSION

        proc.result("runtime.handshake", {"rpc_version": SIDECAR_RPC_VERSION})
        message, _ = proc.call("config.env_write", {"profile_home": str(hermes_home), "updates": {"FREE_KEY": "value-1", "PINNED_KEY": "mine"}})
    finally:
        proc.close()
    assert message["error"]["data"]["condition"] == "env_write_refused", message
    assert "PINNED_KEY" in message["error"]["message"]
    assert env_lines(hermes_home) == ["EXISTING=1"]


@requires_agent
def test_env_write_reports_a_held_lock(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    (hermes_home / ".env").write_text("EXISTING=1\n")
    agent, go = paused_agent_write(hermes_home)
    try:
        message, _ = handshaken.call("config.env_write", {"profile_home": str(hermes_home), "updates": {"LATE_KEY": "value"}}, timeout=60)
    finally:
        go.touch()
        agent.wait(timeout=30)
    assert message["error"]["data"]["condition"] == "env_locked", message
    assert "LATE_KEY=value" not in env_lines(hermes_home)


@requires_agent
def test_env_write_never_publishes_into_the_process_environment(hermes_home: pathlib.Path) -> None:
    # A gateway spawned mid-write snapshots os.environ; the key must not appear there at any point of the write.
    script = """
import os, sys
sys.path.insert(0, sys.argv[1])
from pathlib import Path
from hermes_cli import config
from talaria_sidecar.methods.config import env_write
seen = []
original = config.invalidate_env_cache
def observe():
    seen.append(os.environ.get("ROOT_WRITTEN_KEY"))
    return original()
config.invalidate_env_cache = observe
env_write(Path(os.environ["HERMES_HOME"]), {"ROOT_WRITTEN_KEY": "root-value"})
assert seen and seen == [None] * len(seen), seen
assert "ROOT_WRITTEN_KEY" not in os.environ
assert "ROOT_WRITTEN_KEY=root-value" in (Path(os.environ["HERMES_HOME"]) / ".env").read_text().splitlines()
"""
    result = subprocess.run([AGENT_PYTHON, "-c", script, str(AGENT_DIR)], env=isolated_env(hermes_home), capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
