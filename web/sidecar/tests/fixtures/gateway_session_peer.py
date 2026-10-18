"""Two real viewers and an ordinary disposable daemon on a held loopback provider."""
import asyncio
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import threading
import time

agent = Path(os.environ["HERMES_WEBUI_AGENT_DIR"])
sys.path[:0] = [str(agent), str(agent / "tests/gateway/fixtures"), str(Path(__file__).resolve().parents[1])]
from local_recovery_probe import Model, child_env, daemon, rpc, websocket
from conftest import SidecarProcess


async def probe(home, peer, desc, *, require_gap=False):
    sidecar = SidecarProcess(home)
    viewer = SidecarProcess(home)
    try:
        async with websocket(home, desc) as native:
            created = await rpc(native, "session.create", request_id="native-create", source="cli", toolsets=[])
            sid = created["result"]["session_id"]
            submitted = await rpc(native, "prompt.submit", session_id=sid, submission_id="native-start", text="BLOCK_STARTED")
            assert "result" in submitted, submitted
            assert await asyncio.to_thread(peer.blocked.wait, 25), "native turn did not reach provider"
            def call(action, **params):
                return sidecar.result("gateway.session", {"profile_home": str(home), "session_id": sid, "action": action, **params})
            attached = await asyncio.to_thread(call, "snapshot")
            assert attached["state"] == "attached", attached
            assert attached["snapshot"]["running"] and attached["snapshot"]["session_id"] == sid, attached
            first = await asyncio.to_thread(call, "submit", request_id="lost-ack", text="FOLLOWUP")
            second = await asyncio.to_thread(call, "submit", request_id="lost-ack", text="FOLLOWUP")
            assert first["receipt"]["admission_id"] == second["receipt"]["admission_id"], (first, second)
            cancel_me = await asyncio.to_thread(call, "submit", request_id="cancel-queued", text="NEVER_RUN_CANCELLED")
            cancelled = await asyncio.to_thread(call, "cancel", admission_id=cancel_me["receipt"]["admission_id"])
            assert cancelled["receipt"]["status"] == "terminal" and cancelled["receipt"]["outcome"] == "cancelled", cancelled
            # Observation is detachable while the native inference remains blocked.
            watch_id = viewer.request("gateway.session", {"profile_home": str(home), "session_id": sid, "action": "watch"})
            frame = await asyncio.to_thread(viewer.next_message, 20)
            assert frame["method"] == "stream" and frame["params"]["event"] == "snapshot", frame
            if require_gap:
                while True:
                    frame = await asyncio.to_thread(viewer.next_message, 20)
                    if frame.get("method") == "stream" and frame["params"]["event"] == "snapshot" and frame["params"]["data"].get("replay_gap"):
                        assert frame["params"]["data"]["snapshot"]["session_id"] == sid, frame
                        break
            viewer.request("rpc.cancel", {"id": watch_id})
            while True:
                frame = await asyncio.to_thread(viewer.next_message, 20)
                if frame.get("id") == watch_id:
                    assert frame["result"]["state"] == "attached", frame
                    break
            assert peer.blocked.is_set() and not peer.release.is_set()
            assert (await asyncio.to_thread(call, "snapshot"))["snapshot"]["running"]
            peer.release.set()
            deadline = time.monotonic() + 40
            while True:
                final = await asyncio.to_thread(call, "snapshot")
                if final["snapshot"] and not final["snapshot"]["pending"]:
                    break
                assert time.monotonic() < deadline, final
                await asyncio.sleep(.05)
            native_final = await rpc(native, "session.resume", session_id=sid)
            assert [(m["role"], m.get("content")) for m in final["snapshot"]["messages"]] == [(m["role"], m.get("content")) for m in native_final["result"]["messages"]]
            assert "gateway_input_owner" not in json.dumps(final)
            assert "system_prompt" not in final["snapshot"]["info"]
            assert "credential_hint" not in final["snapshot"]["info"]
            history = json.dumps(final["snapshot"]["messages"])
            assert history.count("RECOVERY_ACK_FOLLOWUP") == 1, history
            assert len(peer.requests) == 2, peer.requests
            receipt = await asyncio.to_thread(call, "receipt", admission_id=first["receipt"]["admission_id"])
            assert receipt["receipt"]["status"] == "terminal", receipt
            # A third exchange leaves a compressible head while retaining a complete recent turn.
            await asyncio.to_thread(call, "submit", request_id="compression-tail", text="COMPRESSION_TAIL")
            deadline = time.monotonic() + 40
            while True:
                final = await asyncio.to_thread(call, "snapshot")
                if final["snapshot"] and not final["snapshot"]["pending"]:
                    break
                assert time.monotonic() < deadline, final
                await asyncio.sleep(.05)
            # Stale revisions and generations reach the owner and are refused without a local writer.
            stale = await asyncio.to_thread(call, "mutate", request_id="stale", expected_revision=0,
                                            execution_generation=0, operation="workspace", payload={"cwd": str(home)})
            assert stale["state"] == "refused", stale
            compressed = await asyncio.to_thread(call, "mutate", request_id="compress-stable", expected_revision=final["snapshot"]["revision"],
                execution_generation=final["snapshot"]["execution_generation"], operation="compress", payload={})
            assert compressed["state"] == "attached" and compressed["snapshot"]["session_id"] == sid, compressed
            assert len(compressed["snapshot"]["messages"]) < len(final["snapshot"]["messages"]), compressed
            reset = await asyncio.to_thread(call, "mutate", request_id="reset-stable", expected_revision=compressed["snapshot"]["revision"],
                execution_generation=compressed["snapshot"]["execution_generation"], operation="reset", payload={})
            assert reset["state"] == "attached" and reset["snapshot"]["session_id"] == sid, reset
            assert reset["snapshot"]["messages"] == [], reset
            retained = await asyncio.to_thread(call, "receipt", admission_id=first["receipt"]["admission_id"])
            assert retained["receipt"]["admission_id"] == first["receipt"]["admission_id"] and retained["receipt"]["status"] == "terminal"
            print(json.dumps({"same_owner": True, "deduplicated": True, "detached_running": True, "model_requests": len(peer.requests)}))
    finally:
        peer.release.set()
        sidecar.close()
        viewer.close()


async def probe_control(home, peer, desc, kind):
    sidecar = SidecarProcess(home)
    try:
        async with websocket(home, desc) as native:
            created = await rpc(native, "session.create", request_id="control-create", source="cli",
                                toolsets=["terminal" if kind == "approval" else "clarify"])
            sid = created["result"]["session_id"]
            submitted = await rpc(native, "prompt.submit", session_id=sid, submission_id="control-input", text="Run fixture control")
            assert "result" in submitted, submitted
            deadline = time.monotonic() + 30
            while True:
                pending = await rpc(native, "session.resume", session_id=sid)
                if pending["result"]["prompts"]:
                    break
                assert time.monotonic() < deadline, pending
                await asyncio.sleep(.03)
            prompt = pending["result"]["prompts"][0]
            await native.close()
        params = {"profile_home": str(home), "session_id": sid}
        attached = await asyncio.to_thread(sidecar.result, "gateway.session", {**params, "action": "snapshot"})
        assert attached["state"] == "attached" and attached["snapshot"]["prompts"][0]["prompt_id"] == prompt["prompt_id"], attached
        response = {"choice": "once"} if kind == "approval" else {"text": "green"}
        answered = await asyncio.to_thread(sidecar.result, "gateway.session", {**params, "action": kind,
            "prompt_id": prompt["prompt_id"], "execution_generation": prompt["execution_generation"], **response})
        assert answered["state"] == "attached", answered
        while True:
            final = await asyncio.to_thread(sidecar.result, "gateway.session", {**params, "action": "snapshot"})
            if not final["snapshot"]["pending"]:
                break
            assert time.monotonic() < deadline, final
            await asyncio.sleep(.03)
        assert kind.upper() + "_FINISHED" in json.dumps(final["snapshot"]["messages"]), final
        if kind == "approval":
            assert not (home / "owned-removal").exists()
        else:
            assert any("green" in json.dumps(m) for messages in peer.requests for m in messages if m["role"] == "tool")
    finally:
        sidecar.close()


async def probe_batch(home, peer, desc):
    sidecar = SidecarProcess(home)
    try:
        async with websocket(home, desc) as native:
            created = await rpc(native, "session.create", request_id="batch-create", source="cli", toolsets=["clarify"])
            sid = created["result"]["session_id"]
            admitted = await rpc(native, "prompt.submit", session_id=sid, submission_id="native-batch",
                                 text="Ask for a color", clarify_batch=True)
            assert "result" in admitted, admitted
            async with asyncio.timeout(30):
                while True:
                    frame = json.loads(await native.recv())
                    if frame.get("method") == "clarify" and str(frame.get("id", "")).startswith("srq-"):
                        break
            await native.close()
        async with websocket(home, desc) as resumed:
            before = await rpc(resumed, "session.resume", session_id=sid)
            assert before["result"]["running"] and before["result"]["prompts"] == [], before
            before_requests = len(peer.requests)
            result = await asyncio.to_thread(sidecar.result, "gateway.session", {
                "profile_home": str(home), "session_id": sid, "action": "snapshot"})
            assert result["state"] == "incompatible" and result["reason"] == "native_clarify_batch_unavailable", result
            # Attachment must not decline the native batch or release its parked turn.
            after = await rpc(resumed, "session.resume", session_id=sid)
            assert after["result"]["running"] and len(peer.requests) == before_requests, {
                "running": after["result"]["running"], "before_requests": before_requests,
                "after_requests": len(peer.requests), "pending": after["result"]["pending"]}
            await resumed.send(json.dumps({"jsonrpc": "2.0", "id": frame["id"],
                "result": {"answers": {"q0": "green"}, "outcome": "submitted"}}))
            deadline = time.monotonic() + 30
            while True:
                done = await rpc(resumed, "session.resume", session_id=sid)
                if not done["result"]["pending"]:
                    break
                assert time.monotonic() < deadline, done
                await asyncio.sleep(.05)
    finally:
        sidecar.close()


async def probe_profiles(home, peer, desc):
    from hermes_cli.gateway_runtime import discover_gateway_endpoint
    from hermes_cli.gateway_client import _session_ticket, gateway_ws_target
    from websockets.asyncio.client import connect
    alpha = home / "profiles/alpha"
    discovered = discover_gateway_endpoint(alpha)
    assert discovered.state == "ready" and discovered.endpoint.profile_id == str(alpha), discovered
    url, protocols = gateway_ws_target(discovered.endpoint, _session_ticket(alpha, discovered.endpoint))
    sidecar = SidecarProcess(home)
    ids = {}
    try:
        async with websocket(home, desc) as root_view, connect(url, subprotocols=protocols) as alpha_view:
            created = await rpc(root_view, "session.create", request_id="same-request", source="cli", model="root-model", toolsets=[])
            root_id = created["result"]["session_id"]
            await rpc(root_view, "prompt.submit", session_id=root_id, submission_id="same-input", text="ROOT_HOME")
            deadline = time.monotonic() + 30
            while True:
                result = await asyncio.to_thread(sidecar.result, "gateway.session", {"profile_home": str(home), "session_id": root_id, "action": "snapshot"})
                assert result["state"] == "attached", result
                if not result["snapshot"]["pending"]:
                    break
                assert time.monotonic() < deadline, result
                await asyncio.sleep(.03)
            assert result["snapshot"]["info"]["model"] == "root-model", result
            created_alpha = await rpc(alpha_view, "session.create", request_id="same-request", source="cli", model="alpha-model", toolsets=[])
            alpha_id = created_alpha["result"]["session_id"]
            count = len(peer.requests)
            for action, extra in (("snapshot", {}), ("submit", {"request_id": "blocked", "text": "MUST_NOT_RUN"})):
                refused = await asyncio.to_thread(sidecar.result, "gateway.session", {"profile_home": str(alpha), "session_id": alpha_id, "action": action, **extra})
                assert refused["state"] == "incompatible" and refused["reason"] == "served_profile_sessions_unavailable", refused
            assert len(peer.requests) == count
    finally:
        sidecar.close()


async def probe_dedicated(home, peer, desc, alpha, alpha_desc):
    sidecar = SidecarProcess(home)
    ids = {}
    try:
        async with websocket(home, desc) as root_view, websocket(alpha, alpha_desc) as alpha_view:
            for name, viewer, target in (("root", root_view, home), ("alpha", alpha_view, alpha)):
                created = await rpc(viewer, "session.create", request_id="same-create", source="cli", model=name + "-model", toolsets=[])
                sid = created["result"]["session_id"]
                ids[name] = sid
                await rpc(viewer, "prompt.submit", session_id=sid, submission_id="same-input", text=name.upper() + "_HOME")
                deadline = time.monotonic() + 30
                while True:
                    result = await asyncio.to_thread(sidecar.result, "gateway.session", {"profile_home": str(target), "session_id": sid, "action": "snapshot"})
                    assert result["state"] == "attached", result
                    if not result["snapshot"]["pending"]:
                        break
                    assert time.monotonic() < deadline, result
                    await asyncio.sleep(.03)
                assert result["snapshot"]["info"]["model"] == name + "-model", result
                assert "RECOVERY_ACK_" + name.upper() + "_HOME" in json.dumps(result["snapshot"]["messages"])
            count = len(peer.requests)
            foreign = await asyncio.to_thread(sidecar.result, "gateway.session", {"profile_home": str(alpha), "session_id": ids["root"], "action": "snapshot"})
            assert foreign["state"] == "refused" and len(peer.requests) == count, foreign
    finally:
        sidecar.close()


async def probe_secure(home):
    from types import SimpleNamespace
    from unittest.mock import patch
    from websockets.asyncio.server import serve
    from talaria_sidecar.methods.gateway_sessions import _connect, _run
    answered = asyncio.Event()
    async def requests(ws):
        for name in ("sudo", "secret"):
            await ws.send(json.dumps({"jsonrpc": "2.0", "id": "srq-" + name, "method": name,
                                      "params": {"session_id": "fixture", "command": "owned-fixture"}}))
            async with asyncio.timeout(2):
                response = json.loads(await ws.recv())
            assert response == {"jsonrpc": "2.0", "id": "srq-" + name, "result": {"value": ""}}, response
        answered.set()
        await ws.wait_closed()
    with patch("hermes_cli.gateway_client._session_ticket", return_value="synthetic-one-use-ticket"):
        async with serve(requests, "127.0.0.1", 0, subprotocols=["hermes-gateway-v1"]) as server:
            endpoint = SimpleNamespace(api_origin=f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}")
            async with _connect(home, endpoint) as (_, events):
                await asyncio.wait_for(answered.wait(), 3)
                assert events.empty(), "secure prompts reached the Web observation queue"
        seen = []
        async def incompatible(ws):
            frame = json.loads(await ws.recv())
            seen.append(frame["method"])
            await ws.send(json.dumps({"jsonrpc": "2.0", "id": frame["id"], "result": {
                "instance_id": "fixture", "profile_id": str(home), "authority_epoch": 1, "capabilities": []}}))
            await ws.wait_closed()
        async with serve(incompatible, "127.0.0.1", 0, subprotocols=["hermes-gateway-v1"]) as server:
            endpoint = SimpleNamespace(api_origin=f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}", control_home=None,
                instance_id="fixture", profile_id=str(home), authority_epoch=1)
            result = await _run(SimpleNamespace(), {"session_id": "fixture", "action": "snapshot"}, home,
                                SimpleNamespace(endpoint=endpoint))
            assert result["state"] == "incompatible" and result["reason"] == "owner_capabilities", result
            assert seen == ["runtime.describe"], seen

        import sqlite3
        from contextlib import closing
        with closing(sqlite3.connect(home / "state.db")) as db:
            db.execute("CREATE TABLE session_admissions(target_session_id TEXT, payload_json TEXT, status TEXT)")
            db.commit()
        receipt = {"admission_id": "acknowledged", "sequence": 1, "status": "queued", "outcome": None,
                   "authority_epoch": 1, "execution_generation": None}
        async def acknowledged_then_disconnected(ws):
            responses = {
                "runtime.describe": {"instance_id": "fixture", "profile_id": str(home), "authority_epoch": 1,
                    "capabilities": ["durable-admission-v1", "event-replay-v1"]},
                "session.resume": {"session_id": "fixture", "subscription_id": "viewer", "messages": [], "info": {}},
                "prompt.submit": receipt,
            }
            for method in ("runtime.describe", "session.resume", "prompt.submit"):
                frame = json.loads(await ws.recv())
                assert frame["method"] == method, frame
                await ws.send(json.dumps({"jsonrpc": "2.0", "id": frame["id"], "result": responses[method]}))
            await ws.close()
        async with serve(acknowledged_then_disconnected, "127.0.0.1", 0, subprotocols=["hermes-gateway-v1"]) as server:
            endpoint = SimpleNamespace(api_origin=f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}", control_home=None,
                instance_id="fixture", profile_id=str(home), authority_epoch=1)
            result = await _run(SimpleNamespace(), {"session_id": "fixture", "action": "submit", "request_id": "stable", "text": "once"},
                                home, SimpleNamespace(endpoint=endpoint))
            assert result["state"] == "unavailable" and result["receipt"] == receipt, result


def probe_recovery(home, peer, env):
    import sqlite3
    ids = {}
    async def first(desc, proc):
        async with websocket(home, desc) as native:
            for name in ("safe", "unknown"):
                created = await rpc(native, "session.create", request_id=name, source="cli", toolsets=[])
                ids[name] = created["result"]["session_id"]
            await rpc(native, "prompt.submit", session_id=ids["unknown"], submission_id="started", text="BLOCK_STARTED")
            assert await asyncio.to_thread(peer.blocked.wait, 25)
            await rpc(native, "prompt.submit", session_id=ids["unknown"], submission_id="follower", text="AFTER_UNKNOWN")
            await native.send(json.dumps({"jsonrpc": "2.0", "id": "safe", "method": "prompt.submit", "params": {
                "session_id": ids["safe"], "submission_id": "queued", "text": "RECOVER_QUEUED"}}))
            deadline = time.monotonic() + 20
            while True:
                with sqlite3.connect((home / "state.db").as_uri() + "?mode=ro", uri=True) as db:
                    row = db.execute("SELECT status FROM session_admissions WHERE request_id='queued'").fetchone()
                if row and row[0] == "queued":
                    break
                assert time.monotonic() < deadline
                await asyncio.sleep(.03)
            proc.kill()
            await asyncio.to_thread(proc.wait, 10)

    async def recovered():
        sidecar = SidecarProcess(home)
        def call(name, action="snapshot", **params):
            return sidecar.result("gateway.session", {"profile_home": str(home), "session_id": ids[name], "action": action, **params})
        try:
            deadline = time.monotonic() + 40
            while True:
                safe = await asyncio.to_thread(call, "safe")
                if safe["state"] == "attached" and not safe["snapshot"]["pending"]:
                    break
                assert time.monotonic() < deadline, safe
                await asyncio.sleep(.05)
            assert "RECOVERY_ACK_RECOVER_QUEUED" in json.dumps(safe["snapshot"]["messages"]), safe
            unknown = await asyncio.to_thread(call, "unknown")
            assert unknown["state"] == "attached", unknown
            pending = unknown["snapshot"]["pending"]
            assert [p["status"] for p in pending] == ["unknown", "queued"], pending
            lost = pending[0]
            refused = await asyncio.to_thread(call, "unknown", "discard", admission_id=lost["admission_id"],
                                              execution_generation=lost["execution_generation"] + 1)
            assert refused["state"] == "refused", refused
            assert (await asyncio.to_thread(call, "unknown"))["snapshot"]["pending"][0]["status"] == "unknown"
            resolved = await asyncio.to_thread(call, "unknown", "discard", admission_id=lost["admission_id"],
                                               execution_generation=lost["execution_generation"])
            assert resolved["state"] == "attached", resolved
            while True:
                final = await asyncio.to_thread(call, "unknown")
                if not final["snapshot"]["pending"]:
                    break
                assert time.monotonic() < deadline, final
                await asyncio.sleep(.05)
            assert "RECOVERY_ACK_AFTER_UNKNOWN" in json.dumps(final["snapshot"]["messages"]), final
        finally:
            sidecar.close()

    with daemon(agent, home, env, barrier=True) as (proc, desc):
        asyncio.run(first(desc, proc))
    with daemon(agent, home, env, barrier=False):
        asyncio.run(recovered())
    with daemon(agent, home, env, barrier=False):
        sidecar = SidecarProcess(home)
        try:
            for sid in ids.values():
                snapshot = sidecar.result("gateway.session", {"profile_home": str(home), "session_id": sid, "action": "snapshot"})
                assert snapshot["state"] == "attached" and snapshot["snapshot"]["pending"] == [], snapshot
        finally:
            sidecar.close()
    texts = [next((m.get("content") for m in reversed(body.get("messages", [])) if m["role"] == "user"), "") for body in peer.requests]
    for text in ("BLOCK_STARTED", "RECOVER_QUEUED", "AFTER_UNKNOWN"):
        assert texts.count(text) == 1, texts


def main():
    home = Path(os.environ["HERMES_HOME"])
    home.mkdir(mode=0o700, exist_ok=True)
    mode = sys.argv[1] if len(sys.argv) > 1 else "shared"
    from authority_clarify_peer import ModelPeer as ClarifyPeer
    from authority_controls_peer import ModelPeer as ApprovalPeer
    handler = ApprovalPeer if mode == "approval" else ClarifyPeer if mode in {"batch", "clarify"} else Model
    if mode == "profiles":
        class ProfileModel(Model):
            def do_POST(self):
                self.server.authorization.append(self.headers.get("Authorization"))
                super().do_POST()
        handler = ProfileModel
    peer = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    peer.authorization = []
    if mode == "approval":
        import shlex
        target = home / "owned-removal"
        target.mkdir()
        (target / "owned.txt").write_text("disposable")
        peer.command = "rm -r -- " + shlex.quote(str(target))
    peer.requests = []
    peer.blocked, peer.release = threading.Event(), threading.Event()
    threading.Thread(target=peer.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{peer.server_port}/v1"
    (home / "config.yaml").write_text(json.dumps({"gateway": {"multiplex_profiles": mode == "profiles"},
        "model": {"provider": "custom", "default": "owner-fixture", "base_url": url},
        "compression": {"in_place": False, "protect_first_n": 0, "protect_last_n": 0, "min_tail_user_messages": 1},
        "auxiliary": {"title_generation": {"enabled": False}}, "approvals": {"mode": "manual", "timeout": 45}, "platform_toolsets": {"cli": []}}))
    if mode in {"profiles", "dedicated"}:
        alpha = home / "profiles/alpha"
        alpha.mkdir(parents=True)
        alpha_config = json.loads((home / "config.yaml").read_text())
        alpha_config["gateway"] = {"multiplex_profiles": False, "standalone": mode == "dedicated"}
        (alpha / "config.yaml").write_text(json.dumps(alpha_config))
        (alpha / ".env").write_text("OPENAI_API_KEY=alpha-only\n")
    env = child_env()
    env.update(HOME=os.environ["HOME"], HERMES_HOME=str(home), PYTHONPATH=str(agent),
               OPENAI_API_KEY="loopback-only", OPENAI_BASE_URL=url, HERMES_STATE_DB_GUARD_BYPASS="1", HERMES_DISABLE_LAZY_INSTALLS="1")
    env.update(PYTEST_CURRENT_TEST="talaria native owner fixture", TIRITH_ENABLED="0", AWS_EC2_METADATA_DISABLED="true")
    try:
        if mode == "dedicated":
            alpha_env = dict(env, HERMES_HOME=str(alpha), OPENAI_API_KEY="alpha-only")
            with daemon(agent, home, env, barrier=False) as (_, desc), daemon(agent, alpha, alpha_env, barrier=False) as (_, alpha_desc):
                asyncio.run(probe_dedicated(home, peer, desc, alpha, alpha_desc))
            return
        if mode == "secure":
            asyncio.run(probe_secure(home))
            return
        if mode == "recovery":
            probe_recovery(home, peer, env)
            return
        with daemon(agent, home, env, barrier=mode == "replay", fixture=str(Path(__file__).with_name("gateway_replay_daemon.py"))) as (_, desc):
            if mode == "profiles":
                asyncio.run(probe_profiles(home, peer, desc))
            elif mode in {"approval", "clarify"}:
                asyncio.run(probe_control(home, peer, desc, mode))
            else:
                asyncio.run(probe_batch(home, peer, desc) if mode == "batch" else probe(home, peer, desc, require_gap=mode == "replay"))
    finally:
        peer.release.set()
        peer.shutdown()
        peer.server_close()


if __name__ == "__main__":
    main()
