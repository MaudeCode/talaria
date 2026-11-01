"""Newline-delimited JSON-RPC 2.0 over stdio with streamed frames and cancellation.

One line per message. Requests dispatch on a worker thread each, at most
``max_calls`` at a time; beyond that a request is answered immediately with a
``sidecar_busy`` error instead of growing the thread count. A method may emit
``stream`` frames tagged with its request id before it returns its result.
``rpc.cancel`` sets the request's cancel event; the method decides how to stop
and still returns (a result with ``status: "cancelled"`` or a CANCELLED error).
Cancellation never takes a slot, so it always reaches the call it targets.
The reader loop routes a request by its leading ``jsonrpc``/``id``/``method``
members and leaves the full parse to the call's worker, so a multi-MB body
(a ``chat.start`` history) never delays the requests read after it. The worker
decodes member by member because CPython's C JSON scanner holds the GIL for a
whole call: one ``json.loads`` of the body would stall every thread anyway.

The sidecar can also ask the server (TAL-1164): ``call_server`` writes a ``server.*`` request with an ``s:`` string id
on stdout and waits for the server's reply on stdin. It times out, and closing the channel fails every waiting call.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import re
import time
import sys
import threading
import traceback
from typing import Any, Callable

from .startup_timing import StartupTiming, outcome_for

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
SERVER_CALL_TIMEOUT = 30.0

# The server writes ``{"jsonrpc","id","method","params",...}``: the routing members lead every request line.
_PEEK_BYTES = 256
_HEAD_MEMBER = re.compile(rb'\s*"([A-Za-z_]+)"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)\s*([,}])')

# Containers this many levels deep are walked member by member (request → params → each params value's members, so
# every history message is one C decode); the GIL can pass to other threads between members.
_WALK_DEPTH = 3
_SPACE = re.compile(r"[ \t\n\r]*")
_DECODER = json.JSONDecoder()

# The server channel the running process serves; ``call_server`` asks through it.
_ACTIVE: "RpcServer | None" = None


def _peek_head(raw: bytes) -> dict | None:
    """The request's leading top-level scalar members, read from a bounded prefix without parsing the body.

    Returns ``None`` (parse the whole line instead) unless ``jsonrpc`` is ``"2.0"`` and a string ``method`` and an
    integer or string ``id`` all precede the first non-scalar member.
    """
    prefix = raw[:_PEEK_BYTES]
    if not prefix.startswith(b"{"):
        return None
    head: dict[str, Any] = {}
    pos = 1
    try:
        while match := _HEAD_MEMBER.match(prefix, pos):
            head[match[1].decode()] = json.loads(match[2])
            if match[3] == b"}":
                break
            pos = match.end()
    except ValueError:
        return None
    if head.get("jsonrpc") == "2.0" and isinstance(head.get("method"), str) and type(head.get("id")) in (int, str):
        return head
    return None


def _decode_value(text: str, idx: int, depth: int) -> tuple[Any, int]:
    """One JSON value at ``idx`` (no leading space) and the index after it, decoded exactly as ``json.loads`` would."""
    opener = text[idx:idx + 1]
    if depth and opener in ("{", "["):
        closer = "}" if opener == "{" else "]"
        container: Any = {} if opener == "{" else []
        idx = _SPACE.match(text, idx + 1).end()
        if text[idx:idx + 1] == closer:
            return container, idx + 1
        while True:
            if opener == "{":
                if text[idx:idx + 1] != '"':
                    raise json.JSONDecodeError("Expecting property name enclosed in double quotes", text, idx)
                key, idx = json.decoder.scanstring(text, idx + 1)
                idx = _SPACE.match(text, idx).end()
                if text[idx:idx + 1] != ":":
                    raise json.JSONDecodeError("Expecting ':' delimiter", text, idx)
                container[key], idx = _decode_value(text, _SPACE.match(text, idx + 1).end(), depth - 1)
            else:
                value, idx = _decode_value(text, idx, depth - 1)
                container.append(value)
            idx = _SPACE.match(text, idx).end()
            delimiter = text[idx:idx + 1]
            if delimiter == closer:
                return container, idx + 1
            if delimiter != ",":
                raise json.JSONDecodeError("Expecting ',' delimiter", text, idx)
            idx = _SPACE.match(text, idx + 1).end()
    return _DECODER.raw_decode(text, idx)


def _loads_yielding(raw: bytes) -> Any:
    """``json.loads`` for a request line that lets other threads run while a multi-MB body decodes."""
    text = raw.decode("utf-8")
    value, end = _decode_value(text, _SPACE.match(text).end(), _WALK_DEPTH)
    end = _SPACE.match(text, end).end()
    if end != len(text):
        raise json.JSONDecodeError("Extra data", text, end)
    return value


def call_server(method: str, params: dict, *, timeout: float | None = None):
    """Ask the server over the active channel; raises ``RpcError`` with the server's or the channel's condition."""
    server = _ACTIVE
    if server is None:
        raise RpcError("Talaria server is not connected", condition="server_unavailable")
    return server.call_server(method, params, timeout=timeout)


class CallContext:
    """Per-request handle: stream emission and cooperative cancellation."""

    def __init__(self, server: "RpcServer", request_id: Any, method: str, request: dict | None = None):
        self.server = server
        self.id = request_id
        self.method = method
        self.cancel_event = threading.Event()
        self.timing = StartupTiming(request) if method == "chat.start" and request is not None else None
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
        if self.timing:
            self.timing.frame(event, data)
        self.server.notify("stream", {"id": self.id, "seq": seq, "event": event, "data": data if data is not None else {}})


class RpcServer:
    def __init__(self, methods: dict[str, Handler], *, stdin=None, stdout=None, max_calls: int = DEFAULT_MAX_CALLS):
        self.methods = dict(methods)
        call_limit = max(1, int(max_calls))
        self._slots = threading.BoundedSemaphore(call_limit)
        # A parked command must leave room for its answer and unrelated Agent work.
        self._command_slots = threading.BoundedSemaphore(min(8, call_limit - 1))
        self.methods.setdefault("rpc.cancel", self._cancel)
        self.methods.setdefault("rpc.methods", lambda ctx, params: {"methods": sorted(self.methods)})
        self._in = stdin or sys.stdin.buffer
        self._out = stdout or sys.stdout.buffer
        self._write_lock = threading.Lock()
        self._active: dict[Any, CallContext] = {}
        self._active_lock = threading.Lock()
        self._closed = threading.Event()
        self.exit_code = 0
        self._server_calls: dict[str, dict] = {}
        self._server_calls_lock = threading.Lock()
        self._server_seq = 0
        self._server_closed = False

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
                broken = True
            else:
                broken = False
        if broken:
            self._fail_server_calls()

    def notify(self, method: str, params: dict) -> None:
        self._write({"jsonrpc": "2.0", "method": method, "params": params})

    def _result(self, request_id: Any, result: Any) -> None:
        self._write({"jsonrpc": "2.0", "id": request_id, "result": result})

    def _error(self, request_id: Any, code: int, message: str, data: dict | None = None) -> None:
        error: dict[str, Any] = {"code": code, "message": message}
        if data:
            error["data"] = data
        self._write({"jsonrpc": "2.0", "id": request_id, "error": error})

    # ── requests to the server ───────────────────────────────────────────
    def call_server(self, method: str, params: dict, *, timeout: float | None = None):
        waiter: dict = {"done": threading.Event()}
        with self._server_calls_lock:
            if self._server_closed:
                raise RpcError("Talaria server channel is closed", condition="server_unavailable")
            self._server_seq += 1
            request_id = f"s:{self._server_seq}"
            self._server_calls[request_id] = waiter
        try:
            self._write({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
            if not waiter["done"].wait(SERVER_CALL_TIMEOUT if timeout is None else timeout):
                raise RpcError(f"server call {method} timed out", condition="timeout")
        finally:
            with self._server_calls_lock:
                self._server_calls.pop(request_id, None)
        error = waiter.get("error")
        if error is not None:
            data = error.get("data") if isinstance(error.get("data"), dict) else None
            code = error.get("code") if isinstance(error.get("code"), int) else APPLICATION_ERROR
            raise RpcError(str(error.get("message") or "server call failed"), code=code, data=data)
        return waiter.get("result")

    def _settle_server_call(self, message: dict) -> None:
        with self._server_calls_lock:
            waiter = self._server_calls.get(message["id"])
        if waiter is None:
            return  # timed out, or a reply to nothing we asked
        if "error" in message:
            waiter["error"] = message["error"] if isinstance(message["error"], dict) else {"message": "server call failed"}
        else:
            waiter["result"] = message.get("result")
        waiter["done"].set()

    def _fail_server_calls(self) -> None:
        with self._server_calls_lock:
            self._server_closed = True
            waiters = list(self._server_calls.values())
        for waiter in waiters:
            waiter.setdefault("error", {"code": APPLICATION_ERROR, "message": "Talaria server channel closed", "data": {"condition": "server_unavailable"}})
            waiter["done"].set()

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
        self._fail_server_calls()
        with self._active_lock:
            for ctx in self._active.values():
                ctx.cancel_event.set()
                if ctx.timing:
                    ctx.timing.finish("unknown")

    # ── dispatch ──────────────────────────────────────────────────────────
    def _register(self, request: dict) -> CallContext | None:
        """Make the call cancellable before the reader accepts the next message (an immediate ``rpc.cancel`` must find it)."""
        request_id = request.get("id")
        method = request.get("method")
        if request_id is None or not isinstance(method, str):
            return None
        ctx = CallContext(self, request_id, method, request)
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
            if ctx and ctx.timing:
                ctx.timing.finish("refused")
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
            ctx = CallContext(self, request_id, method, request)
            if request_id is not None:
                with self._active_lock:
                    self._active[request_id] = ctx
        outcome = "error"
        if ctx.timing:
            ctx.timing.end("rpc_wait")
            ctx.timing.observe("rpc_start")
        try:
            result = handler(ctx, params)
            status = result.get("status") if isinstance(result, dict) else None
            failed = isinstance(result, dict) and bool(result.get("failed") or result.get("partial") or result.get("error"))
            outcome = "cancelled" if ctx.cancelled or status == "cancelled" else "error" if status == "error" or failed else "ok"
            if request_id is not None:
                self._result(request_id, result if result is not None else {})
        except RpcError as exc:
            outcome = outcome_for(exc)
            if request_id is not None:
                error = exc.to_json()
                self._error(request_id, error["code"], error["message"], error.get("data"))
        except TypeError as exc:
            outcome = "refused"
            # Wrong keyword arguments reaching a wrapped Agent function.
            log.debug("invalid params for %s", method, exc_info=True)
            if request_id is not None:
                self._error(request_id, INVALID_PARAMS, str(exc))
        except Exception as exc:  # noqa: BLE001 - every unexpected failure becomes a typed error
            log.error("method %s failed: %s\n%s", method, exc, traceback.format_exc())
            if request_id is not None:
                self._error(request_id, INTERNAL_ERROR, f"{type(exc).__name__}: {exc}")
        finally:
            if ctx.timing:
                ctx.timing.finish(outcome)
            if request_id is not None:
                with self._active_lock:
                    self._active.pop(request_id, None)

    def serve_forever(self) -> int:
        """Read requests until stdin closes or shutdown is requested."""
        global _ACTIVE
        _ACTIVE = self
        incoming = queue.Queue(maxsize=1)
        def read_input():
            try:
                try:
                    fd = self._in.fileno()
                except (AttributeError, OSError, ValueError):
                    fd = None
                if fd is None:
                    while raw := self._in.readline():
                        incoming.put(raw)
                else:
                    # An unbuffered OS read cannot hold sys.stdin's Python buffer lock at interpreter exit.
                    pending = []
                    while chunk := os.read(fd, 65536):
                        lines = chunk.split(b"\n")
                        pending.append(lines[0])
                        for line in lines[1:]:
                            incoming.put(b"".join(pending))
                            pending = [line]
                    if pending:
                        incoming.put(b"".join(pending))
            except (OSError, ValueError):
                pass
            finally:
                incoming.put(None)
        threading.Thread(target=read_input, name="rpc-input", daemon=True).start()
        while not self._closed.is_set():
            try:
                raw = incoming.get(timeout=.1)
            except queue.Empty:
                continue
            if raw is None or self._closed.is_set():
                break
            raw = raw.strip()
            if not raw:
                continue
            request = _peek_head(raw)
            if request is None or request["method"] == "rpc.cancel":
                line, raw = raw, None
                try:
                    request = json.loads(line)
                except (ValueError, RecursionError):
                    self._error(None, PARSE_ERROR, "invalid JSON")
                    continue
                if not isinstance(request, dict) or request.get("jsonrpc") != "2.0":
                    self._error(request.get("id") if isinstance(request, dict) else None, INVALID_REQUEST, "expected a JSON-RPC 2.0 request object")
                    continue
                if "method" not in request and isinstance(request.get("id"), str) and request["id"].startswith("s:"):
                    self._settle_server_call(request)
                    continue
            if request.get("method") == "rpc.cancel":
                # Cancellation must not queue behind the call it targets.
                self._dispatch(request)
                continue
            command = request.get("method") == "commands.exec"
            command_admitted = not command or self._command_slots.acquire(blocking=False)
            if not command_admitted or not self._slots.acquire(blocking=False):
                if command and command_admitted:
                    self._command_slots.release()
                if request.get("method") == "chat.start":
                    StartupTiming(request).finish("refused")
                self._error(request.get("id"), APPLICATION_ERROR, "sidecar is at its concurrent call limit", {"condition": "sidecar_busy"})
                continue
            ctx = self._register(request)
            threading.Thread(target=self._dispatch_slot, args=(request, ctx, raw), name=f"rpc-{request.get('method')}", daemon=True).start()
        # No more replies can arrive: a tool waiting on the server fails now rather than at its timeout.
        self._fail_server_calls()
        if self._closed.is_set():
            # Let the terminal reply reach stdout before the process returns its final exit code.
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                with self._active_lock:
                    terminal_reply = any(ctx.method in {"runtime.shutdown", "runtime.handshake"} for ctx in self._active.values())
                if not terminal_reply:
                    break
                threading.Event().wait(.01)
        return self.exit_code

    def _dispatch_slot(self, request: dict, ctx: CallContext | None, raw: bytes | None = None) -> None:
        method = request.get("method")
        try:
            if raw is not None:
                request = self._parse_body(raw, request, ctx)
            if request is not None:
                self._dispatch(request, ctx)
        finally:
            self._slots.release()
            if method == "commands.exec":
                self._command_slots.release()

    def _parse_body(self, raw: bytes, head: dict, ctx: CallContext | None) -> dict | None:
        """Parse a peeked request on its worker; an unusable body is answered under the peeked id."""
        try:
            request = _loads_yielding(raw)
        except (ValueError, RecursionError):
            code, message = PARSE_ERROR, "invalid JSON"
        else:
            if isinstance(request, dict) and all(request.get(name) == head[name] for name in ("jsonrpc", "id", "method")):
                if ctx and ctx.timing:
                    ctx.timing.identify(request)
                return request
            code, message = INVALID_REQUEST, "request body does not match its leading jsonrpc, id and method"
        if ctx and ctx.timing:
            ctx.timing.finish("refused")
        with self._active_lock:
            self._active.pop(head["id"], None)
        self._error(head["id"], code, message)
        return None
