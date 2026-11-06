"""Native room compatibility through the actual sidecar RPC boundary."""
from contextlib import asynccontextmanager
from pathlib import Path
import subprocess
import sys
import asyncio
import sys
from types import SimpleNamespace

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, isolated_env, requires_agent


@requires_agent
def test_native_group_round_trip(tmp_path):
    if not (AGENT_DIR / "gateway/session_group_controls.py").exists():
        pytest.skip("this supported Agent has no native groups")
    env = isolated_env(tmp_path / "hermes", HERMES_WEBUI_AGENT_DIR=str(AGENT_DIR),
                       HERMES_WEBUI_PYTHON=str(AGENT_PYTHON),
                       PYTHONPATH=f"{SIDECAR_ROOT}:{Path(pytest.__file__).parent.parent}")
    result = subprocess.run([AGENT_PYTHON, str(Path(__file__).parent / "fixtures/group_peer.py")],
                            env=env, capture_output=True, text=True, timeout=150, check=False)
    assert result.returncode == 0, result.stdout + result.stderr


def test_context_forwards_only_declared_fields(monkeypatch, tmp_path):
    import contextlib
    from talaria_sidecar.errors import InvalidParams
    from talaria_sidecar.methods import groups as module
    calls = []
    class Client:
        websocket = SimpleNamespace(protocol=SimpleNamespace(max_size=0))
        async def rpc(self, method, **fields):
            calls.append((method, fields))
            return {"driver": True, "methods": ["groups.context"]} if method == "groups.capabilities" else {}
    @contextlib.asynccontextmanager
    async def connect(*_args, **_kwargs):
        yield Client(), None
    monkeypatch.setitem(sys.modules, "hermes_cli", SimpleNamespace())
    monkeypatch.setitem(sys.modules, "hermes_cli.gateway_client", SimpleNamespace(GatewayRPCError=RuntimeError))
    monkeypatch.setattr(module, "_connect", connect)
    monkeypatch.setattr(module, "_owner_refusal", lambda *_: False)
    monkeypatch.setattr(module, "_with_owner", lambda _home, run: asyncio.run(run(SimpleNamespace(state="ready", endpoint="ws://owner"))))
    ctx, fields = SimpleNamespace(check_cancelled=lambda: None), {
        "room_id": "room", "event_id": "save", "purpose": "Ship", "notes": "", "routing": "lead", "lead_member_id": "one"}
    params = {"profile_home": str(tmp_path), "subject": "owner"}
    assert module.groups(ctx, {**params, "operation": {"action": "context", **fields}})["state"] == "available"
    assert calls[-1][0] == "groups.context"
    assert {k: v for k, v in calls[-1][1].items() if k != "_timeout"} == fields
    calls.clear()
    with pytest.raises(InvalidParams):
        module.groups(ctx, {**params, "operation": {"action": "context", **fields, "profile": "other"}})
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


def test_continue_forwards_only_its_declared_fields(monkeypatch, tmp_path):
    from talaria_sidecar.errors import InvalidParams
    from talaria_sidecar.methods import groups as module
    operation = {"action": "continue", "room_id": "room", "discussion_event_id": "discussion"}
    with pytest.raises(InvalidParams):
        module.groups(SimpleNamespace(), {"profile_home": str(tmp_path), "subject": "owner",
                                          "operation": {**operation, "thread_id": "smuggled"}})

    calls = []
    class Client:
        websocket = SimpleNamespace(protocol=SimpleNamespace(max_size=0))
        async def rpc(self, method, **params):
            calls.append((method, params))
            return {"driver": True, "methods": ["groups.continue"]} if method == "groups.capabilities" else {"continued": True}
    @asynccontextmanager
    async def connect(*_args, **_kwargs):
        yield Client(), None
    monkeypatch.setitem(sys.modules, "hermes_cli.gateway_client", SimpleNamespace(GatewayRPCError=RuntimeError))
    monkeypatch.setattr(module, "_connect", connect)
    monkeypatch.setattr(module, "_owner_refusal", lambda *_: None)
    result = asyncio.run(module._run(tmp_path, "owner", operation, SimpleNamespace(state="ready", endpoint="ws://owner")))
    assert result == {"state": "available", "reason": None, "value": {"continued": True}}
    assert calls[-1] == ("groups.continue", {"room_id": "room", "discussion_event_id": "discussion", "_timeout": 25})
