"""``runtime.*``: handshake, status, environment, shutdown."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from .. import SIDECAR_RPC_VERSION
from ..errors import InvalidParams, RpcError
from ..home import edit_launch_env, _frozen_launch_env
from ..rpc import CallContext


def register(registry) -> None:
    runtime = registry.runtime

    @registry.method("runtime.sync_dependencies", requires_agent=False)
    def sync_dependencies(ctx: CallContext, params: dict) -> dict:
        # Source has already advanced; loading it or checking the old revision would prevent repair.
        expected = params.get("agent_dir")
        root = runtime.agent_dir
        if not isinstance(expected, str) or not expected or root is None or Path(expected).resolve() != root.resolve():
            raise InvalidParams("agent_dir must match the sidecar's configured Agent checkout")
        if not (root / "hermes_cli" / "venv_sync.py").is_file():
            return {"ok": True, "skipped": True, "detail": ""}
        env = _frozen_launch_env()
        env.update(HERMES_HOME=str(runtime.hermes_home), HERMES_DISABLE_LAZY_INSTALLS="1",
                   PYTHONPATH=str(root) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else ""))
        # The supervisor's stdin is a lifetime lease: closing it also covers a killed sidecar.
        with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
            try:
                proc = subprocess.Popen(
                    [sys.executable, str(Path(__file__).parents[1] / "dependency_sync.py"), str(root)],
                    cwd=root, env=env, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr,
                )
            except OSError as exc:
                return {"ok": False, "skipped": False, "detail": str(exc)}
            deadline = time.monotonic() + 300
            try:
                while proc.poll() is None:
                    ctx.check_cancelled()
                    if time.monotonic() >= deadline:
                        return {"ok": False, "skipped": False, "detail": "Agent dependency sync timed out."}
                    ctx.cancel_event.wait(0.05)
            finally:
                proc.stdin.close()
                proc.wait()  # The supervisor terminates and reaps its writer before releasing the lock.
            stdout.seek(0)
            output = stdout.read(4 * 1024 * 1024 + 1)
            stderr.seek(0, os.SEEK_END)
            stderr.seek(max(0, stderr.tell() - 4000))
            diagnostic = stderr.read().decode("utf-8", errors="replace")
            if proc.returncode != 0:
                return {"ok": False, "skipped": False, "detail": diagnostic or output[-4000:].decode("utf-8", errors="replace") or "Agent dependency sync failed."}
            try:
                if len(output) > 4 * 1024 * 1024:
                    raise ValueError("sync output exceeds limit")
                response = json.loads(output)
                if not isinstance(response, dict):
                    raise ValueError("not an object")
            except ValueError:
                return {"ok": False, "skipped": False, "detail": "Agent dependency sync returned an invalid result."}
            return {"ok": response.get("ok") is True, "skipped": False,
                    "detail": str(response.get("detail") or "")[-4000:]}

    @registry.method("runtime.handshake", requires_agent=False)
    def handshake(ctx: CallContext, params: dict) -> dict:
        requested = params.get("rpc_version")
        if requested != SIDECAR_RPC_VERSION:
            ctx.server.request_shutdown(exit_code=3)
            raise RpcError(
                f"sidecar RPC version mismatch: server speaks {requested!r}, sidecar speaks {SIDECAR_RPC_VERSION}",
                condition="sidecar_rpc_version_mismatch",
                data={"server_rpc_version": requested, "sidecar_rpc_version": SIDECAR_RPC_VERSION},
            )
        try:
            runtime.load()
        except RpcError:
            # Report the failed import in the handshake payload; the server
            # decides whether to keep the process for non-Agent methods.
            return runtime.describe()
        return runtime.describe()

    @registry.method("runtime.status", requires_agent=False)
    def status(ctx: CallContext, params: dict) -> dict:
        return runtime.describe()

    @registry.method("runtime.ensure_current", requires_agent=True)
    def ensure_current(ctx: CallContext, params: dict) -> dict:
        return {"current": True, "agent_revision": runtime.revision}

    @registry.method("runtime.env", requires_agent=False)
    def env(ctx: CallContext, params: dict) -> dict:
        """Apply Web-owned ``.env`` edits to this process so Agent calls stop (or start) seeing a credential without a restart."""
        names = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
        to_set = params.get("set") or {}
        to_unset = params.get("unset") or []
        if not isinstance(to_set, dict) or not all(isinstance(k, str) and names.match(k) and isinstance(v, str) for k, v in to_set.items()):
            raise InvalidParams("set must map variable names to strings")
        if not isinstance(to_unset, list) or not all(isinstance(k, str) and names.match(k) for k in to_unset):
            raise InvalidParams("unset must list variable names")
        to_set = {**to_set, "HERMES_DISABLE_LAZY_INSTALLS": "1"}
        for name in to_unset:
            os.environ.pop(name, None)
        for name, value in to_set.items():
            os.environ[name] = value
        edit_launch_env(to_set, to_unset)
        # Cached agents bound the credentials they were built with; none of them may outlive a credential change.
        from .chat import evict_all_agents

        evict_all_agents()
        return {"ok": True}

    @registry.method("runtime.shutdown", requires_agent=False)
    def shutdown(ctx: CallContext, params: dict) -> dict:
        code = params.get("exit_code", 0)
        if not isinstance(code, int):
            raise InvalidParams("exit_code must be an integer")
        from .chat import drain_agents

        drain_agents()
        ctx.server.request_shutdown(exit_code=code)
        return {"ok": True}
