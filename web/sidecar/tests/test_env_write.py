"""``config.env_write`` edits ``.env`` through the Agent's locked writer (TAL-797)."""

from __future__ import annotations

import os
import pathlib
import subprocess
import time

from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, SidecarProcess, isolated_env, requires_agent

# The Agent's own ``save_env_value``, paused between its locked read and its atomic replace until ``go`` exists.
PAUSED_AGENT_WRITE = """
import os, sys, time
sys.path.insert(0, sys.argv[1])
from hermes_cli import config
ready, go = sys.argv[2], sys.argv[3]
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


def wait_for_mark(mark: pathlib.Path, proc: subprocess.Popen) -> None:
    """Wait, under one shared ceiling, until ``proc`` creates ``mark``; it must still be running then."""
    deadline = time.monotonic() + 30
    while not mark.exists():
        assert proc.poll() is None, f"exited {proc.returncode} before {mark.name}: {proc.stderr.read() if proc.stderr else ''}"
        assert time.monotonic() < deadline, f"{mark.name} never appeared"
        time.sleep(0.02)
    assert proc.poll() is None


def paused_agent_write(home: pathlib.Path) -> tuple[subprocess.Popen, pathlib.Path]:
    ready, go = home / "agent-ready", home / "agent-go"
    proc = subprocess.Popen([AGENT_PYTHON, "-c", PAUSED_AGENT_WRITE, str(AGENT_DIR), str(ready), str(go)], env=isolated_env(home), stderr=subprocess.PIPE, text=True)
    wait_for_mark(ready, proc)
    return proc, go


def env_lines(home: pathlib.Path) -> list[str]:
    return (home / ".env").read_text().splitlines()


# ``env_write`` in the Agent interpreter, marking ``contending`` when it asks for the Agent's ``.env`` lock.
CONTENDING_WRITE = """
import os, sys
from pathlib import Path
from hermes_cli import auth
from talaria_sidecar.methods.config import env_write
home, contending = Path(os.environ["HERMES_HOME"]), Path(sys.argv[1])
original = auth._file_lock
def observed(path, *args, **kwargs):
    if Path(path).resolve() == (home / ".env.lock").resolve():
        contending.touch()
    return original(path, *args, **kwargs)
auth._file_lock = observed
env_write(home, {"TALARIA_WRITTEN_KEY": "from-talaria"})
"""


@requires_agent
def test_env_write_waits_for_a_concurrent_agent_write(hermes_home: pathlib.Path) -> None:
    (hermes_home / ".env").write_text("EXISTING=1\n")
    agent, go = paused_agent_write(hermes_home)
    contending = hermes_home / "talaria-contending"
    writer = subprocess.Popen([AGENT_PYTHON, "-c", CONTENDING_WRITE, str(contending)], env=isolated_env(hermes_home,
        PYTHONPATH=str(SIDECAR_ROOT) + os.pathsep + str(AGENT_DIR)), stderr=subprocess.PIPE, text=True)
    try:
        # The Agent holds the lock mid-write: once the write has asked for it, it cannot finish before the Agent's.
        wait_for_mark(contending, writer)
    finally:
        go.touch()
        assert agent.wait(timeout=30) == 0
        assert writer.wait(timeout=30) == 0, writer.stderr.read() if writer.stderr else ""
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
    for value in ("sk-caf\u00e9-1234", "sk-a b", 'sk-a"b', "sk-a'b", "sk-a#b", "sk-a\tb"):
        message, _ = handshaken.call("config.env_write", {**params, "updates": {"E": value}})
        assert "non-ASCII" in message["error"]["message"], (value, message)
    assert "E=" not in path.read_text()


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
def test_native_lock_timeout_maps_to_env_locked(hermes_home: pathlib.Path) -> None:
    (hermes_home / '.env').write_text('EXISTING=1\n')
    holder, go = paused_agent_write(hermes_home)
    script = '''import os
from pathlib import Path
from hermes_cli import auth
from talaria_sidecar.errors import RpcError
from talaria_sidecar.methods.config import env_write
home=Path(os.environ['HERMES_HOME'])
original=auth._file_lock
budgets=[]
def short_budget(path, holder, timeout, message, *args, **kwargs):
 if Path(path).resolve()==(home/'.env.lock').resolve():
  budgets.append(timeout)
  timeout=.02
 return original(path, holder, timeout, message, *args, **kwargs)
auth._file_lock=short_budget
try: env_write(home, {'LATE_KEY':'value'})
except RpcError as error: assert error.data['condition']=='env_locked', error.data
else: raise AssertionError('native held lock did not time out')
assert budgets and all(timeout>.02 for timeout in budgets), budgets
assert (home/'.env').read_text()=='EXISTING=1\\n'
'''
    try:
        result = subprocess.run([AGENT_PYTHON, '-c', script], env=isolated_env(hermes_home,
            PYTHONPATH=str(SIDECAR_ROOT) + os.pathsep + str(AGENT_DIR)), capture_output=True, text=True, timeout=30)
        assert result.returncode == 0, result.stdout + result.stderr
    finally:
        go.touch()
        assert holder.wait(timeout=30) == 0
    assert 'LATE_KEY=value' not in env_lines(hermes_home)


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
