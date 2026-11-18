"""Snapshot and publish the Agent's additive plugin registry without importing it, and mask key-shaped text with it."""
from __future__ import annotations

import hashlib
import json
import sys
import threading
from contextlib import nullcontext


def _policy(patterns: list[dict]) -> dict:
    fingerprint = hashlib.sha256(json.dumps(patterns, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"fingerprint": fingerprint, "patterns": patterns}


def redact_key_shapes(text: str) -> str:
    """``text`` with every key-shaped token masked by the Agent's own patterns, plugin-registered ones included, whatever
    the profile's ``redact_secrets`` preference: for a line shown to the user verbatim, such as an MCP launch command."""
    from agent.redact import redact_sensitive_text

    return redact_sensitive_text(text, force=True)


class RedactionPolicy:
    def __init__(self):
        self._identity = None
        self._policy = _policy([])
        self._lock = threading.Lock()

    @staticmethod
    def _read(module) -> tuple[object, dict]:
        # Registration swaps the matcher under this same native lock. Snapshot its identity and rules together.
        with getattr(module, "_registry_lock", nullcontext()):
            identity = getattr(module, "_PREFIX_RE", None)
            registry = getattr(module, "_plugin_patterns", None)
            prefix = getattr(module, "_extract_literal_prefix", None)
            patterns = [{"pattern": p, "literal_prefix": prefix(p)} for p in registry()] if callable(registry) and callable(prefix) else []
            return identity, _policy(patterns)

    def snapshot(self) -> dict:
        # A concurrent read must not consume an update that has yet to be pushed before another call's stream.
        with self._lock:
            return self._read(sys.modules.get("agent.redact"))[1]

    def publish(self, server) -> None:
        module = sys.modules.get("agent.redact")
        if getattr(module, "_PREFIX_RE", None) is self._identity:
            return
        with self._lock:
            identity, policy = self._read(module)
            if policy["fingerprint"] != self._policy["fingerprint"]:
                server.notify("redaction.policy", policy)
            # Publish first: a concurrent emitter can skip the lock only after the push is on the wire.
            self._identity, self._policy = identity, policy
