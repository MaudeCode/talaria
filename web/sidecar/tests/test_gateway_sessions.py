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
def test_queued_controls_use_owner_verbs_and_caller_ids(tmp_path, native_owner_stub, action, method, extra):
    native_owner_stub.receipt = {"admission_id": "queued"}
    result = native_owner_stub.run(None, {"session_id": "native", "action": action, "admission_id": "queued", **extra})
    assert (method, {"session_id": "native", "admission_id": "queued", **extra}) in native_owner_stub.calls
    assert result["receipt"] == {"admission_id": "queued"}
    assert native_owner_stub.session(None, {"profile_home": str(tmp_path), "session_id": "native", "action": action, "admission_id": "queued", **extra})["receipt"] == result["receipt"]


@requires_agent
def test_real_owner_voice_stop_succeeds_without_admission(tmp_path):
    controls = AGENT_DIR / "gateway/session_controls.py"
    if not controls.exists() or "voice_stopped" not in controls.read_text():
        pytest.skip("this supported Agent does not consume typed voice stops")
    env = isolated_env(tmp_path / "hermes", HERMES_WEBUI_AGENT_DIR=str(AGENT_DIR), HERMES_WEBUI_PYTHON=str(AGENT_PYTHON),
                       PYTHONPATH=f"{SIDECAR_ROOT}:{Path(pytest.__file__).parent.parent}")
    result = subprocess.run([AGENT_PYTHON, str(Path(__file__).parent / "fixtures/gateway_session_peer.py"), "voice-stop"],
                            env=env, capture_output=True, text=True, timeout=90, check=False)
    assert result.returncode == 0, result.stdout + result.stderr


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
def test_watch_negotiates_display_without_breaking_older_owners(native_owner_stub, shown, failure):
    from types import SimpleNamespace
    native_owner_stub.config_failure = failure
    frames = []
    ctx = SimpleNamespace(cancelled=False)
    def emit(kind, data):
        frames.append((kind, data))
        ctx.cancelled = True
    ctx.emit = emit
    result = native_owner_stub.run(ctx, {"session_id": "native", "action": "watch", "show_reasoning": shown})
    assert result["state"] == "attached"
    assert frames[0][0] == "snapshot"
    assert ("config.set", {"session_id": "native", "key": "show_reasoning", "value": "1" if shown else "0", "_timeout": 10}) in native_owner_stub.calls
    assert native_owner_stub.calls[-1] == ("session.detach", {"session_id": "native", "subscription_id": "viewer"})


@pytest.fixture
def native_owner_stub(tmp_path, monkeypatch):
    import asyncio
    from contextlib import asynccontextmanager
    import sys
    from types import SimpleNamespace
    from talaria_sidecar.methods import gateway_sessions as adapter

    owner = SimpleNamespace(receipt=None, replay=[], events=[], payload=None, calls=[], config_failure=None,
                            described={"instance_id": "owner", "profile_id": "profile", "authority_epoch": 1,
                                       "capabilities": ["durable-admission-v1", "event-replay-v1"]})
    async def rpc(method, **params):
        owner.calls.append((method, params))
        if method == "runtime.describe":
            return owner.described
        if method == "session.resume":
            return {"session_id": params["session_id"], "subscription_id": "viewer", "messages": [], "info": {},
                    "replay_epoch": "epoch", "last_sequence": 4, "execution_generation": 1}
        if method in {"session.mutate", "prompt.steer_queued", "prompt.replace_queued"}:
            owner.payload = params.get("payload")
            return owner.receipt
        if method == "config.set":
            if owner.config_failure == "refused":
                raise RuntimeError("unsupported_setting")
            if owner.config_failure == "timeout":
                raise TimeoutError()
        if method == "session.events.since":
            return {"events": owner.replay, "last_sequence": 4}
    @asynccontextmanager
    async def connect(home, selected):
        assert home == tmp_path and selected is endpoint
        queue = asyncio.Queue()
        for event in owner.events:
            queue.put_nowait({"params": event})
        yield SimpleNamespace(rpc=rpc), queue
    monkeypatch.setitem(sys.modules, "hermes_cli.gateway_client", SimpleNamespace(GatewayRPCError=RuntimeError))
    monkeypatch.setattr(adapter, "_connect", connect)
    monkeypatch.setattr(adapter, "_control_refusal", lambda *args: None)
    endpoint = SimpleNamespace(control_home=None, instance_id="owner", profile_id="profile", authority_epoch=1)
    found = SimpleNamespace(endpoint=endpoint, state="ready")
    owner.endpoint, owner.discovery = endpoint, found
    monkeypatch.setattr(adapter, "_with_owner", lambda home, run: asyncio.run(run(found)))
    owner.session = adapter.session
    owner.run = lambda ctx, params: asyncio.run(adapter._run(ctx, params, tmp_path, found))
    return owner


@pytest.mark.parametrize("sha,attached", [
    ("4d04303818b61bf3aa09278af48356315515965b", True),
    ("5b147ab036d6d19131bff8d20701b5001eab844a", False),
    ("0.22.4", False), (None, False), ("unknown", False),
])
def test_served_owner_requires_verified_runtime_revision(tmp_path, native_owner_stub, sha, attached):
    owner = native_owner_stub
    owner.endpoint.control_home = str(tmp_path.parent)
    owner.endpoint.code_sha = sha
    result = owner.run(None, {"session_id": "chat", "action": "snapshot"})
    assert (result["state"] == "attached") is attached, result
    if not attached:
        assert result["reason"] == "served_profile_sessions_unavailable"
        assert owner.calls == []


@pytest.mark.parametrize("field,value", [
    ("instance_id", "previous-owner"), ("profile_id", "other-profile"), ("authority_epoch", 2),
    ("authority_epoch", True), ("capabilities", None), ("capabilities", "durable-admission-v1,event-replay-v1"),
    ("capabilities", []), ("capabilities", ["durable-admission-v1", {}]),
])
def test_served_owner_rechecks_authenticated_identity(tmp_path, native_owner_stub, field, value):
    owner = native_owner_stub
    owner.endpoint.control_home = str(tmp_path.parent)
    owner.endpoint.code_sha = "4d04303818b61bf3aa09278af48356315515965b"
    owner.described[field] = value
    result = owner.run(None, {"session_id": "chat", "action": "snapshot"})
    assert (result["state"], result["reason"]) == ("incompatible", "owner_capabilities"), result
    assert owner.calls == [("runtime.describe", {})]


@pytest.mark.parametrize("record", ["unreadable", "{", "null", "{}", '{"nativeContracts":null}',
    '{"nativeContracts":{"served-local-policy-v1":"0.22.4"}}',
    '{"nativeContracts":{"served-local-policy-v1":[null]}}'])
def test_unreadable_served_contract_fails_closed(tmp_path, native_owner_stub, monkeypatch, record):
    def read(*args, **kwargs):
        if record == "unreadable":
            raise OSError("unreadable contract")
        return record
    monkeypatch.setattr(Path, "read_text", read)
    owner = native_owner_stub
    owner.endpoint.control_home = str(tmp_path.parent)
    owner.endpoint.code_sha = "4d04303818b61bf3aa09278af48356315515965b"
    result = owner.run(None, {"session_id": "chat", "action": "snapshot"})
    assert result["reason"] == "served_profile_sessions_unavailable", result
    assert owner.calls == []


def test_verified_served_owner_keeps_restart_and_diagnostic_gates(tmp_path, native_owner_stub):
    from talaria_sidecar.methods import gateway_sessions as adapter
    owner = native_owner_stub
    owner.endpoint.control_home = str(tmp_path.parent)
    owner.endpoint.code_sha = "4d04303818b61bf3aa09278af48356315515965b"
    owner.discovery.state = "draining"
    result = owner.run(None, {"session_id": "chat", "action": "submit", "text": "wait", "request_id": "wait"})
    assert (result["state"], result["reason"]) == ("refused", "gateway_restarting"), result
    assert owner.calls == []
    assert owner.run(None, {"session_id": "chat", "action": "snapshot"})["state"] == "attached"
    assert adapter._served(tmp_path, owner.endpoint), "diagnostic creation requires its own verified contract"


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


def test_watch_forwards_native_progress_and_deduplicates_replay_overlap(native_owner_stub):
    from types import SimpleNamespace
    def progress(seq, message, session="chat"):
        return {"session_id": session, "type": "tool.progress", "seq": seq, "replay_epoch": "epoch",
                "authority_epoch": 1, "execution_generation": 1,
                "payload": {"tool_id": "index", "progress": 21, "total": 50, "percent": 42, "message": message}}
    retained, current = progress(4, "retained"), progress(5, "current")
    native_owner_stub.replay = [retained]
    native_owner_stub.events = [retained, progress(5, "foreign", "other-chat"), current]
    emitted = []
    ctx = SimpleNamespace(cancelled=False)
    def emit(kind, data):
        emitted.append((kind, data))
        if kind == "event" and data == current:
            ctx.cancelled = True
    ctx.emit = emit
    native_owner_stub.run(ctx, {"session_id": "chat", "action": "watch"})
    assert [data for kind, data in emitted if kind == "event"] == [retained, current]
