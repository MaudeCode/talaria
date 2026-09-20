"""``runtime.*``: handshake, status, shutdown."""

from __future__ import annotations

from .. import SIDECAR_RPC_VERSION
from ..errors import InvalidParams, RpcError
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

    @registry.method("runtime.shutdown", requires_agent=False)
    def shutdown(ctx: CallContext, params: dict) -> dict:
        code = params.get("exit_code", 0)
        if not isinstance(code, int):
            raise InvalidParams("exit_code must be an integer")
        ctx.server.request_shutdown(exit_code=code)
        return {"ok": True}
