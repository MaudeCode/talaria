"""RpcServer dispatch in-process: no Agent checkout needed."""

from __future__ import annotations

import io
import json
import os
import threading

from talaria_sidecar.errors import CANCELLED, Cancelled
from talaria_sidecar.rpc import RpcServer


def test_dispatch_is_bounded_and_cancel_still_reaches_a_running_call() -> None:
    release = threading.Event()
    started = threading.Semaphore(0)

    def slow(ctx, params):
        started.release()
        while not ctx.cancelled:
            if release.wait(0.05):
                return {"done": params["n"]}
        raise Cancelled()

    requests = [{"jsonrpc": "2.0", "id": n, "method": "slow", "params": {"n": n}} for n in range(3)]
    requests.append({"jsonrpc": "2.0", "id": "c", "method": "rpc.cancel", "params": {"id": 1}})
    stdin = io.BytesIO(b"".join(json.dumps(line).encode() + b"\n" for line in requests))
    stdout = io.BytesIO()
    server = RpcServer({"slow": slow}, stdin=stdin, stdout=stdout, max_calls=2)
    reader = threading.Thread(target=server.serve_forever, daemon=True)
    reader.start()
    assert started.acquire(timeout=5) and started.acquire(timeout=5)
    reader.join(5)
    assert not reader.is_alive()

    def replies_so_far() -> dict:
        return {json.loads(raw)["id"]: json.loads(raw) for raw in stdout.getvalue().splitlines()}

    pause = threading.Event()
    for _ in range(100):
        if {1, 2, "c"} <= set(replies_so_far()):
            break
        pause.wait(0.05)
    release.set()
    for _ in range(100):
        replies = replies_so_far()
        if len(replies) == 4:
            break
        pause.wait(0.05)
    assert replies[2]["error"]["data"] == {"condition": "sidecar_busy"}
    assert replies[0]["result"] == {"done": 0}
    assert replies[1]["error"]["code"] == CANCELLED
    assert replies["c"]["result"] == {"cancelled": True}


def test_a_released_slot_admits_the_next_call() -> None:
    read_fd, write_fd = os.pipe()
    stdout = io.BytesIO()
    server = RpcServer({"ping": lambda ctx, params: {"ok": True}}, stdin=os.fdopen(read_fd, "rb"), stdout=stdout, max_calls=1)
    reader = threading.Thread(target=server.serve_forever, daemon=True)
    reader.start()
    pause = threading.Event()
    for n in range(3):
        # Wait for the previous call to hand its slot back before sending the next one.
        for _ in range(100):
            if server._slots.acquire(blocking=False):
                server._slots.release()
                break
            pause.wait(0.02)
        os.write(write_fd, json.dumps({"jsonrpc": "2.0", "id": n, "method": "ping"}).encode() + b"\n")
        for _ in range(100):
            if f'"id":{n}' in stdout.getvalue().decode():
                break
            pause.wait(0.02)
    os.close(write_fd)
    reader.join(5)
    replies = [json.loads(raw) for raw in stdout.getvalue().splitlines()]
    assert [r["result"] for r in replies] == [{"ok": True}] * 3


def test_a_cancel_read_immediately_after_the_call_still_finds_it() -> None:
    """Registration happens on the reader thread, so a cancel that follows the request in the same buffer is never `not_active`."""
    seen: list[bool] = []

    def waits_for_cancel(ctx, params):
        for _ in range(200):
            if ctx.cancelled:
                break
            threading.Event().wait(0.01)
        seen.append(ctx.cancelled)
        return {"cancelled": ctx.cancelled}

    for _ in range(20):
        requests = [{"jsonrpc": "2.0", "id": 1, "method": "slow"}, {"jsonrpc": "2.0", "id": "c", "method": "rpc.cancel", "params": {"id": 1}}]
        stdin = io.BytesIO(b"".join(json.dumps(line).encode() + b"\n" for line in requests))
        stdout = io.BytesIO()
        server = RpcServer({"slow": waits_for_cancel}, stdin=stdin, stdout=stdout)
        server.serve_forever()
        for _ in range(300):
            replies = {json.loads(raw)["id"]: json.loads(raw) for raw in stdout.getvalue().splitlines()}
            if len(replies) == 2:
                break
            threading.Event().wait(0.01)
        assert replies["c"]["result"] == {"cancelled": True}
        assert replies[1]["result"] == {"cancelled": True}
    assert all(seen)
