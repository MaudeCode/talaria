"""``gateway.control`` (and its ``gateway.restart`` alias) drives the CLI as a subprocess; driven in-process with a stand-in command."""

from __future__ import annotations

import sys
import textwrap

import pytest

from talaria_sidecar.errors import InvalidParams
from talaria_sidecar.methods import gateway


class _Ctx:
    cancelled = False

    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []

    def emit(self, event: str, data: dict) -> None:
        self.events.append((event, data))


def _script(tmp_path, body: str) -> str:
    path = tmp_path / "fake-hermes.py"
    path.write_text(textwrap.dedent(body))
    return path


def test_restart_survives_a_restart_that_floods_both_pipes(tmp_path, monkeypatch) -> None:
    script = _script(tmp_path, """
        import sys
        assert sys.argv[1:] == ["gateway", "restart"], sys.argv
        sys.stdout.write("out-" * 200000)
        sys.stderr.write("err-" * 200000)
        sys.stdout.write("\\nrestarted\\n")
        sys.exit(0)
    """)
    monkeypatch.setattr(gateway, "_hermes_command", lambda: sys.executable)
    monkeypatch.setattr(gateway.subprocess, "Popen", _popen_with_script(script))
    result = gateway.control("restart", tmp_path, None, _Ctx(), quick_timeout=0.2, background_wait=5.0)
    assert result["status"] == "completed", result
    assert result["detail"].endswith("restarted")


def test_restart_reports_a_failed_exit_with_stderr(tmp_path, monkeypatch) -> None:
    script = _script(tmp_path, """
        import sys
        sys.stderr.write("launchd rotating\\n")
        sys.exit(2)
    """)
    monkeypatch.setattr(gateway, "_hermes_command", lambda: sys.executable)
    monkeypatch.setattr(gateway.subprocess, "Popen", _popen_with_script(script))
    result = gateway.control("restart", tmp_path, None, _Ctx(), quick_timeout=2.0, background_wait=5.0)
    assert result == {"status": "failed", "message": "Restart failed: launchd rotating", "detail": "launchd rotating", "returncode": 2}


def test_restart_terminates_a_hung_child_after_the_background_wait(tmp_path, monkeypatch) -> None:
    script = _script(tmp_path, """
        import sys, time
        sys.stdout.write("x" * 300000)
        sys.stdout.flush()
        time.sleep(30)
    """)
    monkeypatch.setattr(gateway, "_hermes_command", lambda: sys.executable)
    monkeypatch.setattr(gateway.subprocess, "Popen", _popen_with_script(script))
    ctx = _Ctx()
    result = gateway.control("restart", tmp_path, None, ctx, quick_timeout=0.1, background_wait=0.6)
    assert result["status"] == "failed" and "timed out" in result["message"] and result["timed_out"] is True
    assert [e for e, _ in ctx.events] == ["progress", "progress"]


@pytest.mark.parametrize("action", ["start", "stop"])
def test_start_and_stop_run_their_cli_subcommand_in_the_profile_home(tmp_path, monkeypatch, action) -> None:
    script = _script(tmp_path, f"""
        import os, sys
        assert sys.argv[1:] == ["gateway", "{action}"], sys.argv
        assert os.environ["HERMES_HOME"] == {str(tmp_path)!r}
        print("pid 4242 service details")
    """)
    monkeypatch.setattr(gateway, "_hermes_command", lambda: sys.executable)
    monkeypatch.setattr(gateway.subprocess, "Popen", _popen_with_script(script))
    result = gateway.control(action, tmp_path, None, _Ctx(), quick_timeout=2.0, background_wait=5.0)
    assert result["status"] == "completed", result
    assert result["message"] == f"Gateway service {'started' if action == 'start' else 'stopped'} successfully"


def test_failed_stop_reports_the_exit_code(tmp_path, monkeypatch) -> None:
    script = _script(tmp_path, """
        import sys
        sys.stdout.write("partial output\\n")
        sys.stderr.write("stop failed\\n")
        sys.exit(7)
    """)
    monkeypatch.setattr(gateway, "_hermes_command", lambda: sys.executable)
    monkeypatch.setattr(gateway.subprocess, "Popen", _popen_with_script(script))
    result = gateway.control("stop", tmp_path, None, _Ctx(), quick_timeout=2.0, background_wait=5.0)
    assert result["status"] == "failed" and result["returncode"] == 7, result


def test_an_action_in_flight_makes_every_other_action_busy_without_spawning(tmp_path, monkeypatch) -> None:
    spawned: list[list[str]] = []
    monkeypatch.setattr(gateway.subprocess, "Popen", lambda cmd, **kw: spawned.append(cmd))
    assert gateway._ACTION_LOCK.acquire(blocking=False)
    try:
        results = [gateway.control(action, tmp_path, None, _Ctx(), quick_timeout=0.1, background_wait=0.1) for action in gateway.ACTIONS]
    finally:
        gateway._ACTION_LOCK.release()
    assert [r["status"] for r in results] == ["busy", "busy", "busy"]
    assert spawned == []


def test_a_missing_cli_fails_without_raising(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(gateway, "_hermes_command", lambda: str(tmp_path / "no-such-hermes"))
    result = gateway.control("start", tmp_path, None, _Ctx(), quick_timeout=0.1, background_wait=0.1)
    assert result == {"status": "failed", "message": "Hermes CLI not found"}
    assert gateway._ACTION_LOCK.acquire(blocking=False)
    gateway._ACTION_LOCK.release()


def test_an_unsupported_action_is_invalid_params(tmp_path) -> None:
    with pytest.raises(InvalidParams):
        gateway.control("bogus", tmp_path, None, _Ctx(), quick_timeout=0.1, background_wait=0.1)


def _popen_with_script(script):
    real = gateway.subprocess.Popen

    def popen(cmd, **kwargs):
        # The stand-in runs the script where the CLI would run: `<python> gateway restart` → `<python> script.py gateway restart`.
        return real([cmd[0], str(script), *cmd[1:]], **kwargs)

    return popen
