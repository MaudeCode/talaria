"""Canonical owner attachment never creates an independent Agent or starts a daemon."""
from pathlib import Path
import subprocess

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, SidecarProcess, isolated_env, requires_agent


@requires_agent
def test_stopped_owner_is_an_explicit_refusal_without_starting(tmp_path):
    home = tmp_path / "hermes"
    home.mkdir()
    sidecar = SidecarProcess(home)
    try:
        response, _ = sidecar.call("gateway.session", {
            "profile_home": str(home), "session_id": "native-chat", "action": "snapshot",
        })
    finally:
        sidecar.close()
    expected = "stopped" if (AGENT_DIR / "hermes_cli/gateway_client.py").exists() else "incompatible"
    assert response.get("result", {}).get("state") == expected, response
    assert not (home / "gateway.pid").exists()


@requires_agent
@pytest.mark.parametrize("mode", ["shared", "batch", "approval", "clarify", "recovery", "secure", "profiles", "dedicated", "replay", "detail", "restart"])
def test_real_native_owner_shared_admission_and_detach(tmp_path, mode):
    if not (AGENT_DIR / "hermes_cli/gateway_client.py").exists():
        pytest.skip("this supported Agent does not expose native sessions")
    if mode == "detail" and "def _publish_subagent" not in (AGENT_DIR / "gateway/local_viewer_events.py").read_text():
        pytest.skip("this supported Agent does not forward native subagent lifecycle events")
    if mode == "restart" and "def attachable(" not in (AGENT_DIR / "hermes_cli/gateway_runtime.py").read_text():
        pytest.skip("this supported Agent refuses every client during a restart's after-turn wait")
    home = tmp_path / "hermes"
    env = isolated_env(home, HERMES_WEBUI_AGENT_DIR=str(AGENT_DIR), HERMES_WEBUI_PYTHON=str(AGENT_PYTHON),
                       PYTHONPATH=f"{SIDECAR_ROOT}:{Path(pytest.__file__).parent.parent}")
    result = subprocess.run([AGENT_PYTHON, str(Path(__file__).parent / "fixtures/gateway_session_peer.py"), mode],
                            env=env, capture_output=True, text=True, timeout=200, check=False)
    assert result.returncode == 0, result.stdout + result.stderr


@requires_agent
def test_real_native_owner_model_outcomes(tmp_path):
    if not (AGENT_DIR / "gateway/session_deferred_pick.py").exists():
        pytest.skip("this supported Agent does not expose deferred native model picks")
    env = isolated_env(tmp_path / "hermes", HERMES_WEBUI_AGENT_DIR=str(AGENT_DIR), HERMES_WEBUI_PYTHON=str(AGENT_PYTHON),
                       PYTHONPATH=f"{SIDECAR_ROOT}:{Path(pytest.__file__).parent.parent}")
    result = subprocess.run([AGENT_PYTHON, str(Path(__file__).parent / "fixtures/gateway_session_peer.py"), "model"],
                            env=env, capture_output=True, text=True, timeout=90, check=False)
    assert result.returncode == 0, result.stdout + result.stderr


@requires_agent
def test_diagnostic_creation_refuses_without_starting(tmp_path):
    home = tmp_path / "hermes"
    home.mkdir()
    sidecar = SidecarProcess(home)
    try:
        probed = sidecar.result("gateway.create", {"profile_home": str(home), "probe": True})
        created = sidecar.result("gateway.create", {"profile_home": str(home), "request_id": "never", "execution_mode": "safe",
                                                    "cwd": str(tmp_path), "model": "fixture"})
    finally:
        sidecar.close()
    native = (AGENT_DIR / "hermes_cli/gateway_client.py").exists()
    for result in (probed, created):
        if native:
            assert result["state"] == "stopped", result
        else:
            assert (result["state"], result["reason"]) == ("incompatible", "native_sessions_unavailable"), result
        assert result["snapshot"] is None and result["receipt"] is None
    assert not (home / "gateway.pid").exists() and not (home / "state.db").exists()


@requires_agent
def test_real_owner_diagnostic_execution_modes(tmp_path):
    if not (AGENT_DIR / "hermes_cli/gateway_client.py").exists():
        pytest.skip("this supported Agent does not expose native sessions")
    home = tmp_path / "hermes"
    env = isolated_env(home, HERMES_WEBUI_AGENT_DIR=str(AGENT_DIR), HERMES_WEBUI_PYTHON=str(AGENT_PYTHON),
                       PYTHONPATH=f"{SIDECAR_ROOT}:{Path(pytest.__file__).parent.parent}")
    result = subprocess.run([AGENT_PYTHON, str(Path(__file__).parent / "fixtures/gateway_execution_peer.py")],
                            env=env, capture_output=True, text=True, timeout=600, check=False)
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize("action,method,extra", [
    ("steer_queued", "prompt.steer_queued", {}),
    ("replace_queued", "prompt.replace_queued", {"submission_id": "stable-edit", "text": "Edited"}),
])
def test_queued_controls_use_owner_verbs_and_caller_ids(tmp_path, monkeypatch, action, method, extra):
    import asyncio
    from contextlib import asynccontextmanager
    import sys
    from types import SimpleNamespace
    from talaria_sidecar.methods import gateway_sessions as gateway

    class RPCError(Exception):
        pass

    monkeypatch.setitem(sys.modules, "hermes_cli.gateway_client", SimpleNamespace(GatewayRPCError=RPCError))
    endpoint = SimpleNamespace(control_home=None, instance_id="owner", profile_id="profile", authority_epoch=1)
    calls = []
    class Client:
        async def rpc(self, verb, **params):
            calls.append((verb, params))
            if verb == "runtime.describe":
                return {"instance_id": "owner", "profile_id": "profile", "authority_epoch": 1, "capabilities": list(gateway._CAPABILITIES)}
            if verb == "session.resume":
                return {"session_id": "native", "subscription_id": "viewer", "messages": [], "info": {}}
            return {"admission_id": "queued"}
    @asynccontextmanager
    async def connect(*_):
        yield Client(), asyncio.Queue()
    monkeypatch.setattr(gateway, "_connect", connect)
    monkeypatch.setattr(gateway, "_control_refusal", lambda *_: None)
    monkeypatch.setattr(gateway, "_with_owner", lambda home, run: asyncio.run(run(SimpleNamespace(endpoint=endpoint, state="ready"))))
    # _run exercises dispatch independently of public input validation.
    result = asyncio.run(gateway._run(None, {"session_id": "native", "action": action, "admission_id": "queued", **extra}, tmp_path, SimpleNamespace(endpoint=endpoint, state="ready")))
    assert (method, {"session_id": "native", "admission_id": "queued", **extra}) in calls
    assert result["receipt"] == {"admission_id": "queued"}
    assert gateway.session(None, {"profile_home": str(tmp_path), "session_id": "native", "action": action, "admission_id": "queued", **extra})["receipt"] == result["receipt"]


@requires_agent
def test_real_owner_queued_controls(tmp_path):
    protocol = AGENT_DIR / "hermes_cli/gateway_client.py"
    # Only releases publishing these verbs can establish their execution semantics.
    if not protocol.exists() or not any("prompt.steer_queued" in p.read_text() for p in (AGENT_DIR / "gateway").rglob("*.py")):
        pytest.skip("this supported Agent does not expose queued controls")
    home = tmp_path / "hermes"
    env = isolated_env(home, HERMES_WEBUI_AGENT_DIR=str(AGENT_DIR), HERMES_WEBUI_PYTHON=str(AGENT_PYTHON),
                       PYTHONPATH=f"{SIDECAR_ROOT}:{Path(pytest.__file__).parent.parent}")
    result = subprocess.run([AGENT_PYTHON, str(Path(__file__).parent / "fixtures/gateway_session_peer.py"), "queued-controls"],
                            env=env, capture_output=True, text=True, timeout=200, check=False)
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize("shown,failure", [(True, None), (False, None), (True, "refused"), (True, "timeout")])
def test_watch_negotiates_display_without_breaking_older_owners(tmp_path, monkeypatch, shown, failure):
    import asyncio
    from contextlib import asynccontextmanager
    from types import ModuleType, SimpleNamespace
    import sys
    from talaria_sidecar.methods import gateway_sessions

    class GatewayRPCError(Exception):
        pass

    client_module = ModuleType("hermes_cli.gateway_client")
    client_module.GatewayRPCError = GatewayRPCError
    monkeypatch.setitem(sys.modules, "hermes_cli.gateway_client", client_module)
    calls, frames = [], []
    endpoint = SimpleNamespace(control_home=None, instance_id="owner", profile_id="profile", authority_epoch=1)
    snap = {"session_id": "native", "subscription_id": "viewer", "messages": [], "info": {},
            "replay_epoch": "epoch", "last_sequence": 0, "execution_generation": 1}

    async def rpc(method, **params):
        calls.append((method, params))
        if method == "runtime.describe":
            return {"instance_id": "owner", "profile_id": "profile", "authority_epoch": 1,
                    "capabilities": ["durable-admission-v1", "event-replay-v1"]}
        if method == "session.resume":
            return snap
        if method == "config.set":
            if failure == "refused":
                raise GatewayRPCError("unsupported_setting")
            if failure == "timeout":
                raise TimeoutError()
        if method == "session.events.since":
            return {"events": [], "last_sequence": 0}
        return {}

    @asynccontextmanager
    async def connect(home, selected):
        assert home == tmp_path and selected is endpoint
        yield SimpleNamespace(rpc=rpc), asyncio.Queue()

    ctx = SimpleNamespace(cancelled=False)

    def emit(kind, data):
        frames.append((kind, data))
        ctx.cancelled = True

    ctx.emit = emit
    monkeypatch.setattr(gateway_sessions, "_connect", connect)
    monkeypatch.setattr(gateway_sessions, "_control_refusal", lambda *_: None)
    result = asyncio.run(gateway_sessions._run(ctx, {"session_id": "native", "action": "watch", "show_reasoning": shown},
                                               tmp_path, SimpleNamespace(endpoint=endpoint, state="ready")))
    assert result["state"] == "attached"
    assert frames[0][0] == "snapshot"
    assert ("config.set", {"session_id": "native", "key": "show_reasoning", "value": "1" if shown else "0", "_timeout": 10}) in calls
    assert calls[-1] == ("session.detach", {"session_id": "native", "subscription_id": "viewer"})


@pytest.fixture
def native_owner_stub(tmp_path, monkeypatch):
    import asyncio
    from contextlib import asynccontextmanager
    import sys
    from types import SimpleNamespace
    from talaria_sidecar.methods import gateway_sessions as adapter

    owner = SimpleNamespace(receipt=None, replay=[], payload=None)
    async def rpc(method, **params):
        if method == "runtime.describe":
            return {"instance_id": "owner", "profile_id": "profile", "authority_epoch": 1,
                    "capabilities": ["durable-admission-v1", "event-replay-v1"]}
        if method == "session.resume":
            return {"session_id": "chat", "subscription_id": "viewer", "messages": [], "info": {},
                    "replay_epoch": "epoch", "last_sequence": 4, "execution_generation": 1}
        if method == "session.mutate":
            owner.payload = params["payload"]
            return owner.receipt
        if method == "session.events.since":
            return {"events": owner.replay, "last_sequence": 4}
    @asynccontextmanager
    async def connect(*args):
        yield SimpleNamespace(rpc=rpc), asyncio.Queue()
    monkeypatch.setitem(sys.modules, "hermes_cli.gateway_client", SimpleNamespace(GatewayRPCError=RuntimeError))
    monkeypatch.setattr(adapter, "_connect", connect)
    monkeypatch.setattr(adapter, "_control_refusal", lambda *args: None)
    endpoint = SimpleNamespace(control_home=None, instance_id="owner", profile_id="profile", authority_epoch=1)
    owner.run = lambda ctx, params: asyncio.run(adapter._run(ctx, params, tmp_path, SimpleNamespace(endpoint=endpoint)))
    return owner


@pytest.mark.parametrize("receipt", [
    {"operation": "model", "model": "picked", "revision": 3, "execution_generation": 1},
    {"operation": "model", "status": "deferred", "model": "picked"},
    {"operation": "model", "status": "confirmation_required", "confirm": "owner-token", "confirm_message": "Guard warning"},
])
def test_model_mutation_preserves_owner_receipt(native_owner_stub, receipt):
    native_owner_stub.receipt = receipt
    result = native_owner_stub.run(None, {"session_id": "chat", "action": "mutate", "request_id": "pick",
        "expected_revision": 2, "execution_generation": 1, "operation": "model", "payload": {"model": "picked"}})
    assert result["receipt"] == receipt
    assert native_owner_stub.payload == {"model": "picked"}


def test_watch_replays_idle_model_outcomes_without_execution_stamp(native_owner_stub):
    from types import SimpleNamespace
    event = {"session_id": "chat", "type": "session.updated", "seq": 4, "replay_epoch": "epoch",
             "payload": {"operation": "model", "status": "refused", "reason": "model_resolution_failed"}}
    native_owner_stub.replay = [event]
    emitted = []
    ctx = SimpleNamespace(cancelled=True, emit=lambda kind, data: emitted.append((kind, data)))
    native_owner_stub.run(ctx, {"session_id": "chat", "action": "watch"})
    assert ("event", event) in emitted
