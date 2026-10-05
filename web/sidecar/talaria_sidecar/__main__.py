"""``python -m talaria_sidecar``: serve JSON-RPC over stdio until stdin closes."""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

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


def main() -> int:
    rpc_out = _claim_stdout()
    logging.basicConfig(stream=sys.stderr, level=os.environ.get("TALARIA_SIDECAR_LOG_LEVEL", "INFO"), format="[sidecar] %(levelname)s %(name)s: %(message)s")
    hermes_home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes").expanduser()
    # Every turn here has a human behind the Web UI: flagged actions must ask (approval cards), never auto-approve.
    os.environ.setdefault("HERMES_EXEC_ASK", "1")
    agent_dir = os.environ.get("TALARIA_SIDECAR_AGENT_DIR") or os.environ.get("HERMES_WEBUI_AGENT_DIR")
    runtime = AgentRuntime(hermes_home, Path(agent_dir) if agent_dir else None)
    if runtime.agent_dir is not None and str(runtime.agent_dir) not in sys.path:
        # Append, never prepend: the Agent venv's site-packages must win over
        # any same-named module in the checkout (api/config.py has the history).
        sys.path.append(str(runtime.agent_dir))
    server = RpcServer(build_methods(runtime), stdout=rpc_out, max_calls=int(os.environ.get("TALARIA_SIDECAR_MAX_CALLS") or DEFAULT_MAX_CALLS))
    try:
        return server.serve_forever()
    finally:
        # The server closes stdin to stop the sidecar: end every cached agent's memory session on the way out.
        from .methods.chat import drain_agents

        drain_agents()


if __name__ == "__main__":
    sys.exit(main())
