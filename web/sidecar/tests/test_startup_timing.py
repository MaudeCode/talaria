"""Payload-free startup records use RPC identity and process-local monotonic offsets."""
import io
import json
import logging

from talaria_sidecar.rpc import RpcServer
from talaria_sidecar.methods import chat
from test_chat_turn import FakeAgent, _params, _patch


def test_rpc_chat_start_records_setup_and_first_content_without_payloads(monkeypatch, caplog):
    _patch(monkeypatch)
    monkeypatch.setattr(chat, "_discover_mcp_tools", lambda run: None)
    class Agent(FakeAgent):
        def run_conversation(self, **kwargs):
            for _ in range(2000):
                self.kwargs["stream_delta_callback"]("SECRET_PROMPT /private/path https://secret.example")
            return super().run_conversation(**kwargs)
    monkeypatch.setattr(chat, "_agent_class", lambda: Agent)
    caplog.set_level(logging.INFO)
    output = io.BytesIO()
    server = RpcServer({"chat.start": chat.start}, stdout=output)
    trace = "11111111-1111-4111-8111-111111111111"
    request = {"jsonrpc": "2.0", "id": 7, "method": "chat.start", "trace_id": trace, "params": _params("stream")}
    server._dispatch(request, server._register(request))
    records = [json.loads(r.message) for r in caplog.records if r.message.startswith('{"event":"chat_start_timing"')]
    assert [r["stage"] for r in records] == ["first_visible", "conversation_entry", "terminal"] or [r["stage"] for r in records] == ["conversation_entry", "first_visible", "terminal"]
    assert {r["trace_id"] for r in records} == {trace}
    last = records[-1]
    assert last["rpc_id"] == 7
    assert last["spans"]["mcp_discovery"]["outcome"] == "ok"
    assert last["spans"]["runtime_resolution"]["outcome"] == "ok"
    assert last["spans"]["agent_binding"]["outcome"] == "ok"
    assert "first_visible_token" in last["observations"]
    assert last["provider_boundaries"] == {"first_call": "unavailable", "first_chunk": "unavailable"}
    assert "SECRET" not in json.dumps(records)
    assert "/private" not in json.dumps(records)


def test_monotonic_spans_close_once_and_error_messages_stay_private():
    from talaria_sidecar.startup_timing import StartupTiming
    from talaria_sidecar.errors import RpcError
    now = [10.0]
    records = []
    timing = StartupTiming({"id": 1, "trace_id": "SECRET/invalid", "params": {"session_id": "SECRET/PATH"}}, now=lambda: now[0], write=lambda line: records.append(json.loads(line)))
    with timing.span("runtime_resolution"):
        now[0] += .05
        assert timing.spans["runtime_resolution"]["duration_ms"] is None
    timing.end("runtime_resolution", "error")
    assert timing.spans["runtime_resolution"]["outcome"] == "ok"
    try:
        with timing.span("agent_binding"):
            now[0] += .025
            raise RpcError("SECRET PROMPT https://private.example/path", condition="sidecar_timeout")
    except RpcError:
        pass
    timing.finish("timeout")
    timing.finish("error")
    assert len(records) == 1
    assert records[0]["spans"]["agent_binding"]["outcome"] == "timeout"
    assert round(records[0]["spans"]["runtime_resolution"]["duration_ms"]) == 50
    assert "SECRET" not in json.dumps(records)


def test_interleaved_rpc_startup_keeps_receipt_queue_and_terminal_identity(monkeypatch, caplog):
    import threading
    from talaria_sidecar.errors import Cancelled
    caplog.set_level(logging.INFO)
    gates = {key: threading.Event() for key in (1, 2)}
    entered = {key: threading.Event() for key in (1, 2)}
    def start(ctx, params):
        with ctx.timing.span("runtime_resolution"):
            entered[ctx.id].set()
            assert gates[ctx.id].wait(5)
        if ctx.cancelled:
            raise Cancelled("SECRET CANCEL REASON")
        ctx.emit("reasoning", {"text": "SECRET REASONING"})
        return {"status": "completed"}
    server = RpcServer({"chat.start": start}, stdout=io.BytesIO())
    requests = [{"id": i, "method": "chat.start", "trace_id": f"00000000-0000-4000-8000-{i:012}", "params": {"session_id": str(i)}} for i in (1, 2)]
    contexts = [server._register(r) for r in requests]
    workers = [threading.Thread(target=server._dispatch, args=(r, ctx)) for r, ctx in zip(requests, contexts)]
    try:
        for w in workers:
            w.start()
        for event in entered.values():
            assert event.wait(5)
        for ctx in contexts:
            assert ctx.timing.spans["runtime_resolution"]["duration_ms"] is None
        server._cancel(None, {"id": 1})
        gates[2].set()
        workers[1].join(5)
        gates[1].set()
        workers[0].join(5)
        records = [json.loads(r.message) for r in caplog.records if r.message.startswith('{"event":"chat_start_timing"')]
        terminals = [r for r in records if r["stage"] == "terminal"]
        assert [(r["rpc_id"], r["outcome"]) for r in terminals] == [(2, "ok"), (1, "cancelled")]
        assert all(r["trace_id"] == requests[r["rpc_id"] - 1]["trace_id"] for r in records)
        assert not server._active
        assert "SECRET" not in json.dumps(records)
    finally:
        for gate in gates.values():
            gate.set()
        for w in workers:
            w.join(5)


def test_cached_agent_and_distinct_content_observations(monkeypatch):
    from talaria_sidecar.startup_timing import StartupTiming
    from test_chat_turn import Ctx
    _patch(monkeypatch)
    monkeypatch.setattr(chat, "_discover_mcp_tools", lambda run: None)
    class Agent(FakeAgent):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            for name, value in kwargs.items():
                if name.endswith("callback"):
                    setattr(self, name, value)

        def run_conversation(self, **kwargs):
            self.reasoning_callback("SECRET REASONING")
            self.tool_start_callback("call", "tool", {"secret": "SECRET ARGS"})
            self.stream_delta_callback("SECRET ANSWER")
            return super().run_conversation(**kwargs)
    monkeypatch.setattr(chat, "_agent_class", lambda: Agent)
    records = []
    for index in range(2):
        ctx = Ctx()
        ctx.timing = StartupTiming({"id": index, "params": {}}, write=lambda line: records.append(json.loads(line)))
        emit = ctx.emit
        def timed_emit(event, data=None):
            ctx.timing.frame(event, data)
            emit(event, data)
        ctx.emit = timed_emit
        assert chat.start(ctx, _params(f"stream-{index}"))["status"] == "completed"
        ctx.timing.finish("ok")
    assert len(FakeAgent.instances) == 1
    assert records[-1]["spans"]["agent_binding"]["outcome"] == "cache_hit"
    assert {"first_visible_token", "first_visible_tool", "first_visible_reasoning"} <= records[-1]["observations"].keys()
    assert "SECRET" not in json.dumps(records)


def test_each_chat_setup_boundary_stays_open_until_its_operation_returns(monkeypatch):
    """Hold the real handler at each setup seam, without Agent processes or sleep-based timing."""
    import threading
    import pytest
    from talaria_sidecar.startup_timing import StartupTiming
    from test_chat_turn import Ctx
    _patch(monkeypatch)
    monkeypatch.setattr(chat, "_discover_mcp_tools", lambda run: None)
    for name, attribute in [("mcp_discovery", "_discover_mcp_tools"), ("runtime_resolution", "_resolve_runtime"), ("agent_binding", "_build_agent")]:
        chat._AGENT_CACHE.clear()
        now = [10.0]
        records = []
        ctx = Ctx()
        ctx.timing = StartupTiming({"id": 1, "params": {}}, now=lambda: now[0], write=lambda line: records.append(json.loads(line)))
        entered, release = threading.Event(), threading.Event()
        original = getattr(chat, attribute)
        def held(*args, **kwargs):
            entered.set()
            assert release.wait(5)
            return original(*args, **kwargs)
        monkeypatch.setattr(chat, attribute, held)
        result = {}
        worker = threading.Thread(target=lambda: result.update(chat.start(ctx, _params(name))))
        try:
            worker.start()
            assert entered.wait(5)
            assert ctx.timing.spans[name]["duration_ms"] is None
            now[0] += .075
            release.set()
            worker.join(5)
            assert result["status"] == "completed"
            assert ctx.timing.spans[name]["duration_ms"] == pytest.approx(75)
            assert ctx.timing.spans[name]["outcome"] == "ok"
            ctx.timing.end(name, "error")
            assert ctx.timing.spans[name]["outcome"] == "ok"
        finally:
            release.set()
            worker.join(5)
            monkeypatch.setattr(chat, attribute, original)


def test_rpc_shutdown_records_unknown_once_and_cancel_remains_cooperative(caplog):
    import threading
    caplog.set_level(logging.INFO)
    entered, release = threading.Event(), threading.Event()
    def start(ctx, params):
        entered.set()
        assert release.wait(5)
        assert ctx.cancelled
        return {"status": "cancelled"}
    server = RpcServer({"chat.start": start}, stdout=io.BytesIO())
    request = {"id": 1, "method": "chat.start", "params": {}}
    ctx = server._register(request)
    worker = threading.Thread(target=server._dispatch, args=(request, ctx))
    try:
        worker.start()
        assert entered.wait(5)
        server.request_shutdown()
        assert worker.is_alive()
        release.set()
        worker.join(5)
        records = [json.loads(r.message) for r in caplog.records if r.message.startswith('{"event":"chat_start_timing"')]
        assert len(records) == 1
        assert records[0]["outcome"] == "unknown"
        assert not server._active
    finally:
        release.set()
        worker.join(5)
