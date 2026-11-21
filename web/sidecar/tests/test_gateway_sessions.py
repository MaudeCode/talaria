"""Canonical owner attachment never creates an independent Agent or starts a daemon."""
from pathlib import Path
import json
import queue
import subprocess
import threading
import time

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, SidecarProcess, isolated_env, requires_agent

CRON_REFUSAL = json.loads((Path(__file__).resolve().parents[3] / "contracts/fixtures/native-cron-refusal.json").read_text())
SUPPORTED_REVISIONS = [release["sourceRevision"] for release in json.loads((SIDECAR_ROOT / "agent_support.json").read_text())["releases"]]


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
    assert response.get("result", {}).get("state") == "stopped", response
    assert not (home / "gateway.pid").exists()


def peer_env(tmp_path):
    return isolated_env(tmp_path / "hermes", TALARIA_WEB_AGENT_DIR=str(AGENT_DIR), TALARIA_WEB_PYTHON=str(AGENT_PYTHON),
                        PYTHONPATH=f"{SIDECAR_ROOT}:{Path(pytest.__file__).parent.parent}")


def account_for(request, modes, output, failed):
    """A peer's report must account for every requested mode: a mode this release does not support is reported as
    skipped, and one the peer dropped fails here. The JUnit report keeps what each run did and where its time went, so
    a passing CI run shows them too."""
    report = next((json.loads(line.removeprefix("MODES ")) for line in output.splitlines() if line.startswith("MODES ")), {})
    request.node.user_properties.extend(("peer_" + line.split(" ", 1)[0].lower(), line.split(" ", 1)[1])
                                        for line in output.splitlines() if line.startswith(("MODES ", "PHASES ")))
    assert not failed, f"failed mode: {report.get('failed')}\n{output}"
    assert sorted(report["ran"] + list(report["skipped"])) == sorted(modes), report
    if not report["ran"]:
        pytest.skip("; ".join(sorted(set(report["skipped"].values()))))


def run_owner_peer(request, tmp_path, script, modes, timeout=200):
    """One peer run on a real disposable owner."""
    try:
        result = subprocess.run([AGENT_PYTHON, str(Path(__file__).parent / "fixtures" / script), *modes],
                                env=peer_env(tmp_path), capture_output=True, text=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired as expired:
        pytest.fail(f"peer outlived {timeout} s; the last MODE line names the one it was running:\n{expired.stdout}\n{expired.stderr}")
    account_for(request, modes, result.stdout + result.stderr, result.returncode != 0)


@pytest.fixture(scope="module")
def shared_owner(tmp_path_factory):
    """One served owner for every mode that needs no owner state of its own, so the modes run as separate tests yet
    repeat neither its boot nor its first-turn warmup (TAL-1780, TAL-2493). Each mode runs on its own sessions."""
    peer = subprocess.Popen([AGENT_PYTHON, str(Path(__file__).parent / "fixtures/gateway_session_peer.py"), "--serve"],
                            env=peer_env(tmp_path_factory.mktemp("shared-owner")), stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    lines = queue.Queue()
    threading.Thread(target=lambda: [*map(lines.put, peer.stdout), lines.put(None)], daemon=True).start()

    def run(request, mode, timeout=200):
        assert peer.poll() is None, f"the shared owner exited with {peer.returncode}"
        peer.stdin.write(mode + "\n")
        peer.stdin.flush()
        output, deadline = [], time.monotonic() + timeout
        while not output or not output[-1].startswith("MODES "):
            try:
                line = lines.get(timeout=max(0, deadline - time.monotonic()))
            except queue.Empty:
                peer.kill()
                pytest.fail(f"{mode} outlived {timeout} s on the shared owner:\n{''.join(output)}")
            assert line is not None, f"the shared owner exited during {mode}:\n{''.join(output)}"
            output.append(line)
        account_for(request, [mode], "".join(output), json.loads(output[-1].removeprefix("MODES "))["failed"] is not None)

    try:
        yield run
    finally:
        peer.stdin.close()
        try:
            peer.wait(timeout=60)
        except subprocess.TimeoutExpired:
            peer.kill()
            peer.wait()


@requires_agent
@pytest.mark.parametrize("mode", ["shared", "reactions", "reaction-watch", "batch", "approval", "approval-tell", "clarify", "detail",
                                  "queued-controls", "model", "voice-stop", "connections", "work", "transcript"])
def test_real_native_owner_shared_admission_and_detach(request, shared_owner, mode):
    shared_owner(request, mode)


@requires_agent
@pytest.mark.parametrize("mode", ["recovery", "secure", "profiles", "dedicated", "replay", "restart", "reasoning", "reasoning-restart",
                                  "session-open"])
def test_real_native_owner_on_its_own_daemon(request, tmp_path, mode):
    run_owner_peer(request, tmp_path, "gateway_session_peer.py", [mode])


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
    for result in (probed, created):
        assert result["state"] == "stopped", result
        assert result["snapshot"] is None and result["receipt"] is None
    assert not (home / "gateway.pid").exists() and not (home / "state.db").exists()


@requires_agent
@pytest.mark.parametrize("scenario", ["controls", "restart-config", "restart-safe", "safe", "safe-sibling", "safe-error"])
def test_real_owner_diagnostic_execution_modes(request, tmp_path, scenario):
    run_owner_peer(request, tmp_path, "gateway_execution_peer.py", [scenario])


@pytest.mark.parametrize("owner_lacks,probe,outcome", [
    pytest.param(None, True, ("attached", None), id="supported-probe"),
    pytest.param("parameters", True, ("incompatible", "execution_mode_unavailable"), id="parameters-probe"),
    pytest.param("parameters", False, ("incompatible", "execution_mode_unavailable"), id="parameters-create"),
    pytest.param("capability", False, ("incompatible", "execution_mode_unavailable"), id="capability-create"),
    pytest.param("served", False, ("incompatible", "served_profile_sessions_unavailable"), id="served-create"),
])
def test_diagnostic_creation_requires_the_owners_bypass_creation_contract(native_owner_stub, tmp_path, owner_lacks, probe, outcome):
    """A probe or create reaches ``session.create`` only on an owner that advertises local CLI creation with the bypass
    fields, and never on a served profile's owner."""
    owner = native_owner_stub
    parameters = ["request_id", "source", "cwd", "model", "provider", "base_url", "toolsets", "safe_mode", "ignore_user_config"]
    owner.described.update(capabilities=[*owner.described["capabilities"], "local-cli-create-v1"],
                           session_create={"sources": ["cli"], "parameters": parameters})
    if owner_lacks == "parameters":
        parameters.remove("safe_mode")
        parameters.remove("ignore_user_config")
    elif owner_lacks == "capability":
        owner.described["capabilities"].remove("local-cli-create-v1")
    elif owner_lacks == "served":
        owner.endpoint.control_home = str(tmp_path.parent)
    result = owner.create({"profile_home": str(tmp_path), "probe": probe, "request_id": "diagnostic", "execution_mode": "safe",
                           "cwd": str(tmp_path), "model": "fixture"})
    assert (result["state"], result["reason"]) == outcome, result
    assert result["snapshot"] is None and result["receipt"] is None
    assert owner.calls == ([] if owner_lacks == "served" else [("runtime.describe", {})])


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


def test_steer_forwards_only_its_declared_fields_and_returns_the_owner_verdict(native_owner_stub):
    verdict = {"status": "rejected", "text": "Do this", "execution_generation": 7, "authority_epoch": 1, "delivered": False}
    native_owner_stub.receipt = verdict
    result = native_owner_stub.run(None, {"session_id": "native", "action": "steer", "execution_generation": 7, "text": "Do this",
                                          "admission_id": "ignored", "prompt_id": "ignored", "choice": "deny", "profile": "other"})
    steers = [call for call in native_owner_stub.calls if call[0] == "session.steer"]
    assert steers == [("session.steer", {"session_id": "native", "execution_generation": 7, "text": "Do this"})]
    assert result["receipt"] == verdict


@pytest.mark.parametrize("missing", ["execution_generation", "text"])
def test_steer_requires_its_declared_fields_before_connecting(tmp_path, native_owner_stub, missing):
    from talaria_sidecar.errors import InvalidParams
    params = {"profile_home": str(tmp_path), "session_id": "native", "action": "steer", "execution_generation": 7, "text": "Do this"}
    del params[missing]
    with pytest.raises(InvalidParams):
        native_owner_stub.session(None, params)
    assert not [call for call in native_owner_stub.calls if call[0] == "session.steer"]


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


@pytest.mark.parametrize("action,extra", [("snapshot", {}), ("submit", {"request_id": "turn", "text": "Hi"}), ("watch", {})])
def test_only_the_watch_resumes_as_an_open(native_owner_stub, action, extra):
    """TAL-2054: the owner fires on_session_open on a connection's first resume unless that connection read the replay
    first. Web's polls and controls read it first; the watch is the viewer opening the chat."""
    from types import SimpleNamespace
    ctx = SimpleNamespace(cancelled=False)
    ctx.emit = lambda kind, data: setattr(ctx, "cancelled", True)
    assert native_owner_stub.run(ctx, {"session_id": "native", "action": action, **extra})["state"] == "attached"
    reads = [call for call in native_owner_stub.calls if call[0] in {"session.events.since", "session.resume"}]
    reconnect = action != "watch"
    assert reads[:1 + reconnect] == [("session.events.since", {"session_id": "native"})] * reconnect + [("session.resume", {"session_id": "native"})]
    assert reads.count(("session.events.since", {"session_id": "native"})) == reconnect


@pytest.fixture
def native_owner_stub(tmp_path, monkeypatch):
    import asyncio
    from contextlib import asynccontextmanager
    import sys
    from types import SimpleNamespace
    from talaria_sidecar.methods import gateway_sessions as adapter

    owner = SimpleNamespace(receipt=None, replay=[], events=[], frames=[], info={}, payload=None, calls=[], config_failure=None,
                            export=None, export_failure=None, transcript=None, checkpoint_diff=None, checkpoint_failure=None, checkpoints=[], shell=None, shell_failure=None,
                            described={"instance_id": "owner", "profile_id": "profile", "authority_epoch": 1,
                                       "capabilities": ["durable-admission-v1", "event-replay-v1"]})
    async def rpc(method, **params):
        owner.calls.append((method, params))
        if method == "runtime.describe":
            return owner.described
        if method in {"prompt.background", "prompt.btw"}:
            result = owner.launch
            if isinstance(result, Exception):
                raise result
            return result
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
        if method == "message.react" and getattr(owner, "reaction_failure", None):
            raise RuntimeError(owner.reaction_failure)
        if method in {"session.mutate", "session.steer", "prompt.steer_queued", "prompt.replace_queued", "message.react"}:
            owner.payload = params.get("payload")
            return owner.receipt
        if method == "session.context_breakdown":
            import json
            value = json.loads((Path(__file__).parent / "fixtures/context-breakdown.json").read_text())
            if getattr(owner, 'change_on_context', None):
                owner.snapshot_extra = owner.change_on_context
            return getattr(owner, 'context_payload', value)
        if method == "session.stats":
            return {"output_tokens": 40, "last_turn_tokens": 12, **getattr(owner, "usage_stats", {})}
        if method == "config.set":
            if owner.config_failure == "refused":
                raise RuntimeError("unsupported_setting")
            if owner.config_failure == "timeout":
                raise TimeoutError()
        if method == "session.events.since":
            return {"events": owner.replay, "last_sequence": 4}
        if method == "session.transcript":
            if isinstance(owner.transcript, Exception):
                raise owner.transcript
            return owner.transcript
        if method in {"connection.respond", "connectors.operation.status", "connectors.operation.wake", "connectors.connect"}:
            reply = owner.connection[method]
            if isinstance(reply, Exception):
                raise reply
            return reply
    @asynccontextmanager
    async def connect(home, selected):
        assert home == tmp_path and selected is endpoint
        queue = asyncio.Queue()
        for event in owner.events:
            queue.put_nowait({"method": "event", "params": event})
        for frame in owner.frames:
            queue.put_nowait(frame)
        yield SimpleNamespace(rpc=rpc), queue
    monkeypatch.setitem(sys.modules, "hermes_cli.gateway_client", SimpleNamespace(GatewayRPCError=RuntimeError, GatewayClientError=ConnectionError))
    # The Agent's redactor leaves these key-free launch lines as they are; test_connectors.py proves the real one masks a key.
    monkeypatch.setitem(sys.modules, "agent.redact", SimpleNamespace(redact_sensitive_text=lambda text, force: text))
    monkeypatch.setattr(adapter, "_connect", connect)
    owner.control_refusal = adapter._control_refusal
    monkeypatch.setattr(adapter, "_control_refusal", lambda *args: None)
    endpoint = SimpleNamespace(code_sha=SUPPORTED_REVISIONS[-1], control_home=None, instance_id="owner", profile_id="profile", authority_epoch=1)
    found = SimpleNamespace(endpoint=endpoint, state="ready")
    owner.endpoint, owner.discovery = endpoint, found
    monkeypatch.setattr(adapter, "_with_owner", lambda home, run: asyncio.run(run(found)))
    owner.session, owner.create = adapter.session, adapter.create
    owner.run = lambda ctx, params, **loop: asyncio.run(adapter._run(ctx, params, tmp_path, found), **loop)
    return owner


@pytest.mark.parametrize("kind", ["background", "btw"])
def test_native_side_launch_uses_subscribed_parent_and_only_native_text(native_owner_stub, tmp_path, kind):
    owner = native_owner_stub
    owner.launch = {"task_id": "bg-native", "private": "never forward"}
    result = owner.session(None, {"profile_home": str(tmp_path), "session_id": "native", "action": "launch_" + kind,
                                  "authority_epoch": 1, "replay_epoch": "epoch", "text": "Check"})
    assert result.get("launch") == {"state": "accepted", "task_id": "bg-native"}
    calls = owner.calls
    assert calls.index(("session.resume", {"session_id": "native"})) < calls.index(("prompt." + kind, {"session_id": "native", "text": "Check"}))
    assert calls[-1] == ("session.detach", {"session_id": "native", "subscription_id": "viewer"})
    assert not any(method in {"prompt.submit", "session.create"} for method, _ in calls)


@pytest.mark.parametrize("failure,state", [(RuntimeError("method_not_found"), "unsupported"),
                                          (RuntimeError("permission_denied"), "failed"),
                                          (RuntimeError("runtime_draining"), "failed"),
                                          (RuntimeError("request_failed"), "unknown"),
                                          (TimeoutError(), "unknown")])
def test_native_side_launch_never_retries_an_uncertain_reply(native_owner_stub, failure, state):
    owner = native_owner_stub
    owner.launch = failure
    result = owner.run(None, {"session_id": "native", "action": "launch_background",
                              "authority_epoch": 1, "replay_epoch": "epoch", "text": "Check"})
    assert result.get("launch") == {"state": state, "task_id": None}
    assert len([call for call in owner.calls if call[0] == "prompt.background"]) == 1


def test_native_side_launch_fences_owner_before_dispatch(native_owner_stub):
    owner = native_owner_stub
    result = owner.run(None, {"session_id": "native", "action": "launch_background",
                              "authority_epoch": 2, "replay_epoch": "epoch", "text": "Check"})
    assert result.get("launch") == {"state": "failed", "task_id": None}
    assert not any(method.startswith("prompt.") for method, _ in owner.calls)


@pytest.mark.parametrize("extra", [{"model": "other"}, {"submission_id": "unsafe-retry"}, {"profile": "other"}, {"text": " "}])
def test_native_side_launch_rejects_policy_and_retry_overrides(native_owner_stub, tmp_path, extra):
    from talaria_sidecar.errors import InvalidParams
    params = {"profile_home": str(tmp_path), "session_id": "native", "action": "launch_btw",
              "authority_epoch": 1, "replay_epoch": "epoch", "text": "Question", **extra}
    with pytest.raises(InvalidParams, match="side launch requires"):
        native_owner_stub.session(None, params)
    assert native_owner_stub.calls == []


@pytest.mark.parametrize("kind", ["background", "btw"])
def test_native_side_completion_replays_without_a_parent_turn_stamp(native_owner_stub, kind):
    from types import SimpleNamespace
    owner = native_owner_stub
    owner.replay = [{"type": kind + ".complete", "session_id": "native", "replay_epoch": "epoch", "seq": 5,
                     "payload": {"task_id": "bg-native", "text": "x" * 70000, "private": "omit"}}]
    ctx = SimpleNamespace(cancelled=False)
    frames = []
    def emit(event, data):
        frames.append((event, data))
        if event == "replay_complete":
            ctx.cancelled = True
    ctx.emit = emit
    owner.run(ctx, {"session_id": "native", "action": "watch"})
    assert [(data["type"], data["payload"]) for event, data in frames if event == "event"] == [
        (kind + ".complete", {"task_id": "bg-native", "text": "x" * 64000})]


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
    *((revision, True) for revision in SUPPORTED_REVISIONS),
    ("bf0203a794a07aac3ff764972ab9087baa4e4f4f", False),
    ("4d04303818b61bf3aa09278af48356315515965b", False),
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
    from functools import lru_cache
    from talaria_sidecar.methods import gateway_sessions as adapter
    monkeypatch.setattr(adapter, "_support_record", lru_cache(maxsize=1)(adapter._support_record.__wrapped__))
    monkeypatch.setattr(Path, "read_text", read)
    owner = native_owner_stub
    owner.endpoint.control_home = str(tmp_path.parent)
    result = owner.run(None, {"session_id": "chat", "action": "snapshot"})
    assert result["reason"] == "served_profile_sessions_unavailable", result
    assert owner.calls == []


def test_verified_served_owner_keeps_restart_and_diagnostic_gates(tmp_path, native_owner_stub):
    from talaria_sidecar.methods import gateway_sessions as adapter
    owner = native_owner_stub
    owner.endpoint.control_home = str(tmp_path.parent)
    owner.discovery.state = "draining"
    result = owner.run(None, {"session_id": "chat", "action": "submit", "text": "wait", "request_id": "wait"})
    assert (result["state"], result["reason"]) == ("refused", "gateway_restarting"), result
    assert owner.calls == []
    assert owner.run(None, {"session_id": "chat", "action": "snapshot"})["state"] == "attached"
    assert adapter._served(tmp_path, owner.endpoint), "diagnostic creation requires its own verified contract"


def _owner_admission(home, payload):
    import sqlite3
    from contextlib import closing
    with closing(sqlite3.connect(home / "state.db")) as db:
        db.execute("CREATE TABLE session_admissions(target_session_id TEXT, payload_json TEXT, status TEXT)")
        db.execute("INSERT INTO session_admissions VALUES ('chat', ?, 'queued')", (json.dumps(payload),))
        db.commit()


@pytest.mark.parametrize("held,result", [(0.2, ("attached", None)), (None, ("unavailable", "owner_state_busy"))])
def test_locked_owner_state_is_retryable_not_incompatible(tmp_path, native_owner_stub, monkeypatch, held, result):
    """TAL-1671: a write lock while the owner commits an admission is transient, never an incompatible owner."""
    import sqlite3
    import threading
    from talaria_sidecar.methods import gateway_sessions as adapter
    monkeypatch.setattr(adapter, "_control_refusal", native_owner_stub.control_refusal)
    if not held:
        monkeypatch.setattr(adapter, "_STATE_BUSY_BUDGET", 0.5, raising=False)
    _owner_admission(tmp_path, {"cli_turn_v1": {"clarify_batch": False}})
    writer = sqlite3.connect(tmp_path / "state.db", isolation_level=None, check_same_thread=False)
    writer.execute("BEGIN EXCLUSIVE")
    release = threading.Timer(held, writer.rollback) if held else None
    try:
        if release:
            release.start()
        outcome = native_owner_stub.run(None, {"session_id": "chat", "action": "snapshot"})
    finally:
        if release:
            release.join()
        writer.close()
    assert (outcome["state"], outcome["reason"]) == result, outcome


@pytest.mark.parametrize("policy", [[], {"clarify_batch": "yes"}])
def test_malformed_owner_admission_stays_incompatible(tmp_path, native_owner_stub, monkeypatch, policy):
    from talaria_sidecar.methods import gateway_sessions as adapter
    monkeypatch.setattr(adapter, "_control_refusal", native_owner_stub.control_refusal)
    _owner_admission(tmp_path, {"cli_turn_v1": policy})
    outcome = native_owner_stub.run(None, {"session_id": "chat", "action": "snapshot"})
    assert (outcome["state"], outcome["reason"]) == ("incompatible", "owner_controls_unverified"), outcome


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


@pytest.mark.parametrize("todo", [None, {"todos": [], "revision": 4},
    {"todos": [{"id": "a", "content": "Owner task", "status": "pending", "private_binding": "hidden"}], "revision": 3, "private_state": "hidden"}])
def test_todo_snapshot_preserves_explicit_clear_and_strips_private_fields(native_owner_stub, todo):
    native_owner_stub.snapshot_extra = {"todo_state": todo}
    result = native_owner_stub.run(None, {"session_id": "chat", "action": "snapshot"})
    assert "todo_state" in result["snapshot"]
    assert "hidden" not in json.dumps(result["snapshot"]["todo_state"])
    if todo is None:
        assert result["snapshot"]["todo_state"] is None
    else:
        assert result["snapshot"]["todo_state"]["revision"] == todo["revision"]


def test_todo_replay_and_live_events_share_private_field_sanitization(native_owner_stub):
    from types import SimpleNamespace
    owner = native_owner_stub
    def event(seq):
        return {"session_id": "chat", "type": "todo.updated", "seq": seq, "replay_epoch": "epoch",
                "authority_epoch": 1, "execution_generation": 1,
                "payload": {"todos": [{"content": "Task", "private": "hidden", "title": {"binding": "hidden"}}],
                            "revision": seq, "private": "hidden"}}
    owner.replay, owner.events = [event(4)], [event(4), event(5)]
    emitted = []
    ctx = SimpleNamespace(cancelled=False)
    def emit(kind, data):
        emitted.append((kind, data))
        if kind == "event" and data["seq"] == 5:
            ctx.cancelled = True
    ctx.emit = emit
    owner.run(ctx, {"session_id": "chat", "action": "watch"})
    assert [data["payload"] for kind, data in emitted if kind == "event"] == [
        {"todos": [{"content": "Task"}], "revision": 4}, {"todos": [{"content": "Task"}], "revision": 5}]


@requires_agent
def test_real_owner_todo_producer_matches_snapshot_and_replay(native_owner_stub, tmp_path):
    from types import SimpleNamespace
    fixture_path = SIDECAR_ROOT.parent.parent / "contracts/fixtures/web-native-todos.json"
    result = subprocess.run([AGENT_PYTHON, str(Path(__file__).parent / "fixtures/gateway_todo_producer.py"),
                             str(AGENT_DIR), str(fixture_path)],
                            env=isolated_env(tmp_path / "producer", TALARIA_WEB_AGENT_DIR=str(AGENT_DIR)),
                            capture_output=True, text=True, timeout=30, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    produced = json.loads(result.stdout)
    owner = native_owner_stub
    owner.snapshot_extra = {"todo_state": produced["snapshot"]}
    owner.replay = produced["events"]
    frames = []
    owner.run(SimpleNamespace(cancelled=True, emit=lambda kind, data: frames.append((kind, data))),
              {"session_id": "chat", "action": "watch"})
    expected = json.loads(fixture_path.read_text())["owner"]
    assert frames[0][1]["snapshot"]["todo_state"] == expected
    assert [data["payload"] for kind, data in frames if kind == "event"] == [expected]


def test_older_owner_todo_omission_stays_absent(native_owner_stub):
    result = native_owner_stub.run(None, {"session_id": "chat", "action": "snapshot"})
    assert "todo_state" not in result["snapshot"]


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
    env = isolated_env(tmp_path / "hermes", TALARIA_WEB_AGENT_DIR=str(AGENT_DIR))
    result = subprocess.run([AGENT_PYTHON, str(Path(__file__).parent / "fixtures/gateway_cron_refusal.py")],
                            env=env, capture_output=True, text=True, timeout=60, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    report = json.loads(result.stdout)
    assert report["status"] == "supported", report
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


def test_context_detail_before_the_owner_builds_its_agent_is_not_built(native_owner_stub):
    native_owner_stub.context_payload = {'categories': [], 'context_used': 0, 'context_max': 256000}
    assert native_owner_stub.run(None, {'session_id': 'native', 'action': 'context_detail'})['context_detail']['reason'] == 'not_built'


@requires_agent
def test_real_plugin_notice_producer_replays_without_turn_stamp(native_owner_stub, tmp_path):
    import json
    from types import SimpleNamespace
    fixture_path = SIDECAR_ROOT.parent.parent / "contracts/fixtures/web-native-notices.json"
    env = isolated_env(tmp_path / "producer", TALARIA_WEB_AGENT_DIR=str(AGENT_DIR))
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
    result = native_owner_stub.session(None, {"profile_home": str(tmp_path), "session_id": "logical-before-compression", "action": "checkpoint_diff"})
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


@pytest.mark.parametrize("boundary", ["restart", "unsupported"])
def test_checkpoint_diff_never_falls_back_on_owner_refusal(native_owner_stub, boundary):
    if boundary == "restart":
        native_owner_stub.discovery.state = "restart_wait"
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
    # A control reads the replay first, so its resume is a reconnect rather than an open (TAL-2054).
    assert all(method in {"runtime.describe", "session.events.since", "session.resume", "shell.exec", "session.detach"}
               for method, _ in owner.calls)
    assert sum(method == "shell.exec" for method, _ in owner.calls) == 1


@pytest.mark.parametrize("boundary", ["epoch", "replay"])
def test_captured_command_refuses_a_stale_owner(native_owner_stub, boundary):
    owner = native_owner_stub
    owner.snapshot_extra = {"authority_epoch": 2} if boundary == "epoch" else {"replay_epoch": "successor"}
    result = owner.run(None, {"session_id": "native", "action": "shell_exec", "command": "pwd",
                              "authority_epoch": 1, "replay_epoch": "epoch"})
    assert (result["state"], result["reason"]) == ("refused", "owner_changed"), result
    assert not any(method == "shell.exec" for method, _ in owner.calls)


@requires_agent
def test_supported_owner_captured_command_policy(tmp_path):
    env = isolated_env(tmp_path / "hermes", TALARIA_WEB_AGENT_DIR=str(AGENT_DIR))
    result = subprocess.run([AGENT_PYTHON, str(Path(__file__).parent / "fixtures/gateway_shell_policy.py"),
                             str(AGENT_DIR), str(tmp_path / "workspaces")], env=env,
                            capture_output=True, text=True, timeout=60, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert json.loads(result.stdout)["code"] == 7


@pytest.mark.parametrize("revision", SUPPORTED_REVISIONS)
def test_captured_command_accepts_verified_supported_revision(native_owner_stub, revision):
    native_owner_stub.endpoint.code_sha = revision
    result = native_owner_stub.run(None, {"session_id": "native", "action": "terminal_info"})
    assert result["state"] == "attached"


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


@pytest.mark.parametrize("sha", SUPPORTED_REVISIONS)
def test_reaction_snapshot_strips_private_metadata(native_owner_stub, sha):
    owner = native_owner_stub
    owner.endpoint.code_sha = sha
    owner.snapshot_extra = {"messages": [{"role": "assistant", "row_id": 42, "content": "answer",
        "display_metadata": {"private_principal": "secret", "reactions": [{"author": "user", "emoji": "👍", "seen": True}]}}]}
    result = owner.run(None, {"session_id": "native", "action": "snapshot"})
    assert result["snapshot"]["messages"][0].get("reactions") == [{"author": "user", "emoji": "👍"}]
    assert "display_metadata" not in result["snapshot"]["messages"][0]
    assert result["snapshot"]["reactions_supported"] is True


def test_snapshot_skips_model_only_micro_compaction_rows(native_owner_stub):
    owner = native_owner_stub
    owner.snapshot_extra = {"messages": [
        {"role": "user", "row_id": 1, "content": "q0", "archived": True},
        {"role": "user", "row_id": 2, "content": "q1", "archived": True},
        {"role": "user", "row_id": 3, "content": "q0\n\nq1", "display_metadata": {"model_only": True}},
        {"role": "assistant", "row_id": 4, "content": "answer", "display_metadata": {"model_only": False}}]}
    result = owner.run(None, {"session_id": "native", "action": "snapshot"})
    assert [row["content"] for row in result["snapshot"]["messages"]] == ["q0", "q1", "answer"]


def _simulated_watch(owner, monkeypatch, seconds, on_emit=lambda kind, at: None, restart_wait=lambda home: False, **params):
    """Run a watch on a virtual clock until ``seconds`` have passed: the loop jumps to its next timer instead of
    sleeping. Returns the emitted frames with their clock time, and the resumes issued before the deadline."""
    import asyncio
    import selectors
    from types import SimpleNamespace
    from talaria_sidecar.methods import gateway_sessions as adapter
    monkeypatch.setattr(adapter, "_restart_wait", restart_wait)
    clock = {"now": 0.0}
    frames, ctx = [], SimpleNamespace(cancelled=False)

    class Virtual(selectors.DefaultSelector):
        def select(self, timeout=None):
            if ctx.cancelled or not timeout:  # a thread hand-off or the loop's own shutdown runs in real time
                return super().select(timeout)
            clock["now"] += timeout
            if clock["now"] >= seconds:
                ctx.cancelled, clock["resumes"] = True, sum(method == "session.resume" for method, _ in owner.calls)
            return super().select(0)

    def virtual_loop():
        loop = asyncio.SelectorEventLoop(Virtual())
        loop.time = lambda: clock["now"]
        return loop

    def emit(kind, data):
        frames.append((clock["now"], kind, data))
        on_emit(kind, clock["now"])
    ctx.emit = emit
    owner.run(ctx, {"session_id": "native", "action": "watch", **params}, loop_factory=virtual_loop)
    assert owner.calls[-1][0] == "session.detach"
    return frames, clock["resumes"]


def test_an_idle_watch_reads_the_transcript_at_most_every_ten_seconds(native_owner_stub, monkeypatch):
    """TAL-1711: an idle watch costs one transcript read per 10 s, one resume per read, and one contract file read."""
    reads, read_text = [], Path.read_text
    monkeypatch.setattr(Path, "read_text", lambda self, *args, **kwargs: (reads.append(self.name), read_text(self, *args, **kwargs))[1])
    _, resumes = _simulated_watch(native_owner_stub, monkeypatch, 30)
    assert resumes <= 3
    assert reads.count("agent_support.json") <= 1


def test_a_watch_reads_reactions_at_its_injected_interval(native_owner_stub, monkeypatch):
    """TAL-2526: a watch's reaction_poll_seconds replaces the 10 s idle interval, so a real-owner test need not wait it out."""
    _, resumes = _simulated_watch(native_owner_stub, monkeypatch, 3, reaction_poll_seconds=.5)
    assert resumes >= 5


@pytest.mark.parametrize("action,value", [("watch", 0), ("watch", -1), ("watch", True), ("watch", "1"), ("watch", float("inf")),
                                          ("watch", float("nan")), ("snapshot", .5)])
def test_a_reaction_poll_is_a_watchs_positive_interval(native_owner_stub, tmp_path, action, value):
    from talaria_sidecar.errors import InvalidParams
    with pytest.raises(InvalidParams):
        native_owner_stub.session(None, {"profile_home": str(tmp_path), "session_id": "native", "action": action, "reaction_poll_seconds": value})
    assert native_owner_stub.calls == []


@pytest.mark.parametrize("event,within", [(None, 10), ("message.complete", 1), ("message.reaction", 1)])
def test_another_viewers_reaction_reaches_the_watch(native_owner_stub, monkeypatch, event, within):
    """The owner emits no event for another viewer's reaction: an idle watch reads it within its 10 s poll, and a message or reaction event brings the read forward to the next loop."""
    owner = native_owner_stub
    owner.snapshot_extra = {"messages": [{"role": "assistant", "row_id": 42, "content": "answer", "display_metadata": {}}]}
    if event:
        owner.events = [{"session_id": "native", "type": event, "replay_epoch": "epoch", "seq": 5, "execution_generation": 1}]
    started = {}
    def react(kind, at):
        if kind == "replay_complete":
            owner.snapshot_extra["messages"][0]["display_metadata"] = {"reactions": [{"author": "agent", "emoji": "🎉"}]}
            started["at"] = at
    frames, _ = _simulated_watch(owner, monkeypatch, 12, react)
    refreshed = [(at, data["snapshot"]) for at, kind, data in frames if kind == "snapshot" and data.get("reaction_only")]
    assert len(refreshed) == 1
    assert refreshed[0][0] - started["at"] <= within
    assert refreshed[0][1]["messages"][0]["reactions"] == [{"author": "agent", "emoji": "🎉"}]


def test_an_event_triggered_read_waits_for_the_restart_probe(native_owner_stub, monkeypatch):
    """A socket opened before the owner's restart wait is cut when it sends, so no read runs before the probe."""
    owner = native_owner_stub
    owner.events = [{"session_id": "native", "type": "message.complete", "replay_epoch": "epoch", "seq": 5, "execution_generation": 1}]
    frames, resumes = _simulated_watch(owner, monkeypatch, 12, restart_wait=lambda home: True)
    assert resumes == 1
    assert [kind for _, kind, _ in frames].count("restarting") == 1


@pytest.mark.parametrize("failure", [ConnectionError("disconnected"), RuntimeError("storage_unavailable")], ids=["lost", "busy"])
def test_a_watch_delivers_every_received_frame_when_its_own_read_fails(native_owner_stub, monkeypatch, failure):
    """A reaction read that fails must not end the watch before the frames it already received or that follow. TAL-2344:
    an owner restarting when idle exits right after a turn ends, and the watch ends on the reader's disconnect, queued
    behind them. TAL-2398: an owner committing a turn's settlement refuses a read that overlaps it as
    storage_unavailable; the watch reads again later and delivers what follows (a deferred model pick's update)."""
    from contextlib import asynccontextmanager
    from types import SimpleNamespace
    from talaria_sidecar.methods import gateway_sessions as adapter
    monkeypatch.setattr(adapter, "_restart_wait", lambda home: False)
    owner, connect, frames = native_owner_stub, adapter._connect, []
    owner.events = [{"session_id": "native", "type": kind, "replay_epoch": "epoch", "seq": seq, "execution_generation": 1}
                    for seq, kind in ((5, "message.start"), (6, "message.complete"))]
    owner.frames = [ConnectionError("disconnected")]

    @asynccontextmanager
    async def closing(home, endpoint):
        async with connect(home, endpoint) as (client, events):
            async def rpc(method, **params):
                if method == "session.resume" and any(call[0] == "session.resume" for call in owner.calls):
                    raise failure  # the owner exited, or was committing, while this read was in flight
                return await client.rpc(method, **params)
            yield SimpleNamespace(rpc=rpc), events
    monkeypatch.setattr(adapter, "_connect", closing)
    result = owner.run(SimpleNamespace(cancelled=False, emit=lambda kind, data: frames.append((kind, data))),
                       {"session_id": "native", "action": "watch"})
    assert [data["type"] for kind, data in frames if kind == "event"] == ["message.start", "message.complete"]
    assert (result["state"], result["reason"]) == ("unavailable", "owner_connection_lost")


def test_a_streaming_token_does_not_read_the_transcript(native_owner_stub, monkeypatch):
    owner = native_owner_stub
    owner.events = [{"session_id": "native", "type": "message.delta", "replay_epoch": "epoch", "seq": 5, "execution_generation": 1}]
    _, resumes = _simulated_watch(owner, monkeypatch, 5)
    assert resumes == 1


@pytest.mark.parametrize("emoji", ["👍", "❤️", None])
def test_reactions_write_only_through_the_owner_as_user(native_owner_stub, tmp_path, emoji):
    owner = native_owner_stub
    owner.snapshot_extra = {"messages": [{"role": "assistant", "row_id": 42}]}
    result = owner.session(None, {"profile_home": str(tmp_path), "session_id": "native", "action": "react", "row_id": 42, "emoji": emoji})
    assert result["state"] == "attached"
    assert ("message.react", {"session_id": "native", "row_id": 42, "emoji": emoji, "author": "user"}) in owner.calls
    assert not (tmp_path / "state.db").exists()


@pytest.mark.parametrize("extra", [{"author": "agent"}, {"row_id": True}, {"emoji": {}}, {"emoji": "text"}, {"row_id": -1}])
def test_reactions_reject_untrusted_fields_before_connecting(native_owner_stub, tmp_path, extra):
    from talaria_sidecar.errors import InvalidParams
    with pytest.raises(InvalidParams):
        native_owner_stub.session(None, {"profile_home": str(tmp_path), "session_id": "native", "action": "react", "row_id": 42, "emoji": "👍", **extra})
    assert native_owner_stub.calls == []


def test_reaction_vocabulary_matches_the_public_contract():
    from talaria_sidecar.methods.gateway_sessions import _REACTION_EMOJIS
    fixture = json.loads((Path(__file__).resolve().parents[3] / "contracts/fixtures/web-reactions.json").read_text())
    assert _REACTION_EMOJIS == {a["emoji"] for a in fixture["message"]["reaction_view"]["actions"] if a["emoji"]}


@pytest.mark.parametrize("reason,state", [("permission_denied", "refused"), ("not_found", "refused"),
                                         ("request_failed", "unavailable"), ("storage_failed", "unavailable")])
def test_reaction_rpc_failures_preserve_unknown_outcomes(native_owner_stub, reason, state):
    owner = native_owner_stub
    owner.snapshot_extra = {"messages": [{"role": "assistant", "row_id": 42}]}
    owner.reaction_failure = reason
    result = owner.run(None, {"session_id": "native", "action": "react", "row_id": 42, "emoji": "👍"})
    assert result["state"] == state
    assert len([call for call in owner.calls if call[0] == "message.react"]) == 1


def test_plan_gauge_snapshot_is_read_from_this_owner_and_cleared_on_omission(native_owner_stub):
    owner = native_owner_stub
    gauge = {"id": "day", "label": "Today", "used_bp": 8300, "resets_at_ms": None}
    owner.usage_stats = {"plan_gauge": gauge}
    assert owner.run(None, {"session_id": "chat", "action": "snapshot"})["snapshot"]["plan_gauge"] == gauge
    assert [method for method, _ in owner.calls].count("session.resume") == 1
    owner.usage_stats = {"plan_gauge": gauge, "execution_generation": 2}
    assert owner.run(None, {"session_id": "chat", "action": "snapshot"})["snapshot"]["plan_gauge"] is None
    owner.usage_stats = {}
    assert owner.run(None, {"session_id": "chat", "action": "snapshot"})["snapshot"]["plan_gauge"] is None


RAW_CONNECTION = {
    "op_id": "op-native", "seq": 3, "deadline_at": 1.0, "timeout_seconds": 1.0, "tool_call_id": "call-native",
    "targets": [
        {"name": "gmail", "kind": "connector", "action": "connect", "state": "initiated", "resolved": False, "connect_url": "https://vendor.example.test/a",
         "connection_id": "private-connection", "attempt": "private-attempt", "alias": "private-alias", "launch": {"kind": "stdio", "target": "private-launch"}},
        {"name": "linear", "kind": "mcp", "action": "install", "state": "pending", "resolved": False, "detail": "needs a key",
         "required_env": [{"name": "LINEAR_API_KEY", "required": True, "secret": True, "default": "private-default", "prompt": "API key"}],
         "launch": {"kind": "stdio", "target": "npx -y mcp-linear 'two  spaces'", "env": ["LINEAR_API_KEY"], "cwd": "/work", "private": "private-launch-field"}},
    ],
}
PUBLIC_CONNECTION = {
    "op_id": "op-native", "seq": 3, "settled": False, "owner": "session", "tool_call_id": "call-native",
    "targets": [
        {"name": "gmail", "kind": "connector", "state": "initiated", "detail": "", "connect_url": "https://vendor.example.test/a", "required_env": []},
        {"name": "linear", "kind": "mcp", "state": "pending", "detail": "needs a key", "connect_url": None,
         "required_env": [{"name": "LINEAR_API_KEY", "prompt": "API key", "required": True, "secret": True}],
         "launch": {"kind": "stdio", "target": "npx -y mcp-linear 'two  spaces'", "env": ["LINEAR_API_KEY"], "cwd": "/work"}},
    ],
}


@pytest.mark.parametrize("launch", [
    None, "npx -y mcp-linear", {"target": "npx"}, {"kind": "stdio"}, {"kind": "stdio", "target": ""}, {"kind": "stdio", "target": 7}, {"kind": "future", "target": "npx"},
])
def test_a_target_without_a_usable_launch_line_keeps_the_older_row(launch):
    from talaria_sidecar.methods.connectors import snapshot_view
    raw = {"op_id": "op", "targets": [{"name": "linear", "kind": "mcp", "state": "pending", "launch": launch}]}
    assert set(snapshot_view(raw, owner="session", tool_call_id=None)["targets"][0]) == {"name", "kind", "state", "detail", "connect_url", "required_env"}


def test_snapshot_and_live_events_project_the_open_connection_through_the_direct_allowlist(native_owner_stub):
    from types import SimpleNamespace
    native_owner_stub.snapshot_extra = {"pending_connection": RAW_CONNECTION}
    native_owner_stub.replay = [{"type": "connection.update", "session_id": "native", "replay_epoch": "epoch", "seq": 2, "payload": {**RAW_CONNECTION, "settled_at": None, "settled": False}}]
    native_owner_stub.events = [{"type": "connection.update", "session_id": "native", "replay_epoch": "epoch", "seq": 5, "payload": {**RAW_CONNECTION, "seq": 4, "settled_at": 2.0, "settled": True}}]
    frames = []
    ctx = SimpleNamespace(cancelled=False)
    def emit(kind, data):
        frames.append((kind, data))
        if kind == "event" and data["seq"] == 5:
            ctx.cancelled = True
    ctx.emit = emit
    native_owner_stub.run(ctx, {"session_id": "native", "action": "watch"})
    assert frames[0][1]["snapshot"]["pending_connection"] == PUBLIC_CONNECTION
    events = [data["payload"] for kind, data in frames if kind == "event"]
    assert events == [PUBLIC_CONNECTION, {**PUBLIC_CONNECTION, "seq": 4, "settled": True, "targets": [{**PUBLIC_CONNECTION["targets"][0], "connect_url": "https://vendor.example.test/a"}, PUBLIC_CONNECTION["targets"][1]]}]
    assert "private-" not in json.dumps(frames)


def test_an_owner_without_the_field_keeps_it_absent_and_null_clears_it(native_owner_stub):
    assert "pending_connection" not in native_owner_stub.run(None, {"session_id": "native", "action": "snapshot"})["snapshot"]
    native_owner_stub.snapshot_extra = {"pending_connection": None}
    assert native_owner_stub.run(None, {"session_id": "native", "action": "snapshot"})["snapshot"]["pending_connection"] is None


@pytest.mark.parametrize("action,method,extra,sent", [
    ("connection_status", "connectors.operation.status", {}, {"op_id": "op-native"}),
    ("connection_wake", "connectors.operation.wake", {}, {"op_id": "op-native"}),
    ("connection_respond", "connection.respond", {"connection_answer": {"settled_by": "continue"}}, {"op_id": "op-native", "result": {"settled_by": "continue"}}),
    ("connection_respond", "connection.respond", {"connection_answer": {"targets": [{"name": "linear", "status": "approved", "env": {"LINEAR_API_KEY": "synthetic"}}]}},
     {"op_id": "op-native", "result": {"targets": [{"name": "linear", "status": "approved", "env": {"LINEAR_API_KEY": "synthetic"}}]}}),
])
def test_connection_verbs_route_to_the_exact_owner_and_never_resume(native_owner_stub, action, method, extra, sent):
    native_owner_stub.connection = {"connectors.operation.status": RAW_CONNECTION, "connectors.operation.wake": {"status": "ok"},
                                    "connection.respond": {"status": "ok", "settled": True}, "connectors.connect": RAW_CONNECTION}
    result = native_owner_stub.run(None, {"session_id": "native", "action": action, "op_id": "op-native", "authority_epoch": 1, **extra})
    assert result["state"] == "attached" and result["snapshot"] is None
    verbs = [call for call in native_owner_stub.calls if call[0] != "runtime.describe"]
    assert verbs == [(method, {"owner": {"type": "session", "session_id": "native"}, **sent})]
    if action == "connection_status":
        assert result["connection"] == PUBLIC_CONNECTION
    if action == "connection_respond":
        assert result["connection_settled"] is True


RETRY = {"session_id": "native", "action": "connection_retry", "op_id": "op-native", "authority_epoch": 1, "connector": "gmail"}
OWNER = {"owner": {"type": "session", "session_id": "native"}}


def test_retry_reads_the_requested_operation_on_its_own_connection_before_running_it(native_owner_stub):
    native_owner_stub.connection = {"connectors.operation.status": RAW_CONNECTION, "connectors.connect": RAW_CONNECTION}
    result = native_owner_stub.run(None, RETRY)
    assert result["connection"] == PUBLIC_CONNECTION
    assert [call for call in native_owner_stub.calls if call[0] != "runtime.describe"] == [
        ("connectors.operation.status", {**OWNER, "op_id": "op-native"}),
        ("connectors.connect", {**OWNER, "connectors": ["gmail"], "reconnect": True}),
    ]


def test_retry_never_runs_against_an_operation_that_replaced_the_requested_one(native_owner_stub):
    native_owner_stub.connection = {"connectors.operation.status": RuntimeError("UNKNOWN_OPERATION"), "connectors.connect": RAW_CONNECTION}
    result = native_owner_stub.run(None, RETRY)
    assert (result["state"], result["reason"]) == ("refused", "UNKNOWN_OPERATION")
    assert not any(call[0] == "connectors.connect" for call in native_owner_stub.calls)


def test_retry_refuses_when_the_owner_answers_for_another_operation(native_owner_stub):
    native_owner_stub.connection = {"connectors.operation.status": RAW_CONNECTION, "connectors.connect": {**RAW_CONNECTION, "op_id": "op-replacement"}}
    result = native_owner_stub.run(None, RETRY)
    assert (result["state"], result["reason"]) == ("refused", "UNKNOWN_OPERATION")
    assert "connection" not in result


def test_a_replaced_owner_refuses_the_late_answer_before_it_is_sent(native_owner_stub):
    result = native_owner_stub.run(None, {"session_id": "native", "action": "connection_respond", "op_id": "op-native", "authority_epoch": 9, "connection_answer": {"settled_by": "continue"}})
    assert (result["state"], result["reason"]) == ("refused", "owner_changed")
    assert [call[0] for call in native_owner_stub.calls] == ["runtime.describe"]


@pytest.mark.parametrize("failure,state,reason", [(RuntimeError("UNKNOWN_OPERATION"), "refused", "UNKNOWN_OPERATION"), (RuntimeError("CONNECTORS_UNAVAILABLE"), "refused", "CONNECTORS_UNAVAILABLE"), (TimeoutError(), "unavailable", "owner_connection_lost")])
def test_a_refusal_keeps_its_reason_and_a_lost_answer_stays_unknown(native_owner_stub, failure, state, reason):
    native_owner_stub.connection = {"connection.respond": failure}
    result = native_owner_stub.run(None, {"session_id": "native", "action": "connection_respond", "op_id": "op-native", "authority_epoch": 1, "connection_answer": {"settled_by": "continue"}})
    assert (result["state"], result["reason"]) == (state, reason)
    assert sum(call[0] == "connection.respond" for call in native_owner_stub.calls) == 1


@pytest.mark.parametrize("params", [
    {"action": "connection_status", "authority_epoch": 1},
    {"action": "connection_status", "op_id": "op", "authority_epoch": True},
    {"action": "connection_retry", "op_id": "op", "authority_epoch": 1},
    {"action": "connection_respond", "op_id": "op", "authority_epoch": 1},
    {"action": "connection_respond", "op_id": "op", "authority_epoch": 1, "connection_answer": {"settled_by": "deadline"}},
    {"action": "connection_respond", "op_id": "op", "authority_epoch": 1, "connection_answer": {"targets": []}},
    {"action": "connection_respond", "op_id": "op", "authority_epoch": 1, "connection_answer": {"settled_by": "continue", "targets": [{"name": "a", "status": "skipped"}]}},
    {"action": "connection_respond", "op_id": "op", "authority_epoch": 1, "connection_answer": {"targets": [{"name": "a", "status": "connected"}]}},
    {"action": "connection_respond", "op_id": "op", "authority_epoch": 1, "connection_answer": {"targets": [{"name": "a", "status": "approved", "env": {"K": 1}}]}},
])
def test_connection_verbs_are_closed(tmp_path, native_owner_stub, params):
    from talaria_sidecar.errors import InvalidParams
    with pytest.raises(InvalidParams):
        native_owner_stub.session(None, {"profile_home": str(tmp_path), "session_id": "native", **params})


NATIVE_WORK = json.loads((Path(__file__).resolve().parents[3] / "contracts/fixtures/web-native-work.json").read_text())


@pytest.fixture
def work_owner(native_owner_stub, monkeypatch):
    import asyncio
    from contextlib import asynccontextmanager
    from types import SimpleNamespace
    from talaria_sidecar.methods import gateway_sessions as adapter
    native_owner_stub.work = {**NATIVE_WORK["owner"]}
    connect = adapter._connect

    @asynccontextmanager
    async def connected(home, endpoint):
        async with connect(home, endpoint) as (client, events):
            inner = client.rpc

            async def rpc(method, **params):
                if method in {"process.list", "subagent.list", "subagent.tail", "process.kill", "process.stop", "subagent.interrupt", "subagent.steer", "delegation.pause"}:
                    native_owner_stub.calls.append((method, params))
                    value = native_owner_stub.work.get(method)
                    if method == "subagent.tail" and isinstance(value, dict):
                        value = value.get(params["subagent_id"])
                    if isinstance(value, Exception):
                        raise value
                    return value
                return await inner(method, **params)
            yield SimpleNamespace(rpc=rpc), events
    monkeypatch.setattr(adapter, "_connect", connected)
    return native_owner_stub


def test_work_list_projects_both_rosters_without_resuming_the_session(work_owner):
    result = work_owner.run(None, {"session_id": "native", "action": "work_list"})
    assert result == {"state": "attached", "reason": None, "snapshot": None, "receipt": None, "work": NATIVE_WORK["work"]}
    methods = [method for method, _ in work_owner.calls]
    # Reading never adopts a cold session or opens a subscription.
    assert "session.resume" not in methods and "session.detach" not in methods
    assert methods == ["runtime.describe", "process.list", "subagent.list", "subagent.tail", "subagent.tail"]
    assert ("subagent.tail", {"session_id": "native", "subagent_id": "sa-rebuilt"}) in work_owner.calls


def test_work_list_reads_a_cold_session_as_empty_and_a_managed_worker_as_unsupported(work_owner):
    # A session the owner has not adopted is not_found on every ancillary read.
    work_owner.work["process.list"] = work_owner.work["subagent.list"] = RuntimeError("not_found")
    assert work_owner.run(None, {"session_id": "native", "action": "work_list"})["work"] == {"authority_epoch": 1, "processes": [], "subagents": []}
    work_owner.work["process.list"] = RuntimeError("unsupported_projection")
    assert work_owner.run(None, {"session_id": "native", "action": "work_list"}) == {
        "state": "refused", "reason": "unsupported_projection", "snapshot": None, "receipt": None}


def test_work_list_keeps_the_rest_when_one_child_ends_mid_read(work_owner):
    tails = dict(NATIVE_WORK["owner"]["subagent.tail"])
    tails["sa-resident"] = RuntimeError("not_found")
    work_owner.work["subagent.tail"] = tails
    work = work_owner.run(None, {"session_id": "native", "action": "work_list"})["work"]
    assert work["processes"] == NATIVE_WORK["work"]["processes"]
    assert [(a["subagent_id"], a["resident"]) for a in work["subagents"]] == [("sa-resident", False), ("sa-rebuilt", False)]


@pytest.mark.parametrize("kind,reply,method,outcome", [
    ("process", {"status": "killed", "session_id": "proc_server"}, "process.kill", "stopped"),
    ("process", {"status": "already_exited"}, "process.kill", "not_running"),
    ("process", RuntimeError("process_not_found"), "process.kill", "not_found"),
    ("subagent", {"found": True, "subagent_id": "sa-resident"}, "subagent.interrupt", "stopped"),
    ("subagent", {"found": False, "subagent_id": "sa-resident"}, "subagent.interrupt", "not_found"),
])
def test_work_stop_reaches_exactly_one_row_with_its_owner_verdict(work_owner, kind, reply, method, outcome):
    work_owner.work[method] = reply
    native = "proc_server" if kind == "process" else "sa-resident"
    result = work_owner.run(None, {"session_id": "native", "action": "work_stop", "work_kind": kind, "work_id": native, "authority_epoch": 1})
    assert result["state"] == "attached" and result["work_outcome"] == outcome
    key = "process_id" if kind == "process" else "subagent_id"
    controls = [call for call in work_owner.calls if call[0] in {"process.kill", "process.stop", "subagent.interrupt", "delegation.pause"}]
    # One row, never the session-wide process.stop or the owner-wide delegation.pause.
    assert controls == [(method, {"session_id": "native", key: native})]


@pytest.mark.parametrize("status,outcome", [("queued", "queued"), ("rejected", "rejected")])
def test_work_steer_returns_the_owner_verdict(work_owner, status, outcome):
    work_owner.work["subagent.steer"] = {"status": status, "subagent_id": "sa-resident", "text": "Look"}
    result = work_owner.run(None, {"session_id": "native", "action": "work_steer", "work_kind": "subagent", "work_id": "sa-resident", "authority_epoch": 1, "text": "Look"})
    assert result["work_outcome"] == outcome
    assert [call for call in work_owner.calls if call[0] == "subagent.steer"] == [("subagent.steer", {"session_id": "native", "subagent_id": "sa-resident", "text": "Look"})]


def test_work_tail_serves_a_resident_child(work_owner):
    result = work_owner.run(None, {"session_id": "native", "action": "work_tail", "work_kind": "subagent", "work_id": "sa-resident", "authority_epoch": 1})
    assert result["work_tail"] == {"available": True, "text": "read_file logs/app.log\n", "truncated": False}


@pytest.mark.parametrize("action", ["work_stop", "work_steer", "work_tail"])
def test_work_controls_refuse_another_owner_authority_before_sending(work_owner, action):
    result = work_owner.run(None, {"session_id": "native", "action": action, "work_kind": "subagent", "work_id": "sa-resident", "authority_epoch": 2, "text": "Look"})
    assert result == {"state": "refused", "reason": "owner_changed", "snapshot": None, "receipt": None}
    assert [method for method, _ in work_owner.calls] == ["runtime.describe"]


@pytest.mark.parametrize("params", [
    {"action": "work_stop", "work_kind": "process", "work_id": "proc_server"},
    {"action": "work_stop", "work_kind": "delegation", "work_id": "x", "authority_epoch": 1},
    {"action": "work_stop", "work_kind": "process", "work_id": "", "authority_epoch": 1},
    {"action": "work_steer", "work_kind": "process", "work_id": "proc_server", "authority_epoch": 1, "text": "x"},
    {"action": "work_steer", "work_kind": "subagent", "work_id": "sa", "authority_epoch": 1},
    {"action": "work_tail", "work_kind": "process", "work_id": "proc_server", "authority_epoch": 1},
])
def test_work_controls_validate_closed_inputs_before_connecting(tmp_path, work_owner, params):
    from talaria_sidecar.errors import InvalidParams
    with pytest.raises(InvalidParams):
        work_owner.session(None, {"profile_home": str(tmp_path), "session_id": "native", **params})
    assert work_owner.calls == []


# TAL-2072: a stored page as the owner answers it: a compaction handoff in place, private row metadata beside the display.
TRANSCRIPT_PAGE = {"session_id": "native", "next_cursor": "c2", "reset": False, "rows": [
    {"row_kind": "message", "role": "user", "text": "HEAD", "row_id": 3,
     "display_metadata": {"gateway_input_owner": "principal", "reactions": [{"author": "agent", "emoji": "🎉"}]}},
    {"row_kind": "compaction", "role": "system", "text": "Earlier turns summarized", "compacted_messages": 4, "row_id": 9, "timestamp": 5.0},
    {"row_kind": "message", "role": "tool", "name": "read_file", "tool_call_id": "c1", "context": "app.log", "args": {"path": "app.log"}},
    {"row_kind": "message", "role": "assistant", "text": "TAIL", "row_id": 11}]}
SHOWN_PAGE = [
    {"row_kind": "message", "role": "user", "text": "HEAD", "row_id": 3, "reactions": [{"author": "agent", "emoji": "🎉"}]},
    {"row_kind": "compaction", "text": "Earlier turns summarized", "compacted_messages": 4, "row_id": 9, "timestamp": 5.0},
    {"row_kind": "message", "role": "tool", "name": "read_file", "tool_call_id": "c1", "context": "app.log", "args": {"path": "app.log"}, "reactions": []},
    {"row_kind": "message", "role": "assistant", "text": "TAIL", "row_id": 11, "reactions": []}]


@pytest.mark.parametrize("cursor", [None, "c1"])
def test_transcript_reads_a_stored_page_without_attaching(native_owner_stub, cursor):
    """A history page is the owner's stored read: no resume, replay read or detach, so it never opens or subscribes."""
    native_owner_stub.described["capabilities"].append("session-transcript-v1")
    native_owner_stub.transcript = TRANSCRIPT_PAGE
    result = native_owner_stub.run(None, {"session_id": "native", "action": "transcript", "order": "oldest", "limit": 50,
                                          **({"cursor": cursor} if cursor else {})})
    assert result == {"state": "attached", "reason": None, "snapshot": None, "receipt": None,
                      "transcript": {"rows": SHOWN_PAGE, "next_cursor": "c2", "reset": False}}
    assert native_owner_stub.calls == [("runtime.describe", {}), ("session.transcript", {
        "session_id": "native", "order": "oldest", "limit": 50, **({"cursor": cursor} if cursor else {})})]


@pytest.mark.parametrize("serves", [True, False])
def test_a_snapshot_says_whether_its_owner_serves_stored_reads(native_owner_stub, serves):
    """A v0.23.0 owner has no session.transcript: its snapshot says so and the read is refused unsent."""
    if serves:
        native_owner_stub.described["capabilities"].append("session-transcript-v1")
    snapshot = native_owner_stub.run(None, {"session_id": "native", "action": "snapshot"})["snapshot"]
    assert snapshot.get("transcripts", False) is serves
    if not serves:
        refused = native_owner_stub.run(None, {"session_id": "native", "action": "transcript", "order": "latest", "limit": 50})
        assert refused == {"state": "incompatible", "reason": "owner_transcript_unsupported", "snapshot": None, "receipt": None}
        assert not any(method == "session.transcript" for method, _ in native_owner_stub.calls)


@pytest.mark.parametrize("params", [
    {"action": "transcript", "limit": 50},
    {"action": "transcript", "order": "newest", "limit": 50},
    {"action": "transcript", "order": "oldest", "limit": 0},
    {"action": "transcript", "order": "oldest", "limit": 501},
    {"action": "transcript", "order": "oldest", "limit": 50, "cursor": ""},
    {"action": "work_transcript", "work_kind": "subagent", "work_id": "sa"},
])
def test_transcript_reads_validate_closed_inputs_before_connecting(tmp_path, native_owner_stub, params):
    from talaria_sidecar.errors import InvalidParams
    with pytest.raises(InvalidParams):
        native_owner_stub.session(None, {"profile_home": str(tmp_path), "session_id": "native", **params})
    assert native_owner_stub.calls == []


def test_work_transcript_reads_a_finished_child_under_its_parent(work_owner):
    """A child the roster no longer lists stays readable through its parent's stored read (TAL-2072)."""
    work_owner.described["capabilities"].append("session-transcript-v1")
    work_owner.transcript = {**TRANSCRIPT_PAGE, "subagent_id": "sa-done", "available": True, "running": False, "child_session_id": "child"}
    listed = work_owner.run(None, {"session_id": "native", "action": "work_list"})
    assert listed["work"]["transcripts"] is True
    read = work_owner.run(None, {"session_id": "native", "action": "work_transcript", "work_kind": "subagent", "work_id": "sa-done", "authority_epoch": 1})
    assert read["work_transcript"] == {"available": True, "running": False, "rows": SHOWN_PAGE}
    assert work_owner.calls[-1] == ("session.transcript", {"session_id": "native", "subagent_id": "sa-done", "order": "latest", "limit": 200})
    assert not any(method in {"session.resume", "session.events.since"} for method, _ in work_owner.calls)
    # A parent the owner no longer holds, and a child it cannot place, read as unavailable, never as an error.
    work_owner.transcript = RuntimeError("not_found")
    gone = work_owner.run(None, {"session_id": "native", "action": "work_transcript", "work_kind": "subagent", "work_id": "sa-done", "authority_epoch": 1})
    assert gone["work_transcript"] == {"available": False, "running": False, "rows": []}


def test_work_transcript_needs_the_stored_read(work_owner):
    result = work_owner.run(None, {"session_id": "native", "action": "work_transcript", "work_kind": "subagent", "work_id": "sa-done", "authority_epoch": 1})
    assert result == {"state": "incompatible", "reason": "owner_transcript_unsupported", "snapshot": None, "receipt": None}
    assert "transcripts" not in work_owner.run(None, {"session_id": "native", "action": "work_list"})["work"]
