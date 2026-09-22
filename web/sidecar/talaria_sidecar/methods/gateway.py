"""``gateway.*``: Hermes gateway lifecycle through the ``hermes`` CLI (ported from api/gateway_restart.py)."""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

from ..errors import InvalidParams
from ..home import profile_home_param
from ..rpc import CallContext

log = logging.getLogger("talaria_sidecar.gateway")
_RESTART_LOCK = threading.Lock()


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


def restart(home: Path, cli_profile: str | None, ctx: CallContext, *, quick_timeout: float, background_wait: float) -> dict:
    if not _RESTART_LOCK.acquire(blocking=False):
        return {"status": "busy", "message": "Restart already in progress. Please wait a moment and try again."}
    try:
        env = dict(os.environ)
        env["HERMES_HOME"] = str(home)
        env.pop("HERMES_EXEC_ASK", None)  # the sidecar's own approval posture, not the gateway's
        cmd = [_hermes_command()]
        if cli_profile:
            cmd.extend(["--profile", cli_profile])
        cmd.extend(["gateway", "restart"])
        log.info("Restarting gateway via %s (HERMES_HOME=%s)", " ".join(cmd), home)
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
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
                return {"status": "completed", "message": "Gateway service restarted successfully", "detail": stdout or stderr}
            return {"status": "failed", "message": f"Restart failed: {stderr or stdout}", "detail": stdout or stderr, "returncode": proc.returncode}

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
            return {"status": "failed", "message": f"Gateway restart process timed out after {background_wait:.0f}s and was terminated"}
        return outcome()
    finally:
        _RESTART_LOCK.release()


def register(registry) -> None:
    @registry.method("gateway.restart", requires_agent=False)
    def restart_(ctx: CallContext, params: dict) -> dict:
        home = profile_home_param(params)
        cli_profile = params.get("cli_profile")
        if cli_profile is not None and not isinstance(cli_profile, str):
            raise InvalidParams("cli_profile must be a string")
        return restart(home, cli_profile or None, ctx, quick_timeout=float(params.get("quick_timeout_seconds") or 2.0), background_wait=float(params.get("background_wait_seconds") or 240.0))
