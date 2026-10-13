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


_REFUSAL = "\033[31m✗ Profile 'work' does not get a gateway of its own.\033[0m\n  Exactly one gateway per host is the inbound process for every\n  profile.\n"


def _host_cli(tmp_path, *, serves_after_host: bool = True, root_exit: int = 0) -> tuple[str, object, Path]:
    """A stand-in v0.21.6 CLI: a named home's start/restart exits 78 until the host gateway runs; ``--profile default`` starts the host."""
    root = tmp_path / ".hermes"
    named = root / "profiles" / "work"
    named.mkdir(parents=True)
    calls = tmp_path / "calls.log"
    host = tmp_path / "host.running"
    script = _script(tmp_path, f"""
        import os, sys
        args = sys.argv[1:]
        with open({str(calls)!r}, "a") as f:
            f.write(os.environ["HERMES_HOME"] + " " + " ".join(args) + "\\n")
        if args[:2] == ["--profile", "default"]:
            if {root_exit}:
                sys.stderr.write("launchctl bootstrap failed\\n")
                sys.exit({root_exit})
            open({str(host)!r}, "w").close()
            print("Gateway started")
            sys.exit(0)
        if os.environ["HERMES_HOME"].endswith("/profiles/work") and args[-1] in ("start", "restart"):
            if {serves_after_host} and os.path.exists({str(host)!r}) and not os.path.exists({str(host)!r} + ".served"):
                open({str(host)!r} + ".served", "w").close()
                print("Profile 'work' served by the host gateway.")
                sys.exit(0)
            sys.stdout.write({_REFUSAL!r})
            sys.exit(78)
        print("ok")
    """)
    return script, calls, named


def _agent_profiles(monkeypatch, root: Path) -> None:
    """Stand-in Agent profile helpers for ``root``: its homes name themselves, and a named profile's child env pins its home."""
    constants = types.ModuleType("hermes_constants")
    constants.profile_name_for_home = lambda home: "default" if Path(home) == root else Path(home).name if Path(home).parent == root / "profiles" else None
    monkeypatch.setitem(sys.modules, "hermes_constants", constants)
    monkeypatch.setitem(sys.modules, "hermes_cli", types.ModuleType("hermes_cli"))
    web = types.ModuleType("hermes_cli.web_server_gateway")
    web._profile_action_environment = lambda argv: {**os.environ, "HERMES_HOME": str(root / "profiles" / argv[1])}
    monkeypatch.setitem(sys.modules, "hermes_cli.web_server_gateway", web)


def _calls(calls) -> list[str]:
    return calls.read_text().splitlines() if calls.exists() else []


@pytest.mark.parametrize("action", ["start", "restart"])
def test_a_refused_named_profile_starts_the_host_gateway_then_reruns_its_action(tmp_path, monkeypatch, action) -> None:
    script, calls, named = _host_cli(tmp_path)
    _agent_profiles(monkeypatch, named.parent.parent)
    monkeypatch.setattr(gateway, "_hermes_command", lambda: sys.executable)
    monkeypatch.setattr(gateway.subprocess, "Popen", _popen_with_script(script))
    result = gateway.control(action, named, None, _Ctx(), quick_timeout=2.0, background_wait=5.0)
    assert result["status"] == "completed", result
    assert _calls(calls) == [f"{named} --profile work gateway {action}", f"{named.parent.parent} --profile default gateway start", f"{named} --profile work gateway {action}"]


def test_a_refusal_the_host_resolves_reads_as_started_when_the_host_serves_the_profile(tmp_path, monkeypatch) -> None:
    script, calls, named = _host_cli(tmp_path, serves_after_host=False)
    _agent_profiles(monkeypatch, named.parent.parent)
    monkeypatch.setattr(gateway, "_hermes_command", lambda: sys.executable)
    monkeypatch.setattr(gateway.subprocess, "Popen", _popen_with_script(script))
    monkeypatch.setattr(gateway, "gateway_mode", lambda home, name, is_default: "served" if (home, name, is_default) == (named, "work", False) else "stopped")
    result = gateway.control("start", named, None, _Ctx(), quick_timeout=2.0, background_wait=5.0)
    assert result["status"] == "completed", result
    assert len(_calls(calls)) == 3


def test_an_unresolved_refusal_reports_the_agents_first_error_line(tmp_path, monkeypatch) -> None:
    script, calls, named = _host_cli(tmp_path, serves_after_host=False)
    _agent_profiles(monkeypatch, named.parent.parent)
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
    _agent_profiles(monkeypatch, named.parent.parent)
    monkeypatch.setattr(gateway, "_hermes_command", lambda: sys.executable)
    monkeypatch.setattr(gateway.subprocess, "Popen", _popen_with_script(script))
    result = gateway.control("start", named, None, _Ctx(), quick_timeout=2.0, background_wait=5.0)
    assert result["status"] == "failed" and result["returncode"] == 3 and result["reason"] == "launchctl bootstrap failed", result
    assert len(_calls(calls)) == 2


def test_an_older_agent_that_starts_the_named_profile_runs_one_call(tmp_path, monkeypatch) -> None:
    named = tmp_path / ".hermes" / "profiles" / "work"
    named.mkdir(parents=True)
    _agent_profiles(monkeypatch, tmp_path / ".hermes")
    spawned: list[list[str]] = []
    real = _popen_with_script(_script(tmp_path, "print('started')\n"))
    monkeypatch.setattr(gateway, "_hermes_command", lambda: sys.executable)
    monkeypatch.setattr(gateway.subprocess, "Popen", lambda cmd, **kw: spawned.append(cmd) or real(cmd, **kw))
    assert gateway.control("start", named, None, _Ctx(), quick_timeout=2.0, background_wait=5.0)["status"] == "completed"
    assert len(spawned) == 1


@pytest.mark.parametrize(("action", "home"), [("stop", ".hermes/profiles/work"), ("start", ".hermes")])
def test_a_refused_stop_or_root_profile_action_is_not_retried(tmp_path, monkeypatch, action, home) -> None:
    (tmp_path / home).mkdir(parents=True)
    _agent_profiles(monkeypatch, tmp_path / ".hermes")
    spawned: list[list[str]] = []
    real = _popen_with_script(_script(tmp_path, "import sys\nprint('✗ refused')\nsys.exit(78)\n"))
    monkeypatch.setattr(gateway, "_hermes_command", lambda: sys.executable)
    monkeypatch.setattr(gateway.subprocess, "Popen", lambda cmd, **kw: spawned.append(cmd) or real(cmd, **kw))
    result = gateway.control(action, tmp_path / home, None, _Ctx(), quick_timeout=2.0, background_wait=5.0)
    assert result["returncode"] == 78 and result["reason"] == "refused" and len(spawned) == 1, result


def test_the_host_fallback_shares_one_deadline_across_every_step(tmp_path, monkeypatch) -> None:
    named = tmp_path / ".hermes" / "profiles" / "work"
    named.mkdir(parents=True)
    marker = tmp_path / "refused"
    _agent_profiles(monkeypatch, tmp_path / ".hermes")
    script = _script(tmp_path, f"""
        import os, sys, time
        if sys.argv[1:3] == ["--profile", "default"]:
            time.sleep(1.5)
            sys.exit(0)
        if not os.path.exists({str(marker)!r}):
            open({str(marker)!r}, "w").close()
            print("✗ Profile 'work' does not get a gateway of its own.")
            sys.exit(78)
        time.sleep(30)
    """)
    monkeypatch.setattr(gateway, "_hermes_command", lambda: sys.executable)
    monkeypatch.setattr(gateway.subprocess, "Popen", _popen_with_script(script))
    started = time.monotonic()
    result = gateway.control("start", named, None, _Ctx(), quick_timeout=0.1, background_wait=2.0)
    assert result.get("timed_out") is True, result
    assert time.monotonic() - started < 3.0


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


def _agent_budget(monkeypatch, budget: float | None) -> list:
    """Stand-in Agent modules: ``_get_restart_exit_wait_budget`` returns ``budget`` (absent when None); returns the homes it was scoped to."""
    scoped: list = []
    constants = types.ModuleType("hermes_constants")
    constants.set_hermes_home_override = lambda home: scoped.append(home) or "token"
    constants.reset_hermes_home_override = lambda token: scoped.append(None)
    monkeypatch.setitem(sys.modules, "hermes_constants", constants)
    cli = types.ModuleType("hermes_cli")
    monkeypatch.setitem(sys.modules, "hermes_cli", cli)
    if budget is None:
        monkeypatch.setitem(sys.modules, "hermes_cli.gateway", None)
    else:
        module = types.ModuleType("hermes_cli.gateway")
        module._get_restart_exit_wait_budget = lambda: budget
        monkeypatch.setitem(sys.modules, "hermes_cli.gateway", module)
    return scoped


def _fast_clock(monkeypatch, scale: float = 100.0) -> None:
    """The gateway module's clock runs ``scale`` times real time, so a few real seconds read as minutes."""
    start = time.monotonic()
    monkeypatch.setattr(gateway, "time", types.SimpleNamespace(monotonic=lambda: start + (time.monotonic() - start) * scale, sleep=time.sleep))


@pytest.mark.parametrize(("budget", "status"), [(400.0, "completed"), (float("inf"), "completed"), (None, "failed")])
def test_a_restart_waits_out_the_agents_own_restart_budget(tmp_path, monkeypatch, budget, status) -> None:
    # TAL-894: the CLI drains for up to its own budget (default 1885 s). At 100x, the stand-in's 2.8 s is 280 s: past the old
    # 240 s wait (the fallback when the helper is missing), inside a 400 s budget's 430 s.
    script = _script(tmp_path, "import time\ntime.sleep(2.8)\nprint('restarted')\n")
    monkeypatch.setattr(gateway, "_hermes_command", lambda: sys.executable)
    monkeypatch.setattr(gateway.subprocess, "Popen", _popen_with_script(script))
    scoped = _agent_budget(monkeypatch, budget)
    _fast_clock(monkeypatch)
    result = _restart_method()(_Ctx(), {"profile_home": str(tmp_path)})
    assert result["status"] == status, result
    if budget is None:
        assert result["timed_out"] is True and "240s" in result["message"], result
    else:
        assert scoped == [tmp_path, None]


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
def test_every_action_names_the_requested_profile_not_the_sticky_active_one(tmp_path, hermes_home) -> None:
    _profile(hermes_home, "work")
    b = _profile(hermes_home, "b")
    (hermes_home / "active_profile").write_text("work\n")
    proc, run = _cli_sidecar(tmp_path, hermes_home)
    try:
        assert run(hermes_home, "restart")["argv"] == ["--profile", "default", "gateway", "restart"]
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
