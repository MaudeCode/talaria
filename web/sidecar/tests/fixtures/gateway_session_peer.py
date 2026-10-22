"""Two real viewers and an ordinary disposable daemon on a held loopback provider."""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import queue
import sys
import threading
import time

agent = Path(os.environ["HERMES_WEBUI_AGENT_DIR"])
sys.path[:0] = [str(agent), str(agent / "tests/gateway/fixtures"), str(Path(__file__).resolve().parents[1])]
from agent.context_compressor import SUMMARY_PREFIX
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
            resumed_again = await rpc(native, "session.resume", session_id=sid)
            assert resumed_again["result"]["subscription_id"] == native_final["result"]["subscription_id"], resumed_again
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
            # v0.22.3 resumes with the whole display history (older rows archived), so the row count need not shrink.
            def summaries(snapshot):
                return sum(isinstance(m.get("content"), str) and m["content"].startswith(SUMMARY_PREFIX) for m in snapshot["messages"])
            assert compressed["snapshot"]["revision"] > final["snapshot"]["revision"], compressed
            assert summaries(compressed["snapshot"]) == summaries(final["snapshot"]) + 1, compressed
            assert [m.get("content") for m in compressed["snapshot"]["messages"][-2:]] == ["COMPRESSION_TAIL", "RECOVERY_ACK_COMPRESSION_TAIL"], compressed
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


async def probe_queued_controls(home, peer, desc):
    sidecar = SidecarProcess(home)
    try:
        async with websocket(home, desc) as native:
            created = await rpc(native, "session.create", request_id="queue-create", source="cli", toolsets=[])
            sid = created["result"]["session_id"]
            def call(action, **params):
                return sidecar.result("gateway.session", {"profile_home": str(home), "session_id": sid, "action": action, **params})
            await asyncio.to_thread(call, "submit", request_id="queue-running", text="BLOCK_STARTED")
            assert await asyncio.to_thread(peer.blocked.wait, 25), "running turn did not reach provider"
            steer = await asyncio.to_thread(call, "submit", request_id="queue-steer", text="QUEUE_CORRECTION")
            edit = await asyncio.to_thread(call, "submit", request_id="queue-edit", text="NEVER_RUN_ORIGINAL")
            steered = await asyncio.to_thread(call, "steer_queued", admission_id=steer["receipt"]["admission_id"])
            assert steered["state"] == "attached", steered
            assert any(p["admission_id"] == steer["receipt"]["admission_id"] and p.get("steering") is True for p in steered["snapshot"]["pending"]), steered
            replacement = dict(admission_id=edit["receipt"]["admission_id"], submission_id="queue-edit-stable", text="REPLACED_QUEUED")
            replaced = await asyncio.to_thread(call, "replace_queued", **replacement)
            repeated = await asyncio.to_thread(call, "replace_queued", **replacement)
            assert replaced["state"] == repeated["state"] == "attached", (replaced, repeated)
            assert replaced["receipt"]["admission_id"] == repeated["receipt"]["admission_id"], (replaced, repeated)
            peer.release.set()
            deadline = time.monotonic() + 40
            while True:
                final = await asyncio.to_thread(call, "snapshot")
                if final["snapshot"] and not final["snapshot"]["pending"]:
                    break
                assert time.monotonic() < deadline, final
                await asyncio.sleep(.05)
            contexts = [body["messages"] for body in peer.requests]
            # Steering reaches the original execution before the edited queued turn starts.
            corrected = next(i for i, rows in enumerate(contexts) if "QUEUE_CORRECTION" in json.dumps(rows))
            edited = next(i for i, rows in enumerate(contexts) if "REPLACED_QUEUED" in json.dumps(rows))
            assert corrected < edited, contexts
            assert "NEVER_RUN_ORIGINAL" not in json.dumps(contexts), contexts
            assert "REPLACED_QUEUED" in json.dumps(final["snapshot"]["messages"]), final
    finally:
        peer.release.set()
        sidecar.close()


async def probe_model(home, peer, desc):
    sidecar = SidecarProcess(home)
    viewer = SidecarProcess(home)
    try:
        async with websocket(home, desc) as native:
            created = await rpc(native, "session.create", request_id="model-create", source="cli", toolsets=[])
            sid = created["result"]["session_id"]
            def call(action, **params):
                return sidecar.result("gateway.session", {"profile_home": str(home), "session_id": sid, "action": action, **params})
            await asyncio.to_thread(call, "submit", request_id="model-turn", text="BLOCK_STARTED")
            assert await asyncio.to_thread(peer.blocked.wait, 25)
            running = (await asyncio.to_thread(call, "snapshot"))["snapshot"]
            picked = await asyncio.to_thread(call, "mutate", request_id="native-model-pick",
                expected_revision=running["revision"], execution_generation=running["execution_generation"],
                operation="model", payload={"model": "owner-fixture-picked", "provider": "custom"})
            assert picked["receipt"]["status"] == "deferred", picked
            model_watch = viewer.request("gateway.session", {"profile_home": str(home), "session_id": sid, "action": "watch"})
            frame = await asyncio.to_thread(viewer.next_message, 20)
            assert frame["params"]["event"] == "snapshot", frame
            peer.release.set()
            while True:
                frame = await asyncio.to_thread(viewer.next_message, 20)
                data = frame.get("params", {}).get("data", {})
                if data.get("type") == "session.updated" and data.get("payload", {}).get("operation") == "model":
                    assert data.get("execution_generation") is None, data
                    assert data["payload"].get("status") is None, data
                    assert data["payload"]["model"] == "owner-fixture-picked", data
                    break
            viewer.request("rpc.cancel", {"id": model_watch})
            while (await asyncio.to_thread(viewer.next_message, 20)).get("id") != model_watch:
                pass
    finally:
        peer.release.set()
        sidecar.close()
        viewer.close()


async def probe_voice_stop(home, peer, desc):
    import subprocess
    web = Path(__file__).resolve().parents[3]
    server = web / 'packages/server/dist'
    assert (server / 'runtime.js').exists(), 'voice-stop HTTP proof needs the built Web server'
    async with websocket(home, desc) as native:
        created = await rpc(native, 'session.create', request_id='voice-create', source='cli', toolsets=[])
        sid = created['result']['session_id']
        enabled = await rpc(native, 'slash.exec', session_id=sid, command='/voice on')
        assert 'error' not in enabled, enabled
        voice = await rpc(native, 'config.get', session_id=sid, key='voice')
        assert voice['result']['value'] == 'voice_only', voice
        script = home / 'voice-stop.mjs'
        imports = '\n'.join(f'import {{{name}}} from {json.dumps((server / path).as_uri())};'
            for name, path in [('createApp', 'app.js'), ('createDeps', 'runtime.js'),
                               ('startServer', 'server.js'), ('SidecarClient', 'sidecar/client.js')])
        args = dict(home=str(home), web=str(web), agent=str(agent), python=sys.executable, sid=sid)
        script.write_text(imports + '\nconst a=' + json.dumps(args) + ';\n' + r'''
const logs=[];
const env={...process.env,PYTHONPATH:a.web+'/sidecar',HERMES_HOME:a.home,HERMES_WEBUI_STATE_DIR:a.home+'/webui',
  HERMES_WEBUI_DEFAULT_WORKSPACE:a.home,HERMES_WEBUI_CLAUDE_PROJECTS_DIR:a.home+'/claude',
  HERMES_WEBUI_HOST:'127.0.0.1',HERMES_WEBUI_PORT:'0'};
const client=new SidecarClient({python:a.python,agentDir:a.agent,sidecarDir:a.web+'/sidecar',hermesHome:a.home,env,log:l=>logs.push(l)});
let running;
try {
 await client.start();
 const deps=await createDeps({webRoot:a.web,env,sidecar:client,pty:null,log:l=>logs.push(l),fetch:async()=>{throw Error('external network forbidden')}});
 running=await startServer(createApp(deps),deps.config,{signals:false,log:l=>logs.push(l)});
 const response=await fetch('http://127.0.0.1:'+running.port+'/api/chat/start',{
   method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({session_id:a.sid,message:'stop',submission_id:'voice-stop-once'})});
 console.log(JSON.stringify({status:response.status,body:await response.json()}));
} finally {
 await running?.close(); await client.close();
}
''')
        result = await asyncio.to_thread(subprocess.run, ['node', str(script)], env=os.environ.copy(),
                                         capture_output=True, text=True, timeout=60)
        assert result.returncode == 0, result.stdout + result.stderr
        response = json.loads(result.stdout.splitlines()[-1])
        voice = await rpc(native, 'config.get', session_id=sid, key='voice')
        assert voice['result']['value'] == 'off', (voice, response)
        import sqlite3
        with sqlite3.connect(home / 'state.db') as db:
            assert db.execute('SELECT COUNT(*) FROM session_admissions WHERE target_session_id=?', (sid,)).fetchone()[0] == 0
        assert peer.requests == [], 'a consumed voice stop must never reach a provider'
        assert response['status'] == 200, response
        assert response['body']['status'] == 'suppressed' and response['body']['reason'] == 'voice_stopped', response
        assert 'stream_id' not in response['body'] and 'admission_id' not in response['body'], response
        print(json.dumps({'voice_stopped': True, 'admissions': 0, 'http_status': response['status']}))


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
    from importlib.util import find_spec
    if find_spec("gateway.session_clarify_lock") is None:
        return await probe_batch_unavailable(home, peer, desc)
    sidecar = SidecarProcess(home)
    viewer = SidecarProcess(home)
    try:
        async with websocket(home, desc) as native:
            created = await rpc(native, "session.create", request_id="batch-create", source="cli", toolsets=["clarify"])
            sid = created["result"]["session_id"]
            params = {"profile_home": str(home), "session_id": sid}
            # The Web viewer is attached before the owner asks, as the server's watch is while a turn runs.
            watch_id = viewer.request("gateway.session", {**params, "action": "watch"})
            frame = await asyncio.to_thread(viewer.next_message, 20)
            assert frame["method"] == "stream" and frame["params"]["event"] == "snapshot", frame
            admitted = await rpc(native, "prompt.submit", session_id=sid, submission_id="native-batch",
                                 text="Ask for a color and a size", clarify_batch=True)
            assert "result" in admitted, admitted
            async with asyncio.timeout(30):
                while True:
                    frame = await asyncio.to_thread(viewer.next_message, 20)
                    assert frame.get("id") != watch_id, f"the watch ended before Web received the batch: {frame}"
                    if frame.get("method") == "stream" and frame["params"]["event"] == "clarify_batch":
                        batch = frame["params"]["data"]
                        break
            assert [q["qid"] for q in batch["questions"]] == ["q0", "q1"], batch
            assert batch["questions"][0]["question"] == "Pick a color" and "green" in batch["questions"][0]["choices"], batch
            # The batch turn no longer makes the session incompatible for Web.
            attached = await asyncio.to_thread(sidecar.result, "gateway.session", {**params, "action": "snapshot"})
            assert attached["state"] == "attached" and attached["snapshot"]["running"], attached
            before_requests = len(peer.requests)
            first = await asyncio.to_thread(sidecar.result, "gateway.session", {**params, "action": "clarify_lock",
                "request_id": batch["request_id"], "question_id": "q0", "answer": "green"})
            assert first["state"] == "attached" and first["lock"] == {"status": "ok", "remaining": ["q1"]}, first
            assert len(peer.requests) == before_requests, "one lock must not release the batch"
            last = await asyncio.to_thread(sidecar.result, "gateway.session", {**params, "action": "clarify_lock",
                "request_id": batch["request_id"], "question_id": "q1", "answer": "large"})
            assert last["state"] == "attached" and last["lock"] == {"status": "ok", "remaining": []}, last
            # The owner withdraws the settled request from every viewer; the server clears its card on that event.
            async with asyncio.timeout(30):
                while True:
                    frame = await asyncio.to_thread(viewer.next_message, 20)
                    event = frame.get("params", {}).get("data", {}) if frame.get("method") == "stream" else {}
                    if event.get("type") == "request.cancel":
                        assert event["payload"]["id"] == batch["request_id"], event
                        assert event["payload"]["reason"] == "resolved", event
                        break
            deadline = time.monotonic() + 30
            while True:
                final = await asyncio.to_thread(sidecar.result, "gateway.session", {**params, "action": "snapshot"})
                if not final["snapshot"]["pending"]:
                    break
                assert time.monotonic() < deadline, final
                await asyncio.sleep(.05)
            tool = json.dumps([m for messages in peer.requests for m in messages if m["role"] == "tool"])
            assert "green" in tool and "large" in tool, tool
            assert "CLARIFY_FINISHED" in json.dumps(final["snapshot"]["messages"]), final
            viewer.request("rpc.cancel", {"id": watch_id})
    finally:
        sidecar.close()
        viewer.close()


async def probe_batch_unavailable(home, peer, desc):
    """Agents without ``clarify.lock`` keep the explicit refusal and never release the parked batch."""
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
                "result": {"answers": {"q0": "green", "q1": "large"}, "outcome": "submitted"}}))
            deadline = time.monotonic() + 30
            while True:
                done = await rpc(resumed, "session.resume", session_id=sid)
                if not done["result"]["pending"]:
                    break
                assert time.monotonic() < deadline, done
                await asyncio.sleep(.05)
    finally:
        sidecar.close()


async def probe_restart(home, peer, desc, proc):
    """``hermes gateway restart`` waits for a turn parked on an approval; Web answers it, then the restart completes."""
    import signal
    from hermes_cli.gateway_runtime import discover_gateway_endpoint
    sidecar = SidecarProcess(home)
    viewer = SidecarProcess(home)
    try:
        async with websocket(home, desc) as native:
            created = await rpc(native, "session.create", request_id="restart-create", source="cli", toolsets=["terminal"])
            sid = created["result"]["session_id"]
            await rpc(native, "prompt.submit", session_id=sid, submission_id="restart-input", text="Run fixture control")
            deadline = time.monotonic() + 30
            while True:
                pending = await rpc(native, "session.resume", session_id=sid)
                if pending["result"]["prompts"]:
                    break
                assert time.monotonic() < deadline, pending
                await asyncio.sleep(.03)
            prompt = pending["result"]["prompts"][0]
        params = {"profile_home": str(home), "session_id": sid}
        # Web's watch was opened before the wait, as the server's is while the turn runs.
        watch_id = viewer.request("gateway.session", {**params, "action": "watch"})
        frame = await asyncio.to_thread(viewer.next_message, 20)
        assert frame["method"] == "stream" and frame["params"]["event"] == "snapshot", frame
        # The initial snapshot precedes the replay RPC. Wait for its first event so this
        # probe restarts an established watch, not a socket still sending its startup reads.
        seen = []
        while True:
            frame = await asyncio.to_thread(viewer.next_message, 20)
            assert frame.get("id") != watch_id, frame
            if frame["params"]["event"] == "event":
                seen.append(frame["params"]["data"].get("type"))
                break
        proc.send_signal(signal.SIGUSR1)  # the service restart path `hermes gateway restart` takes
        deadline = time.monotonic() + 30
        while (found := discover_gateway_endpoint(home)).reason_code != "restart_wait":
            assert time.monotonic() < deadline, found
            await asyncio.sleep(.05)
        # The watch learns the transition itself, so the server can stop sending without another read.
        while True:
            try:
                frame = await asyncio.to_thread(viewer.next_message, 10)
            except queue.Empty:
                raise AssertionError(f"the open watch never reported the restart wait: {seen}") from None
            assert frame.get("id") != watch_id, frame
            if frame["params"]["event"] == "restarting":
                break
            seen.append(frame["params"]["data"].get("type"))
        attached = await asyncio.to_thread(sidecar.result, "gateway.session", {**params, "action": "snapshot"})
        assert attached["state"] == "attached" and attached["restarting"] is True, attached
        assert attached["snapshot"]["prompts"][0]["prompt_id"] == prompt["prompt_id"], attached
        count = len(peer.requests)
        for action, extra in (("submit", {"request_id": "restart-submit", "text": "MUST_NOT_RUN"}),
                              ("mutate", {"request_id": "restart-mutate", "expected_revision": attached["snapshot"]["revision"],
                                          "execution_generation": attached["snapshot"]["execution_generation"],
                                          "operation": "rename", "payload": {"title": "never"}})):
            refused = await asyncio.to_thread(sidecar.result, "gateway.session", {**params, "action": action, **extra})
            assert (refused["state"], refused["reason"]) == ("refused", "gateway_restarting"), refused
        answered = await asyncio.to_thread(sidecar.result, "gateway.session", {**params, "action": "approval",
            "prompt_id": prompt["prompt_id"], "execution_generation": prompt["execution_generation"], "choice": "once"})
        assert answered["state"] == "attached", answered
        # The restart waited only for that turn: the owner now exits on its own.
        await asyncio.to_thread(proc.wait, 60)
        # The watch opened before the wait observed the settlement and the turn's end until the owner exited.
        while (frame := await asyncio.to_thread(viewer.next_message, 20)).get("id") != watch_id:
            seen.append(frame["params"]["data"].get("type"))
        assert seen.index("approval.settled") < seen.index("message.complete"), seen
        import sqlite3
        from contextlib import closing
        with closing(sqlite3.connect((home / "state.db").as_uri() + "?mode=ro", uri=True)) as db:
            contents = [row[0] for row in db.execute("SELECT content FROM messages WHERE session_id=?", (sid,))]
        assert "APPROVAL_FINISHED" in contents, contents
        assert not (home / "owned-removal").exists()
        assert "MUST_NOT_RUN" not in json.dumps(peer.requests[count:]), peer.requests[count:]
    finally:
        sidecar.close()
        viewer.close()


async def probe_profiles(home, peer, desc, proc, env):
    from dataclasses import replace
    from hermes_cli.gateway_runtime import discover_gateway_endpoint
    from hermes_cli.gateway_runtime_discovery import DiscoveryError
    from hermes_cli.gateway_client import GatewayClientError, _session_ticket, gateway_ws_target
    from websockets.asyncio.client import connect
    alpha = home / "profiles/alpha"
    discovered = discover_gateway_endpoint(alpha)
    assert discovered.state == "ready" and discovered.endpoint.profile_id == str(alpha), discovered
    url, protocols = gateway_ws_target(discovered.endpoint, _session_ticket(alpha, discovered.endpoint))
    sidecar = SidecarProcess(home)
    verified = getattr(discovered.endpoint, "code_sha", None) == "4d04303818b61bf3aa09278af48356315515965b"

    async def call(target, sid, action, **extra):
        return await asyncio.to_thread(sidecar.result, "gateway.session", {
            "profile_home": str(target), "session_id": sid, "action": action, **extra})

    async def settled(target, sid):
        deadline = time.monotonic() + 40
        while True:
            result = await call(target, sid, "snapshot")
            assert result["state"] == "attached", result
            if not result["snapshot"]["pending"]:
                return result["snapshot"]
            assert time.monotonic() < deadline, result
            await asyncio.sleep(.03)
    try:
        async with websocket(home, desc) as root_view, connect(url, subprotocols=protocols) as alpha_view:
            created = await rpc(root_view, "session.create", request_id="same-request", source="cli", model="root-model", toolsets=["terminal"])
            root_id = created["result"]["session_id"]
            # Run the primary LOCAL adapter first and keep its turn in flight.
            await rpc(root_view, "prompt.submit", session_id=root_id, submission_id="same-input", text="BLOCK_STARTED")
            assert await asyncio.to_thread(peer.blocked.wait, 25), "primary LOCAL adapter did not run"
            created_alpha = await rpc(alpha_view, "session.create", request_id="same-request", source="tui", model="alpha-model", toolsets=[])
            alpha_id = created_alpha["result"]["session_id"]
            if not verified:
                count = len(peer.secondary.requests)
                for action, extra in (("snapshot", {}), ("submit", {"request_id": "blocked", "text": "MUST_NOT_RUN"})):
                    refused = await call(alpha, alpha_id, action, **extra)
                    assert (refused["state"], refused["reason"]) == ("incompatible", "served_profile_sessions_unavailable"), refused
                assert len(peer.secondary.requests) == count
                return
            attached = await call(alpha, alpha_id, "snapshot")
            assert attached["state"] == "attached", attached
            snap = attached["snapshot"]
            workspace = alpha / "picked-workspace"
            workspace.mkdir()
            for operation, payload in (("model", {"model": "alpha-picked", "provider": "custom"}),
                                       ("workspace", {"cwd": str(workspace)})):
                changed = await call(alpha, alpha_id, "mutate", request_id=operation,
                    expected_revision=snap["revision"], execution_generation=snap["execution_generation"],
                    operation=operation, payload=payload)
                assert changed["state"] == "attached", changed
                snap = changed["snapshot"]
            submitted = await call(alpha, alpha_id, "submit", request_id="same-input", text="ALPHA_ONLY")
            assert submitted["state"] == "attached", submitted
            final = await settled(alpha, alpha_id)
            assert final["info"]["model"] == "alpha-picked", final
            assert final["info"]["cwd"] == str(workspace), final
            assert "ALPHA_ONLY" in json.dumps(final["messages"]), final
            assert "BLOCK_STARTED" not in json.dumps(final["messages"]), final
            assert peer.secondary.requests and all(r["model"] == "alpha-picked" and not r.get("tools") for r in peer.secondary.requests)
            assert set(peer.secondary.authorization) == {"Bearer alpha-only"}, peer.secondary.authorization
            assert not peer.release.is_set(), "primary and secondary did not overlap"
            assert len(peer.requests) == 1 and peer.requests[0]["model"] == "root-model", peer.requests
            assert peer.requests[0].get("tools"), "primary and secondary tool policies were not distinct"
            # Each Talaria action reconnects with a fresh ticket; the wrong profile cannot read the row.
            wrong = await call(home, alpha_id, "snapshot")
            assert wrong["state"] == "refused", wrong
            try:
                _session_ticket(alpha, replace(discovered.endpoint, control_home=str(alpha)))
            except (OSError, GatewayClientError, DiscoveryError):
                pass
            else:
                raise AssertionError("a wrong control home minted a ticket")
            peer.release.set()
            primary = await settled(home, root_id)
            assert "ALPHA_ONLY" not in json.dumps(primary["messages"]), primary
            assert set(peer.authorization) == {"Bearer loopback-only"}, peer.authorization
            proc.kill()
            proc.wait(timeout=10)
            with daemon(agent, home, env, barrier=False):
                successor = discover_gateway_endpoint(alpha)
                assert successor.state == "ready" and successor.endpoint.instance_id != discovered.endpoint.instance_id, successor
                try:
                    _session_ticket(alpha, discovered.endpoint)
                except (GatewayClientError, DiscoveryError):
                    pass
                else:
                    raise AssertionError("a successor accepted a stale owner identity")
                restored = await call(alpha, alpha_id, "snapshot")
                assert restored["state"] == "attached", restored
                assert restored["snapshot"]["info"]["model"] == "alpha-picked", restored
                assert restored["snapshot"]["info"]["cwd"] == str(workspace), restored
                resumed = await call(alpha, alpha_id, "submit", request_id="after-replacement", text="ALPHA_AFTER_RESTART")
                assert resumed["state"] == "attached", resumed
                final = await settled(alpha, alpha_id)
                assert "ALPHA_AFTER_RESTART" in json.dumps(final["messages"]), final
                assert "BLOCK_STARTED" not in json.dumps(final["messages"]), final
                assert all(r["model"] == "alpha-picked" and not r.get("tools") for r in peer.secondary.requests)
                assert set(peer.secondary.authorization) == {"Bearer alpha-only"}, peer.secondary.authorization
            print(json.dumps({"served_profile": True, "profile_bound_model_key_workspace": True,
                              "primary_concurrent": True, "reconnect": True, "replacement": True}))
    finally:
        peer.release.set()
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
                                SimpleNamespace(endpoint=endpoint, state="ready"))
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
                                home, SimpleNamespace(endpoint=endpoint, state="ready"))
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


class DetailModel(Model):
    """A loopback model that reasons, delegates one child, then answers."""
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.requests.append(body)
        messages = body.get('messages', [])
        prompt = next((m.get('content', '') for m in reversed(messages) if m['role'] == 'user'), '')
        delegate = prompt == 'NATIVE_DETAIL' and not any(m['role'] == 'tool' for m in messages)
        message = {'role': 'assistant', 'content': None if delegate else 'Owner detail complete.',
                   'reasoning_content': '**Inspecting the task**\nCheck the supplied facts.'}
        if delegate:
            message['tool_calls'] = [{'id': 'detail-delegate', 'type': 'function', 'function': {
                'name': 'delegate_task', 'arguments': json.dumps({'goal': 'Inspect the supplied facts', 'toolsets': []})}}]
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream' if body.get('stream') else 'application/json')
        self.end_headers()
        if body.get('stream'):
            deltas = [{'role': 'assistant', 'reasoning_content': message['reasoning_content']}]
            if delegate:
                call = message['tool_calls'][0]
                deltas.append({'tool_calls': [{'index': 0, **call}]})
            else:
                deltas.append({'content': message['content']})
            for delta in deltas:
                self.wfile.write(('data: ' + json.dumps({'id': 'detail', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]}) + '\n\n').encode())
                self.wfile.flush()
            payload = 'data: ' + json.dumps({'id': 'detail', 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls' if delegate else 'stop'}],
                'usage': {'prompt_tokens': 20, 'completion_tokens': 10, 'total_tokens': 30}}) + '\n\ndata: [DONE]\n\n'
        else:
            payload = json.dumps({'id': 'detail', 'choices': [{'index': 0, 'message': message, 'finish_reason': 'tool_calls' if delegate else 'stop'}],
                'usage': {'prompt_tokens': 20, 'completion_tokens': 10, 'total_tokens': 30}})
        self.wfile.write(payload.encode())
        self.wfile.flush()


async def probe_detail(home, peer, desc):
    viewer = SidecarProcess(home)
    try:
        async with websocket(home, desc) as native:
            created = await rpc(native, 'session.create', request_id='detail-create', source='cli', toolsets=['delegation'])
            sid = created['result']['session_id']
            # Recording can enable the native flag independently of Talaria's pre-fix adapter.
            if os.environ.get('TALARIA_RECORD_OWNER_EVENTS'):
                assert 'result' in await rpc(native, 'config.set', session_id=sid, key='show_reasoning', value='1')
            watch = viewer.request('gateway.session', {'profile_home': str(home), 'session_id': sid, 'action': 'watch', 'show_reasoning': True})
            first = await asyncio.to_thread(viewer.next_message, 20)
            assert first['params']['event'] == 'snapshot', first
            submitted = await rpc(native, 'prompt.submit', session_id=sid, submission_id='detail-input', text='NATIVE_DETAIL')
            assert 'result' in submitted, submitted
            events = []
            ran = False
            async with asyncio.timeout(75):
                while True:
                    frame = await asyncio.to_thread(viewer.next_message, 20)
                    assert frame.get('method') == 'stream', frame
                    event = frame['params'].get('data', {})
                    if frame['params']['event'] != 'event':
                        continue
                    events.append(event)
                    ran = ran or event.get('payload', {}).get('running') is True
                    if ran and event.get('type') == 'session.info' and event.get('payload', {}).get('running') is False:
                        break
            kinds = [e['type'] for e in events]
            if os.environ.get('TALARIA_RECORD_OWNER_EVENTS'):
                Path(os.environ['TALARIA_RECORD_OWNER_EVENTS']).write_text(json.dumps({'release': 'v0.22.3',
                    'revision': '5b147ab036d6d19131bff8d20701b5001eab844a', 'events': events}, indent=2) + '\n')
            assert 'reasoning.delta' in kinds, kinds
            assert kinds.index('reasoning.delta') < kinds.index('message.delta'), kinds
            assert 'subagent.start' in kinds and 'subagent.complete' in kinds, kinds
            assert 'session.usage' in kinds and 'message.complete' in kinds, kinds
            viewer.request('rpc.cancel', {'id': watch})
            print(json.dumps({'live_reasoning': True, 'subagent_progress': True, 'usage': True, 'events': kinds}))
    finally:
        viewer.close()


class BatchPeer(BaseHTTPRequestHandler):
    """The clarify tool's two-question batch, then a final answer once both were answered."""
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        messages = body.get("messages", [])
        self.server.requests.append(messages)
        asking = bool(messages) and not any(m["role"] == "tool" for m in messages)
        message = {"role": "assistant", "content": "CLARIFY_FINISHED"}
        if asking:
            message = {"role": "assistant", "content": None, "tool_calls": [{"index": 0, "id": "owned-batch", "type": "function",
                "function": {"name": "clarify", "arguments": json.dumps({"questions": [
                    {"question": "Pick a color", "choices": ["blue", "green"]}, {"question": "Pick a size"}]})}}]}
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for delta, finish in [(message, None), ({}, "tool_calls" if asking else "stop")]:
            frame = {"id": "batch", "object": "chat.completion.chunk", "created": 1, "model": "batch",
                     "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            self.wfile.write(("data: " + json.dumps(frame) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def main():
    home = Path(os.environ["HERMES_HOME"])
    home.mkdir(mode=0o700, exist_ok=True)
    mode = sys.argv[1] if len(sys.argv) > 1 else "shared"
    from authority_clarify_peer import ModelPeer as ClarifyPeer
    from authority_controls_peer import ModelPeer as ApprovalPeer
    handler = {"detail": DetailModel, "approval": ApprovalPeer, "restart": ApprovalPeer, "batch": BatchPeer, "clarify": ClarifyPeer}.get(mode, Model)
    if mode == "profiles":
        class ProfileModel(Model):
            def do_POST(self):
                self.server.authorization.append(self.headers.get("Authorization"))
                super().do_POST()
        handler = ProfileModel
    peer = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    peer.authorization = []
    secondary = None
    if mode in {"approval", "restart"}:
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
        if mode == "profiles":
            secondary = ThreadingHTTPServer(("127.0.0.1", 0), ProfileModel)
            secondary.authorization, secondary.requests = [], []
            secondary.blocked, secondary.release = threading.Event(), threading.Event()
            secondary.release.set()
            threading.Thread(target=secondary.serve_forever, daemon=True).start()
            peer.secondary = secondary
            alpha_config["model"]["base_url"] = f"http://127.0.0.1:{secondary.server_port}/v1"
        alpha_config["gateway"] = {"multiplex_profiles": False, "standalone": mode == "dedicated"}
        (alpha / "config.yaml").write_text(json.dumps(alpha_config))
        alpha_url = alpha_config["model"]["base_url"]
        (alpha / ".env").write_text(f"OPENAI_API_KEY=alpha-only\nOPENAI_BASE_URL={alpha_url}\n")
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
        with daemon(agent, home, env, barrier=mode == "replay", fixture=str(Path(__file__).with_name("gateway_replay_daemon.py"))) as (proc, desc):
            if mode == "queued-controls":
                asyncio.run(probe_queued_controls(home, peer, desc))
            elif mode == "detail":
                asyncio.run(probe_detail(home, peer, desc))
            elif mode == "restart":
                asyncio.run(probe_restart(home, peer, desc, proc))
            elif mode == "model":
                asyncio.run(probe_model(home, peer, desc))
            elif mode == "voice-stop":
                asyncio.run(probe_voice_stop(home, peer, desc))
            elif mode == "profiles":
                asyncio.run(probe_profiles(home, peer, desc, proc, env))
            elif mode in {"approval", "clarify"}:
                asyncio.run(probe_control(home, peer, desc, mode))
            else:
                asyncio.run(probe_batch(home, peer, desc) if mode == "batch" else probe(home, peer, desc, require_gap=mode == "replay"))
    finally:
        peer.release.set()
        peer.shutdown()
        peer.server_close()
        if secondary is not None:
            secondary.shutdown()
            secondary.server_close()


if __name__ == "__main__":
    main()
