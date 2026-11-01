"""RpcServer dispatch in-process: no Agent checkout needed."""

from __future__ import annotations

import io
import json
import os
import threading
import pytest

from talaria_sidecar.errors import CANCELLED, Cancelled
from talaria_sidecar.rpc import RpcServer


@pytest.mark.parametrize('max_calls', [1, 2, 64])
def test_unanswered_commands_leave_capacity_for_clarification_replies(max_calls):
    release, replied = threading.Event(), threading.Event()
    requests = [{'jsonrpc': '2.0', 'id': n, 'method': 'commands.exec', 'params': {'profile_home': f'/profile/{n}'}} for n in range(64)]
    requests.append({'jsonrpc': '2.0', 'id': 'answer', 'method': 'clarify.respond'})
    output = io.BytesIO()
    server = RpcServer({'commands.exec': lambda ctx, params: release.wait(5), 'clarify.respond': lambda ctx, params: {'ok': True}},
                       stdin=io.BytesIO(b''.join(json.dumps(r).encode() + b'\n' for r in requests)), stdout=output, max_calls=max_calls)
    write = server._write

    def observe(message):
        write(message)
        if message.get('id') == 'answer':
            replied.set()

    server._write = observe
    try:
        server.serve_forever()
        assert replied.wait(3)
        replies = {json.loads(raw)['id']: json.loads(raw) for raw in output.getvalue().splitlines()}
        assert replies['answer'].get('result') == {'ok': True}, replies['answer']
        busy = [r for r in replies.values() if r.get('error', {}).get('data', {}).get('condition') == 'sidecar_busy']
        assert len(busy) >= 56
    finally:
        release.set()


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


def test_a_result_that_is_not_json_becomes_an_error_answer_instead_of_a_dropped_line() -> None:
    requests = [{"jsonrpc": "2.0", "id": 7, "method": "nan"}]
    stdin = io.BytesIO(b"".join(json.dumps(line).encode() + b"\n" for line in requests))
    stdout = io.BytesIO()
    server = RpcServer({"nan": lambda ctx, params: {"value": float("nan")}}, stdin=stdin, stdout=stdout)
    server.serve_forever()
    for _ in range(100):
        replies = [json.loads(raw) for raw in stdout.getvalue().splitlines()]
        if replies:
            break
        threading.Event().wait(0.01)
    assert replies[0]["id"] == 7 and replies[0]["error"]["code"] == -32603
    assert "JSON" in replies[0]["error"]["message"]


def test_shutdown_wakes_an_open_input_reader_and_flushes_its_final_reply() -> None:
    read_fd, write_fd = os.pipe()
    waiting, release = threading.Event(), threading.Event()
    pipe = os.fdopen(read_fd, 'rb')
    class Input:
        reads = 0
        def readline(self):
            self.reads += 1
            if self.reads == 2:
                waiting.set()
            return pipe.readline()
    def shutdown(ctx, params):
        assert release.wait(5)
        ctx.server.request_shutdown(exit_code=3)
        return {'ok': True}
    output = io.BytesIO()
    server = RpcServer({'runtime.shutdown': shutdown}, stdin=Input(), stdout=output)
    result = []
    reader = threading.Thread(target=lambda: result.append(server.serve_forever()), daemon=True)
    reader.start()
    try:
        os.write(write_fd, b'{"jsonrpc":"2.0","id":7,"method":"runtime.shutdown"}\n')
        assert waiting.wait(5), 'reader never waited for another input line'
        release.set()
        reader.join(1)
        assert not reader.is_alive(), 'shutdown must not wait for the caller to close stdin'
        assert result == [3]
        assert json.loads(output.getvalue())['result'] == {'ok': True}
    finally:
        release.set()
        os.close(write_fd)
        reader.join(5)
        pipe.close()


def test_unbuffered_input_preserves_a_large_utf8_frame_across_os_reads() -> None:
    read_fd, write_fd = os.pipe()
    output = io.BytesIO()
    text = 'synthetic-🌲\n' * 30000
    server = RpcServer({'echo': lambda ctx, params: {'length': len(params['text']), 'matches': params['text'] == text}},
                       stdin=os.fdopen(read_fd, 'rb'), stdout=output, max_calls=1)
    reader = threading.Thread(target=server.serve_forever, daemon=True)
    reader.start()
    with os.fdopen(write_fd, 'wb') as pipe:
        pipe.write(json.dumps({'jsonrpc': '2.0', 'id': 8, 'method': 'echo', 'params': {'text': text}}, ensure_ascii=False).encode() + b'\n')
    reader.join(5)
    for _ in range(100):
        if output.getvalue():
            break
        threading.Event().wait(.01)
    assert json.loads(output.getvalue())['result'] == {'length': len(text), 'matches': True}


def test_a_huge_request_body_parses_on_its_worker_so_the_next_call_is_answered_first(monkeypatch) -> None:
    """A multi-MB chat.start history must not hold up dispatch of the requests read after it (TAL-1228)."""
    from talaria_sidecar import rpc
    real_loads, release, parsed = json.loads, threading.Event(), threading.Event()

    def slow_loads(text, *args, **kwargs):
        if len(text) > 1_000_000:
            release.wait(10)  # stands in for a slow multi-MB parse
            try:
                return real_loads(text, *args, **kwargs)
            finally:
                parsed.set()
        return real_loads(text, *args, **kwargs)

    monkeypatch.setattr(rpc, 'json', type('SlowJson', (), {'loads': staticmethod(slow_loads), 'dumps': staticmethod(json.dumps)}))
    history = [{'role': 'user', 'content': 'synthetic ' * 100_000} for _ in range(20)]
    big = {'jsonrpc': '2.0', 'id': 1, 'method': 'chat.start', 'params': {'session_id': 'synthetic', 'conversation_history': history},
           'trace_id': '22222222-2222-4222-8222-222222222222'}
    small = {'jsonrpc': '2.0', 'id': 2, 'method': 'models.list', 'params': {}}
    read_fd, write_fd = os.pipe()
    output = io.BytesIO()
    answered, parse_done_at_answer = threading.Event(), []
    server = RpcServer({'chat.start': lambda ctx, params: {'turns': len(params['conversation_history'])},
                        'models.list': lambda ctx, params: {'models': []}}, stdin=os.fdopen(read_fd, 'rb'), stdout=output)
    write = server._write

    def observe(message):
        if message.get('id') == 2:
            parse_done_at_answer.append(parsed.is_set())
            answered.set()
        write(message)

    server._write = observe
    reader = threading.Thread(target=server.serve_forever, daemon=True)
    reader.start()
    writer = threading.Thread(target=lambda: (os.write(write_fd, (json.dumps(big) + '\n' + json.dumps(small) + '\n').encode()), os.close(write_fd)), daemon=True)
    writer.start()
    try:
        assert answered.wait(3), 'models.list waited behind the chat.start body parse'
        assert parse_done_at_answer == [False]
    finally:
        release.set()
        writer.join(5)
        reader.join(5)
    for _ in range(300):
        replies = {json.loads(raw)['id']: json.loads(raw) for raw in output.getvalue().splitlines()}
        if len(replies) == 2:
            break
        threading.Event().wait(0.01)
    assert replies[1]['result'] == {'turns': 20}
    assert replies[2]['result'] == {'models': []}


def _serve_lines(lines: list[bytes], methods: dict) -> list[dict]:
    stdout = io.BytesIO()
    RpcServer(methods, stdin=io.BytesIO(b''.join(line + b'\n' for line in lines)), stdout=stdout).serve_forever()
    for _ in range(300):
        replies = [json.loads(raw) for raw in stdout.getvalue().splitlines()]
        if len(replies) == len(lines):
            break
        threading.Event().wait(0.01)
    return replies


def test_malformed_bodies_answer_the_standard_errors_under_the_best_known_id() -> None:
    lines = [
        b'{"jsonrpc":"2.0","id":1,"method":"echo","params":{"broken":',  # routed by its head, parsed on the worker
        b'not json',
        b'{"jsonrpc":"1.0","id":3,"method":"echo"}',
        b'{"jsonrpc":"2.0","id":4,"method":"echo","params":{},"method":"other"}',  # body disagrees with its routing head
        b'{"jsonrpc":"2.0","params":{"method":"nested","id":0},"id":5,"method":"echo"}',  # head after params: full parse
    ]
    replies = {r['id']: r for r in _serve_lines(lines, {'echo': lambda ctx, params: {'params': params}})}
    assert replies[1]['error']['code'] == -32700
    assert replies[None]['error']['code'] == -32700
    assert replies[3]['error']['code'] == -32600
    assert replies[4]['error']['code'] == -32600
    assert replies[5]['result'] == {'params': {'method': 'nested', 'id': 0}}


def test_a_routed_chat_start_keeps_the_trace_and_session_identity_from_its_body(caplog) -> None:
    import logging
    caplog.set_level(logging.INFO)
    trace = '33333333-3333-4333-8333-333333333333'
    line = json.dumps({'jsonrpc': '2.0', 'id': 9, 'method': 'chat.start', 'params': {'session_id': 'synthetic'}, 'trace_id': trace}).encode()
    assert _serve_lines([line], {'chat.start': lambda ctx, params: {'status': 'completed'}})[0]['result'] == {'status': 'completed'}
    records = [json.loads(r.message) for r in caplog.records if r.message.startswith('{"event":"chat_start_timing"')]
    assert [(r['trace_id'], r['rpc_id'], 'session_key' in r) for r in records] == [(trace, 9, True)]
