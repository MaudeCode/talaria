"""Approval selection and choice policy, once with Agent boundary fakes."""

import contextlib
import sys
import threading
from types import ModuleType, SimpleNamespace

import pytest

from talaria_sidecar.errors import RpcError
from talaria_sidecar.methods import Registry, chat


@pytest.fixture
def approvals(monkeypatch):
    api = ModuleType("tools.approval")
    api.session_grants = []
    api.saved = []
    api.permanent = {"old *"}
    api._lock = threading.Lock()
    api._permanent_set = lambda: api.permanent
    api._baseline_key = lambda: "profile"
    api._permanent_baseline_by_home = {"profile": {"old *"}}
    api.approve_session = lambda sid, key: api.session_grants.append((sid, key))
    api.approve_permanent = api.permanent.add
    api.save_permanent_allowlist = lambda grants: api.saved.append(set(grants))
    api.pending = [{"request_id": "first", "pattern_key": "first *"},
                   {"request_id": "second", "pattern_keys": ["second *", "extra *", ""]}]
    api.list_gateway_approvals = lambda _: list(api.pending)

    def resolve(sid, choice, request_id=None):
        targets = [e for e in api.pending if e["request_id"] == request_id] if request_id else api.pending[:1]
        api.pending = [e for e in api.pending if e not in targets]
        return len(targets)

    api.resolve_gateway_approval = resolve
    tools = ModuleType("tools")
    tools.approval = api
    monkeypatch.setitem(sys.modules, "tools", tools)
    monkeypatch.setitem(sys.modules, "tools.approval", api)
    monkeypatch.setattr(chat, "scoped_home", contextlib.nullcontext)
    registry = Registry(SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
    chat.register(registry)
    return api, registry.methods["approval.respond"]


@pytest.mark.parametrize("choice", ["deny", "once", "session", "always"])
def test_only_the_selected_request_receives_the_chosen_grants(approvals, choice):
    api, respond = approvals
    result = respond(None, {"profile_home": "/synthetic", "session_id": "s", "request_id": "second", "choice": choice})
    assert result == {"ok": True, "resolved": 1, "choice": choice}
    assert [e["request_id"] for e in api.pending] == ["first"]
    assert api.session_grants == ([("s", "second *"), ("s", "extra *")] if choice in ("session", "always") else [])
    assert api.permanent == ({"old *", "second *", "extra *"} if choice == "always" else {"old *"})
    assert api.saved == ([{"second *", "extra *"}] if choice == "always" else [])


@pytest.mark.parametrize("choice", ["session", "always"])
def test_no_request_id_grants_only_the_fifo_request_that_is_resolved(approvals, choice):
    api, respond = approvals
    assert respond(None, {"profile_home": "/synthetic", "session_id": "s", "choice": choice})["resolved"] == 1
    assert api.session_grants == [("s", "first *")]
    assert [e["request_id"] for e in api.pending] == ["second"]


def test_missing_request_never_changes_grants(approvals):
    api, respond = approvals
    assert respond(None, {"profile_home": "/synthetic", "session_id": "s", "request_id": "absent", "choice": "always"})["ok"] is False
    assert not api.session_grants and not api.saved
    assert api.permanent == {"old *"}


@pytest.mark.parametrize("capability", ["_permanent_set", "_baseline_key", "_permanent_baseline_by_home"])
def test_an_agent_without_safe_reconciliation_is_refused_before_granting(approvals, capability):
    api, respond = approvals
    delattr(api, capability)
    with pytest.raises(RpcError) as refused:
        respond(None, {"profile_home": "/synthetic", "session_id": "s", "request_id": "second", "choice": "always"})
    assert refused.value.data["condition"] == "agent_incompatible"
    assert len(api.pending) == 2
    assert not api.session_grants and not api.saved
    assert api.permanent == {"old *"}
