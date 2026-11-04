"""``python -m talaria_sidecar``: serve JSON-RPC over stdio until stdin closes."""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

from .home import _PROCESS_HOME
from .methods import build_methods
from .rpc import DEFAULT_MAX_CALLS, RpcServer
from .runtime import AgentRuntime


def _claim_stdout():
    """Reserve the real stdout for RPC frames; everything else goes to stderr.

    Agent code prints freely (profile deletion confirmations, pip output,
    warnings). A single stray line on stdout would corrupt the JSON-RPC
    channel, so the transport keeps a private duplicate of fd 1 and both
    ``sys.stdout`` and fd 1 itself are redirected to stderr.
    """
    rpc_fd = os.dup(sys.stdout.fileno())
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    return os.fdopen(rpc_fd, "wb", buffering=0)


def _apply_resource_limits() -> None:
    """Cap glibc malloc arenas and raise the open-file soft limit, as the Agent's own servers do (Agent 0.22.6+).

    glibc never unmaps an arena, so this must run before the first worker thread exists. The helpers
    read the profile config themselves, are no-ops off Linux/glibc, and must never stop startup;
    older Agents have no ``hermes_cli.resource_limits`` at all.
    """
    try:
        from hermes_cli import resource_limits
    except Exception:
        return
    for name in ("apply_malloc_arena_max", "apply_nofile_soft_limit"):
        try:
            getattr(resource_limits, name)()
        except Exception:
            logging.getLogger("talaria_sidecar").debug("%s failed", name, exc_info=True)


def main() -> int:
    rpc_out = _claim_stdout()
    logging.basicConfig(stream=sys.stderr, level=os.environ.get("TALARIA_SIDECAR_LOG_LEVEL", "INFO"), format="[sidecar] %(levelname)s %(name)s: %(message)s")
    # Every turn here has a human behind the Web UI: flagged actions must ask (approval cards), never auto-approve.
    os.environ.setdefault("HERMES_EXEC_ASK", "1")
    agent_dir = os.environ.get("TALARIA_SIDECAR_AGENT_DIR") or os.environ.get("HERMES_WEBUI_AGENT_DIR")
    runtime = AgentRuntime(_PROCESS_HOME, Path(agent_dir) if agent_dir else None)
    if runtime.agent_dir is not None and str(runtime.agent_dir) not in sys.path:
        # Append, never prepend: the Agent venv's site-packages must win over
        # any same-named module in the checkout (api/config.py has the history).
        sys.path.append(str(runtime.agent_dir))
    _apply_resource_limits()
    server = RpcServer(build_methods(runtime), stdout=rpc_out, max_calls=int(os.environ.get("TALARIA_SIDECAR_MAX_CALLS") or DEFAULT_MAX_CALLS))
    try:
        return server.serve_forever()
    finally:
        # The server closes stdin to stop the sidecar: end every cached agent's memory session on the way out.
        from .methods.chat import drain_agents
        from .agent_mutation import close_all
        from .methods.dashboard_plugins import close_dashboard_sources

        try:
            close_all()
            drain_agents()
        finally:
            try:
                runtime.retire()
            finally:
                close_dashboard_sources()


if __name__ == "__main__":
    sys.exit(main())
