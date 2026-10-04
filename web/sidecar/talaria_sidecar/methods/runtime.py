"""``runtime.*``: handshake, status, environment, shutdown."""

from __future__ import annotations

import os
import re

from .. import SIDECAR_RPC_VERSION
from ..errors import InvalidParams, RpcError
from ..home import edit_launch_env
from ..rpc import CallContext


def register(registry) -> None:
    runtime = registry.runtime

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
        ctx.server.request_shutdown(exit_code=code)
        return {"ok": True}
