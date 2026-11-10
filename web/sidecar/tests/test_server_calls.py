"""Sidecar-to-server requests (TAL-1164) in-process against a fake server peer: no Agent checkout needed."""

from __future__ import annotations

import json
import os
import pathlib
import sys
import threading
import time

import pytest

from conftest import validate
from talaria_sidecar import harness_toolset, rpc, talaria_toolset
from talaria_sidecar.errors import RpcError
from talaria_sidecar.rpc import RpcServer

HERE = pathlib.Path(__file__).parent
SCHEMAS = json.loads((HERE / "fixtures" / "server_schemas.json").read_text())
SERVER_FIXTURES = json.loads((HERE.parent.parent / "packages" / "contracts" / "fixtures" / "sidecar" / "server.json").read_text())
RECORDED = SERVER_FIXTURES["server.session_list"][0]
DECISION_FIXTURES = json.loads((HERE.parent.parent / "packages" / "contracts" / "fixtures" / "sidecar" / "decisions.json").read_text())
PROPOSAL_FIXTURES = json.loads((HERE.parent.parent / "packages" / "contracts" / "fixtures" / "sidecar" / "proposals.json").read_text())
SHOW_FIXTURES = json.loads((HERE.parent.parent / "packages" / "contracts" / "fixtures" / "sidecar" / "show.json").read_text())
SECRET_FIXTURES = json.loads((HERE.parent.parent / "packages" / "contracts" / "fixtures" / "sidecar" / "secrets.json").read_text())
NOTIFY_FIXTURES = json.loads((HERE.parent.parent / "packages" / "contracts" / "fixtures" / "sidecar" / "notify.json").read_text())
DELIVER_FIXTURES = json.loads((HERE.parent.parent / "packages" / "contracts" / "fixtures" / "sidecar" / "deliver.json").read_text())
TERMINAL_FIXTURES = json.loads((HERE.parent.parent / "packages" / "contracts" / "fixtures" / "sidecar" / "terminal.json").read_text())
REPORT_ISSUE_FIXTURES = json.loads((HERE.parent.parent / "packages" / "contracts" / "fixtures" / "sidecar" / "report-issue.json").read_text())
USAGE_READ_FIXTURES = json.loads((HERE.parent.parent / "packages" / "contracts" / "fixtures" / "sidecar" / "usage-read.json").read_text())


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
        ("session_branch", "talaria", "session_branch"),
        ("session_update", "talaria", "session_update"),
        ("session_handoff", "talaria", "session_handoff"),
        ("session_compress", "talaria", "session_compress"),
        ("background_list", "talaria", "background_list"),
        ("pending_list", "talaria", "pending_list"),
        ("clarify_respond", "talaria", "clarify_respond"),
        ("approval_respond", "talaria", "approval_respond"),
        ("project_list", "talaria", "project_list"),
        ("project_create", "talaria", "project_create"),
        ("project_rename", "talaria", "project_rename"),
        ("workspace_list", "talaria", "workspace_list"),
        ("workspace_add", "talaria", "workspace_add"),
        ("workspace_rename", "talaria", "workspace_rename"),
        ("profile_list", "talaria", "profile_list"),
        ("goal_get", "talaria", "goal_get"),
        ("goal_set", "talaria", "goal_set"),
    ]
    assert all(r["schema"]["name"] == r["name"] for r in registered)
    # session_wait and session_compress outlast the Agent's generic tool deadline by their own server call's timeout.
    assert {r["name"]: r.get("execution_timeout") for r in registered if "execution_timeout" in r} == {"session_wait": 630.0, "session_compress": 600.0}


@pytest.mark.parametrize(("tool", "method", "index"), [
    ("session_new", "server.session_new", 0),
    ("session_send", "server.session_send", 0),
    ("session_send", "server.session_send", 1),
    ("session_wait", "server.session_wait", 0),
    ("session_wait", "server.session_wait", 1),
    ("session_interrupt", "server.session_interrupt", 0),
    ("session_branch", "server.session_branch", 0),
    ("session_branch", "server.session_branch", 1),
    ("session_update", "server.session_update", 0),
    ("session_handoff", "server.session_handoff", 0),
    ("session_compress", "server.session_compress", 0),
    ("background_list", "server.background_list", 0),
    ("pending_list", "server.pending_list", 0),
    ("pending_list", "server.pending_list", 1),
    ("clarify_respond", "server.clarify_respond", 0),
    ("approval_respond", "server.approval_respond", 0),
    ("approval_respond", "server.approval_respond", 1),
    ("project_list", "server.project_list", 0),
    ("project_create", "server.project_create", 0),
    ("project_rename", "server.project_rename", 0),
    ("workspace_list", "server.workspace_list", 0),
    ("workspace_add", "server.workspace_add", 0),
    ("workspace_add", "server.workspace_add", 1),
    ("workspace_rename", "server.workspace_rename", 0),
    ("profile_list", "server.profile_list", 0),
    ("goal_get", "server.goal_get", 0),
    ("goal_set", "server.goal_set", 0),
    ("goal_set", "server.goal_set", 1),
])
def test_session_tools_forward_their_call_and_return_the_server_result_unchanged(monkeypatch, tool, method, index) -> None:
    """TAL-1165, TAL-1166, TAL-1168, TAL-1169, TAL-1170: each session tool sends the calling Web session and its arguments to its ``server.*`` method."""
    from types import SimpleNamespace

    from talaria_sidecar.methods import chat

    recorded = SERVER_FIXTURES[method][index]
    handler = getattr(talaria_toolset, tool)
    monkeypatch.setitem(chat._RUNS, "stream-1", SimpleNamespace(session_id=recorded["params"]["caller_session_id"], agent=SimpleNamespace(session_id="20261020_130000_tip")))
    sent: list[tuple[str, dict, float | None]] = []
    monkeypatch.setattr(rpc, "call_server", lambda m, params, timeout=None: sent.append((m, params, timeout)) or recorded["result"])
    args = {key: f"  {value}  " if isinstance(value, str) else value for key, value in recorded["params"].items() if key != "caller_session_id"}
    assert json.loads(handler(args, session_id="20261020_130000_tip")) == recorded["result"]
    timeout = {
        "session_wait": recorded["params"].get("timeout_s", 0) + rpc.SERVER_CALL_TIMEOUT,
        "session_handoff": talaria_toolset.SESSION_HANDOFF_TIMEOUT_S,
        "session_compress": talaria_toolset.SESSION_COMPRESS_TIMEOUT_S,
    }.get(tool)
    assert sent == [(method, recorded["params"], timeout)]
    assert validate(sent[0][1], SCHEMAS[method]["params"]) == []
    assert validate(recorded["result"], SCHEMAS[method]["result"]) == []

    # A missing required string never reaches the server; the server's refusal reaches the agent with its condition.
    optional = {"pending_list": ("session_id",), "session_new": ("title",), "session_update": ("title", "project_id"), "workspace_add": ("name",)}.get(tool, ())
    for missing in [key for key, value in args.items() if isinstance(value, str) and key not in optional]:
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


def test_session_update_sends_only_the_fields_given(monkeypatch) -> None:
    """TAL-1166: an absent field stays absent; a null project_id is sent, since it removes the session from its project."""
    sent: list[dict] = []
    monkeypatch.setattr(rpc, "call_server", lambda m, params, timeout=None: sent.append(params) or {})
    talaria_toolset.session_update({"session_id": "s1", "pinned": False}, session_id="caller")
    talaria_toolset.session_update({"session_id": "s1", "project_id": None, "title": "  Release  "}, session_id="caller")
    assert sent == [
        {"caller_session_id": "caller", "session_id": "s1", "pinned": False},
        {"caller_session_id": "caller", "session_id": "s1", "title": "Release", "project_id": None},
    ]


@pytest.mark.parametrize(("tool", "method", "index"), [
    ("decision_review_put", "server.decision_review_put", 0),
    ("decision_review_put", "server.decision_review_put", 1),
    ("decision_review_read", "server.decision_review_read", 0),
    ("decision_review_record", "server.decision_review_record", 0),
])
def test_harness_decision_tools_forward_their_call_and_return_the_server_result_unchanged(monkeypatch, tool, method, index) -> None:
    """TAL-1963: each decision tool sends the calling Web session and its arguments to its ``server.decision_*`` method."""
    from types import SimpleNamespace

    from talaria_sidecar.methods import chat

    recorded = DECISION_FIXTURES[method][index]
    handler = getattr(harness_toolset, tool)
    monkeypatch.setitem(chat._RUNS, "stream-1", SimpleNamespace(session_id=recorded["params"]["caller_session_id"], agent=SimpleNamespace(session_id="20261108_130000_tip")))
    sent: list[tuple[str, dict]] = []
    monkeypatch.setattr(rpc, "call_server", lambda m, params, timeout=None: sent.append((m, params)) or recorded["result"])
    args = {key: value for key, value in recorded["params"].items() if key != "caller_session_id"}
    assert json.loads(handler(args, session_id="20261108_130000_tip")) == recorded["result"]
    assert sent == [(method, recorded["params"])]
    assert validate(sent[0][1], SCHEMAS[method]["params"]) == []
    assert validate(recorded["result"], SCHEMAS[method]["result"]) == []

    def refuse(m, params, timeout=None):
        raise RpcError("item retention has 1 choices; each item has 2 to 4", condition="choices_count")

    monkeypatch.setattr(rpc, "call_server", refuse)
    assert json.loads(handler(args, session_id="20261108_130000_tip")) == {"error": "item retention has 1 choices; each item has 2 to 4", "condition": "choices_count"}
    assert json.loads(handler(args))["condition"] == "caller_unknown"
    assert len(sent) == 1


def test_the_harness_toolset_registers_its_tools_and_the_talaria_one_stays_separate(monkeypatch) -> None:
    import sys
    from types import ModuleType, SimpleNamespace

    registered: list[dict] = []
    fake = ModuleType("tools.registry")
    fake.registry = SimpleNamespace(register=lambda **kw: registered.append(kw))
    monkeypatch.setitem(sys.modules, "tools", ModuleType("tools"))
    monkeypatch.setitem(sys.modules, "tools.registry", fake)
    harness_toolset.register()
    assert [(r["name"], r["toolset"], r["handler"].__name__) for r in registered] == [
        ("decision_review_put", "harness", "decision_review_put"),
        ("decision_review_read", "harness", "decision_review_read"),
        ("decision_review_record", "harness", "decision_review_record"),
        ("propose", "harness", "propose"),
        ("proposal_read", "harness", "proposal_read"),
        ("show", "harness", "show"),
        ("request_secret", "harness", "request_secret"),
        ("notify", "harness", "notify"),
        ("deliver", "harness", "deliver"),
        ("terminal_open", "harness", "terminal_open"),
        ("terminal_read", "harness", "terminal_read"),
        ("report_issue", "harness", "report_issue"),
        ("usage_read", "harness", "usage_read"),
    ]
    assert all(r["schema"]["name"] == r["name"] for r in registered)
    # The descriptions tell the agent when a review beats clarify.
    assert "instead of clarify" in registered[0]["description"]


@pytest.mark.parametrize(("tool", "method"), [("propose", "server.proposal_put"), ("proposal_read", "server.proposal_read")])
def test_harness_proposal_tools_forward_their_call_and_return_the_server_result_unchanged(monkeypatch, tool, method) -> None:
    """TAL-1967: ``propose`` sends the kind, the payload as given and how long it stays open; ``proposal_read`` the id."""
    from types import SimpleNamespace

    from talaria_sidecar.methods import chat

    recorded = PROPOSAL_FIXTURES[method][0]
    handler = getattr(harness_toolset, tool)
    monkeypatch.setitem(chat._RUNS, "stream-1", SimpleNamespace(session_id=recorded["params"]["caller_session_id"], agent=SimpleNamespace(session_id="20261109_090000_tip")))
    monkeypatch.setattr(chat, "_clarify_timeout", lambda params: 3600)
    sent: list[tuple[str, dict]] = []
    monkeypatch.setattr(rpc, "call_server", lambda m, params, timeout=None: sent.append((m, params)) or recorded["result"])
    args = {key: value for key, value in recorded["params"].items() if key not in ("caller_session_id", "timeout_seconds")}
    assert json.loads(handler(args, session_id="20261109_090000_tip")) == recorded["result"]
    assert sent == [(method, recorded["params"])]
    assert validate(sent[0][1], SCHEMAS[method]["params"]) == []
    assert validate(recorded["result"], SCHEMAS[method]["result"]) == []

    def refuse(m, params, timeout=None):
        raise RpcError("_set_password is not a setting a proposal can change", condition="setting_unknown")

    monkeypatch.setattr(rpc, "call_server", refuse)
    assert json.loads(handler(args, session_id="20261109_090000_tip")) == {"error": "_set_password is not a setting a proposal can change", "condition": "setting_unknown"}
    assert json.loads(handler(args))["condition"] == "caller_unknown"
    assert len(sent) == 1
    if tool == "propose":
        # A payload sent as JSON text is the same payload; an absent one reaches the server empty, which names what is missing.
        monkeypatch.setattr(rpc, "call_server", lambda m, params, timeout=None: sent.append((m, params)) or recorded["result"])
        handler({**args, "payload": json.dumps(args["payload"])}, session_id="20261109_090000_tip")
        handler({"kind": args["kind"]}, session_id="20261109_090000_tip")
        assert [params["payload"] for _, params in sent[1:]] == [recorded["params"]["payload"], {}]


def test_harness_show_forwards_its_call_and_returns_the_server_result_unchanged(monkeypatch) -> None:
    """TAL-1968: ``show`` sends the kind and the payload as given to ``server.show_put`` and collects nothing else."""
    from types import SimpleNamespace

    from talaria_sidecar.methods import chat

    recorded = SHOW_FIXTURES["server.show_put"][0]
    monkeypatch.setitem(chat._RUNS, "stream-1", SimpleNamespace(session_id=recorded["params"]["caller_session_id"], agent=SimpleNamespace(session_id="20261109_090000_tip")))
    sent: list[tuple[str, dict]] = []
    monkeypatch.setattr(rpc, "call_server", lambda m, params, timeout=None: sent.append((m, params)) or recorded["result"])
    args = {key: value for key, value in recorded["params"].items() if key != "caller_session_id"}
    assert json.loads(harness_toolset.show(args, session_id="20261109_090000_tip")) == recorded["result"]
    assert sent == [("server.show_put", recorded["params"])]
    assert validate(sent[0][1], SCHEMAS["server.show_put"]["params"]) == []
    assert validate(recorded["result"], SCHEMAS["server.show_put"]["result"]) == []

    def refuse(m, params, timeout=None):
        raise RpcError("../secret.txt is outside this session's workspace", condition="path_outside_workspace")

    monkeypatch.setattr(rpc, "call_server", refuse)
    assert json.loads(harness_toolset.show(args, session_id="20261109_090000_tip")) == {"error": "../secret.txt is outside this session's workspace", "condition": "path_outside_workspace"}
    assert json.loads(harness_toolset.show(args))["condition"] == "caller_unknown"
    assert len(sent) == 1
    # A payload sent as JSON text is the same payload; an absent one reaches the server empty, which names what is missing.
    monkeypatch.setattr(rpc, "call_server", lambda m, params, timeout=None: sent.append((m, params)) or recorded["result"])
    harness_toolset.show({**args, "payload": json.dumps(args["payload"])}, session_id="20261109_090000_tip")
    harness_toolset.show({"kind": "table"}, session_id="20261109_090000_tip")
    assert [params["payload"] for _, params in sent[1:]] == [recorded["params"]["payload"], {}]


def test_harness_request_secret_forwards_its_call_and_never_returns_the_value(monkeypatch) -> None:
    """TAL-1969: ``request_secret`` sends the name, purpose and prompt timeout to ``server.secret_request``, outlasts the
    prompt, and on a save adds the value to this turn's secret scope from the profile ``.env``, reporting ``applied``
    once the Agent's resolver returns it. The value never reaches the result."""
    import sys
    from types import ModuleType, SimpleNamespace

    from talaria_sidecar.methods import chat

    recorded = SECRET_FIXTURES["server.secret_request"][0]
    monkeypatch.setitem(chat._RUNS, "stream-1", SimpleNamespace(session_id=recorded["params"]["caller_session_id"], agent=SimpleNamespace(session_id="20261109_090000_tip")))
    monkeypatch.setattr(chat, "_clarify_timeout", lambda params: 3600)
    sent: list[tuple[str, dict, float | None]] = []
    monkeypatch.setattr(rpc, "call_server", lambda m, params, timeout=None: sent.append((m, params, timeout)) or dict(recorded["result"]))
    scope: dict[str, str] = {}
    secret_scope = ModuleType("agent.secret_scope")
    secret_scope.current_secret_scope = lambda: scope
    secret_scope.get_secret = lambda name: scope.get(name)
    config = ModuleType("hermes_cli.config")
    config.load_env = lambda: {"FOO_API_KEY": "sk-foo-correct-horse"}
    monkeypatch.setitem(sys.modules, "agent.secret_scope", secret_scope)
    monkeypatch.setitem(sys.modules, "hermes_cli.config", config)

    args = {"env_name": "FOO_API_KEY", "purpose": recorded["params"]["purpose"], "optional": False}
    raw = harness_toolset.request_secret(args, session_id="20261109_090000_tip")
    assert json.loads(raw) == {**recorded["result"], "runtime_application": "applied"}
    assert "sk-foo-correct-horse" not in raw
    assert scope == {"FOO_API_KEY": "sk-foo-correct-horse"}
    assert sent == [("server.secret_request", recorded["params"], 3600 + rpc.SERVER_CALL_TIMEOUT)]
    assert validate(sent[0][1], SCHEMAS["server.secret_request"]["params"]) == []
    assert validate(recorded["result"], SCHEMAS["server.secret_request"]["result"]) == []

    # A resolver that cannot see the value (no scope bound, a foreign profile) means the next session picks it up.
    secret_scope.current_secret_scope = lambda: None
    secret_scope.get_secret = lambda name: None
    assert json.loads(harness_toolset.request_secret(args, session_id="20261109_090000_tip"))["runtime_application"] == "restart_required"

    # A decline or a timeout returns the server's answer unchanged; a clarify timeout of 0 never times the call out.
    monkeypatch.setattr(chat, "_clarify_timeout", lambda params: 0)
    monkeypatch.setattr(rpc, "call_server", lambda m, params, timeout=None: sent.append((m, params, timeout)) or {**recorded["result"], "outcome": "declined"})
    assert json.loads(harness_toolset.request_secret(args, session_id="20261109_090000_tip")) == {**recorded["result"], "outcome": "declined"}
    assert sent[-1][2] == threading.TIMEOUT_MAX and sent[-1][1]["timeout_seconds"] == 0

    def refuse(m, params, timeout=None):
        raise RpcError("HERMES_HOME is reserved for Talaria, the Agent or the system; ask for a name of the service's own", condition="env_name_reserved")

    monkeypatch.setattr(rpc, "call_server", refuse)
    assert json.loads(harness_toolset.request_secret({**args, "env_name": "HERMES_HOME"}, session_id="20261109_090000_tip"))["condition"] == "env_name_reserved"
    assert json.loads(harness_toolset.request_secret({"env_name": "FOO_API_KEY"}, session_id="20261109_090000_tip")) == {"error": "purpose is required", "condition": "invalid_params"}


@pytest.mark.parametrize(("clarify", "prompt", "deadline"), [(90, 3600, 3600 + rpc.SERVER_CALL_TIMEOUT), (7200, 7200, 7200 + rpc.SERVER_CALL_TIMEOUT), (0, 0, threading.TIMEOUT_MAX)], ids=["v0.23.1-default", "raised", "no-limit"])
def test_harness_proposals_and_secret_requests_outlast_the_agent_clarify_default(monkeypatch, clarify, prompt, deadline) -> None:
    """TAL-2053: Agent v0.23.1 lowers the clarify default to 90 s; a proposal or secret request stays open an hour (or the
    configured clarify timeout when longer), and never expires when the clarify timeout is 0 or less."""
    import sys
    from types import ModuleType, SimpleNamespace

    from talaria_sidecar.methods import chat

    gateway = ModuleType("tools.clarify_gateway")
    gateway.get_clarify_timeout = lambda: clarify
    monkeypatch.setitem(sys.modules, "tools.clarify_gateway", gateway)
    monkeypatch.setitem(chat._RUNS, "stream-1", SimpleNamespace(session_id="talaria-session", agent=SimpleNamespace(session_id="20261109_090000_tip")))
    sent: list[tuple[str, dict, float | None]] = []
    monkeypatch.setattr(rpc, "call_server", lambda m, params, timeout=None: sent.append((m, params, timeout)) or {"outcome": "declined"})
    harness_toolset.propose({"kind": "setting", "payload": {}}, session_id="20261109_090000_tip")
    harness_toolset.request_secret({"env_name": "FOO_API_KEY", "purpose": "the Foo API"}, session_id="20261109_090000_tip")
    assert [(m, params["timeout_seconds"]) for m, params, _ in sent] == [("server.proposal_put", prompt), ("server.secret_request", prompt)]
    assert sent[1][2] == deadline


@pytest.mark.parametrize("recorded", NOTIFY_FIXTURES["server.notify"], ids=["sent", "rate_limited"])
def test_harness_notify_forwards_its_call_and_returns_the_server_result_unchanged(monkeypatch, recorded) -> None:
    """TAL-1970: ``notify`` sends the title, body and level to ``server.notify`` and returns its JSON as the server sent it."""
    from types import SimpleNamespace

    from talaria_sidecar.methods import chat

    monkeypatch.setitem(chat._RUNS, "stream-1", SimpleNamespace(session_id=recorded["params"]["caller_session_id"], agent=SimpleNamespace(session_id="20261109_090000_tip")))
    sent: list[tuple[str, dict]] = []
    monkeypatch.setattr(rpc, "call_server", lambda m, params, timeout=None: sent.append((m, params)) or recorded["result"])
    args = {key: value for key, value in recorded["params"].items() if key != "caller_session_id"}
    assert json.loads(harness_toolset.notify(args, session_id="20261109_090000_tip")) == recorded["result"]
    assert sent == [("server.notify", recorded["params"])]
    assert validate(sent[0][1], SCHEMAS["server.notify"]["params"]) == []
    assert validate(recorded["result"], SCHEMAS["server.notify"]["result"]) == []

    def refuse(m, params, timeout=None):
        raise RpcError("title is 81 characters; at most 80", condition="title_too_long")

    monkeypatch.setattr(rpc, "call_server", refuse)
    assert json.loads(harness_toolset.notify(args, session_id="20261109_090000_tip")) == {"error": "title is 81 characters; at most 80", "condition": "title_too_long"}
    assert json.loads(harness_toolset.notify({"title": args["title"]}, session_id="20261109_090000_tip")) == {"error": "body is required", "condition": "invalid_params"}


@pytest.mark.parametrize("recorded", DELIVER_FIXTURES["server.deliver"], ids=["titled_pdf", "untitled_download"])
def test_harness_deliver_forwards_its_call_and_returns_the_server_result_unchanged(monkeypatch, recorded) -> None:
    """TAL-1971: ``deliver`` sends the path and title to ``server.deliver`` and returns its JSON as the server sent it."""
    from types import SimpleNamespace

    from talaria_sidecar.methods import chat

    monkeypatch.setitem(chat._RUNS, "stream-1", SimpleNamespace(session_id=recorded["params"]["caller_session_id"], agent=SimpleNamespace(session_id="20261109_090000_tip")))
    sent: list[tuple[str, dict]] = []
    monkeypatch.setattr(rpc, "call_server", lambda m, params, timeout=None: sent.append((m, params)) or recorded["result"])
    args = {key: value for key, value in recorded["params"].items() if key != "caller_session_id"}
    assert json.loads(harness_toolset.deliver(args, session_id="20261109_090000_tip")) == recorded["result"]
    assert sent == [("server.deliver", recorded["params"])]
    assert validate(sent[0][1], SCHEMAS["server.deliver"]["params"]) == []
    assert validate(recorded["result"], SCHEMAS["server.deliver"]["result"]) == []

    def refuse(m, params, timeout=None):
        raise RpcError("../secret.txt is outside this session's workspace", condition="outside_workspace")

    monkeypatch.setattr(rpc, "call_server", refuse)
    assert json.loads(harness_toolset.deliver(args, session_id="20261109_090000_tip")) == {"error": "../secret.txt is outside this session's workspace", "condition": "outside_workspace"}
    assert json.loads(harness_toolset.deliver({}, session_id="20261109_090000_tip")) == {"error": "path is required", "condition": "invalid_params"}


@pytest.mark.parametrize(
    ("method", "tool", "recorded"),
    [("server.terminal_open", "terminal_open", r) for r in TERMINAL_FIXTURES["server.terminal_open"]]
    + [("server.terminal_read", "terminal_read", r) for r in TERMINAL_FIXTURES["server.terminal_read"]],
    ids=["open_command", "read_from_start", "read_capped_after_exit"],
)
def test_harness_terminal_tools_forward_their_call_and_return_the_server_result_unchanged(monkeypatch, method, tool, recorded) -> None:
    """TAL-1974: ``terminal_open`` and ``terminal_read`` send their arguments to ``server.terminal_*`` and return its JSON as sent."""
    from types import SimpleNamespace

    from talaria_sidecar.methods import chat

    monkeypatch.setitem(chat._RUNS, "stream-1", SimpleNamespace(session_id=recorded["params"]["caller_session_id"], agent=SimpleNamespace(session_id="20261109_090000_tip")))
    guarded: list[str] = []
    _agent_guard(monkeypatch, lambda command, env_type: guarded.append(command) or {"approved": True, "message": None})
    sent: list[tuple[str, dict]] = []
    monkeypatch.setattr(rpc, "call_server", lambda m, params, timeout=None: sent.append((m, params)) or recorded["result"])
    handler = getattr(harness_toolset, tool)
    args = {key: value for key, value in recorded["params"].items() if key != "caller_session_id"}
    assert json.loads(handler(args, session_id="20261109_090000_tip")) == recorded["result"]
    assert sent == [(method, recorded["params"])]
    assert guarded == ([recorded["params"]["command"]] if tool == "terminal_open" else [])
    assert validate(sent[0][1], SCHEMAS[method]["params"]) == []
    assert validate(recorded["result"], SCHEMAS[method]["result"]) == []

    def refuse(m, params, timeout=None):
        raise RpcError("This session already has a live terminal", condition="limit_reached")

    monkeypatch.setattr(rpc, "call_server", refuse)
    assert json.loads(handler(args, session_id="20261109_090000_tip")) == {"error": "This session already has a live terminal", "condition": "limit_reached"}


def _agent_guard(monkeypatch, guard) -> None:
    """Stand in for the Agent's ``tools.approval`` command guard, which the fast layer runs without an Agent."""
    from types import ModuleType

    tools = ModuleType("tools")
    approval = ModuleType("tools.approval")
    approval.check_all_command_guards = guard
    tools.approval = approval
    monkeypatch.setitem(sys.modules, "tools", tools)
    monkeypatch.setitem(sys.modules, "tools.approval", approval)


@pytest.mark.parametrize(
    ("verdict", "condition"),
    [
        ({"approved": False, "message": "BLOCKED: rm -rf / is on the blocklist"}, "approval_denied"),
        ({"approved": False, "status": "pending_approval", "description": "recursive delete"}, "approval_pending"),
    ],
    ids=["denied", "pending"],
)
def test_harness_terminal_open_types_nothing_the_agent_command_guard_refuses(monkeypatch, verdict, condition) -> None:
    """TAL-1974: the command passes the Agent's own terminal approval before the server starts or types anything."""
    _agent_guard(monkeypatch, lambda command, env_type: verdict)
    sent: list = []
    monkeypatch.setattr(rpc, "call_server", lambda m, params, timeout=None: sent.append(m))
    result = json.loads(harness_toolset.terminal_open({"command": "rm -rf /"}, session_id="20261109_090000_tip"))
    assert result["condition"] == condition and result["error"]
    assert sent == []


@pytest.mark.parametrize("recorded", REPORT_ISSUE_FIXTURES["server.report_issue"], ids=["with_diagnostics", "without_diagnostics"])
def test_harness_report_issue_forwards_its_call_and_returns_the_server_result_unchanged(monkeypatch, recorded) -> None:
    """TAL-1972: ``report_issue`` sends its arguments to ``server.report_issue`` and returns its JSON, or its refusal with the
    refusal's data, as sent."""
    from types import SimpleNamespace

    from talaria_sidecar.methods import chat

    monkeypatch.setitem(chat._RUNS, "stream-1", SimpleNamespace(session_id=recorded["params"]["caller_session_id"], agent=SimpleNamespace(session_id="20261109_090000_tip")))
    sent: list[tuple[str, dict]] = []
    monkeypatch.setattr(rpc, "call_server", lambda m, params, timeout=None: sent.append((m, params)) or recorded["result"])
    args = {key: value for key, value in recorded["params"].items() if key != "caller_session_id"}
    assert json.loads(harness_toolset.report_issue(args, session_id="20261109_090000_tip")) == recorded["result"]
    assert sent == [("server.report_issue", recorded["params"])]
    assert validate(sent[0][1], SCHEMAS["server.report_issue"]["params"]) == []
    assert validate(recorded["result"], SCHEMAS["server.report_issue"]["result"]) == []

    def refuse(m, params, timeout=None):
        raise RpcError("Too many feedback reports were sent from this server recently", condition="rate_limited", data={"retry_after_seconds": 42})

    monkeypatch.setattr(rpc, "call_server", refuse)
    assert json.loads(harness_toolset.report_issue(args, session_id="20261109_090000_tip")) == {"error": "Too many feedback reports were sent from this server recently", "condition": "rate_limited", "retry_after_seconds": 42}
    assert json.loads(harness_toolset.report_issue({"summary": "x"}, session_id="20261109_090000_tip")) == {"error": "detail is required", "condition": "invalid_params"}


@pytest.mark.parametrize("recorded", USAGE_READ_FIXTURES["server.usage_read"], ids=["with_quota", "without_quota"])
def test_harness_usage_read_forwards_its_call_and_returns_the_server_result_unchanged(monkeypatch, recorded) -> None:
    """TAL-1973: ``usage_read`` sends only the caller to ``server.usage_read`` and returns its JSON as sent; outside a
    Talaria session it answers caller_unknown without a call."""
    from types import SimpleNamespace

    from talaria_sidecar.methods import chat

    monkeypatch.setitem(chat._RUNS, "stream-1", SimpleNamespace(session_id=recorded["params"]["caller_session_id"], agent=SimpleNamespace(session_id="20261109_090000_tip")))
    sent: list[tuple[str, dict]] = []
    monkeypatch.setattr(rpc, "call_server", lambda m, params, timeout=None: sent.append((m, params)) or recorded["result"])
    assert json.loads(harness_toolset.usage_read({}, session_id="20261109_090000_tip")) == recorded["result"]
    assert sent == [("server.usage_read", recorded["params"])]
    assert validate(sent[0][1], SCHEMAS["server.usage_read"]["params"]) == []
    assert validate(recorded["result"], SCHEMAS["server.usage_read"]["result"]) == []
    assert json.loads(harness_toolset.usage_read({})) == {"error": "usage_read runs only inside a Talaria chat session", "condition": "caller_unknown"}
    assert len(sent) == 1
