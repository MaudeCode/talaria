"""TAL-2684: ``gateway.bot_deliveries`` answers only a profile's canonical Bot Chat, from its owner's read-only
``bot_delivery.list``. Pure Talaria behavior against a fake owner; the canonical lookup has its own Agent test
(``test_profile_identity.py``)."""
import asyncio
import json
from contextlib import asynccontextmanager
import sys
from types import SimpleNamespace

import pytest

from conftest import SIDECAR_ROOT, assert_matches

ROW = {"delivery_id": "d1", "target": "scout", "target_handle": "@scout", "state": "waiting_on_you", "since": 1700000000.5,
       "preview": "Find the Q3 numbers", "waiting_on": "clarify"}


class RPCError(Exception):
    def __init__(self, reason, code=None):
        super().__init__(reason)
        self.code = code


def _owner(monkeypatch, tmp_path, answer, *, state="ready"):
    """A fake owner for two profiles' homes; ``answer`` is the native list or the error it raises. Returns the calls."""
    from talaria_sidecar.methods import bot_deliveries as module
    calls = []
    homes = {tmp_path / "a": {"session_id": "a-root", "tip_session_id": "a-tip"}, tmp_path / "b": {"session_id": "b-root", "tip_session_id": "b-root"}}

    class Client:
        async def rpc(self, method, **params):
            calls.append((method, params))
            if method == "runtime.describe":
                return {}
            if isinstance(answer, Exception):
                raise answer
            return answer

    @asynccontextmanager
    async def connect(home, _endpoint):
        calls.append(("connect", home))
        yield Client(), None

    monkeypatch.setitem(sys.modules, "hermes_cli.gateway_client", SimpleNamespace(GatewayRPCError=RPCError))
    monkeypatch.setattr(module, "canonical_bot_chat", lambda home: homes.get(home))
    monkeypatch.setattr(module, "_connect", connect)
    monkeypatch.setattr(module, "_owner_refusal", lambda *_: None)
    monkeypatch.setattr(module, "_served", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(module, "_with_owner", lambda home, run: asyncio.run(run(SimpleNamespace(state=state, endpoint="ws://owner"))))
    for home in homes:
        home.mkdir()
    return module, calls


def _call(module, home, sid):
    return module.bot_deliveries(SimpleNamespace(check_cancelled=lambda: None), {"profile_home": str(home), "session_id": sid})


@pytest.mark.parametrize("sid", ["a-root", "a-tip"])
def test_the_canonical_bot_chat_reads_its_owners_list_through_the_allowlist(monkeypatch, tmp_path, sid):
    # The shared fixture the server maps is this method's output for the owner's rows, extra native fields dropped.
    native = json.loads((SIDECAR_ROOT.parents[1] / "contracts/fixtures/bot-deliveries.json").read_text())["native"]
    rows = [{**row, "error": "secret detail", "extra": "dropped"} for row in native["deliveries"]]
    module, calls = _owner(monkeypatch, tmp_path, {"sender": "a", "deliveries": rows})
    result = _call(module, tmp_path / "a", sid)
    assert_matches("gateway.bot_deliveries", result)
    assert result == native
    # One read, with no parameters: the owner lists its own profile as the sender. Nothing else is sent.
    assert [c for c in calls if c[0] != "connect"] == [("runtime.describe", {}), ("bot_delivery.list", {})]


def test_an_empty_list_is_available(monkeypatch, tmp_path):
    module, _ = _owner(monkeypatch, tmp_path, {"sender": "a", "deliveries": []})
    assert _call(module, tmp_path / "a", "a-tip") == {"state": "available", "reason": None, "deliveries": []}


@pytest.mark.parametrize("home,sid", [("a", "b-root"), ("b", "a-tip"), ("a", "side-chat")])
def test_any_other_chat_including_another_profiles_bot_chat_never_reaches_an_owner(monkeypatch, tmp_path, home, sid):
    module, calls = _owner(monkeypatch, tmp_path, {"sender": "a", "deliveries": [ROW]})
    assert _call(module, tmp_path / home, sid) == {"state": "not_bot_chat", "reason": None, "deliveries": []}
    assert calls == []


@pytest.mark.parametrize("answer,expected", [
    (RPCError("unknown_method", -32601), ("unsupported", "agent_unsupported")),
    (RPCError("unknown_method"), ("unsupported", "agent_unsupported")),
    (RPCError("storage_unavailable"), ("unavailable", "owner_refused")),
    ({"sender": "a", "deliveries": [{**ROW, "state": "dismissed"}]}, ("unavailable", "owner_invalid")),
])
def test_an_older_agent_is_unsupported_and_any_other_failure_is_transient(monkeypatch, tmp_path, answer, expected):
    module, _ = _owner(monkeypatch, tmp_path, answer)
    assert _call(module, tmp_path / "a", "a-tip") == {"state": expected[0], "reason": expected[1], "deliveries": []}


def test_a_stopped_or_restarting_owner_is_named(monkeypatch, tmp_path):
    module, calls = _owner(monkeypatch, tmp_path, {"deliveries": []}, state="restarting")
    assert _call(module, tmp_path / "a", "a-tip")["state"] == "unavailable"
    monkeypatch.setattr(module, "_with_owner", lambda _home, _run: {"state": "stopped", "reason": "stopped", "snapshot": None, "receipt": None})
    assert _call(module, tmp_path / "a", "a-tip") == {"state": "stopped", "reason": "stopped", "deliveries": []}
    assert calls == []
