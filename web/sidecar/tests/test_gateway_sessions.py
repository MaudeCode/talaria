"""Canonical owner attachment never creates an independent Agent or starts a daemon."""
from pathlib import Path
import json
import subprocess

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, SidecarProcess, isolated_env, requires_agent

CRON_REFUSAL = json.loads((Path(__file__).resolve().parents[3] / "contracts/fixtures/native-cron-refusal.json").read_text())


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

    owner = SimpleNamespace(receipt=None, replay=[], events=[], frames=[], info={}, payload=None, calls=[], config_failure=None,
                            export=None, export_failure=None, checkpoint_diff=None, checkpoint_failure=None, checkpoints=[], shell=None, shell_failure=None,
                            described={"instance_id": "owner", "profile_id": "profile", "authority_epoch": 1,
                                       "capabilities": ["durable-admission-v1", "event-replay-v1"]})
    async def rpc(method, **params):
        owner.calls.append((method, params))
        if method == "runtime.describe":
            return owner.described
        if method == "session.resume":
            return {"session_id": params["session_id"], "subscription_id": "viewer", "messages": [], "info": owner.info,
                    "authority_epoch": 1, "replay_epoch": "epoch", "last_sequence": 4, "execution_generation": 1, **getattr(owner, "snapshot_extra", {})}
        if method == "rollback.list":
            return {"enabled": True, "checkpoints": owner.checkpoints}
        if method == "rollback.session_diff":
            if owner.checkpoint_failure:
                raise RuntimeError(owner.checkpoint_failure)
            return owner.checkpoint_diff
        if method == "shell.exec":
            if owner.shell_failure == "timeout":
                raise TimeoutError()
            if owner.shell_failure:
                raise RuntimeError(owner.shell_failure)
            return owner.shell
        if method == "session.export":
            if owner.export_failure == "timeout":
                raise TimeoutError()
            if owner.export_failure:
                raise RuntimeError(owner.export_failure)
            return owner.export
        if method in {"session.mutate", "prompt.steer_queued", "prompt.replace_queued"}:
            owner.payload = params.get("payload")
            return owner.receipt
        if method == "session.context_breakdown":
            import json
            value = json.loads((Path(__file__).parent / "fixtures/context-breakdown.json").read_text())
            if getattr(owner, 'change_on_context', None):
                owner.snapshot_extra = owner.change_on_context
            return getattr(owner, 'context_payload', value)
        if method == "session.stats":
            return {"output_tokens": 40, "last_turn_tokens": 12}
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
            queue.put_nowait({"method": "event", "params": event})
        for frame in owner.frames:
            queue.put_nowait(frame)
        yield SimpleNamespace(rpc=rpc), queue
    monkeypatch.setitem(sys.modules, "hermes_cli.gateway_client", SimpleNamespace(GatewayRPCError=RuntimeError))
    monkeypatch.setattr(adapter, "_connect", connect)
    monkeypatch.setattr(adapter, "_control_refusal", lambda *args: None)
    endpoint = SimpleNamespace(code_sha="4d04303818b61bf3aa09278af48356315515965b", control_home=None, instance_id="owner", profile_id="profile", authority_epoch=1)
    found = SimpleNamespace(endpoint=endpoint, state="ready")
    owner.endpoint, owner.discovery = endpoint, found
    monkeypatch.setattr(adapter, "_with_owner", lambda home, run: asyncio.run(run(found)))
    owner.session = adapter.session
    owner.run = lambda ctx, params: asyncio.run(adapter._run(ctx, params, tmp_path, found))
    return owner


@pytest.mark.parametrize("boundary", ["warning", "replay"])
def test_idle_notice_replay_and_snapshot_warning(native_owner_stub, boundary):
    from types import SimpleNamespace
    owner = native_owner_stub
    owner.info = {"config_warning": "Project plugins were skipped", "system_prompt": "private"}
    owner.replay = [{"type": "notification.show", "session_id": "native", "replay_epoch": "epoch", "seq": seq,
                     "payload": {"key": "plugin-message:fixture:job", "text": text, "level": "info", "kind": "sticky"}}
                    for seq, text in [(1, "Plugin started"), (2, "Plugin finished")]]
    frames = []
    ctx = SimpleNamespace(cancelled=True, emit=lambda kind, data: frames.append((kind, data)))
    owner.run(ctx, {"session_id": "native", "action": "watch"})
    if boundary == "warning":
        assert frames[0][1]["snapshot"]["info"] == {"config_warning": "Project plugins were skipped"}
    else:
        assert [data["payload"]["text"] for kind, data in frames if kind == "event"] == ["Plugin started", "Plugin finished"]
    assert not any(method.startswith("prompt.") for method, _ in owner.calls)


@pytest.mark.parametrize("sha,attached", [
    ("4d04303818b61bf3aa09278af48356315515965b", True),
    ("bf0203a794a07aac3ff764972ab9087baa4e4f4e", True),
    ("bf0203a794a07aac3ff764972ab9087baa4e4f4f", False),
    ("5b147ab036d6d19131bff8d20701b5001eab844a", False),
    ("0.22.4", False), ("0.22.5", False), (None, False), ("unknown", False),
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


@pytest.mark.parametrize("fmt", ["json", "markdown", "html"])
@pytest.mark.parametrize("redact", [True, False])
def test_export_uses_one_read_only_owner_call(native_owner_stub, tmp_path, fmt, redact):
    native_fmt = "md" if fmt == "markdown" else fmt
    native_owner_stub.export = {"format": native_fmt, "filename": "transcript." + native_fmt, "content": "current transcript"}
    result = native_owner_stub.session(None, {"profile_home": str(tmp_path), "session_id": "logical-chat",
                                            "action": "export", "format": fmt, "redact": redact})
    assert result == {"state": "attached", "reason": None, "snapshot": None, "receipt": None,
                      "export": {**native_owner_stub.export, "format": fmt}}
    assert native_owner_stub.calls == [("runtime.describe", {}), ("session.export", {
        "session_id": "logical-chat", "format": native_fmt, "redact": redact, "_timeout": 25})]
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("failure,reason", [("method_not_found", "owner_export_unsupported"),
    ("timeout", "owner_connection_lost"), ("export_too_large", "export_too_large"),
    ("invalid", "owner_export_invalid"), ("bytes", "export_too_large")])
def test_export_refuses_unsupported_timeout_and_invalid_content(native_owner_stub, failure, reason):
    native_owner_stub.export_failure = failure if failure not in {"invalid", "bytes"} else None
    native_owner_stub.export = {"format": "json", "filename": "owner.json", "content": "界" * 1_500_000} if failure == "bytes" else {}
    result = native_owner_stub.run(None, {"session_id": "native", "action": "export", "format": "json", "redact": True})
    assert result["reason"] == reason and result["snapshot"] is None
    assert [method for method, _ in native_owner_stub.calls] == ["runtime.describe", "session.export"]


@pytest.mark.parametrize("fmt,redact", [("pdf", True), ("json", "false"), (None, True)])
def test_export_validates_closed_inputs_before_owner_discovery(native_owner_stub, tmp_path, fmt, redact):
    from talaria_sidecar.errors import InvalidParams
    with pytest.raises(InvalidParams):
        native_owner_stub.session(None, {"profile_home": str(tmp_path), "session_id": "native", "action": "export",
                                          "format": fmt, "redact": redact})
    assert native_owner_stub.calls == []


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


@requires_agent
def test_real_cron_refusal_matches_public_consumer_fixture(tmp_path):
    env = isolated_env(tmp_path / "hermes", HERMES_WEBUI_AGENT_DIR=str(AGENT_DIR))
    result = subprocess.run([AGENT_PYTHON, str(Path(__file__).parent / "fixtures/gateway_cron_refusal.py")],
                            env=env, capture_output=True, text=True, timeout=60, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    report = json.loads(result.stdout)
    if report.get("status") == "unsupported":
        if report.get("method") == "cron.submit":
            assert report == {"status": "unsupported", "method": "cron.submit"}
            pytest.skip("this Agent does not advertise cron.submit")
        assert report == CRON_REFUSAL["legacy_refusal"]
        pytest.skip("verified legacy cron refusal has no typed descriptor")
    assert report["status"] == "supported"
    assert report["scheduled_job_calls"] == 0


def test_watch_brackets_retained_terminal_events_before_idle_settlement(native_owner_stub):
    from types import SimpleNamespace
    event = {"session_id": "chat", "type": "message.complete", "seq": 4, "replay_epoch": "epoch",
             "authority_epoch": 1, "execution_generation": 1, "payload": CRON_REFUSAL["completion"]}
    native_owner_stub.replay = [event]
    emitted = []
    ctx = SimpleNamespace(cancelled=True, emit=lambda kind, data: emitted.append((kind, data)))
    native_owner_stub.run(ctx, {"session_id": "chat", "action": "watch"})
    assert emitted[0][0] == "snapshot" and emitted[0][1]["replaying"] is True
    assert emitted[1:] == [("event", event), ("replay_complete", {})]


@pytest.mark.parametrize("report,outcome", [
    pytest.param({"status": "supported", "scheduled_job_calls": 0}, "supported", id="True"),
    pytest.param({"status": "unsupported", "method": "cron.submit"}, "method", id="False"),
    pytest.param(CRON_REFUSAL["legacy_refusal"], "legacy", id="legacy-refusal"),
    pytest.param({**CRON_REFUSAL["legacy_refusal"], "source_revision": CRON_REFUSAL["producer_revision"]}, "invalid", id="unexpected-revision"),
    pytest.param({**CRON_REFUSAL["legacy_refusal"], "reason": "storage_error"}, "invalid", id="unexpected-code"),
    pytest.param({**CRON_REFUSAL["legacy_refusal"], "scheduled_job_calls": 1}, "invalid", id="unexpected-job"),
    pytest.param({**CRON_REFUSAL["legacy_refusal"], "captured_result": True}, "invalid", id="captured-result"),
])
def test_cron_refusal_compatibility_observes_runtime_capabilities(tmp_path, monkeypatch, report, outcome):
    from types import SimpleNamespace
    agent = tmp_path / "agent"
    (agent / "gateway").mkdir(parents=True)
    (agent / "gateway/session_cron.py").write_text('"""Refusal metadata can be constructed without a module constant."""\n')
    monkeypatch.setitem(globals(), "AGENT_DIR", agent)
    calls = []
    def run(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(returncode=0, stdout=json.dumps(report), stderr="")
    with monkeypatch.context() as patch:
        patch.setattr(subprocess, "run", run)
        if outcome == "supported":
            try:
                test_real_cron_refusal_matches_public_consumer_fixture(tmp_path)
            except pytest.skip.Exception as exc:
                pytest.fail(f"Skipped a capable owner before observing its runtime capability: {exc}")
        elif outcome == "method":
            with pytest.raises(pytest.skip.Exception, match="does not advertise cron.submit"):
                test_real_cron_refusal_matches_public_consumer_fixture(tmp_path)
        elif outcome == "legacy":
            with pytest.raises(pytest.skip.Exception, match="verified legacy"):
                test_real_cron_refusal_matches_public_consumer_fixture(tmp_path)
        else:
            with pytest.raises(AssertionError):
                test_real_cron_refusal_matches_public_consumer_fixture(tmp_path)
    assert len(calls) == 1, "Every Agent must reach the runtime capability probe before a skip decision"


def test_context_detail_reads_authorized_owner_metadata_without_starting(native_owner_stub):
    result = native_owner_stub.run(None, {"session_id": "native", "action": "context_detail"})
    detail = result.get("context_detail", {})
    assert detail.get("available") is True, result
    assert detail["used_tokens"] == 3790
    assert detail["source"] == "local_estimate"
    assert detail["categories"][1] == {"id": "rules", "tokens": 1000, "percent": 0.390625, "estimated": True}
    assert detail["files"] == [{"label": "AGENTS.md", "characters": 4000, "tokens": 1000, "status": "loaded", "loaded": True}]
    assert detail["last_turn_output_tokens"] == 12
    assert ("session.context_breakdown", {"session_id": "native"}) in native_owner_stub.calls
    assert native_owner_stub.calls[-1] == ("session.detach", {"session_id": "native", "subscription_id": "viewer"})
    assert "private" not in str(detail)


@pytest.mark.parametrize("change", [{"authority_epoch": 2}, {"replay_epoch": "successor"}, {"revision": 99}, {"last_sequence": 5}, {"session_id": "foreign"}, {"info": {"model": "new-model"}}])
def test_context_detail_rejects_changed_owner_or_context(native_owner_stub, change):
    native_owner_stub.change_on_context = change
    result = native_owner_stub.run(None, {"session_id": "native", "action": "context_detail"})
    assert result['context_detail']['reason'] == 'changed'
    assert result['context_detail']['categories'] == []


def test_context_detail_prebuild_and_foreign_authority_are_unavailable(native_owner_stub):
    native_owner_stub.context_payload = {'categories': [], 'context_used': 0, 'context_max': 256000}
    assert native_owner_stub.run(None, {'session_id': 'native', 'action': 'context_detail'})['context_detail']['reason'] == 'not_built'
    native_owner_stub.calls.clear()
    native_owner_stub.described['profile_id'] = 'foreign'
    assert native_owner_stub.run(None, {'session_id': 'native', 'action': 'context_detail'})['state'] == 'incompatible'
    assert native_owner_stub.calls == [('runtime.describe', {})]


@requires_agent
def test_real_plugin_notice_producer_replays_without_turn_stamp(native_owner_stub, tmp_path):
    import json
    from types import SimpleNamespace
    if not (AGENT_DIR / "gateway/plugin_messages.py").exists():
        pytest.skip("this supported Agent has no plugin post/edit API")
    fixture_path = SIDECAR_ROOT.parent.parent / "contracts/fixtures/web-native-notices.json"
    env = isolated_env(tmp_path / "producer", HERMES_WEBUI_AGENT_DIR=str(AGENT_DIR))
    result = subprocess.run([AGENT_PYTHON, str(Path(__file__).parent / "fixtures/gateway_notice_producer.py"),
                             str(AGENT_DIR), str(fixture_path)], env=env, capture_output=True, text=True, timeout=30, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    fixture = json.loads(fixture_path.read_text())
    owner = native_owner_stub
    owner.replay = fixture["events"]
    owner.info = fixture["info"]
    for event in owner.replay:
        event["replay_epoch"] = "epoch"
    frames = []
    owner.run(SimpleNamespace(cancelled=True, emit=lambda kind, data: frames.append((kind, data))),
              {"session_id": fixture["session_id"], "action": "watch"})
    assert frames[0][1]["snapshot"]["info"] == fixture["info"]
    assert [data["payload"]["text"] for kind, data in frames if kind == "event"] == ["Plugin started", "Plugin finished"]


def test_idle_observation_ignores_arbitrary_native_requests(native_owner_stub):
    from types import SimpleNamespace
    owner = native_owner_stub
    notice = {"session_id": "native", "type": "notification.show", "seq": 5, "replay_epoch": "epoch", "payload": {"key": "job", "text": "Untrusted request"}}
    owner.frames = [{"method": "unrecognized-operation", "id": "do-not-answer", "params": notice},
                    {"method": "event", "params": {**notice, "payload": {"key": "job", "text": "Real event"}}}]
    frames = []
    ctx = SimpleNamespace(cancelled=False)
    def emit(kind, data):
        frames.append((kind, data))
        if kind == "event":
            ctx.cancelled = True
    ctx.emit = emit
    owner.run(ctx, {"session_id": "native", "action": "watch"})
    assert [data["payload"]["text"] for kind, data in frames if kind == "event"] == ["Real event"]
    assert not any(method == "unrecognized-operation" for method, _ in owner.calls)


def test_late_old_epoch_notice_does_not_clear_current_replay(native_owner_stub):
    from types import SimpleNamespace
    owner = native_owner_stub
    def notice(seq, text, epoch="epoch"):
        return {"session_id": "native", "type": "notification.show", "seq": seq, "replay_epoch": epoch,
                "payload": {"key": "job", "text": text}}
    owner.events = [notice(5, "Current post"), notice(100, "Old owner", "obsolete"), notice(6, "Current edit")]
    frames = []
    ctx = SimpleNamespace(cancelled=False)
    def emit(kind, data):
        frames.append((kind, data))
        if kind == "event" and data["payload"]["text"] == "Current edit":
            ctx.cancelled = True
    ctx.emit = emit
    owner.run(ctx, {"session_id": "native", "action": "watch"})
    assert [data["payload"]["text"] for kind, data in frames if kind == "event"] == ["Current post", "Current edit"]
    assert not any(kind == "snapshot" and data.get("replay_gap") for kind, data in frames)


def test_checkpoint_diff_uses_frozen_owner_read_without_ambient_manager(native_owner_stub, tmp_path, monkeypatch):
    from talaria_sidecar.methods import checkpoints
    monkeypatch.setattr(checkpoints, "_manager", lambda: pytest.fail("ambient checkpoint manager used"))
    native_owner_stub.checkpoint_diff = {"enabled": True, "success": True, "stat": "old project changes", "diff": "older than session\n", "diff_lines": 1, "empty": False}
    result = native_owner_stub.run(None, {"session_id": "logical-before-compression", "action": "checkpoint_diff"})
    assert result.get("checkpoint_diff") == {"diff": "older than session\n", "stat": "old project changes", "comparison": {
        "provenance": "native_owner", "baseline": "earliest_retained_project_checkpoint", "available": True, "reason": None, "truncated": False}}
    assert native_owner_stub.calls == [("runtime.describe", {}), ("rollback.session_diff", {"session_id": "logical-before-compression", "_timeout": 25})]


@pytest.mark.parametrize("payload,reason", [
    ({"enabled": False}, "checkpoints_disabled"),
    ({"enabled": True, "success": True, "stat": "", "diff": "", "diff_lines": 0, "empty": True}, "no_baseline"),
    ({"enabled": True, "success": False, "error": "container host workspace is unrelated"}, "checkpoint_unavailable"),
    ({"enabled": True, "success": True, "stat": "", "diff": "\x01" * 700000, "diff_lines": 1, "empty": False}, "payload_too_large"),
    ({"enabled": True, "success": True, "stat": "", "diff": "abc", "diff_lines": -1, "empty": False}, "invalid_payload"),
])
def test_checkpoint_diff_refuses_missing_baseline_sandbox_and_escaped_wire_overflow(native_owner_stub, payload, reason):
    native_owner_stub.checkpoint_diff = payload
    result = native_owner_stub.run(None, {"session_id": "native", "action": "checkpoint_diff"})
    assert result["checkpoint_diff"]["comparison"]["reason"] == reason
    assert result["checkpoint_diff"]["comparison"]["available"] is False
    assert result["checkpoint_diff"]["diff"] == ""


def test_checkpoint_diff_reports_native_line_truncation(native_owner_stub):
    native_owner_stub.checkpoint_diff = {"enabled": True, "success": True, "stat": "", "diff": "kept\n", "diff_lines": 99, "empty": False}
    result = native_owner_stub.run(None, {"session_id": "native", "action": "checkpoint_diff"})
    assert result["checkpoint_diff"]["comparison"]["truncated"] is True


@pytest.mark.parametrize("boundary", ["restart", "profile", "unsupported"])
def test_checkpoint_diff_never_falls_back_on_owner_refusal(native_owner_stub, boundary):
    if boundary == "restart":
        native_owner_stub.discovery.state = "restart_wait"
    elif boundary == "profile":
        native_owner_stub.described["profile_id"] = "foreign"
    else:
        native_owner_stub.checkpoint_failure = "method_not_found"
    result = native_owner_stub.run(None, {"session_id": "native", "action": "checkpoint_diff"})
    assert result["state"] != "attached"
    assert not any(method in {"session.resume", "session.mutate"} for method, _ in native_owner_stub.calls)


@pytest.mark.parametrize('wire', ['ascii', 'escaped'])
def test_checkpoint_diff_accepts_exact_wire_bound(native_owner_stub, wire):
    diff = 'x' * (4 * 1024 * 1024) if wire == 'ascii' else '\x01' * 699050 + 'xxxx'
    native_owner_stub.checkpoint_diff = {'enabled': True, 'success': True, 'stat': '', 'diff': diff, 'diff_lines': 1, 'empty': False}
    result = native_owner_stub.run(None, {'session_id': 'native', 'action': 'checkpoint_diff'})
    assert result['checkpoint_diff']['comparison']['available'] is True
    assert result['checkpoint_diff']['diff'] == diff


def test_checkpoint_diff_empty_retained_baseline_is_not_unavailable(native_owner_stub):
    native_owner_stub.checkpoints = [{'hash': 'predates-chat'}]
    native_owner_stub.checkpoint_diff = {'enabled': True, 'success': True, 'stat': '', 'diff': '', 'diff_lines': 0, 'empty': True}
    result = native_owner_stub.run(None, {'session_id': 'native', 'action': 'checkpoint_diff'})
    assert result['checkpoint_diff']['comparison']['available'] is True
    assert [method for method, _ in native_owner_stub.calls] == ['runtime.describe', 'rollback.session_diff', 'rollback.list']


def test_checkpoint_diff_is_exposed_as_a_closed_session_read(native_owner_stub, tmp_path):
    native_owner_stub.checkpoint_diff = {'enabled': False}
    result = native_owner_stub.session(None, {'profile_home': str(tmp_path), 'session_id': 'native', 'action': 'checkpoint_diff'})
    assert result['checkpoint_diff']['comparison']['reason'] == 'checkpoints_disabled'


@pytest.mark.parametrize("failure", [None, "unsupported_terminal_backend", "cwd_unavailable", "dangerous_command", "command_timeout", "timeout"])
def test_captured_command_uses_only_authorized_owner(native_owner_stub, failure):
    owner = native_owner_stub
    owner.shell = {"stdout": "local output", "stderr": "diagnostic", "code": 7}
    owner.shell_failure = failure
    result = owner.run(None, {"session_id": "native", "action": "shell_exec", "command": "printf local",
                              "authority_epoch": 1, "replay_epoch": "epoch"})
    assert ("shell.exec", {"session_id": "native", "command": "printf local", "_timeout": 35}) in owner.calls
    if failure:
        assert result["state"] == ("unavailable" if failure == "timeout" else "refused")
        assert "shell" not in result
    else:
        assert result["shell"] == owner.shell
    assert all(method in {"runtime.describe", "session.resume", "shell.exec", "session.detach"} for method, _ in owner.calls)
    assert sum(method == "shell.exec" for method, _ in owner.calls) == 1


@pytest.mark.parametrize("boundary", ["profile", "owner", "epoch", "replay"])
def test_captured_command_refuses_stale_or_wrong_owner(native_owner_stub, boundary):
    owner = native_owner_stub
    if boundary in {"profile", "owner"}:
        owner.described["profile_id" if boundary == "profile" else "instance_id"] = "other"
    else:
        owner.snapshot_extra = {"authority_epoch": 2} if boundary == "epoch" else {"replay_epoch": "successor"}
    result = owner.run(None, {"session_id": "native", "action": "shell_exec", "command": "pwd",
                              "authority_epoch": 1, "replay_epoch": "epoch"})
    assert result["state"] in {"refused", "incompatible"}
    assert not any(method == "shell.exec" for method, _ in owner.calls)


@requires_agent
def test_supported_owner_captured_command_policy(tmp_path):
    if not (AGENT_DIR / "gateway/session_shell.py").exists():
        pytest.skip("this supported Agent has no captured shell command")
    env = isolated_env(tmp_path / "hermes", HERMES_WEBUI_AGENT_DIR=str(AGENT_DIR))
    result = subprocess.run([AGENT_PYTHON, str(Path(__file__).parent / "fixtures/gateway_shell_policy.py"),
                             str(AGENT_DIR), str(tmp_path / "workspaces")], env=env,
                            capture_output=True, text=True, timeout=60, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert json.loads(result.stdout)["code"] == 7


@pytest.mark.parametrize("revision", [None, "unknown", "d923a5eb487a17c0a68801bba9ef0f56c81040a8"])
def test_captured_command_refuses_unverified_native_revision(native_owner_stub, revision):
    native_owner_stub.endpoint.code_sha = revision
    result = native_owner_stub.run(None, {"session_id": "native", "action": "terminal_info"})
    assert (result["state"], result["reason"]) == ("incompatible", "owner_shell_unsupported")
    assert native_owner_stub.calls == []


@pytest.mark.parametrize("value", [{"stdout": "x" * 4001, "stderr": "", "code": 0}, {"stdout": "", "stderr": "", "code": True}, None])
def test_captured_command_rejects_invalid_owner_result(native_owner_stub, value):
    native_owner_stub.shell = value
    result = native_owner_stub.run(None, {"session_id": "native", "action": "shell_exec", "command": "pwd",
                                          "authority_epoch": 1, "replay_epoch": "epoch"})
    assert result["reason"] == "owner_shell_invalid"
    assert "shell" not in result
