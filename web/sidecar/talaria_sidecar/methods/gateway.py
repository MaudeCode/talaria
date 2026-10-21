"""``gateway.*``: Hermes gateway lifecycle (start, stop, restart) through the ``hermes`` CLI."""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

from ..errors import InvalidParams
from ..home import _is_named_profile, profile_home_param
from ..rpc import CallContext
from .profiles import _bounded, gateway_mode

log = logging.getLogger("talaria_sidecar.gateway")
# One lifecycle action at a time across every action: overlapping `hermes gateway` subprocesses race each other.
_ACTION_LOCK = threading.Lock()
ACTIONS = ("start", "stop", "restart")
_DONE = {"start": "started", "stop": "stopped", "restart": "restarted"}
# EX_CONFIG: Agent v0.21.6 refuses a named profile's own start/restart with it, since the host gateway serves every profile.
_REFUSED = 78
_SERVED_WAIT_SECONDS = 15.0
# A restart waits out the CLI's own exit budget plus this headroom; 240 s on an Agent without the budget helper.
_RESTART_HEADROOM_SECONDS = 30.0
_RESTART_FALLBACK_SECONDS = 240.0
_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def _hermes_command() -> str:
    found = shutil.which("hermes")
    if found:
        return found
    sibling = Path(sys.executable).parent / "hermes"
    return str(sibling) if sibling.exists() else "hermes"


def _drain(stream, sink: list[str]) -> None:
    try:
        sink.append(stream.read() or "")
    except (OSError, ValueError):
        sink.append("")
    finally:
        try:
            stream.close()
        except OSError:
            pass


def _reason(stdout: str, stderr: str) -> str | None:
    """The Agent's first error line: its first ``✗`` line, else the first line it wrote; one bounded printable line without colour codes."""
    def lines(text: str) -> list[str]:
        return [line.strip() for line in _ANSI.sub("", text).splitlines() if line.strip()]

    first = next((line for line in lines(f"{stdout}\n{stderr}") if line.startswith("✗")), None) or next(iter(lines(stderr or stdout)), "")
    return _bounded(first.lstrip("✗ "), 300) or None


def _host_root(home: Path) -> Path | None:
    """The Hermes root of a ``<root>/profiles/<name>`` home, as the Agent's ``profile_name_for_home`` reads a named profile."""
    return home.parent.parent if home.parent.name == "profiles" and not home.name.startswith(".") and home.name != "default" else None


def _host_serves(home: Path, budget_deadline: float) -> bool:
    """True once the host gateway serves the named profile at ``home`` (TAL-805 ``served``); the host may still be coming up."""
    deadline = min(time.monotonic() + _SERVED_WAIT_SECONDS, budget_deadline)
    while True:
        try:
            if gateway_mode(home, home.name, False) == "served":
                return True
        except Exception:  # noqa: BLE001
            log.debug("gateway mode probe failed for %s", home, exc_info=True)
            return False
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.5)


def control(action: str, home: Path, cli_profile: str | None, ctx: CallContext, *, quick_timeout: float, background_wait: float, interrupt: bool = False) -> dict:
    if action not in ACTIONS:
        raise InvalidParams("unsupported gateway action")
    if not _ACTION_LOCK.acquire(blocking=False):
        return {"status": "busy", "message": "Another gateway action is already in progress. Please wait a moment and try again."}
    try:
        # One budget for the whole action, host fallback included: each step gets only what is left of it.
        deadline = time.monotonic() + quick_timeout + background_wait

        def run(action: str, home: Path, cli_profile: str | None) -> dict:
            left = deadline - time.monotonic()
            if left <= 0:
                return {"status": "failed", "message": f"Gateway {action} ran out of time before it could start", "timed_out": True}
            quick = min(quick_timeout, left)
            return _run(action, home, cli_profile, ctx, quick_timeout=quick, background_wait=left - quick, interrupt=interrupt)

        result = run(action, home, cli_profile)
        root = _host_root(home)
        # TAL-884: Agent v0.21.6 gives a named profile no gateway of its own. Start the host gateway from the root profile
        # (`--profile default`, so a sticky active profile cannot retarget it), then rerun the profile's action, which
        # serves or unparks it there. Never `--force`: that grows the per-profile fleet member the Agent refuses.
        if action == "stop" or root is None or result.get("returncode") != _REFUSED:
            return result
        log.info("Gateway %s refused for %s; starting the host gateway from %s", action, home, root)
        host = run("start", root, "default")
        if host["status"] != "completed":
            return host
        result = run(action, home, cli_profile)
        if result.get("returncode") == _REFUSED and _host_serves(home, deadline):
            return {"status": "completed", "message": f"Gateway service {_DONE[action]} successfully", "detail": result.get("detail", "")}
        return result
    finally:
        _ACTION_LOCK.release()


def _profile_selector(home: Path) -> str | None:
    """The profile the Agent names ``home`` (``default`` for the root; None for no profile home): a selector-less verb would
    follow the sticky ``active_profile``. Raises ImportError on an Agent without ``profile_name_for_home``."""
    from hermes_constants import profile_name_for_home

    return profile_name_for_home(home)


def _child_env(home: Path, profile: str | None, action: str) -> dict:
    """The CLI's environment. The sidecar's ``os.environ`` carries its launch profile's ``.env`` once chat ran, so only the
    launch home's own root-profile action keeps it; any other profile starts scrubbed of it and loads its own ``.env``."""
    if profile is None or (profile == "default" and not _is_named_profile(home)):
        env = dict(os.environ)
        env["HERMES_HOME"] = str(home)
    else:
        from hermes_cli.web_server_gateway import _profile_action_environment

        env = _profile_action_environment(["--profile", profile, "gateway", action])
    env.pop("HERMES_EXEC_ASK", None)  # the sidecar's own approval posture, not the gateway's
    return env


# The CLI's own restart budget, read as the CLI reads it: in the child's environment once its home's .env has loaded.
_BUDGET_SCRIPT = (
    "import os, sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); "
    "from hermes_cli.env_loader import load_hermes_dotenv; "
    "load_hermes_dotenv(hermes_home=os.environ['HERMES_HOME'], project_env=Path(sys.argv[1]) / '.env'); "
    "from hermes_cli.gateway import _get_restart_exit_wait_budget; print(_get_restart_exit_wait_budget())"
)


def _agent_restart_budget(env: dict) -> float:
    import hermes_cli

    agent_dir = str(Path(hermes_cli.__file__).resolve().parent.parent)
    out = subprocess.run([sys.executable, "-c", _BUDGET_SCRIPT, agent_dir], env=env, capture_output=True, text=True, timeout=60, check=True).stdout
    return float(out.split()[-1])


def _restart_wait(home: Path, cli_profile: str | None = None) -> float:
    """The Agent CLI's own restart wait for ``home`` plus headroom, so Web never kills a restart the CLI still waits on."""
    try:
        profile = cli_profile or _profile_selector(home)
        return _agent_restart_budget(_child_env(home, profile, "restart")) + _RESTART_HEADROOM_SECONDS
    except Exception:  # noqa: BLE001 - an Agent without the helper, or an unreadable config, gets the historical wait
        log.warning("Could not read the Agent's restart budget for %s", home, exc_info=True)
        return _RESTART_FALLBACK_SECONDS


def _run(action: str, home: Path, cli_profile: str | None, ctx: CallContext, *, quick_timeout: float, background_wait: float, interrupt: bool = False) -> dict:
    """One ``hermes --profile <name> gateway <action>`` subprocess for ``home``; the caller holds ``_ACTION_LOCK``."""
    try:
        profile = cli_profile or _profile_selector(home)
    except ImportError:
        # Selector-less, the CLI would follow the sticky profile, and a named profile's would inherit the launch profile's credentials.
        return {"status": "failed", "message": f"Gateway {action} refused: the installed Hermes Agent cannot name the profile at {home}"}
    try:
        env = _child_env(home, profile, action)
    except Exception as exc:  # noqa: BLE001 - never start a named profile's gateway with another profile's credentials
        log.warning("Could not build the %s profile's gateway environment", profile, exc_info=True)
        return {"status": "failed", "message": f"Could not isolate the {profile} profile's environment: {getattr(exc, 'detail', None) or exc}"}
    cmd = [_hermes_command()]
    if profile:
        cmd.extend(["--profile", profile])
    cmd.extend(["gateway", action])
    try:
        from hermes_cli import gateway_lifecycle_guards  # noqa: F401 - installed CLI capability
    except ImportError:
        pass
    else:
        if interrupt and action in ("stop", "restart"):
            cmd.append("--yes")
        if action == "restart":
            cmd.append("--detach")
    log.info("Running gateway %s via %s (HERMES_HOME=%s)", action, " ".join(cmd), home)
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    except FileNotFoundError:
        return {"status": "failed", "message": "Hermes CLI not found"}
    # Drain both pipes from the start: a chatty restart must never block on a full pipe and be mistaken for a hang.
    out: list[str] = []
    err: list[str] = []
    drainers = [threading.Thread(target=_drain, args=(proc.stdout, out), daemon=True), threading.Thread(target=_drain, args=(proc.stderr, err), daemon=True)]
    for t in drainers:
        t.start()

    def collected() -> tuple[str, str]:
        for t in drainers:
            t.join(timeout=5)
        return "".join(out).strip(), "".join(err).strip()

    def outcome() -> dict:
        stdout, stderr = collected()
        if proc.returncode == 0:
            return {"status": "completed", "message": f"Gateway service {_DONE[action]} successfully", "detail": stdout or stderr}
        failed = {"status": "failed", "message": f"{action.capitalize()} failed: {stderr or stdout}", "detail": stdout or stderr, "returncode": proc.returncode}
        reason = _reason(stdout, stderr)
        if proc.returncode == 1 and action in ("stop", "restart") and reason and re.fullmatch(rf"Refusing to {action} the gateway: \d+ live session\(s\) would be interrupted\.", reason):
            return {**failed, "status": "busy_live_work", "reason": reason, "message": reason}
        return {**failed, "reason": reason} if reason else failed

    ctx.emit("progress", {"phase": "started"})
    deadline = time.monotonic() + quick_timeout
    while proc.poll() is None and time.monotonic() < deadline:
        time.sleep(0.1)
    if proc.poll() is not None:
        return outcome()
    ctx.emit("progress", {"phase": "draining"})
    deadline = time.monotonic() + background_wait
    while proc.poll() is None and time.monotonic() < deadline:
        if ctx.cancelled:
            break
        time.sleep(0.5)
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
        collected()
        if ctx.cancelled:
            return {"status": "failed", "message": f"Gateway {action} was cancelled and its process terminated", "timed_out": True}
        return {"status": "failed", "message": f"Gateway {action} process timed out after {background_wait:.0f}s and was terminated", "timed_out": True}
    return outcome()


def register(registry) -> None:
    @registry.method("gateway.session")
    def session_(ctx: CallContext, params: dict) -> dict:
        from .gateway_sessions import session

        return session(ctx, params)

    @registry.method("gateway.create")
    def create_(ctx: CallContext, params: dict) -> dict:
        from .gateway_sessions import create

        return create(params)

    def run(ctx: CallContext, params: dict, action: str) -> dict:
        home = profile_home_param(params)
        cli_profile = params.get("cli_profile")
        if cli_profile is not None and not isinstance(cli_profile, str):
            raise InvalidParams("cli_profile must be a string")
        interrupt = params.get("interrupt", False)
        if not isinstance(interrupt, bool):
            raise InvalidParams("interrupt must be a boolean")
        # A restart drains the old gateway first, for as long as the CLI's own budget allows (infinite: no deadline).
        wait = params.get("background_wait_seconds") or (_restart_wait(home, cli_profile or None) if action == "restart" else 60.0)
        return control(action, home, cli_profile or None, ctx, quick_timeout=float(params.get("quick_timeout_seconds") or 2.0), background_wait=float(wait), interrupt=interrupt)

    @registry.method("gateway.control", requires_agent=False)
    def control_(ctx: CallContext, params: dict) -> dict:
        return run(ctx, params, str(params.get("action") or ""))

    @registry.method("gateway.restart", requires_agent=False)
    def restart_(ctx: CallContext, params: dict) -> dict:
        return run(ctx, params, "restart")

    @registry.method("gateway.mode")
    def mode_(ctx: CallContext, params: dict) -> dict:
        name = params.get("name")
        if not isinstance(name, str) or not name.strip():
            raise InvalidParams("name is required")
        return {"gateway_mode": gateway_mode(profile_home_param(params), name, params.get("is_default") is True)}
