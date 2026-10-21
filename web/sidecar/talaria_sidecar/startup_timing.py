"""Bounded startup diagnostics; payloads and exception messages never enter this recorder."""
from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import threading
import time
import uuid

log = logging.getLogger("talaria_sidecar.startup_timing")
SPANS = frozenset({"rpc_wait", "mcp_discovery", "runtime_resolution", "agent_binding", "conversation_setup"})
OBSERVATIONS = frozenset({"rpc_receipt", "rpc_start", "conversation_entry", "first_sidecar_output", "first_visible_token", "first_visible_reasoning", "first_visible_tool", "first_visible_interim"})
OUTCOMES = frozenset({"ok", "noop", "cache_hit", "timeout", "refused", "cancelled", "unknown", "error"})


def outcome_for(error):
    condition = getattr(error, "data", {}).get("condition")
    if condition == "cancelled":
        return "cancelled"
    if condition in {"timeout", "sidecar_timeout"}:
        return "timeout"
    if condition == "sidecar_unavailable":
        return "unknown"
    if condition in {"session_busy", "profile_unavailable", "invalid_params"} or getattr(error, "code", None) == -32602:
        return "refused"
    return "error"


class StartupTiming:
    def __init__(self, request, *, now=None, write=None):
        self._now = now or time.monotonic
        self._write = write or log.info
        self._origin = self._now()
        self._lock = threading.RLock()
        raw_trace = request.get("trace_id")
        try:
            self.trace_id = str(uuid.UUID(raw_trace)) if isinstance(raw_trace, str) else str(uuid.uuid4())
        except (ValueError, AttributeError):
            self.trace_id = str(uuid.uuid4())
        self.rpc_id = request.get("id") if type(request.get("id")) is int else None
        params = request.get("params") or {}
        self._keys = {name + "_key": hashlib.sha256(value.encode()).hexdigest() for name in ("session", "stream")
                      if isinstance(value := params.get(name + "_id"), str)} if isinstance(params, dict) else {}
        self.spans = {}
        self.observations = {}
        self._emitted = set()
        self._ended = False
        self.observe("rpc_receipt")
        self.begin("rpc_wait")

    def elapsed(self):
        return max(0, (self._now() - self._origin) * 1000)

    def begin(self, name):
        with self._lock:
            if name in SPANS and name not in self.spans and not self._ended:
                self.spans[name] = {"start_ms": self.elapsed(), "duration_ms": None, "outcome": None}

    def end(self, name, outcome="ok"):
        with self._lock:
            span = self.spans.get(name)
            if span and span["duration_ms"] is None:
                span.update(duration_ms=max(0, self.elapsed() - span["start_ms"]), outcome=outcome if outcome in OUTCOMES else "error")

    @contextlib.contextmanager
    def span(self, name):
        self.begin(name)
        try:
            yield
        except BaseException as error:
            self.end(name, outcome_for(error))
            raise
        else:
            self.end(name)

    def observe(self, name):
        with self._lock:
            if name in OBSERVATIONS and name not in self.observations and not self._ended:
                self.observations[name] = self.elapsed()
                return True
            return False

    def frame(self, event, data):
        self.observe("first_sidecar_output")
        if not isinstance(data, dict):
            return
        name = {"token": "first_visible_token", "reasoning": "first_visible_reasoning", "tool": "first_visible_tool", "interim_assistant": "first_visible_interim"}.get(event)
        if name and (event == "tool" or isinstance(data.get("text"), str) and data["text"].strip()) and self.observe(name):
            self.emit("first_visible")

    def emit(self, stage, outcome="ok"):
        with self._lock:
            if stage not in {"conversation_entry", "first_visible", "terminal"} or stage in self._emitted:
                return
            self._emitted.add(stage)
            try:
                self._write(json.dumps({"event": "chat_start_timing", "version": 1, "process": "sidecar", "trace_id": self.trace_id, "rpc_id": self.rpc_id,
                                        **self._keys, "stage": stage, "outcome": outcome if outcome in OUTCOMES else "error", "elapsed_ms": self.elapsed(),
                                        "spans": self.spans, "observations": self.observations,
                                        "provider_boundaries": {"first_call": "unavailable", "first_chunk": "unavailable"}}, separators=(",", ":")))
            except Exception:  # Diagnostics never affect the call.
                pass

    def finish(self, outcome):
        with self._lock:
            if self._ended:
                return
            for name in self.spans:
                self.end(name, outcome)
            self.emit("terminal", outcome)
            self._ended = True
