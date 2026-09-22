"""``gateway.restart`` drives the CLI as a subprocess; driven in-process with a stand-in command."""

from __future__ import annotations

import sys
import textwrap

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
    result = gateway.restart(tmp_path, None, _Ctx(), quick_timeout=0.2, background_wait=5.0)
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
    result = gateway.restart(tmp_path, None, _Ctx(), quick_timeout=2.0, background_wait=5.0)
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
    result = gateway.restart(tmp_path, None, ctx, quick_timeout=0.1, background_wait=0.6)
    assert result["status"] == "failed" and "timed out" in result["message"]
    assert [e for e, _ in ctx.events] == ["progress", "progress"]


def _popen_with_script(script):
    real = gateway.subprocess.Popen

    def popen(cmd, **kwargs):
        # The stand-in runs the script where the CLI would run: `<python> gateway restart` → `<python> script.py gateway restart`.
        return real([cmd[0], str(script), *cmd[1:]], **kwargs)

    return popen
