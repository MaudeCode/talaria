"""``python -m talaria_sidecar``: serve JSON-RPC over stdio until stdin closes."""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

from .methods import build_methods
from .rpc import RpcServer
from .runtime import AgentRuntime


def main() -> int:
    logging.basicConfig(stream=sys.stderr, level=os.environ.get("TALARIA_SIDECAR_LOG_LEVEL", "INFO"), format="[sidecar] %(levelname)s %(name)s: %(message)s")
    hermes_home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes").expanduser()
    agent_dir = os.environ.get("TALARIA_SIDECAR_AGENT_DIR") or os.environ.get("HERMES_WEBUI_AGENT_DIR")
    runtime = AgentRuntime(hermes_home, Path(agent_dir) if agent_dir else None)
    if runtime.agent_dir is not None and str(runtime.agent_dir) not in sys.path:
        # Append, never prepend: the Agent venv's site-packages must win over
        # any same-named module in the checkout (api/config.py has the history).
        sys.path.append(str(runtime.agent_dir))
    server = RpcServer(build_methods(runtime))
    return server.serve_forever()


if __name__ == "__main__":
    sys.exit(main())
