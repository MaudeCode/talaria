"""Talaria Web sidecar: the only process that imports Hermes Agent code.

Spawned by the Talaria Web server on the Agent's own venv interpreter with the
Agent checkout on ``PYTHONPATH``. Speaks newline-delimited JSON-RPC 2.0 over
stdio (docs/architecture/sidecar-rpc.md). Standard library only.
"""

from __future__ import annotations

SIDECAR_RPC_VERSION = 8
