"""Sidecar-to-server requests (TAL-1164) in-process against a fake server peer: no Agent checkout needed."""

from __future__ import annotations

import json
import os
import pathlib
import threading
import time

import pytest

from conftest import validate
from talaria_sidecar import rpc, talaria_toolset
from talaria_sidecar.errors import RpcError
from talaria_sidecar.rpc import RpcServer

HERE = pathlib.Path(__file__).parent
SCHEMAS = json.loads((HERE / "fixtures" / "server_schemas.json").read_text())
SERVER_FIXTURES = json.loads((HERE.parent.parent / "packages" / "contracts" / "fixtures" / "sidecar" / "server.json").read_text())
RECORDED = SERVER_FIXTURES["server.session_list"][0]


class Peer:
    """The server end of the stdio pipes: reads what the sidecar writes, answers through ``reply``."""

    def __init__(self, answer=None):
        to_sidecar_r, self.to_sidecar = os.pipe()
        self.from_sidecar, from_sidecar_w = os.pipe()
        self.server = RpcServer({}, stdin=os.fdopen(to_sidecar_r, "rb"), stdout=os.fdopen(from_sidecar_w, "wb"))
        self.answer = answer
        self.requests: list[dict] = []
        self.reader = threading.Thread(target=self.server.serve_forever, daemon=True)
        threading.Thread(target=self._read, daemon=True).start()
        self.reader.start()

    def _read(self) -> None:
        with os.fdopen(self.from_sidecar, "rb") as out:
            for line in out:
                message = json.loads(line)
                self.requests.append(message)
                reply = self.answer(message) if self.answer else None
                if reply is not None:
                    self.reply({"jsonrpc": "2.0", "id": message["id"], **reply})

    def reply(self, message: dict) -> None:
        os.write(self.to_sidecar, json.dumps(message).encode() + b"\n")

    def close(self) -> None:
        try:
            os.close(self.to_sidecar)
        except OSError:
            pass
        self.reader.join(5)


@pytest.fixture
def peer():
    peers: list[Peer] = []

    def make(answer=None) -> Peer:
        peers.append(Peer(answer))
        # serve_forever has started once it took the channel.
        deadline = time.monotonic() + 5
        while rpc._ACTIVE is not peers[-1].server and time.monotonic() < deadline:
            time.sleep(0.01)
        return peers[-1]

    yield make
    for made in peers:
        made.close()


def test_a_server_call_round_trips_and_both_directions_match_the_contract(peer) -> None:
    def answer(message):
        assert validate(message["params"], SCHEMAS[message["method"]]["params"]) == []
        return {"result": RECORDED["result"]}

    p = peer(answer)
    result = rpc.call_server("server.session_list", RECORDED["params"])
    assert result == RECORDED["result"]
    assert validate(result, SCHEMAS["server.session_list"]["result"]) == []
    assert p.requests[0]["id"].startswith("s:") and p.requests[0]["method"] == "server.session_list"
    # Two calls never share an id, and the server's own integer-id requests still dispatch beside them.
    rpc.call_server("server.session_list", RECORDED["params"])
    assert len({r["id"] for r in p.requests}) == 2


def test_a_server_error_reaches_the_caller_with_its_condition(peer) -> None:
    peer(lambda message: {"error": {"code": -32000, "message": "no Talaria session x", "data": {"condition": "caller_unknown"}}})
    with pytest.raises(RpcError) as raised:
        rpc.call_server("server.session_list", {"caller_session_id": "x"})
    assert str(raised.value) == "no Talaria session x"
    assert raised.value.data == {"condition": "caller_unknown"}


def test_an_unanswered_call_times_out_and_a_late_reply_is_ignored(peer) -> None:
    p = peer()
    started = time.monotonic()
    with pytest.raises(RpcError) as raised:
        rpc.call_server("server.session_list", {"caller_session_id": "x"}, timeout=0.2)
    assert raised.value.data["condition"] == "timeout"
    assert time.monotonic() - started < 2
    assert p.server._server_calls == {}
    p.reply({"jsonrpc": "2.0", "id": p.requests[0]["id"], "result": {}})


@pytest.mark.parametrize("how", ["shutdown", "stdin_closed"])
def test_closing_the_channel_fails_every_pending_call(peer, how) -> None:
    p = peer()
    outcomes: list[RpcError] = []

    def waiting_call():
        try:
            rpc.call_server("server.session_list", {"caller_session_id": "x"}, timeout=30)
        except RpcError as exc:
            outcomes.append(exc)

    callers = [threading.Thread(target=waiting_call) for _ in range(2)]
    for caller in callers:
        caller.start()
    deadline = time.monotonic() + 5
    while len(p.requests) < 2 and time.monotonic() < deadline:
        time.sleep(0.01)
    started = time.monotonic()
    if how == "shutdown":
        p.server.request_shutdown()
    else:
        os.close(p.to_sidecar)
    for caller in callers:
        caller.join(5)
    assert time.monotonic() - started < 5
    assert [exc.data["condition"] for exc in outcomes] == ["server_unavailable"] * 2
    with pytest.raises(RpcError) as raised:
        p.server.call_server("server.session_list", {"caller_session_id": "x"})
    assert raised.value.data["condition"] == "server_unavailable"


def test_session_list_forwards_the_web_session_of_the_calling_agent(monkeypatch) -> None:
    from types import SimpleNamespace

    from talaria_sidecar.methods import chat

    # Compression moved this Web session's running agent onto a new Agent session id.
    monkeypatch.setitem(chat._RUNS, "stream-1", SimpleNamespace(session_id="20261020_120000_caller", agent=SimpleNamespace(session_id="20261020_130000_tip")))
    sent: list[tuple[str, dict]] = []
    monkeypatch.setattr(rpc, "call_server", lambda method, params, **kw: sent.append((method, params)) or RECORDED["result"])
    assert json.loads(talaria_toolset.session_list({"query": "  "}, session_id="20261020_130000_tip")) == RECORDED["result"]
    assert sent == [("server.session_list", {"caller_session_id": "20261020_120000_caller", "query": None})]
    talaria_toolset.session_list({"query": "release"}, session_id="unknown_agent_session")
    assert sent[-1] == ("server.session_list", {"caller_session_id": "unknown_agent_session", "query": "release"})
    for method, params in sent:
        assert validate(params, SCHEMAS[method]["params"]) == []

    def refuse(method, params, **kw):
        raise RpcError("no Talaria session unknown_agent_session", condition="caller_unknown")

    monkeypatch.setattr(rpc, "call_server", refuse)
    assert json.loads(talaria_toolset.session_list({}, session_id="unknown_agent_session")) == {"error": "no Talaria session unknown_agent_session", "condition": "caller_unknown"}
    assert json.loads(talaria_toolset.session_list({}))["condition"] == "caller_unknown"


@pytest.mark.parametrize(("tool", "method"), [
    ("queue_list", "server.queue_list"),
    ("queue_send_now", "server.queue_send_now"),
    ("queue_withdraw", "server.queue_withdraw"),
])
def test_queue_tools_forward_the_target_and_return_the_server_result_unchanged(monkeypatch, tool, method) -> None:
    """TAL-1167: each queue tool sends the calling Web session, the target and the steer to its ``server.*`` method."""
    from types import SimpleNamespace

    from talaria_sidecar.methods import chat

    recorded = SERVER_FIXTURES[method][0]
    handler = getattr(talaria_toolset, tool)
    monkeypatch.setitem(chat._RUNS, "stream-1", SimpleNamespace(session_id=recorded["params"]["caller_session_id"], agent=SimpleNamespace(session_id="20261020_130000_tip")))
    sent: list[tuple[str, dict]] = []
    monkeypatch.setattr(rpc, "call_server", lambda m, params, **kw: sent.append((m, params)) or recorded["result"])
    args = {key: f"  {value}  " for key, value in recorded["params"].items() if key != "caller_session_id"}
    assert json.loads(handler(args, session_id="20261020_130000_tip")) == recorded["result"]
    assert sent == [(method, recorded["params"])]
    assert validate(sent[0][1], SCHEMAS[method]["params"]) == []
    assert validate(recorded["result"], SCHEMAS[method]["result"]) == []

    # A missing target or steer never reaches the server; the server's refusal reaches the agent with its condition.
    for missing in args:
        assert json.loads(handler({k: v for k, v in args.items() if k != missing}, session_id="20261020_130000_tip")) == {"error": f"{missing} is required", "condition": "invalid_params"}
    assert len(sent) == 1

    def refuse(m, params, **kw):
        raise RpcError("a session cannot manage its own queue; it is delivered after your turn ends", condition="self_target")

    monkeypatch.setattr(rpc, "call_server", refuse)
    assert json.loads(handler(args, session_id="20261020_130000_tip"))["condition"] == "self_target"
    assert json.loads(handler(args))["condition"] == "caller_unknown"


def test_the_talaria_toolset_registers_every_tool_under_its_schema_name(monkeypatch) -> None:
    import sys
    from types import ModuleType, SimpleNamespace

    registered: list[dict] = []
    fake = ModuleType("tools.registry")
    fake.registry = SimpleNamespace(register=lambda **kw: registered.append(kw))
    monkeypatch.setitem(sys.modules, "tools", ModuleType("tools"))
    monkeypatch.setitem(sys.modules, "tools.registry", fake)
    talaria_toolset.register()
    assert [(r["name"], r["toolset"], r["handler"].__name__) for r in registered] == [
        ("session_list", "talaria", "session_list"),
        ("queue_list", "talaria", "queue_list"),
        ("queue_send_now", "talaria", "queue_send_now"),
        ("queue_withdraw", "talaria", "queue_withdraw"),
        ("session_new", "talaria", "session_new"),
        ("session_send", "talaria", "session_send"),
        ("session_wait", "talaria", "session_wait"),
        ("session_interrupt", "talaria", "session_interrupt"),
    ]
    assert all(r["schema"]["name"] == r["name"] for r in registered)
    # session_wait outlasts the Agent's generic tool deadline by its own longest wait plus the server call's margin.
    assert {r["name"]: r.get("execution_timeout") for r in registered if "execution_timeout" in r} == {"session_wait": 630.0}


@pytest.mark.parametrize(("tool", "method", "index"), [
    ("session_new", "server.session_new", 0),
    ("session_send", "server.session_send", 0),
    ("session_send", "server.session_send", 1),
    ("session_wait", "server.session_wait", 0),
    ("session_wait", "server.session_wait", 1),
    ("session_interrupt", "server.session_interrupt", 0),
])
def test_session_tools_forward_their_call_and_return_the_server_result_unchanged(monkeypatch, tool, method, index) -> None:
    """TAL-1165: each session tool sends the calling Web session and its arguments to its ``server.*`` method."""
    from types import SimpleNamespace

    from talaria_sidecar.methods import chat

    recorded = SERVER_FIXTURES[method][index]
    handler = getattr(talaria_toolset, tool)
    monkeypatch.setitem(chat._RUNS, "stream-1", SimpleNamespace(session_id=recorded["params"]["caller_session_id"], agent=SimpleNamespace(session_id="20261020_130000_tip")))
    sent: list[tuple[str, dict, float | None]] = []
    monkeypatch.setattr(rpc, "call_server", lambda m, params, timeout=None: sent.append((m, params, timeout)) or recorded["result"])
    args = {key: f"  {value}  " if isinstance(value, str) else value for key, value in recorded["params"].items() if key != "caller_session_id"}
    assert json.loads(handler(args, session_id="20261020_130000_tip")) == recorded["result"]
    timeout = recorded["params"]["timeout_s"] + rpc.SERVER_CALL_TIMEOUT if tool == "session_wait" else None
    assert sent == [(method, recorded["params"], timeout)]
    assert validate(sent[0][1], SCHEMAS[method]["params"]) == []
    assert validate(recorded["result"], SCHEMAS[method]["result"]) == []

    # A missing required string never reaches the server; the server's refusal reaches the agent with its condition.
    for missing in [key for key, value in args.items() if isinstance(value, str) and key != "title"]:
        assert json.loads(handler({k: v for k, v in args.items() if k != missing}, session_id="20261020_130000_tip")) == {"error": f"{missing} is required", "condition": "invalid_params"}
    assert len(sent) == 1

    def refuse(m, params, timeout=None):
        raise RpcError("Read-only imported sessions cannot be modified from WebUI", condition="read_only")

    monkeypatch.setattr(rpc, "call_server", refuse)
    assert json.loads(handler(args, session_id="20261020_130000_tip")) == {"error": "Read-only imported sessions cannot be modified from WebUI", "condition": "read_only"}
    assert json.loads(handler(args))["condition"] == "caller_unknown"


def test_session_wait_clamps_its_timeout_and_session_new_drops_a_blank_title(monkeypatch) -> None:
    sent: list[tuple[dict, float | None]] = []
    monkeypatch.setattr(rpc, "call_server", lambda m, params, timeout=None: sent.append((params, timeout)) or {})
    for timeout_s, expected in ((None, 300), (5000, 600), (0, 1), (True, 300), ("90", 300), (42.9, 42), (float("nan"), 300), (float("inf"), 300)):
        talaria_toolset.session_wait({"session_id": "s1", **({} if timeout_s is None else {"timeout_s": timeout_s})}, session_id="caller")
        assert sent[-1] == ({"caller_session_id": "caller", "session_id": "s1", "timeout_s": expected}, expected + rpc.SERVER_CALL_TIMEOUT)
    talaria_toolset.session_new({"message": "go", "title": "   "}, session_id="caller")
    assert sent[-1] == ({"caller_session_id": "caller", "message": "go"}, None)
