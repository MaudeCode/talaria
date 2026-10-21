"""``gateway.control`` (and its ``gateway.restart`` alias) drives the CLI as a subprocess; driven with a stand-in command, in-process or from a real sidecar."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
import threading
import time
import types
from pathlib import Path

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SidecarProcess, isolated_env, requires_agent
from talaria_sidecar.errors import InvalidParams
from talaria_sidecar.methods import gateway


class _Ctx:
    cancelled = False

    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []

    def emit(self, event: str, data: dict) -> None:
        self.events.append((event, data))


@pytest.fixture(autouse=True)
def _agent_names_profiles(tmp_path, monkeypatch) -> None:
    """In-process tests run without the Agent: stand in its profile helpers for a root at ``tmp_path/.hermes``."""
    _agent_profiles(monkeypatch, tmp_path / ".hermes")


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
    assert result == {"status": "failed", "message": "Restart failed: launchd rotating", "detail": "launchd rotating", "returncode": 2, "reason": "launchd rotating"}


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
    def script(cmd, kwargs):
        assert cmd[1:] == ['gateway', action]
        assert kwargs['env']['HERMES_HOME'] == str(tmp_path)
        return 'pid 4242 service details\n', '', 0, 0
    monkeypatch.setattr(gateway, "_hermes_command", lambda: sys.executable)
    monkeypatch.setattr(gateway.subprocess, "Popen", _popen_with_script(script))
    result = gateway.control(action, tmp_path, None, _Ctx(), quick_timeout=2.0, background_wait=5.0)
    assert result["status"] == "completed", result
    assert result["message"] == f"Gateway service {'started' if action == 'start' else 'stopped'} successfully"


def test_failed_stop_reports_the_exit_code(tmp_path, monkeypatch) -> None:
    script = lambda *args: ('partial output\n', 'stop failed\n', 7, 0)
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
    from unittest.mock import Mock
    monkeypatch.setattr(gateway, "_hermes_command", lambda: str(tmp_path / "no-such-hermes"))
    monkeypatch.setattr(gateway.subprocess, 'Popen', Mock(side_effect=FileNotFoundError('synthetic missing CLI')))
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
        if callable(script):
            import io
            stdout, stderr, code, delay = script(cmd, kwargs)
            deadline = gateway.time.monotonic() + delay
            proc = types.SimpleNamespace(stdout=io.StringIO(stdout), stderr=io.StringIO(stderr), returncode=None)
            def poll():
                if proc.returncode is None and gateway.time.monotonic() >= deadline:
                    proc.returncode = code
                return proc.returncode
            proc.poll = poll
            proc.terminate = lambda: setattr(proc, 'returncode', -15)
            proc.kill = lambda: setattr(proc, 'returncode', -9)
            proc.wait = lambda **kw: proc.returncode
            return proc
        # The stand-in runs the script where the CLI would run: `<python> gateway restart` → `<python> script.py gateway restart`.
        return real([cmd[0], str(script), *cmd[1:]], **kwargs)

    return popen


_REFUSAL = "\033[31m✗ Profile 'work' does not get a gateway of its own.\033[0m\n  Exactly one gateway per host is the inbound process for every\n  profile.\n"


def _host_cli(tmp_path, *, serves_after_host: bool = True, root_exit: int = 0):
    """Boundary responses from a v0.21.6 CLI; the real control function owns fallback decisions."""
    root = tmp_path / ".hermes"
    named = root / "profiles" / "work"
    named.mkdir(parents=True)
    calls = tmp_path / "calls.log"
    host_started = False

    def response(cmd, kwargs):
        nonlocal host_started
        args = cmd[1:]
        with calls.open('a') as output:
            output.write(kwargs['env']['HERMES_HOME'] + ' ' + ' '.join(args) + '\n')
        if args[:2] == ['--profile', 'default']:
            if root_exit: return '', 'launchctl bootstrap failed\n', root_exit, 0
            host_started = True
            return 'Gateway started\n', '', 0, 0
        if host_started and serves_after_host:
            return "Profile 'work' served by the host gateway.\n", '', 0, 0
        return _REFUSAL, '', 78, 0

    return response, calls, named


def _agent_profiles(monkeypatch, root: Path) -> None:
    """Stand-in Agent profile helpers for ``root``: its homes name themselves, and a named profile's child env pins its home."""
    constants = types.ModuleType("hermes_constants")
    constants.profile_name_for_home = lambda home: "default" if Path(home) == root else Path(home).name if Path(home).parent == root / "profiles" else None
    monkeypatch.setitem(sys.modules, "hermes_constants", constants)
    monkeypatch.setitem(sys.modules, "hermes_cli", types.ModuleType("hermes_cli"))
    web = types.ModuleType("hermes_cli.web_server_gateway")
    web._profile_action_environment = lambda argv: {**os.environ, "HERMES_HOME": str(root if argv[1] == "default" else root / "profiles" / argv[1])}
    monkeypatch.setitem(sys.modules, "hermes_cli.web_server_gateway", web)


def _calls(calls) -> list[str]:
    return calls.read_text().splitlines() if calls.exists() else []


@pytest.mark.parametrize("action", ["start", "restart"])
def test_a_refused_named_profile_starts_the_host_gateway_then_reruns_its_action(tmp_path, monkeypatch, action) -> None:
    script, calls, named = _host_cli(tmp_path)
    monkeypatch.setattr(gateway, "_hermes_command", lambda: sys.executable)
    monkeypatch.setattr(gateway.subprocess, "Popen", _popen_with_script(script))
    result = gateway.control(action, named, None, _Ctx(), quick_timeout=2.0, background_wait=5.0)
    assert result["status"] == "completed", result
    assert _calls(calls) == [f"{named} --profile work gateway {action}", f"{named.parent.parent} --profile default gateway start", f"{named} --profile work gateway {action}"]


def test_a_refusal_the_host_resolves_reads_as_started_when_the_host_serves_the_profile(tmp_path, monkeypatch) -> None:
    script, calls, named = _host_cli(tmp_path, serves_after_host=False)
    monkeypatch.setattr(gateway, "_hermes_command", lambda: sys.executable)
    monkeypatch.setattr(gateway.subprocess, "Popen", _popen_with_script(script))
    monkeypatch.setattr(gateway, "gateway_mode", lambda home, name, is_default: "served" if (home, name, is_default) == (named, "work", False) else "stopped")
    result = gateway.control("start", named, None, _Ctx(), quick_timeout=2.0, background_wait=5.0)
    assert result["status"] == "completed", result
    assert len(_calls(calls)) == 3


def test_an_unresolved_refusal_reports_the_agents_first_error_line(tmp_path, monkeypatch) -> None:
    script, calls, named = _host_cli(tmp_path, serves_after_host=False)
    monkeypatch.setattr(gateway, "_hermes_command", lambda: sys.executable)
    monkeypatch.setattr(gateway.subprocess, "Popen", _popen_with_script(script))
    monkeypatch.setattr(gateway, "gateway_mode", lambda *a: "stopped")
    monkeypatch.setattr(gateway, "_SERVED_WAIT_SECONDS", 0.3)
    result = gateway.control("start", named, None, _Ctx(), quick_timeout=2.0, background_wait=5.0)
    assert result["status"] == "failed" and result["returncode"] == 78, result
    assert result["reason"] == "Profile 'work' does not get a gateway of its own."
    assert "--force" not in calls.read_text()


def test_a_failed_host_start_is_the_reported_failure(tmp_path, monkeypatch) -> None:
    script, calls, named = _host_cli(tmp_path, root_exit=3)
    monkeypatch.setattr(gateway, "_hermes_command", lambda: sys.executable)
    monkeypatch.setattr(gateway.subprocess, "Popen", _popen_with_script(script))
    result = gateway.control("start", named, None, _Ctx(), quick_timeout=2.0, background_wait=5.0)
    assert result["status"] == "failed" and result["returncode"] == 3 and result["reason"] == "launchctl bootstrap failed", result
    assert len(_calls(calls)) == 2


def test_an_older_agent_that_starts_the_named_profile_runs_one_call(tmp_path, monkeypatch) -> None:
    named = tmp_path / ".hermes" / "profiles" / "work"
    named.mkdir(parents=True)
    spawned: list[list[str]] = []
    real = _popen_with_script(lambda *args: ('started\n', '', 0, 0))
    monkeypatch.setattr(gateway, "_hermes_command", lambda: sys.executable)
    monkeypatch.setattr(gateway.subprocess, "Popen", lambda cmd, **kw: spawned.append(cmd) or real(cmd, **kw))
    assert gateway.control("start", named, None, _Ctx(), quick_timeout=2.0, background_wait=5.0)["status"] == "completed"
    assert len(spawned) == 1


@pytest.mark.parametrize(("action", "home"), [("stop", ".hermes/profiles/work"), ("start", ".hermes")])
def test_a_refused_stop_or_root_profile_action_is_not_retried(tmp_path, monkeypatch, action, home) -> None:
    (tmp_path / home).mkdir(parents=True)
    spawned: list[list[str]] = []
    real = _popen_with_script(lambda *args: ('✗ refused\n', '', 78, 0))
    monkeypatch.setattr(gateway, "_hermes_command", lambda: sys.executable)
    monkeypatch.setattr(gateway.subprocess, "Popen", lambda cmd, **kw: spawned.append(cmd) or real(cmd, **kw))
    result = gateway.control(action, tmp_path / home, None, _Ctx(), quick_timeout=2.0, background_wait=5.0)
    assert result["returncode"] == 78 and result["reason"] == "refused" and len(spawned) == 1, result


def test_the_host_fallback_shares_one_deadline_across_every_step(tmp_path, monkeypatch) -> None:
    named = tmp_path / ".hermes" / "profiles" / "work"
    named.mkdir(parents=True)
    responses = iter([(_REFUSAL, '', 78, 0), ('', '', 0, 1.5), ('', '', 0, 30)])
    script = lambda *args: next(responses)
    clock = [0.0]
    def advance(seconds): clock[0] += seconds
    monkeypatch.setattr(gateway, 'time', types.SimpleNamespace(monotonic=lambda: clock[0], sleep=advance))
    monkeypatch.setattr(gateway, "_hermes_command", lambda: sys.executable)
    monkeypatch.setattr(gateway.subprocess, "Popen", _popen_with_script(script))
    result = gateway.control("start", named, None, _Ctx(), quick_timeout=0.1, background_wait=2.0)
    assert result.get("timed_out") is True, result
    assert clock[0] < 3.0


class _Registry:
    def __init__(self) -> None:
        self.methods: dict = {}

    def method(self, name: str, *, requires_agent: bool = True):
        def wrap(fn):
            self.methods[name] = fn
            return fn
        return wrap


def _restart_method():
    registry = _Registry()
    gateway.register(registry)
    return registry.methods["gateway.restart"]


@pytest.mark.parametrize("action", gateway.ACTIONS)
@pytest.mark.parametrize("interrupt", [False, True])
@pytest.mark.parametrize("modern", [False, True])
def test_lifecycle_flags_are_scoped_to_capability_action_and_consent(tmp_path, monkeypatch, action, interrupt, modern) -> None:
    if modern:
        monkeypatch.setitem(sys.modules, "hermes_cli.gateway_lifecycle_guards", types.ModuleType("hermes_cli.gateway_lifecycle_guards"))
    def cli(cmd, kwargs):
        assert cmd[1:] == ["gateway", action, *(["--yes"] if modern and interrupt and action != "start" else []), *(["--detach"] if modern and action == "restart" else [])]
        return "ok", "", 0, 0
    monkeypatch.setattr(gateway.subprocess, "Popen", _popen_with_script(cli))
    result = gateway.control(action, tmp_path, None, _Ctx(), quick_timeout=1, background_wait=1, interrupt=interrupt)
    assert result["status"] == "completed", result


@pytest.mark.parametrize("interrupt", ["true", 1, None])
def test_interrupt_requires_an_actual_boolean(tmp_path, interrupt) -> None:
    with pytest.raises(InvalidParams, match="interrupt must be a boolean"):
        _restart_method()(_Ctx(), {"profile_home": str(tmp_path), "interrupt": interrupt})


@pytest.mark.parametrize("code,reason,status", [
    (1, "Refusing to stop the gateway: 2 live session(s) would be interrupted.", "busy_live_work"),
    (2, "Refusing to stop the gateway: 2 live session(s) would be interrupted.", "failed"),
    (1, "Refusing to stop the gateway: foreign service.", "failed"),
])
def test_only_the_live_work_refusal_is_busy(tmp_path, monkeypatch, code, reason, status) -> None:
    monkeypatch.setattr(gateway.subprocess, "Popen", _popen_with_script(lambda *args: (f"\033[31m✗ {reason}\033[0m\nprivate work details", "", code, 0)))
    result = gateway.control("stop", tmp_path, None, _Ctx(), quick_timeout=1, background_wait=1)
    assert result["status"] == status
    assert result["reason"] == reason


def _agent_budget(monkeypatch, budget: float | None) -> list:
    """The Agent's restart budget reads ``budget`` (raises, as on an Agent without the helper, when None); returns the envs it read."""
    envs: list = []

    def read(env: dict) -> float:
        envs.append(env)
        if budget is None:
            raise ImportError("_get_restart_exit_wait_budget")
        return budget

    monkeypatch.setattr(gateway, "_agent_restart_budget", read)
    return envs


@pytest.mark.parametrize(("budget", "status"), [(400.0, "completed"), (float("inf"), "completed"), (None, "failed")])
def test_a_restart_waits_out_the_agents_own_restart_budget(tmp_path, monkeypatch, budget, status) -> None:
    # TAL-894: the CLI drains for up to its own budget (default 1885 s). At 100x, the stand-in's 2.8 s is 280 s: past the old
    # 240 s wait (the fallback when the helper is missing), inside a 400 s budget's 430 s.
    script = lambda *args: ('restarted\n', '', 0, 280)
    monkeypatch.setattr(gateway, "_hermes_command", lambda: sys.executable)
    monkeypatch.setattr(gateway.subprocess, "Popen", _popen_with_script(script))
    envs = _agent_budget(monkeypatch, budget)
    clock = [0.0]
    def advance(seconds): clock[0] += seconds
    monkeypatch.setattr(gateway, 'time', types.SimpleNamespace(monotonic=lambda: clock[0], sleep=advance))
    result = _restart_method()(_Ctx(), {"profile_home": str(tmp_path)})
    assert result["status"] == status, result
    if budget is None:
        assert result["timed_out"] is True and "240s" in result["message"], result
    assert [env["HERMES_HOME"] for env in envs] == [str(tmp_path)]


def test_cancel_still_terminates_a_restart_with_no_deadline(tmp_path, monkeypatch) -> None:
    script = _script(tmp_path, "import time\ntime.sleep(30)\n")
    monkeypatch.setattr(gateway, "_hermes_command", lambda: sys.executable)
    monkeypatch.setattr(gateway.subprocess, "Popen", _popen_with_script(script))
    _agent_budget(monkeypatch, float("inf"))
    ctx = _Ctx()
    threading.Timer(1.0, lambda: setattr(ctx, "cancelled", True)).start()
    started = time.monotonic()
    result = _restart_method()(ctx, {"profile_home": str(tmp_path)})
    assert result["status"] == "failed" and result["timed_out"] is True and "cancelled" in result["message"], result
    assert time.monotonic() - started < 10


def _cli_sidecar(tmp_path, hermes_home, **env: str):
    """A real sidecar whose ``hermes`` is a stand-in that loads its home's ``.env`` the Agent's way, then logs what it saw."""
    bindir = tmp_path / "bin"
    bindir.mkdir()
    log = tmp_path / "cli.jsonl"
    cli = bindir / "hermes"
    cli.write_text(textwrap.dedent(f"""\
        #!{AGENT_PYTHON}
        import json, os, sys
        sys.path.insert(0, {str(AGENT_DIR)!r})
        from hermes_cli.env_loader import load_hermes_dotenv
        load_hermes_dotenv(hermes_home=os.environ["HERMES_HOME"])
        keys = ("TELEGRAM_BOT_TOKEN", "API_SERVER_PORT", "OPENROUTER_API_KEY", "HERMES_EXEC_ASK")
        with open({str(log)!r}, "a") as f:
            f.write(json.dumps({{"argv": sys.argv[1:], "home": os.environ["HERMES_HOME"], **{{k: os.environ.get(k) for k in keys}}}}) + "\\n")
    """))
    cli.chmod(0o755)
    proc = SidecarProcess(hermes_home, env={"PATH": f"{bindir}{os.pathsep}{os.environ.get('PATH', '')}", **env})

    def run(home, action: str, **params) -> dict:
        start = log.read_text().count("\n") if log.exists() else 0
        result = proc.result("gateway.control", {"profile_home": str(home), "action": action, **params})
        assert result["status"] == "completed", result
        rows = [json.loads(line) for line in log.read_text().splitlines()[start:]]
        assert len(rows) == 1, rows
        return rows[0]

    return proc, run


def _profile(root, name: str, dotenv: str = ""):
    home = root / "profiles" / name
    home.mkdir(parents=True)
    (home / "config.yaml").write_text("model: {}\n")
    if dotenv:
        (home / ".env").write_text(dotenv)
    return home


@requires_agent
def test_live_work_consent_matches_the_installed_gateway_cli(tmp_path, hermes_home) -> None:
    """Actual release capability and refusal formatting, with disposable CLI/work and no real gateway."""
    bindir = tmp_path / "bin"
    bindir.mkdir()
    cli = bindir / "hermes"
    cli.write_text(textwrap.dedent(f"""\
        #!{AGENT_PYTHON}
        import json, sys
        sys.path.insert(0, {str(AGENT_DIR)!r})
        try:
            from hermes_cli import gateway_lifecycle_guards as guards
        except ImportError:
            guards = None
        print(json.dumps(sys.argv[1:]))
        if guards and sys.argv[4] in ('stop', 'restart') and '--yes' not in sys.argv:
            from pathlib import Path
            print('✗ ' + guards._work_lines(sys.argv[4], Path('.'), {{'active_agents': 1}}, 'hermes gateway {{verb}} --yes')[0])
            sys.exit(1)
    """))
    cli.chmod(0o755)
    modern = (AGENT_DIR / "hermes_cli/gateway_lifecycle_guards.py").is_file()
    proc = SidecarProcess(hermes_home, env={"PATH": f"{bindir}{os.pathsep}{os.environ.get('PATH', '')}"})
    try:
        for method in ("gateway.control", "gateway.restart"):
            for interrupt in (False, True):
                result = proc.result(method, {"profile_home": str(hermes_home), "action": "restart", "interrupt": interrupt, "background_wait_seconds": 2})
                if modern and not interrupt:
                    assert result["status"] == "busy_live_work", result
                    assert result["reason"] == "Refusing to restart the gateway: 1 live session(s) would be interrupted."
                else:
                    assert result["status"] == "completed", result
                args = json.loads(result["detail"].splitlines()[0])
                assert args == ["--profile", "default", "gateway", "restart", *(["--yes"] if modern and interrupt else []), *(["--detach"] if modern else [])]
    finally:
        proc.close()


@requires_agent
def test_every_action_names_the_requested_profile_not_the_sticky_active_one(tmp_path, hermes_home) -> None:
    _profile(hermes_home, "work")
    b = _profile(hermes_home, "b")
    (hermes_home / "active_profile").write_text("work\n")
    proc, run = _cli_sidecar(tmp_path, hermes_home)
    try:
        assert run(hermes_home, "restart")["argv"] == ["--profile", "default", "gateway", "restart", *(["--detach"] if (AGENT_DIR / "hermes_cli/gateway_lifecycle_guards.py").is_file() else [])]
        assert run(b, "start")["argv"] == ["--profile", "b", "gateway", "start"]
        assert run(hermes_home, "stop", cli_profile="work")["argv"] == ["--profile", "work", "gateway", "stop"]
    finally:
        proc.close()


@requires_agent
def test_a_named_profiles_gateway_loads_its_own_env_never_the_default_profiles(tmp_path, hermes_home) -> None:
    (hermes_home / ".env").write_text("TELEGRAM_BOT_TOKEN=default-profile-bot-token\nAPI_SERVER_PORT=8642\n")
    work = _profile(hermes_home, "work", "OPENROUTER_API_KEY=work-key\n")
    # The sidecar's environment already holds the default profile's .env, as it does once chat imported run_agent.
    proc, run = _cli_sidecar(tmp_path, hermes_home, TELEGRAM_BOT_TOKEN="default-profile-bot-token", API_SERVER_PORT="8642", HERMES_EXEC_ASK="1")
    try:
        seen = run(work, "start")
        assert seen["home"] == str(work)
        assert (seen["TELEGRAM_BOT_TOKEN"], seen["API_SERVER_PORT"], seen["OPENROUTER_API_KEY"], seen["HERMES_EXEC_ASK"]) == (None, None, "work-key", None), seen
        seen = run(hermes_home, "start")
        assert (seen["TELEGRAM_BOT_TOKEN"], seen["API_SERVER_PORT"], seen["HERMES_EXEC_ASK"]) == ("default-profile-bot-token", "8642", None), seen
    finally:
        proc.close()


@requires_agent
def test_the_restart_wait_is_the_installed_agents_own_budget_plus_headroom(hermes_home) -> None:
    code = f"import sys; sys.path.insert(0, {str(AGENT_DIR)!r}); from pathlib import Path; from talaria_sidecar.methods.gateway import _restart_wait; print(_restart_wait(Path({str(hermes_home)!r})))"
    out = subprocess.run([AGENT_PYTHON, "-c", code], env=isolated_env(hermes_home), capture_output=True, text=True, timeout=120, check=True).stdout
    assert float(out.strip().splitlines()[-1]) > gateway._RESTART_FALLBACK_SECONDS + gateway._RESTART_HEADROOM_SECONDS, out


@pytest.mark.parametrize("action", gateway.ACTIONS)
def test_a_named_profile_whose_selector_cannot_be_resolved_is_refused_without_spawning(tmp_path, monkeypatch, action) -> None:
    named = tmp_path / ".hermes" / "profiles" / "work"
    named.mkdir(parents=True)
    spawned: list[list[str]] = []
    monkeypatch.setitem(sys.modules, "hermes_constants", types.ModuleType("hermes_constants"))  # an Agent without profile_name_for_home
    monkeypatch.setattr(gateway, "_hermes_command", lambda: sys.executable)


    def popen(cmd, **kwargs):
        spawned.append(cmd)
        raise FileNotFoundError(cmd[0])

    monkeypatch.setattr(gateway.subprocess, "Popen", popen)
    result = gateway.control(action, named, None, _Ctx(), quick_timeout=0.1, background_wait=0.1)
    assert spawned == [], spawned
    assert result["status"] == "failed" and "work" in result["message"], result


def test_a_root_profile_action_is_refused_when_the_agent_cannot_name_profiles(tmp_path, monkeypatch) -> None:
    root = tmp_path / ".hermes"
    root.mkdir()
    (root / "active_profile").write_text("work\n")
    spawned: list[list[str]] = []
    monkeypatch.setitem(sys.modules, "hermes_constants", types.ModuleType("hermes_constants"))  # an Agent without profile_name_for_home
    monkeypatch.setattr(gateway, "_hermes_command", lambda: sys.executable)

    def popen(cmd, **kwargs):
        spawned.append(cmd)
        raise FileNotFoundError(cmd[0])

    monkeypatch.setattr(gateway.subprocess, "Popen", popen)
    result = gateway.control("restart", root, None, _Ctx(), quick_timeout=0.1, background_wait=0.1)
    assert spawned == [], spawned
    assert result["status"] == "failed" and "refused" in result["message"], result


@requires_agent
def test_a_named_launch_profile_never_donates_its_env_to_the_default_profiles_gateway(tmp_path, hermes_home) -> None:
    # An isolated deployment launches the sidecar as profiles/work; its environment then holds work's .env, not the root's.
    (hermes_home / ".env").write_text("TELEGRAM_BOT_TOKEN=default-profile-bot-token\n")
    work = _profile(hermes_home, "work", "TELEGRAM_BOT_TOKEN=work-bot-token\nAPI_SERVER_PORT=9000\n")
    proc, run = _cli_sidecar(tmp_path, work, HOME=str(hermes_home.parent), TELEGRAM_BOT_TOKEN="work-bot-token", API_SERVER_PORT="9000")
    try:
        seen = run(hermes_home, "start", cli_profile="default")
        assert (seen["argv"][:2], seen["home"]) == (["--profile", "default"], str(hermes_home)), seen
        assert (seen["TELEGRAM_BOT_TOKEN"], seen["API_SERVER_PORT"]) == ("default-profile-bot-token", None), seen
    finally:
        proc.close()


@requires_agent
def test_the_restart_wait_follows_the_restarted_profiles_own_env(hermes_home) -> None:
    # The CLI reads HERMES_RESTART_AFTER_TURN_TIMEOUT from its own environment after its profile's .env loads, not the sidecar's.
    (hermes_home / ".env").write_text("HERMES_RESTART_AFTER_TURN_TIMEOUT=60\n")
    work = _profile(hermes_home, "work", "HERMES_RESTART_AFTER_TURN_TIMEOUT=7200\n")
    code = (f"import sys; sys.path.insert(0, {str(AGENT_DIR)!r}); from pathlib import Path; from talaria_sidecar.methods.gateway import _restart_wait; "
            f"print(_restart_wait(Path({str(work)!r})), _restart_wait(Path({str(hermes_home)!r})))")
    out = subprocess.run([AGENT_PYTHON, "-c", code], env=isolated_env(hermes_home, HERMES_RESTART_AFTER_TURN_TIMEOUT="60"), capture_output=True, text=True, timeout=180, check=True).stdout
    named, root = (float(value) for value in out.strip().splitlines()[-1].split())
    assert named > 7200 > root, out
