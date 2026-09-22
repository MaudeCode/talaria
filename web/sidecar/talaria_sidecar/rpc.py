"""Newline-delimited JSON-RPC 2.0 over stdio with streamed frames and cancellation.

One line per message. Requests dispatch on a worker thread each, at most
``max_calls`` at a time; beyond that a request is answered immediately with a
``sidecar_busy`` error instead of growing the thread count. A method may emit
``stream`` frames tagged with its request id before it returns its result.
``rpc.cancel`` sets the request's cancel event; the method decides how to stop
and still returns (a result with ``status: "cancelled"`` or a CANCELLED error).
Cancellation never takes a slot, so it always reaches the call it targets.
"""

from __future__ import annotations

import json
import logging
import sys
import threading
import traceback
from typing import Any, Callable

from .errors import (
    APPLICATION_ERROR,
    INTERNAL_ERROR,
    INVALID_PARAMS,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    PARSE_ERROR,
    Cancelled,
    RpcError,
)

log = logging.getLogger("talaria_sidecar.rpc")

Handler = Callable[["CallContext", dict], Any]

DEFAULT_MAX_CALLS = 64


class CallContext:
    """Per-request handle: stream emission and cooperative cancellation."""

    def __init__(self, server: "RpcServer", request_id: Any, method: str):
        self.server = server
        self.id = request_id
        self.method = method
        self.cancel_event = threading.Event()
        self._seq = 0
        self._seq_lock = threading.Lock()

    @property
    def cancelled(self) -> bool:
        return self.cancel_event.is_set()

    def check_cancelled(self) -> None:
        if self.cancel_event.is_set():
            raise Cancelled()

    def emit(self, event: str, data: Any = None) -> None:
        """Send one stream frame for this request."""
        with self._seq_lock:
            self._seq += 1
            seq = self._seq
        self.server.notify("stream", {"id": self.id, "seq": seq, "event": event, "data": data if data is not None else {}})


class RpcServer:
    def __init__(self, methods: dict[str, Handler], *, stdin=None, stdout=None, max_calls: int = DEFAULT_MAX_CALLS):
        self.methods = dict(methods)
        self._slots = threading.BoundedSemaphore(max(1, int(max_calls)))
        self.methods.setdefault("rpc.cancel", self._cancel)
        self.methods.setdefault("rpc.methods", lambda ctx, params: {"methods": sorted(self.methods)})
        self._in = stdin or sys.stdin.buffer
        self._out = stdout or sys.stdout.buffer
        self._write_lock = threading.Lock()
        self._active: dict[Any, CallContext] = {}
        self._active_lock = threading.Lock()
        self._closed = threading.Event()
        self.exit_code = 0

    # ── output ────────────────────────────────────────────────────────────
    def _write(self, message: dict) -> None:
        try:
            # Strict JSON: a NaN/Infinity anywhere would be an unparsable line the client silently drops (a hung call).
            line = json.dumps(message, separators=(",", ":"), ensure_ascii=False, allow_nan=False) + "\n"
        except ValueError as exc:
            if "id" in message and "result" in message:
                self._error(message["id"], INTERNAL_ERROR, f"result is not JSON-serialisable: {exc}")
                return
            log.error("dropping unserialisable %s message: %s", message.get("method"), exc)
            return
        data = line.encode("utf-8")
        with self._write_lock:
            try:
                self._out.write(data)
                self._out.flush()
            except (BrokenPipeError, OSError, ValueError):
                self._closed.set()

    def notify(self, method: str, params: dict) -> None:
        self._write({"jsonrpc": "2.0", "method": method, "params": params})

    def _result(self, request_id: Any, result: Any) -> None:
        self._write({"jsonrpc": "2.0", "id": request_id, "result": result})

    def _error(self, request_id: Any, code: int, message: str, data: dict | None = None) -> None:
        error: dict[str, Any] = {"code": code, "message": message}
        if data:
            error["data"] = data
        self._write({"jsonrpc": "2.0", "id": request_id, "error": error})

    # ── built-ins ─────────────────────────────────────────────────────────
    def _cancel(self, ctx: CallContext, params: dict) -> dict:
        target = params.get("id") if isinstance(params, dict) else None
        with self._active_lock:
            active = self._active.get(target)
        if active is None:
            return {"cancelled": False, "reason": "not_active"}
        active.cancel_event.set()
        return {"cancelled": True}

    def request_shutdown(self, exit_code: int = 0) -> None:
        self.exit_code = exit_code
        self._closed.set()

    # ── dispatch ──────────────────────────────────────────────────────────
    def _register(self, request: dict) -> CallContext | None:
        """Make the call cancellable before the reader accepts the next message (an immediate ``rpc.cancel`` must find it)."""
        request_id = request.get("id")
        method = request.get("method")
        if request_id is None or not isinstance(method, str):
            return None
        ctx = CallContext(self, request_id, method)
        with self._active_lock:
            self._active[request_id] = ctx
        return ctx

    def _dispatch(self, request: dict, ctx: CallContext | None = None) -> None:
        request_id = request.get("id")
        method = request.get("method")
        params = request.get("params")
        if params is None:
            params = {}
        if not isinstance(method, str) or not isinstance(params, dict):
            if request_id is not None:
                with self._active_lock:
                    self._active.pop(request_id, None)
                self._error(request_id, INVALID_REQUEST, "method must be a string and params an object")
            return
        handler = self.methods.get(method)
        if handler is None:
            if request_id is not None:
                with self._active_lock:
                    self._active.pop(request_id, None)
                self._error(request_id, METHOD_NOT_FOUND, f"unknown method {method}")
            return
        if ctx is None:
            ctx = CallContext(self, request_id, method)
            if request_id is not None:
                with self._active_lock:
                    self._active[request_id] = ctx
        try:
            result = handler(ctx, params)
            if request_id is not None:
                self._result(request_id, result if result is not None else {})
        except RpcError as exc:
            if request_id is not None:
                error = exc.to_json()
                self._error(request_id, error["code"], error["message"], error.get("data"))
        except TypeError as exc:
            # Wrong keyword arguments reaching a wrapped Agent function.
            log.debug("invalid params for %s", method, exc_info=True)
            if request_id is not None:
                self._error(request_id, INVALID_PARAMS, str(exc))
        except Exception as exc:  # noqa: BLE001 - every unexpected failure becomes a typed error
            log.error("method %s failed: %s\n%s", method, exc, traceback.format_exc())
            if request_id is not None:
                self._error(request_id, INTERNAL_ERROR, f"{type(exc).__name__}: {exc}")
        finally:
            if request_id is not None:
                with self._active_lock:
                    self._active.pop(request_id, None)

    def serve_forever(self) -> int:
        """Read requests until stdin closes or shutdown is requested."""
        while not self._closed.is_set():
            try:
                raw = self._in.readline()
            except (OSError, ValueError):
                break
            if not raw:
                break
            raw = raw.strip()
            if not raw:
                continue
            try:
                request = json.loads(raw)
            except ValueError:
                self._error(None, PARSE_ERROR, "invalid JSON")
                continue
            if not isinstance(request, dict) or request.get("jsonrpc") != "2.0":
                self._error(request.get("id") if isinstance(request, dict) else None, INVALID_REQUEST, "expected a JSON-RPC 2.0 request object")
                continue
            if request.get("method") == "rpc.cancel":
                # Cancellation must not queue behind the call it targets.
                self._dispatch(request)
                continue
            if not self._slots.acquire(blocking=False):
                self._error(request.get("id"), APPLICATION_ERROR, "sidecar is at its concurrent call limit", {"condition": "sidecar_busy"})
                continue
            ctx = self._register(request)
            threading.Thread(target=self._dispatch_slot, args=(request, ctx), name=f"rpc-{request.get('method')}", daemon=True).start()
        return self.exit_code

    def _dispatch_slot(self, request: dict, ctx: CallContext | None) -> None:
        try:
            self._dispatch(request, ctx)
        finally:
            self._slots.release()
