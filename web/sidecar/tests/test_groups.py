"""Native room compatibility through the actual sidecar RPC boundary."""
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, isolated_env, requires_agent


@requires_agent
@pytest.mark.parametrize("scenario", ["round-trip", "approval", "stop", "partial", "lead"])
def test_native_group_round_trip(tmp_path, scenario):
    env = isolated_env(tmp_path / "hermes", TALARIA_WEB_AGENT_DIR=str(AGENT_DIR),
                       TALARIA_WEB_PYTHON=str(AGENT_PYTHON),
                       PYTHONPATH=f"{SIDECAR_ROOT}:{Path(pytest.__file__).parent.parent}")
    result = subprocess.run([AGENT_PYTHON, str(Path(__file__).parent / "fixtures/group_peer.py"), scenario],
                            env=env, capture_output=True, text=True, timeout=150, check=False)
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize("action,fields,smuggled", [
    ("context", {"room_id": "room", "event_id": "save", "purpose": "Ship", "notes": "", "routing": "lead", "lead_member_id": "one"}, "profile"),
    ("continue", {"room_id": "room", "discussion_event_id": "discussion"}, "thread_id"),
])
def test_a_room_operation_forwards_only_its_declared_fields(monkeypatch, tmp_path, action, fields, smuggled):
    from talaria_sidecar.errors import InvalidParams
    module, calls = _group_rpc(monkeypatch, "groups." + action, {"done": True})
    monkeypatch.setattr(module, "_with_owner", lambda _home, run: asyncio.run(run(SimpleNamespace(state="ready", endpoint="ws://owner"))))
    ctx, params = SimpleNamespace(check_cancelled=lambda: None), {"profile_home": str(tmp_path), "subject": "owner"}
    assert module.groups(ctx, {**params, "operation": {"action": action, **fields}}) == {"state": "available", "reason": None, "value": {"done": True}}
    assert calls[-1] == ("groups." + action, {**fields, "_timeout": 25})
    calls.clear()
    with pytest.raises(InvalidParams):
        module.groups(ctx, {**params, "operation": {"action": action, **fields, smuggled: "other"}})
    assert calls == []


def test_canceled_room_read_detaches_native_rpc():
    from talaria_sidecar.errors import Cancelled
    from talaria_sidecar.methods.groups import _read
    async def probe():
        entered, detached = asyncio.Event(), asyncio.Event()
        ctx = SimpleNamespace(cancelled=False)
        def check():
            if ctx.cancelled:
                raise Cancelled()
        ctx.check_cancelled = check
        async def native():
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                detached.set()
        task = asyncio.create_task(_read(ctx, native()))
        await entered.wait()
        ctx.cancelled = True
        with pytest.raises(Cancelled):
            await task
        assert detached.is_set()
    asyncio.run(probe())


def _group_rpc(monkeypatch, method, value):
    from talaria_sidecar.methods import groups as module
    calls = []
    class Client:
        websocket = SimpleNamespace(protocol=SimpleNamespace(max_size=0))
        async def rpc(self, called_method, **params):
            calls.append((called_method, params))
            if isinstance(value, Exception) and called_method == method:
                raise value
            return {"driver": True, "methods": [method]} if called_method == "groups.capabilities" else value
    @asynccontextmanager
    async def connect(*_args, **_kwargs):
        yield Client(), None
    monkeypatch.setitem(sys.modules, "hermes_cli.gateway_client", SimpleNamespace(GatewayRPCError=RuntimeError))
    monkeypatch.setattr(module, "_connect", connect)
    monkeypatch.setattr(module, "_owner_refusal", lambda *_: None)
    return module, calls


@pytest.mark.parametrize("thread_id", [None, "existing-thread"])
def test_send_preserves_reply_thread_or_opens_its_own(monkeypatch, tmp_path, thread_id):
    module, calls = _group_rpc(monkeypatch, "groups.send", {"accepted": True})
    payload = {"text": "Follow-up", **({"thread_id": thread_id} if thread_id else {})}
    operation = {"action": "send", "room_id": "room", "event_id": "new-event", "payload": payload}
    result = asyncio.run(module._run(tmp_path, "owner", operation, SimpleNamespace(state="ready", endpoint="ws://owner")))
    assert result["state"] == "available"
    assert calls[-1] == ("groups.send", {"room_id": "room", "event_id": "new-event", "payload": {
        "text": "Follow-up", "thread_id": thread_id or "new-event"}, "_timeout": 25})


@pytest.mark.parametrize("native,refusal", [("room_stop_pending", "stop_pending"),
                                            ("member_home_unknown", "member_home_unknown"),
                                            ("room_disbanding_retry", "disbanding_retry")])
def test_a_typed_disband_refusal_returns_refused_with_its_reason(monkeypatch, tmp_path, native, refusal):
    # The stub's GatewayRPCError is RuntimeError; str() is the bounded reason code, as the native client gives it.
    module, _ = _group_rpc(monkeypatch, "groups.disband", RuntimeError(native))
    operation = {"action": "disband", "room_id": "room", "cancel_id": "cancel"}
    result = asyncio.run(module._run(tmp_path, "owner", operation, SimpleNamespace(state="ready", endpoint="ws://owner")))
    assert result == {"state": "refused", "reason": refusal, "value": None}
