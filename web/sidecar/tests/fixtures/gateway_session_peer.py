"""Two real viewers and an ordinary disposable daemon on a held loopback provider.

Usage: gateway_session_peer.py MODE [MODE...]. Several modes run in order on one owner, each on its own sessions; a
mode in OWN_OWNER needs owner state of its own and runs alone. With --serve, one owner runs each mode named on a line
of stdin and answers with that mode's MODES line, so tests share its boot and first-turn warmup (TAL-1780, TAL-2493).
"""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import queue
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback

STARTED = time.monotonic()
agent = Path(os.environ["TALARIA_WEB_AGENT_DIR"])
sys.path[:0] = [str(agent), str(agent / "tests/gateway/fixtures"), str(Path(__file__).resolve().parents[1])]
from peer_phases import POLL_SECONDS, Phases, report_modes

# A watch's injected idle reaction poll: the production 10 s interval is pinned by the fast watch tests.
REACTION_POLL_S = .5
OWN_OWNER = {"recovery", "secure", "dedicated", "profiles", "replay", "restart", "reasoning", "reasoning-restart", "session-open"}
# Longest the owner holds a claimed turn on a pending open (the Agent's _UNBOUNDED_TURN_WAIT_S).
OPEN_TURN_WAIT_S = 5
# A profile plugin logging each on_session_open delivery; it holds the delivery past OPEN_TURN_WAIT_S while the .slow
# marker exists. Each line keeps its start time, so a barrier open can tell later deliveries from earlier ones.
OPEN_COUNTER = """import json
import time
from pathlib import Path


def register(ctx):
    def opened(**kw):
        from hermes_constants import get_hermes_home
        log = Path(get_hermes_home()) / "opens.jsonl"
        row = dict(kw, started=time.time())
        with open(log, "a") as out:
            out.write(json.dumps(dict(row, phase="start")) + "\\n")
        if log.with_suffix(".slow").exists():
            time.sleep(%d)
        with open(log, "a") as out:
            out.write(json.dumps(dict(row, phase="done")) + "\\n")
    ctx.register_hook("on_session_open", opened)
""" % (OPEN_TURN_WAIT_S + 2)


def unsupported(mode):
    """Why this Agent release cannot run a mode, or None. Read from its source: nothing here imports the release yet."""
    if mode == "session-open" and not (agent / "gateway/session_open.py").exists():
        return "this supported Agent has no on_session_open hook"
    if mode == "bridge" and not (sys.platform.startswith("linux") and hasattr(socket, "SO_PEERCRED")):
        return "the private session bridge needs Linux peer credentials"
    return None


SERVE = sys.argv[1:] == ["--serve"]
REQUESTED = [] if SERVE else sys.argv[1:] or ["shared"]
SKIPPED = {mode: reason for mode in REQUESTED if (reason := unsupported(mode))}
MODES = [mode for mode in REQUESTED if mode not in SKIPPED]
if not MODES and not SERVE:
    report_modes([], SKIPPED)
    sys.exit(0)
from agent.context_compressor import SUMMARY_PREFIX
from local_recovery_probe import Model, child_env, daemon as owner_daemon, rpc, websocket as owner_websocket
from authority_clarify_peer import ModelPeer as ClarifyPeer
from authority_controls_peer import ModelPeer as ApprovalPeer
from conftest import SidecarProcess

PHASES = Phases(STARTED)


def daemon(*args, **kwargs):
    return PHASES.daemon(owner_daemon, *args, **kwargs)


def websocket(home, desc):
    # A native socket nobody reads during a turn passes the default 16-frame limit and pauses its reader; its close
    # handshake then waits out the 10 s close timeout. The fixture owns this client, so it never pauses (TAL-1780).
    return owner_websocket(home, desc, max_queue=None)


async def drained(call, ceiling=40):
    """The session's snapshot once nothing is pending: the owner announces no drain to a sidecar reader, so this polls."""
    deadline = time.monotonic() + ceiling
    while True:
        final = await asyncio.to_thread(call, "snapshot")
        if final["snapshot"] and not final["snapshot"]["pending"]:
            return final
        assert time.monotonic() < deadline, final
        await asyncio.sleep(POLL_SECONDS)


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
            async def exports(expected):
                before = (await asyncio.to_thread(call, "snapshot"))["snapshot"]
                for fmt in ("json", "markdown", "html"):
                    value = await asyncio.to_thread(call, "export", format=fmt, redact=True)
                    assert value["state"] == "attached" and value["snapshot"] is None, value
                    exported = value["export"]
                    assert exported["format"] == fmt and bool(exported["content"]), value
                    if expected:
                        assert expected in exported["content"], exported
                    else:
                        assert "COMPRESSION_TAIL" not in exported["content"], exported
                    if fmt == "json":
                        assert isinstance(json.loads(exported["content"])["messages"], list)
                assert not (home / "sessions" / "saved").exists()
                after = (await asyncio.to_thread(call, "snapshot"))["snapshot"]
                for key in ("messages", "revision", "execution_generation", "pending"):
                    assert before[key] == after[key], (key, before, after)
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
            final = await drained(call)
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
            final = await drained(call)
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
            await exports("RECOVERY_ACK_COMPRESSION_TAIL")

            reset = await asyncio.to_thread(call, "mutate", request_id="reset-stable", expected_revision=compressed["snapshot"]["revision"],
                execution_generation=compressed["snapshot"]["execution_generation"], operation="reset", payload={})
            assert reset["state"] == "attached" and reset["snapshot"]["session_id"] == sid, reset
            assert reset["snapshot"]["messages"] == [], reset
            await exports(None)
            retained = await asyncio.to_thread(call, "receipt", admission_id=first["receipt"]["admission_id"])
            assert retained["receipt"]["admission_id"] == first["receipt"]["admission_id"] and retained["receipt"]["status"] == "terminal"
            print(json.dumps({"same_owner": True, "deduplicated": True, "detached_running": True, "model_requests": len(peer.requests)}))
    finally:
        peer.release.set()
        sidecar.close()
        viewer.close()


async def probe_reactions(home, peer, desc):
    """message.react on the actual owner and SessionDB: persistence, toggle and removal, a foreign session's refusal,
    another native viewer's reaction kept, the compression tip resolved through its logical owner and reset retiring
    the row."""
    sidecar = SidecarProcess(home)
    try:
        async with websocket(home, desc) as native:
            created = await rpc(native, "session.create", request_id="reaction-create", source="cli", toolsets=[])
            sid = created["result"]["session_id"]
            def call(action, **params):
                return sidecar.result("gateway.session", {"profile_home": str(home), "session_id": sid, "action": action, **params})
            # A third exchange leaves a compressible head while retaining a complete recent turn.
            for text in ("REACTION_HEAD", "REACTION_MIDDLE", "REACTION_TAIL"):
                await asyncio.to_thread(call, "submit", request_id="reaction-" + text, text=text)
                final = await drained(call)
            # Every supported release lists message-reactions-v1 in agent_support.json.
            assert final["snapshot"].get("reactions_supported") is True, final
            reaction_row = final["snapshot"]["messages"][-1]["row_id"]
            async def react(emoji, expected):
                value = await asyncio.to_thread(call, "react", row_id=reaction_row, emoji=emoji)
                assert value["state"] == "attached", value
                row = next(r for r in value["snapshot"]["messages"] if r["row_id"] == reaction_row)
                assert row["reactions"] == expected, row
            await react("👍", [{"author": "user", "emoji": "👍"}])
            await react("👍", [])
            await react("❤️", [{"author": "user", "emoji": "❤️"}])
            await react(None, [])
            foreign = (await rpc(native, "session.create", request_id="reaction-foreign", source="cli", toolsets=[]))["result"]["session_id"]
            refused = await rpc(native, "message.react", session_id=foreign, row_id=reaction_row, emoji="👍", author="user")
            assert "error" in refused, refused
            changed = await rpc(native, "message.react", session_id=sid, row_id=reaction_row, emoji="🎉", author="agent")
            assert "result" in changed, changed
            restored = await asyncio.to_thread(call, "snapshot")
            assert any(r.get("reactions") == [{"author": "agent", "emoji": "🎉"}] for r in restored["snapshot"]["messages"]), restored
            compressed = await asyncio.to_thread(call, "mutate", request_id="reaction-compress", expected_revision=restored["snapshot"]["revision"],
                execution_generation=restored["snapshot"]["execution_generation"], operation="compress", payload={})
            assert compressed["state"] == "attached" and compressed["snapshot"]["revision"] > restored["snapshot"]["revision"], compressed
            # Resolve the physical compression tip through the logical owner, never the old stored id.
            current_row = compressed["snapshot"]["messages"][-1]
            if reaction_row not in {r.get("row_id") for r in compressed["snapshot"]["messages"]}:
                retired = await asyncio.to_thread(call, "react", row_id=reaction_row, emoji="👍")
                assert retired["state"] == "refused", retired
            reaction_row = current_row["row_id"]
            value = await asyncio.to_thread(call, "react", row_id=reaction_row, emoji="👍")
            assert value["state"] == "attached", value
            expected = [r for r in current_row["reactions"] if r["author"] != "user"] + [{"author": "user", "emoji": "👍"}]
            assert next(r for r in value["snapshot"]["messages"] if r["row_id"] == reaction_row)["reactions"] == expected
            reset = await asyncio.to_thread(call, "mutate", request_id="reaction-reset", expected_revision=value["snapshot"]["revision"],
                execution_generation=value["snapshot"]["execution_generation"], operation="reset", payload={})
            assert reset["state"] == "attached" and reset["snapshot"]["messages"] == [], reset
            retired = await asyncio.to_thread(call, "react", row_id=reaction_row, emoji="👍")
            assert retired["state"] == "refused", retired
    finally:
        sidecar.close()


async def probe_images(home, peer, desc):
    """TAL-1344: Web's submit stages images through image.attach_bytes on the actual owner. The admission commits
    their digests; a lost-ACK retry restages the same bytes and reconciles to that admission, changed bytes under the
    same identity are refused, and no staged path reaches the sidecar's result."""
    import base64
    import sqlite3
    png = base64.b64encode(bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
                                         "0000000d49444154789c6360f8cfc0f01f0005000201a5e2c3a30000000049454e44ae426082")).decode()
    sidecar = SidecarProcess(home)
    try:
        async with websocket(home, desc) as native:
            sid = (await rpc(native, "session.create", request_id="images-create", source="cli", toolsets=[]))["result"]["session_id"]
            def call(action, **params):
                return sidecar.result("gateway.session", {"profile_home": str(home), "session_id": sid, "action": action, **params})
            before = await asyncio.to_thread(call, "snapshot")
            # Every supported release lists image-attach-v1 in agent_support.json.
            assert before["snapshot"]["image_attachments"] is True, before
            submit = dict(request_id="images-input", text="IMAGE_TURN", authority_epoch=before["snapshot"]["authority_epoch"],
                          images=[{"data_base64": png, "ext": "png"}])
            first = await asyncio.to_thread(call, "submit", **submit)
            assert first["state"] == "attached" and first["receipt"]["admission_id"], first
            retry = await asyncio.to_thread(call, "submit", **submit)
            assert retry["receipt"]["admission_id"] == first["receipt"]["admission_id"], retry
            # A failed restaging reconciles through the owner's own ledger: this identity, and no other, is admitted.
            from talaria_sidecar.methods.gateway_sessions import _admission_for
            assert _admission_for(home, sid, "images-input") == first["receipt"]["admission_id"]
            assert _admission_for(home, sid, "never-sent") is None
            changed = await asyncio.to_thread(call, "submit", **{**submit, "images": [{"data_base64": png[:-8] + "AAAAAA==", "ext": "png"}]})
            assert (changed["state"], changed["receipt"]) == ("refused", None), changed
            await drained(call)
            with sqlite3.connect(home / "state.db") as db:
                rows = db.execute("SELECT payload_json FROM session_admissions WHERE target_session_id=?", (sid,)).fetchall()
            assert len(rows) == 1, rows
            committed = json.loads(rows[0][0])["attachments_v1"]
            assert committed["media_types"] == ["image/png"], committed
            for result in (first, retry, changed):
                assert "cache/images" not in json.dumps(result), result
    finally:
        sidecar.close()


async def probe_reaction_watch(home, peer, desc):
    """Another native viewer's reaction reaches a watching Web viewer and survives the watch's cancel. The owner emits
    no event for it, so the watch reads it on its idle poll, injected here as REACTION_POLL_S (TAL-2526)."""
    sidecar = SidecarProcess(home)
    viewer = SidecarProcess(home)
    try:
        async with websocket(home, desc) as native:
            created = await rpc(native, "session.create", request_id="reaction-watch-create", source="cli", toolsets=[])
            sid = created["result"]["session_id"]
            def call(action, **params):
                return sidecar.result("gateway.session", {"profile_home": str(home), "session_id": sid, "action": action, **params})
            await asyncio.to_thread(call, "submit", request_id="reaction-watch-turn", text="REACTION_WATCH")
            final = await drained(call)
            assert final["snapshot"].get("reactions_supported") is True, final
            reaction_row = final["snapshot"]["messages"][-1]["row_id"]
            reaction_watch = viewer.request("gateway.session", {"profile_home": str(home), "session_id": sid, "action": "watch",
                                                                "reaction_poll_seconds": REACTION_POLL_S})
            frame = await asyncio.to_thread(viewer.next_message, 20)
            assert frame["params"]["event"] == "snapshot", frame
            changed = await rpc(native, "message.react", session_id=sid, row_id=reaction_row, emoji="🎉", author="agent")
            assert "result" in changed, changed
            deadline, frames = time.monotonic() + 20, []
            while True:
                try:
                    frame = await asyncio.to_thread(viewer.next_message, max(0, deadline - time.monotonic()))
                except queue.Empty:
                    raise AssertionError(f"no watch frame carried another viewer's reaction: {frames[-5:]}") from None
                frames.append(frame)
                data = frame.get("params", {}).get("data", {})
                if frame.get("params", {}).get("event") == "snapshot" and any(r.get("reactions") == [{"author": "agent", "emoji": "🎉"}] for r in data["snapshot"]["messages"]):
                    break
            viewer.request("rpc.cancel", {"id": reaction_watch})
            while (await asyncio.to_thread(viewer.next_message, 20)).get("id") != reaction_watch:
                pass
            restored = await asyncio.to_thread(call, "snapshot")
            assert any(r.get("reactions") == [{"author": "agent", "emoji": "🎉"}] for r in restored["snapshot"]["messages"]), restored
    finally:
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
            final = await drained(call)
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


async def probe_work(home, peer, desc):
    """TAL-1336: the owner's session-scoped process and subagent verbs, as Web calls them, against the installed owner.
    A row the owner does not hold is its own verdict, never a success."""
    sidecar = SidecarProcess(home)
    try:
        async with websocket(home, desc) as native:
            created = await rpc(native, "session.create", request_id="work-create", source="cli", toolsets=[])
            sid = created["result"]["session_id"]
            def call(action, **params):
                return sidecar.result("gateway.session", {"profile_home": str(home), "session_id": sid, "action": action, **params})
            # Make the session live on its owner; an ancillary read never adopts a cold session itself.
            assert (await asyncio.to_thread(call, "snapshot"))["state"] == "attached"
            listed = await asyncio.to_thread(call, "work_list")
            assert listed["state"] == "attached" and listed["work"]["processes"] == [] and listed["work"]["subagents"] == [], listed
            epoch = listed["work"]["authority_epoch"]
            stop = await asyncio.to_thread(call, "work_stop", work_kind="process", work_id="proc_absent", authority_epoch=epoch)
            interrupt = await asyncio.to_thread(call, "work_stop", work_kind="subagent", work_id="sa-absent", authority_epoch=epoch)
            steer = await asyncio.to_thread(call, "work_steer", work_kind="subagent", work_id="sa-absent", authority_epoch=epoch, text="Look")
            tail = await asyncio.to_thread(call, "work_tail", work_kind="subagent", work_id="sa-absent", authority_epoch=epoch)
            assert (stop["work_outcome"], interrupt["work_outcome"], steer["work_outcome"]) == ("not_found", "not_found", "rejected"), (stop, interrupt, steer)
            assert tail["work_tail"]["available"] is False, tail
    finally:
        sidecar.close()


async def probe_complete(home, peer, desc):
    """TAL-1342: Web's path completion reaches the installed owner's complete.path, rooted in the session's own frozen
    workspace: a partial segment, a name with spaces and Unicode, and a directory that does not exist there."""
    sidecar = SidecarProcess(home)
    workspace = Path(tempfile.mkdtemp(prefix="complete-ws-"))
    (workspace / "src").mkdir()
    (workspace / "src" / "main.py").write_text("")
    (workspace / "notes été.md").write_text("")
    try:
        async with websocket(home, desc) as native:
            created = await rpc(native, "session.create", request_id="complete-create", source="cli", toolsets=[], cwd=str(workspace))
            sid = created["result"]["session_id"]
            def call(word):
                return sidecar.result("gateway.session", {"profile_home": str(home), "session_id": sid, "action": "complete_path", "word": word})
            assert (await asyncio.to_thread(sidecar.result, "gateway.session",
                                            {"profile_home": str(home), "session_id": sid, "action": "snapshot"}))["state"] == "attached"
            texts = lambda result: [item["text"] for item in result["completion"]["items"]]
            nested = await asyncio.to_thread(call, "src/ma")
            assert nested["state"] == "attached" and texts(nested) == ["src/main.py"], nested
            spaced = await asyncio.to_thread(call, "@file:not")
            assert "@file:notes été.md" in texts(spaced), spaced
            missing = await asyncio.to_thread(call, "absent/")
            assert missing["completion"]["items"] == [], missing
    finally:
        sidecar.close()


async def probe_commands(home, peer, desc):
    """TAL-1338: a registered quick command and /refine run on the owner for their session, in that session's workspace,
    as Web dispatches them; a stale fence or an unregistered name is the owner's refusal, and nothing runs locally."""
    sidecar = SidecarProcess(home)
    workspace = home / "commands-workspace"
    workspace.mkdir(exist_ok=True)
    try:
        async with websocket(home, desc) as native:
            created = await rpc(native, "session.create", request_id="commands-create", source="cli", toolsets=[], cwd=str(workspace))
            sid = created["result"]["session_id"]
            def call(action, **params):
                return sidecar.result("gateway.session", {"profile_home": str(home), "session_id": sid, "action": action, **params})
            snap = (await asyncio.to_thread(call, "snapshot"))["snapshot"]
            fence = {"authority_epoch": snap["authority_epoch"], "replay_epoch": snap["replay_epoch"]}
            catalog = await asyncio.to_thread(call, "command_catalog")
            assert {"name": "where", "description": "exec: pwd"} in catalog["quick_commands"], catalog
            ran = await asyncio.to_thread(call, "command_dispatch", name="where", arg="", **fence)
            assert ran["command_result"]["kind"] == "output" and str(workspace.resolve()) in ran["command_result"]["output"], ran
            # A cold session with an empty transcript: the owner's own answer, no review and no local Agent.
            empty = await asyncio.to_thread(call, "command_dispatch", name="refine", arg="", **fence)
            assert empty["command_result"] == {"kind": "output", "output": "Nothing to refine yet — send a message first."}, empty
            stale = await asyncio.to_thread(call, "command_dispatch", name="where", arg="", **dict(fence, authority_epoch=fence["authority_epoch"] + 1))
            assert (stale["state"], stale["reason"]) == ("refused", "owner_changed"), stale
            unknown = await asyncio.to_thread(call, "command_dispatch", name="nosuchcommand", arg="", **fence)
            assert (unknown["state"], unknown["reason"]) == ("refused", "unsupported_command"), unknown
            assert not peer.requests, "no command reached the model"
    finally:
        sidecar.close()


SIDECAR = Path(__file__).resolve().parents[2]


def start_bridge(home, path):
    """The Gateway-side helper as an operator runs it: the owner's Agent interpreter, its home, one allowed profile."""
    env = dict(child_env(), HOME=os.environ["HOME"], HERMES_HOME=str(home), PYTHONPATH=f"{SIDECAR}:{agent}")
    helper = subprocess.Popen([sys.executable, "-m", "talaria_sidecar.gateway_bridge", "--socket", str(path), "--home", str(home),
                               "--profile", "default"], cwd=SIDECAR, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    lines = queue.Queue()
    threading.Thread(target=lambda: [*map(lines.put, helper.stdout), lines.put(None)], daemon=True).start()
    assert lines.get(timeout=20) == "gateway session bridge listening\n", "the helper did not start"
    return helper


async def probe_bridge(home, peer, desc):
    """TAL-1977: a Web sidecar whose home is another path, with no owner it can reach, attaches to the canonical owner
    only through the helper's private socket; durable admission, fences and the owner outlive the helper. The socket
    boundary itself, including an owner that does not hold Web's store, is test_gateway_bridge.py's."""
    home = home.resolve()
    private = Path(tempfile.mkdtemp(prefix="bridge-")).resolve()
    path = private / "session.sock"
    web = Path(tempfile.mkdtemp(prefix="web-")).resolve() / "home"
    web.mkdir(mode=0o700)
    # Both mounts of one profile: the Web side reads the owner's store under its own path.
    (web / "state.db").symlink_to(home / "state.db")
    configured = json.dumps({"talaria": {"gateway_session_socket": str(path)}})
    async with websocket(home, desc) as native:
        sid = (await rpc(native, "session.create", request_id="bridge-create", source="cli", toolsets=[]))["result"]["session_id"]
    sidecar, helper = SidecarProcess(web), None
    def call(action, **params):
        return sidecar.result("gateway.session", {"profile_home": str(web), "session_id": sid, "action": action, **params})
    try:
        # Unconfigured, the Web namespace keeps today's refusal: it has no owner of its own to discover.
        assert (await asyncio.to_thread(call, "snapshot"))["state"] == "stopped"
        (web / "config.yaml").write_text(configured)
        absent = await asyncio.to_thread(call, "snapshot")
        assert (absent["state"], absent["reason"]) == ("unavailable", "bridge_socket_missing"), absent
        helper = start_bridge(home, path)
        assert oct(path.lstat().st_mode & 0o777) == oct(0o600)
        attached = await asyncio.to_thread(call, "snapshot")
        assert attached["state"] == "attached" and attached["snapshot"]["session_id"] == sid, attached
        first = await asyncio.to_thread(call, "submit", request_id="bridge-lost-ack", text="BLOCK_STARTED")
        assert first["state"] == "attached" and first["receipt"]["admission_id"], first
        assert await asyncio.to_thread(peer.blocked.wait, 25), "the bridged turn did not reach the provider"
        running = await asyncio.to_thread(call, "snapshot")
        stale = await asyncio.to_thread(call, "interrupt", execution_generation=running["snapshot"]["execution_generation"] - 1)
        assert (stale["state"], stale["reason"]) == ("refused", "stale_generation"), stale
        # Helper shutdown detaches; it removes its own socket and never stops the owner's turn.
        helper.terminate()
        assert helper.wait(10) == 0
        assert not os.path.lexists(path)
        gone = await asyncio.to_thread(call, "snapshot")
        assert (gone["state"], gone["reason"]) == ("unavailable", "bridge_socket_missing"), gone
        async with websocket(home, desc) as native:
            assert (await rpc(native, "session.resume", session_id=sid))["result"]["running"] is True
        helper = start_bridge(home, path)
        # The ACK the caller lost is recovered under the same durable submission, never admitted again.
        again = await asyncio.to_thread(call, "submit", request_id="bridge-lost-ack", text="BLOCK_STARTED")
        assert again["receipt"]["admission_id"] == first["receipt"]["admission_id"], (first, again)
        peer.release.set()
        final = await drained(call)
        assert json.dumps(final["snapshot"]["messages"]).count("RECOVERY_ACK_BLOCK_STARTED") == 1, final
        assert [m["content"] for body in peer.requests for m in body["messages"][-1:]] == ["BLOCK_STARTED"], peer.requests
        receipt = await asyncio.to_thread(call, "receipt", admission_id=first["receipt"]["admission_id"])
        assert receipt["receipt"]["status"] == "terminal", receipt
    finally:
        peer.release.set()
        sidecar.close()
        if helper is not None and helper.poll() is None:
            helper.terminate()
            helper.wait(10)


async def probe_transcript(home, peer, desc):
    """TAL-2072: a rotated owner chat's stored read, both ways across its compression lineage, with the handoff as a row.
    An owner without the read refuses it unsent."""
    sidecar = SidecarProcess(home)
    try:
        async with websocket(home, desc) as native:
            sid = (await rpc(native, "session.create", request_id="transcript-create", source="cli", toolsets=[]))["result"]["session_id"]
        def call(action, **params):
            return sidecar.result("gateway.session", {"profile_home": str(home), "session_id": sid, "action": action, **params})
        if not (agent / "gateway/session_stored_reads.py").exists():
            refused = await asyncio.to_thread(call, "transcript", order="oldest", limit=10)
            assert (refused["state"], refused["reason"]) == ("incompatible", "owner_transcript_unsupported"), refused
            return
        for text in ("TRANSCRIPT_HEAD", "TRANSCRIPT_MIDDLE", "TRANSCRIPT_TAIL"):
            await asyncio.to_thread(call, "submit", request_id="transcript-" + text, text=text)
            final = await drained(call)
        compressed = await asyncio.to_thread(call, "mutate", request_id="transcript-compress", expected_revision=final["snapshot"]["revision"],
            execution_generation=final["snapshot"]["execution_generation"], operation="compress", payload={})
        assert compressed["state"] == "attached", compressed
        await asyncio.to_thread(call, "submit", request_id="transcript-after", text="TRANSCRIPT_AFTER")
        await drained(call)
        assert (await asyncio.to_thread(call, "snapshot"))["snapshot"].get("transcripts") is True

        async def pages(order):
            rows, cursor = [], None
            while True:
                page = (await asyncio.to_thread(call, "transcript", order=order, limit=2, **({"cursor": cursor} if cursor else {})))["transcript"]
                assert page is not None and len(page["rows"]) <= 2 + 1, page  # a tool result may ride with its call
                if not page["rows"]:
                    return rows
                rows = rows + page["rows"] if order == "oldest" else page["rows"] + rows
                cursor = page["next_cursor"]
                if cursor is None:
                    return rows
        oldest, latest = await pages("oldest"), await pages("latest")
        assert oldest == latest, (oldest, latest)
        texts = [row.get("text") for row in oldest if row.get("row_kind") == "message" and row.get("role") == "user"]
        # The head precedes the rotation, so a resume past the cap would not show it; the read pages the whole lineage.
        assert texts == ["TRANSCRIPT_HEAD", "TRANSCRIPT_MIDDLE", "TRANSCRIPT_TAIL", "TRANSCRIPT_AFTER"], oldest
        handoffs = [row for row in oldest if row.get("row_kind") == "compaction"]
        assert len(handoffs) == 1 and handoffs[0]["text"] and handoffs[0]["row_id"] > 0, oldest
        assert "gateway_input_owner" not in json.dumps(oldest) and "display_metadata" not in json.dumps(oldest)
    finally:
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
                assert frame.get("id") != model_watch, f"the watch ended before the pick landed: {frame}"
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


class ReasoningChat:
    """One native chat's reasoning level, read and changed through a real sidecar."""

    def __init__(self, home, sidecar, sid):
        self.home, self.sidecar, self.sid = home, sidecar, sid

    def profile_level(self, level):
        config = json.loads((self.home / "config.yaml").read_text())
        (self.home / "config.yaml").write_text(json.dumps({**config, "agent": {"reasoning_effort": level}}))

    def call(self, action, **params):
        return self.sidecar.result("gateway.session", {"profile_home": str(self.home), "session_id": self.sid, "action": action, **params})

    def current(self):
        result = self.call("snapshot")
        assert result["state"] == "attached", result
        return result["snapshot"]

    def mutate(self, request, operation, payload):
        snap = self.current()
        return self.call("mutate", request_id=request, expected_revision=snap["revision"], execution_generation=snap["execution_generation"],
                         operation=operation, payload=payload)

    def level(self):
        return self.current()["info"].get("reasoning_effort")

    async def settles_on(self, expected):
        deadline = time.monotonic() + 30
        while (found := await asyncio.to_thread(self.level)) != expected:
            assert time.monotonic() < deadline, (expected, found)
            await asyncio.sleep(POLL_SECONDS)


async def reasoning_chat(home, desc, sidecar, request_id):
    async with websocket(home, desc) as native:
        created = await rpc(native, "session.create", request_id=request_id, source="cli", toolsets=[])
    return ReasoningChat(home, sidecar, created["result"]["session_id"])


async def probe_reasoning(home, peer, desc):
    """One chat's own level on a real owner: it follows the profile until picked, a pick holds through a profile edit, a
    busy pick waits for the turn, a stale fence changes nothing, a reset follows the profile again, and a model pick
    carries its level."""
    sidecar = SidecarProcess(home)
    try:
        chat = await reasoning_chat(home, desc, sidecar, "reasoning-create")
        call, current, mutate, level, profile_level, settles_on = chat.call, chat.current, chat.mutate, chat.level, chat.profile_level, chat.settles_on
        profile_level("low")
        await settles_on("low")
        profile_level("medium")
        await settles_on("medium")

        stale = current()
        picked = await asyncio.to_thread(mutate, "reasoning-set", "reasoning", {"effort": "high"})
        assert picked["state"] == "attached" and picked["receipt"].get("status") is None, picked
        assert picked["snapshot"]["info"]["reasoning_effort"] == "high", picked
        refused = await asyncio.to_thread(call, "mutate", request_id="reasoning-stale", expected_revision=stale["revision"],
                                          execution_generation=stale["execution_generation"], operation="reasoning", payload={"effort": "low"})
        assert refused["state"] == "refused", refused
        assert await asyncio.to_thread(level) == "high"
        profile_level("low")
        assert await asyncio.to_thread(level) == "high"

        await asyncio.to_thread(call, "submit", request_id="reasoning-turn", text="BLOCK_STARTED")
        assert await asyncio.to_thread(peer.blocked.wait, 25)
        deferred = await asyncio.to_thread(mutate, "reasoning-busy", "reasoning", {"effort": "minimal"})
        assert deferred["receipt"]["status"] == "deferred" and deferred["receipt"]["effort"] == "minimal", deferred
        assert deferred["snapshot"]["info"]["reasoning_effort"] == "high", deferred
        peer.release.set()
        await settles_on("minimal")

        reset = await asyncio.to_thread(mutate, "reasoning-reset", "reasoning", {"effort": None})
        assert reset["state"] == "attached" and reset["snapshot"]["info"]["reasoning_effort"] == "low", reset
        profile_level("medium")
        await settles_on("medium")

        before = current()["revision"]
        combined = await asyncio.to_thread(mutate, "reasoning-combined", "model", {"model": "owner-fixture-picked", "provider": "custom", "reasoning": "high"})
        assert combined["receipt"]["operation"] == "model", combined
        assert (combined["snapshot"]["info"]["model"], combined["snapshot"]["info"]["reasoning_effort"]) == ("owner-fixture-picked", "high"), combined
        assert combined["snapshot"]["revision"] == before + 1, combined
    finally:
        peer.release.set()
        sidecar.close()


async def probe_reasoning_restart(home, peer, desc, proc, env):
    """A picked level outlives an owner restart and still ignores a profile edit; a reset then follows the profile."""
    sidecar = SidecarProcess(home)
    try:
        chat = await reasoning_chat(home, desc, sidecar, "reasoning-restart-create")
        chat.profile_level("medium")
        await chat.settles_on("medium")
        picked = await asyncio.to_thread(chat.mutate, "reasoning-set", "reasoning", {"effort": "high"})
        assert picked["state"] == "attached" and picked["snapshot"]["info"]["reasoning_effort"] == "high", picked
        proc.kill()
        proc.wait(timeout=10)
        with daemon(agent, home, env, barrier=False):
            chat.profile_level("low")
            assert await asyncio.to_thread(chat.level) == "high"
            await asyncio.to_thread(chat.mutate, "reasoning-reset-after-restart", "reasoning", {"effort": None})
            await chat.settles_on("low")
    finally:
        sidecar.close()


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
const env={...process.env,PYTHONPATH:a.web+'/sidecar',HERMES_HOME:a.home,TALARIA_WEB_STATE_DIR:a.home+'/webui',
  TALARIA_WEB_DEFAULT_WORKSPACE:a.home,TALARIA_WEB_CLAUDE_PROJECTS_DIR:a.home+'/claude',
  TALARIA_WEB_HOST:'127.0.0.1',TALARIA_WEB_PORT:'0'};
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


async def probe_control(home, peer, desc, kind, instruction=None):
    sidecar = SidecarProcess(home)
    try:
        async with websocket(home, desc) as native:
            created = await rpc(native, "session.create", request_id=kind + ("-told" if instruction else "") + "-create", source="cli",
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
                await asyncio.sleep(POLL_SECONDS)
            prompt = pending["result"]["prompts"][0]
            await native.close()
        params = {"profile_home": str(home), "session_id": sid}
        attached = await asyncio.to_thread(sidecar.result, "gateway.session", {**params, "action": "snapshot"})
        assert attached["state"] == "attached" and attached["snapshot"]["prompts"][0]["prompt_id"] == prompt["prompt_id"], attached
        response = {"choice": "once"} if kind == "approval" else {"text": "green"}
        if instruction:
            # TAL-1912: steer the turn parked on this approval, then deny it. The verdict comes back as the receipt.
            told = await asyncio.to_thread(sidecar.result, "gateway.session", {**params, "action": "steer",
                "execution_generation": prompt["execution_generation"], "text": instruction})
            assert told["state"] == "attached" and told["receipt"]["status"] == "queued", told
            response = {"choice": "deny"}
        answered = await asyncio.to_thread(sidecar.result, "gateway.session", {**params, "action": kind,
            "prompt_id": prompt["prompt_id"], "execution_generation": prompt["execution_generation"], **response})
        assert answered["state"] == "attached", answered
        while True:
            final = await asyncio.to_thread(sidecar.result, "gateway.session", {**params, "action": "snapshot"})
            if not final["snapshot"]["pending"]:
                break
            assert time.monotonic() < deadline, final
            await asyncio.sleep(POLL_SECONDS)
        assert kind.upper() + "_FINISHED" in json.dumps(final["snapshot"]["messages"]), final
        if instruction:
            assert (home / "owned-told" / "owned.txt").exists(), "a denied command must not run"
            assert instruction in json.dumps(peer.requests[-1]), peer.requests[-1]
        elif kind == "approval":
            assert not (home / "owned-removal").exists()
        else:
            assert any("green" in json.dumps(m) for messages in peer.requests for m in messages if m["role"] == "tool")
    finally:
        sidecar.close()


async def probe_session_open(home, peer, desc):
    """TAL-2054: only a viewer opening the chat is an open. Web's snapshot polls and controls reach the owner as
    reconnects, so a profile's on_session_open consumer sees the watch alone and a slow one never holds a Web turn."""
    log = home / "opens.jsonl"

    def delivered(since):
        rows = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        return [row["reason"] for row in rows if row["phase"] == "done" and row["started"] >= since]

    async def barrier(since):
        """A native viewer's own open. One session's deliveries run in order, so once a delivery that started after
        this open is done, every open before it has been delivered."""
        mark = time.time()
        async with websocket(home, desc) as native:
            assert "result" in await rpc(native, "session.resume", session_id=sid)
        deadline = time.monotonic() + 30
        while not delivered(mark):
            assert time.monotonic() < deadline, log.read_text()
            await asyncio.sleep(POLL_SECONDS)
        return delivered(since)

    sidecar, viewer = SidecarProcess(home), SidecarProcess(home)
    try:
        async with websocket(home, desc) as native:
            created = await rpc(native, "session.create", request_id="open-create", source="cli", toolsets=["terminal"])
            sid = created["result"]["session_id"]
        deadline = time.monotonic() + 30
        while delivered(0) != ["create"]:
            assert time.monotonic() < deadline, log.read_text() if log.exists() else "no on_session_open delivery"
            await asyncio.sleep(POLL_SECONDS)

        def call(action, **params):
            return sidecar.result("gateway.session", {"profile_home": str(home), "session_id": sid, "action": action, **params})
        # A poll then a submit, while the consumer holds each delivery past the turn's OPEN_TURN_WAIT_S bound.
        polled = time.time()
        log.with_suffix(".slow").touch()
        assert (await asyncio.to_thread(call, "snapshot"))["state"] == "attached"
        # TAL-2072: a history read is the owner's stored read, never an open.
        assert (await asyncio.to_thread(call, "transcript", order="latest", limit=50))["state"] == "attached"
        submitted = time.monotonic()
        assert (await asyncio.to_thread(call, "submit", request_id="open-turn", text="Run fixture control"))["state"] == "attached"
        while not any("Run fixture control" in json.dumps(request.get("messages")) for request in peer.requests):
            assert time.monotonic() - submitted < 25, "the submitted turn did not reach the provider"
            await asyncio.sleep(.05)
        reached = time.monotonic() - submitted
        # The owner logs each turn it released past its OPEN_TURN_WAIT_S hold on a pending open, and the consumer holds
        # every delivery longer than that. That record says whether the turn waited; its time to reach the provider
        # does not, because a loaded runner spends seconds building the turn itself (TAL-2281, TAL-2344).
        errors = home / "logs/errors.log"
        held = [line for line in (errors.read_text().splitlines() if errors.exists() else [])
                if f"on_session_open for {sid} still running" in line]
        assert not held, f"the submitted turn waited on an open ({reached:.1f} s to reach the provider): {held}"
        while not (parked := await asyncio.to_thread(call, "snapshot"))["snapshot"]["prompts"]:
            assert time.monotonic() - submitted < 30, parked
            await asyncio.sleep(POLL_SECONDS)
        log.with_suffix(".slow").unlink()
        opened = await barrier(polled)
        assert opened == ["resume"], f"Web's snapshot, transcript and submit were delivered as opens: {opened} (the last is the barrier); the turn waited {reached:.1f} s"

        # The watch is the viewer opening the chat; every control alongside it is not.
        watched = time.time()
        watch_id = viewer.request("gateway.session", {"profile_home": str(home), "session_id": sid, "action": "watch"})
        frame = await asyncio.to_thread(viewer.next_message, 20)
        assert frame["method"] == "stream" and frame["params"]["event"] == "snapshot", frame
        prompt = parked["snapshot"]["prompts"][0]
        told = await asyncio.to_thread(call, "steer", execution_generation=prompt["execution_generation"], text="OPEN_STEER")
        assert told["state"] == "attached", told
        answered = await asyncio.to_thread(call, "approval", prompt_id=prompt["prompt_id"],
                                           execution_generation=prompt["execution_generation"], choice="deny")
        assert answered["state"] == "attached", answered
        while (final := await asyncio.to_thread(call, "snapshot"))["snapshot"]["pending"] or final["snapshot"]["running"]:
            assert time.monotonic() - submitted < 60, final
            await asyncio.sleep(POLL_SECONDS)
        viewer.request("rpc.cancel", {"id": watch_id})
        while (await asyncio.to_thread(viewer.next_message, 20)).get("id") != watch_id:
            pass
        opened = await barrier(watched)
        assert opened == ["resume", "resume"], f"only the watch and the barrier are opens: {opened}"
    finally:
        sidecar.close()
        viewer.close()


async def probe_batch(home, peer, desc):
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
                await asyncio.sleep(POLL_SECONDS)
            tool = json.dumps([m for messages in peer.requests for m in messages if m["role"] == "tool"])
            assert "green" in tool and "large" in tool, tool
            assert "CLARIFY_FINISHED" in json.dumps(final["snapshot"]["messages"]), final
            viewer.request("rpc.cancel", {"id": watch_id})
    finally:
        sidecar.close()
        viewer.close()


async def probe_connections(home, peer, desc):
    """A real card: the snapshot restores it, updates reach a watch, and every verb reaches this exact owner."""
    sidecar = SidecarProcess(home)
    viewer = SidecarProcess(home)
    try:
        async with websocket(home, desc) as native:
            created = await rpc(native, "session.create", request_id="connection-create", source="cli", toolsets=["connections"])
            sid = created["result"]["session_id"]
            params = {"profile_home": str(home), "session_id": sid}
            watch_id = viewer.request("gateway.session", {**params, "action": "watch"})
            frame = await asyncio.to_thread(viewer.next_message, 20)
            assert frame["params"]["event"] == "snapshot" and frame["params"]["data"]["snapshot"]["pending_connection"] is None, frame
            assert "result" in await rpc(native, "prompt.submit", session_id=sid, submission_id="native-connection", text="Install linear")

            async def event(kind):
                async with asyncio.timeout(30):
                    while True:
                        frame = await asyncio.to_thread(viewer.next_message, 20)
                        assert frame.get("id") != watch_id, f"the watch ended before Web received {kind}: {frame}"
                        if frame.get("method") == "stream" and frame["params"]["event"] == "event" and frame["params"]["data"].get("type") == kind:
                            return frame["params"]["data"]

            opened = await event("connection.request")
            operation = opened["payload"]
            op_id = operation["op_id"]
            assert [(t["name"], t["kind"]) for t in operation["targets"]] == [("linear", "mcp")] and operation["tool_call_id"] == "owned-connection", operation
            assert set(operation["targets"][0]) - {"launch"} == {"name", "kind", "state", "detail", "connect_url", "required_env"}, operation
            assert operation["targets"][0]["launch"] == {"kind": "remote", "target": "https://mcp.linear.app/mcp", "env": [], "cwd": None}, operation

            def call(action, **extra):
                return sidecar.result("gateway.session", {**params, "action": action, **extra})
            restored = await asyncio.to_thread(call, "snapshot")
            assert restored["snapshot"]["pending_connection"]["op_id"] == op_id, restored
            epoch = restored["snapshot"]["authority_epoch"]
            fence = {"op_id": op_id, "authority_epoch": epoch}
            read = await asyncio.to_thread(call, "connection_status", **fence)
            assert read["state"] == "attached" and read["connection"]["op_id"] == op_id and read["connection"]["settled"] is False, read
            woke = await asyncio.to_thread(call, "connection_wake", **fence)
            assert woke["state"] == "attached", woke
            # A foreign operation and a replaced owner are refused; neither moves the card.
            foreign = await asyncio.to_thread(call, "connection_status", op_id="no-such-op", authority_epoch=epoch)
            assert (foreign["state"], foreign["reason"]) == ("refused", "UNKNOWN_OPERATION"), foreign
            stale = await asyncio.to_thread(call, "connection_respond", op_id=op_id, authority_epoch=epoch + 1, connection_answer={"settled_by": "continue"})
            assert (stale["state"], stale["reason"]) == ("refused", "owner_changed"), stale
            assert (await asyncio.to_thread(call, "snapshot"))["snapshot"]["pending_connection"]["op_id"] == op_id
            # Try again reaches the owner's own retry, and only for the operation the card shows.
            elsewhere = await asyncio.to_thread(call, "connection_retry", op_id="no-such-op", authority_epoch=epoch, connector="linear")
            assert (elsewhere["state"], elsewhere["reason"]) == ("refused", "UNKNOWN_OPERATION"), elsewhere
            retried = await asyncio.to_thread(call, "connection_retry", **fence, connector="linear")
            assert retried["state"] == "refused" and retried["reason"] in {"LINK_STILL_VALID", "CONNECTORS_UNAVAILABLE"}, retried
            # A credential reaches the owner only inside this one verb.
            answered = await asyncio.to_thread(call, "connection_respond", **fence, connection_answer={"targets": [{"name": "linear", "status": "skipped"}]})
            assert answered["state"] == "attached" and answered["connection_settled"] is True, answered
            settled = await event("connection.update")
            while settled["payload"].get("settled") is not True:
                settled = await event("connection.update")
            assert settled["payload"]["op_id"] == op_id and settled["payload"]["targets"][0]["state"] == "skipped", settled
            gone = await asyncio.to_thread(call, "connection_status", **fence)
            assert (gone["state"], gone["reason"]) == ("refused", "UNKNOWN_OPERATION"), gone
            assert (await asyncio.to_thread(call, "snapshot"))["snapshot"]["pending_connection"] is None
            async with asyncio.timeout(30):
                while (await asyncio.to_thread(call, "snapshot"))["snapshot"]["running"]:
                    await asyncio.sleep(POLL_SECONDS)
            # Reading it all started no second turn: the model saw the card's result once.
            turns = [messages for messages in peer.requests if messages]
            assert len(turns) == 2 and any(m["role"] == "tool" for m in turns[-1]), turns
    finally:
        viewer.close()
        sidecar.close()


async def probe_restart(home, peer, desc, proc, env):
    """``hermes gateway restart`` waits for a turn parked on an approval; Web answers it, then the restart completes.

    An owner shipping ``gateway/restart_when_idle.py`` restarts when idle: it stays ready and keeps admitting work until
    nothing is live, and the input Web sends meanwhile runs exactly once across the restart. An older one drains at once,
    refusing new work while the parked turn stays answerable."""
    import signal
    from hermes_cli.gateway_runtime import discover_gateway_endpoint
    when_idle = (agent / "gateway/restart_when_idle.py").exists()

    async def until(read, done):
        """The owner's record once ``done`` holds it, read again under the probe's shared 30 s ceiling."""
        deadline = time.monotonic() + 30
        while not done(value := await read()):
            assert time.monotonic() < deadline, value
            await asyncio.sleep(POLL_SECONDS)
        return value
    sidecar = SidecarProcess(home)
    viewer = SidecarProcess(home)
    try:
        async with websocket(home, desc) as native:
            created = await rpc(native, "session.create", request_id="restart-create", source="cli", toolsets=["terminal"])
            sid = created["result"]["session_id"]
            await rpc(native, "prompt.submit", session_id=sid, submission_id="restart-input", text="Run fixture control")
            pending = await until(lambda: rpc(native, "session.resume", session_id=sid), lambda read: read["result"]["prompts"])
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
        owner = discover_gateway_endpoint(home)
        assert owner.state == "ready", owner
        proc.send_signal(signal.SIGUSR1)  # the service restart path `hermes gateway restart` takes
        count = len(peer.requests)
        if when_idle:
            from gateway.status import read_runtime_status
            # The owner publishes the waiting restart, and the work holding it, only in its runtime status.
            status = await until(lambda: asyncio.to_thread(read_runtime_status, home / "gateway_state.json"),
                                 lambda read: (read or {}).get("restart_requested"))
            assert status["active_work"], status
            # Discovery stays ready on the same owner, so Web keeps sending through it.
            found = discover_gateway_endpoint(home)
            assert (found.state, found.reason_code) == ("ready", None), found
            assert (found.endpoint.instance_id, found.endpoint.authority_epoch) == \
                (owner.endpoint.instance_id, owner.endpoint.authority_epoch), (owner, found)
            attached = await asyncio.to_thread(sidecar.result, "gateway.session", {**params, "action": "snapshot"})
            assert attached["state"] == "attached" and not attached["restarting"], attached
            assert attached["snapshot"]["prompts"][0]["prompt_id"] == prompt["prompt_id"], attached
            # Admission stays open while the parked turn holds the restart.
            renamed = await asyncio.to_thread(sidecar.result, "gateway.session", {**params, "action": "mutate",
                "request_id": "restart-mutate", "expected_revision": attached["snapshot"]["revision"],
                "execution_generation": attached["snapshot"]["execution_generation"],
                "operation": "rename", "payload": {"title": "Renamed while restarting"}})
            assert renamed["state"] == "attached" and not renamed["restarting"], renamed
            assert renamed["snapshot"]["revision"] > attached["snapshot"]["revision"], renamed
            followup = await asyncio.to_thread(sidecar.result, "gateway.session", {**params, "action": "submit",
                "request_id": "restart-submit", "text": "ADMITTED_WHILE_RESTARTING"})
            assert followup["state"] == "attached" and followup["receipt"]["admission_id"], followup
            assert proc.poll() is None, "the owner exited while its turn was parked"
        else:
            await until(lambda: asyncio.to_thread(discover_gateway_endpoint, home), lambda found: found.reason_code == "restart_wait")
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
            for action, extra in (("submit", {"request_id": "restart-submit", "text": "MUST_NOT_RUN"}),
                                  ("mutate", {"request_id": "restart-mutate", "expected_revision": attached["snapshot"]["revision"],
                                              "execution_generation": attached["snapshot"]["execution_generation"],
                                              "operation": "rename", "payload": {"title": "never"}})):
                refused = await asyncio.to_thread(sidecar.result, "gateway.session", {**params, "action": action, **extra})
                assert (refused["state"], refused["reason"]) == ("refused", "gateway_restarting"), refused
        answered = await asyncio.to_thread(sidecar.result, "gateway.session", {**params, "action": "approval",
            "prompt_id": prompt["prompt_id"], "execution_generation": prompt["execution_generation"], "choice": "once"})
        # The answer lets the parked turn end, and with it the restart's wait: the owner can exit before the sidecar reads
        # its reply, an unknown outcome. The owner's record below says the answer landed once.
        assert answered["state"] == "attached" or (answered["state"], answered["reason"]) == ("unavailable", "owner_connection_lost"), answered
        # The restart waited only for that work: the owner now exits on its own.
        await asyncio.to_thread(proc.wait, 60)
        # The watch opened before the wait observed the settlement and the turn's end until the owner exited.
        events = []
        while (frame := await asyncio.to_thread(viewer.next_message, 20)).get("id") != watch_id:
            events.append(frame["params"]["event"])
            seen.append(frame["params"]["data"].get("type"))
        assert seen.count("approval.settled") == 1, seen
        assert seen.index("approval.settled") < seen.index("message.complete"), seen
        import sqlite3
        from contextlib import closing

        def record():
            with closing(sqlite3.connect((home / "state.db").as_uri() + "?mode=ro", uri=True)) as db:
                return ([row[0] for row in db.execute("SELECT content FROM messages WHERE session_id=? ORDER BY id", (sid,))],
                        db.execute("SELECT status, outcome FROM session_admissions WHERE target_session_id=? AND request_id=?",
                                   (sid, "restart-submit")).fetchone())
        contents, admitted = record()
        assert "APPROVAL_FINISHED" in contents, contents
        assert not (home / "owned-removal").exists()
        if when_idle:
            # Nothing announced a restart to the watch.
            assert "restarting" not in events, events
            # The owner can see idle between the parked turn's settlement and its drain claiming the follow-up; the
            # follow-up then stays queued in its durable FIFO for the next owner (NousResearch/hermes-agent#157165).
            # Either way the watch delivered every turn the owner's record says ended before the exit (TAL-2344).
            assert admitted in {("terminal", "completed"), ("queued", None)}, admitted
            assert seen.count("message.complete") == 1 + (admitted[0] == "terminal"), (admitted, seen)
            # The supervisor relaunches the owner, which runs a follow-up still queued: it ran once across the restart.
            with daemon(agent, home, env, barrier=False):
                await until(lambda: asyncio.to_thread(record), lambda read: read[1] == ("terminal", "completed"))
            contents = record()[0]
            assert sum("ADMITTED_WHILE_RESTARTING" in json.dumps(body) for body in peer.requests[count:]) == 1, peer.requests[count:]
            assert contents[contents.index("ADMITTED_WHILE_RESTARTING") + 1:].count("APPROVAL_FINISHED") == 1, contents
        else:
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
    verified = getattr(discovered.endpoint, "code_sha", None) in json.loads(
        (Path(__file__).resolve().parents[2] / "agent_support.json").read_text())["nativeContracts"]["served-local-policy-v1"]

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
            await asyncio.sleep(POLL_SECONDS)
    try:
        async with websocket(home, desc) as root_view, connect(url, subprotocols=protocols, max_queue=None) as alpha_view:
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
                    await asyncio.sleep(POLL_SECONDS)
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
                "session.events.since": {"events": [], "snapshot_required": True},
                "session.resume": {"session_id": "fixture", "subscription_id": "viewer", "messages": [], "info": {}},
                "prompt.submit": receipt,
            }
            # The owner fires on_session_open, so Web reads the replay first as a reconnect (TAL-2054).
            for method in ("runtime.describe", "session.events.since", "session.resume", "prompt.submit"):
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
                await asyncio.sleep(POLL_SECONDS)
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
                await asyncio.sleep(POLL_SECONDS)
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
    FOLLOWUP_COMPLETE = 'Owner detail follow-up complete.'

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.requests.append(body)
        messages = body.get('messages', [])
        prompt = next((m.get('content', '') for m in reversed(messages) if m['role'] == 'user'), '')
        has_tool_result = any(m['role'] == 'tool' for m in messages)
        delegate = prompt == 'NATIVE_DETAIL' and not has_tool_result
        final = self.FOLLOWUP_COMPLETE if has_tool_result and prompt != 'NATIVE_DETAIL' else 'Owner detail complete.'
        message = {'role': 'assistant', 'content': None if delegate else final,
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
            context_params = {'profile_home': str(home), 'session_id': sid, 'action': 'context_detail'}
            prebuild = await asyncio.to_thread(viewer.result, 'gateway.session', context_params)
            assert prebuild['context_detail']['reason'] == 'not_built', prebuild
            watch = viewer.request('gateway.session', {'profile_home': str(home), 'session_id': sid, 'action': 'watch', 'show_reasoning': True})
            first = await asyncio.to_thread(viewer.next_message, 20)
            assert first['params']['event'] == 'snapshot', first
            # Retained events precede the live turn. Finish that phase before submitting new work.
            while (frame := await asyncio.to_thread(viewer.next_message, 20))['params']['event'] != 'replay_complete':
                assert frame.get('method') == 'stream', frame
            submitted = await rpc(native, 'prompt.submit', session_id=sid, submission_id='detail-input', text='NATIVE_DETAIL')
            assert 'result' in submitted, submitted
            events = []
            ran = False
            followup_complete = False
            async with asyncio.timeout(75):
                while True:
                    frame = await asyncio.to_thread(viewer.next_message, 20)
                    assert frame.get('method') == 'stream', frame
                    event = frame['params'].get('data', {})
                    if frame['params']['event'] != 'event':
                        continue
                    events.append(event)
                    ran = ran or event.get('payload', {}).get('running') is True
                    followup_complete = followup_complete or (event.get('type') == 'message.complete'
                        and event.get('payload', {}).get('text') == DetailModel.FOLLOWUP_COMPLETE)
                    if (ran and followup_complete and event.get('type') == 'session.info'
                            and event.get('payload', {}).get('running') is False):
                        break
            assert followup_complete, 'the child completion follow-up must finish before context inspection'
            kinds = [e['type'] for e in events]
            assert 'reasoning.delta' in kinds, kinds
            assert kinds.index('reasoning.delta') < kinds.index('message.delta'), kinds
            assert 'subagent.start' in kinds and 'subagent.complete' in kinds, kinds
            assert 'session.usage' in kinds and 'message.complete' in kinds, kinds
            requests_before = len(peer.requests)
            # Background subagent events may follow the parent's idle event; inspect one stable owner snapshot.
            deadline = time.monotonic() + 10
            while True:
                inspected = await asyncio.to_thread(viewer.result, 'gateway.session', context_params)
                context = inspected['context_detail']
                if context.get('reason') != 'changed':
                    break
                assert time.monotonic() < deadline, inspected
                await asyncio.sleep(POLL_SECONDS)
            assert context['available'] is True and context['categories'], inspected
            assert context['source'] in {'provider_usage', 'provider_usage_plus_estimate', 'local_estimate'}, context
            assert all(set(row) == {'label', 'characters', 'tokens', 'status', 'loaded'} for row in context['files']), context
            assert len(peer.requests) == requests_before, {
                'before': requests_before, 'after': len(peer.requests), 'running': inspected['snapshot']['running'],
                'pending': [row.get('status') for row in inspected['snapshot']['pending']],
                'new_requests': [{'model': body.get('model'), 'roles': [row.get('role') for row in body.get('messages', [])],
                                  'tools': [tool.get('function', {}).get('name') for tool in body.get('tools', [])]}
                                 for body in peer.requests[requests_before:]],
            }
            viewer.request('rpc.cancel', {'id': watch})
            # record_gateway_owner_events.py records the server's fixture from this line.
            print('DETAIL ' + json.dumps({'context_inspection': True, 'live_reasoning': True, 'subagent_progress': True, 'usage': True, 'events': events}))
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


class ProfileModel(Model):
    def do_POST(self):
        self.server.authorization.append(self.headers.get("Authorization"))
        super().do_POST()


class ConnectionModel(BatchPeer):
    """Opens one real MCP connection card, then answers once the card settles it."""

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        messages = body.get("messages", [])
        self.server.requests.append(messages)
        asking = bool(messages) and not any(m["role"] == "tool" for m in messages)
        message = {"role": "assistant", "content": "CONNECTION_FINISHED"}
        if asking:
            message = {"role": "assistant", "content": None, "tool_calls": [{"index": 0, "id": "owned-connection", "type": "function",
                "function": {"name": "manage_connections", "arguments": json.dumps({"action": "install", "connectors": [{"name": "linear", "mcp": True}]})}}]}
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for delta, finish in [(message, None), ({}, "tool_calls" if asking else "stop")]:
            frame = {"id": "connection", "object": "chat.completion.chunk", "created": 1, "model": "connection",
                     "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            self.wfile.write(("data: " + json.dumps(frame) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def arm(peer, home, mode):
    """Give one mode its handler and clean provider state on the provider URL every owner config names."""
    print("MODE " + mode, flush=True)
    peer.RequestHandlerClass = {"detail": DetailModel, "approval": ApprovalPeer, "approval-tell": ApprovalPeer, "restart": ApprovalPeer, "batch": BatchPeer,
                                "clarify": ClarifyPeer, "profiles": ProfileModel, "connections": ConnectionModel,
                                "session-open": ApprovalPeer}.get(mode, Model)
    peer.requests = []
    peer.blocked, peer.release = threading.Event(), threading.Event()
    if mode in {"approval", "approval-tell", "restart", "session-open"}:
        import shlex
        target = home / ("owned-told" if mode == "approval-tell" else "owned-removal")
        target.mkdir()
        (target / "owned.txt").write_text("disposable")
        peer.command = "rm -r -- " + shlex.quote(str(target))


def run_on_owner(mode, home, peer, desc, proc, env):
    if mode == "queued-controls":
        return probe_queued_controls(home, peer, desc)
    if mode == "reactions":
        return probe_reactions(home, peer, desc)
    if mode == "reaction-watch":
        return probe_reaction_watch(home, peer, desc)
    if mode == "images":
        return probe_images(home, peer, desc)
    if mode == "detail":
        return probe_detail(home, peer, desc)
    if mode == "restart":
        return probe_restart(home, peer, desc, proc, env)
    if mode == "model":
        return probe_model(home, peer, desc)
    if mode == "voice-stop":
        return probe_voice_stop(home, peer, desc)
    if mode == "reasoning":
        return probe_reasoning(home, peer, desc)
    if mode == "reasoning-restart":
        return probe_reasoning_restart(home, peer, desc, proc, env)
    if mode == "profiles":
        return probe_profiles(home, peer, desc, proc, env)
    if mode in {"approval", "clarify"}:
        return probe_control(home, peer, desc, mode)
    if mode == "approval-tell":
        return probe_control(home, peer, desc, "approval", instruction="TOLD_THE_PARKED_TURN")
    if mode == "batch":
        return probe_batch(home, peer, desc)
    if mode == "connections":
        return probe_connections(home, peer, desc)
    if mode == "work":
        return probe_work(home, peer, desc)
    if mode == "complete":
        return probe_complete(home, peer, desc)
    if mode == "commands":
        return probe_commands(home, peer, desc)
    if mode == "transcript":
        return probe_transcript(home, peer, desc)
    if mode == "session-open":
        return probe_session_open(home, peer, desc)
    if mode == "bridge":
        return probe_bridge(home, peer, desc)
    return probe(home, peer, desc, require_gap=mode == "replay")


def run_alone(mode, home, peer, env, alpha):
    arm(peer, home, mode)
    with PHASES.probe(mode):
        if mode == "dedicated":
            alpha_env = dict(env, HERMES_HOME=str(alpha), OPENAI_API_KEY="alpha-only")
            with daemon(agent, home, env, barrier=False) as (_, desc), daemon(agent, alpha, alpha_env, barrier=False) as (_, alpha_desc):
                asyncio.run(probe_dedicated(home, peer, desc, alpha, alpha_desc))
        elif mode == "secure":
            asyncio.run(probe_secure(home))
        elif mode == "recovery":
            probe_recovery(home, peer, env)
        else:
            with daemon(agent, home, env, barrier=mode == "replay", fixture=str(Path(__file__).with_name("gateway_replay_daemon.py"))) as (proc, desc):
                asyncio.run(run_on_owner(mode, home, peer, desc, proc, env))


def serve(home, peer, env):
    """Each stdin line names a mode for the one owner; its MODES line (after its PHASES line) ends that mode."""
    with daemon(agent, home, env, barrier=False) as (proc, desc):
        for line in sys.stdin:
            mode = line.strip()
            ran, skipped, failed = [], {}, None
            if reason := unsupported(mode):
                skipped[mode] = reason
            else:
                try:
                    assert mode not in OWN_OWNER, f"{mode} needs an owner of its own"
                    arm(peer, home, mode)
                    with PHASES.probe(mode):
                        asyncio.run(run_on_owner(mode, home, peer, desc, proc, env))
                    ran.append(mode)
                except Exception:
                    traceback.print_exc()
                    failed = mode
                finally:
                    peer.release.set()
            PHASES.report()
            report_modes(ran, skipped, failed)


def main():
    home = Path(os.environ["HERMES_HOME"])
    home.mkdir(mode=0o700, exist_ok=True)
    alone = MODES[0] if OWN_OWNER & set(REQUESTED) else None
    assert not alone or REQUESTED == [alone], f"each of these modes needs its own owner: {REQUESTED}"
    # The server builds each request's handler from RequestHandlerClass, so arm() can swap it between modes.
    peer = ThreadingHTTPServer(("127.0.0.1", 0), Model)
    peer.authorization, peer.requests = [], []
    peer.blocked, peer.release = threading.Event(), threading.Event()
    secondary = alpha = None
    threading.Thread(target=peer.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{peer.server_port}/v1"
    (home / "config.yaml").write_text(json.dumps({"gateway": {"multiplex_profiles": alone == "profiles"},
        "model": {"provider": "custom", "default": "owner-fixture", "base_url": url},
        "compression": {"in_place": False, "protect_first_n": 0, "protect_last_n": 0, "min_tail_user_messages": 1},
        "auxiliary": {"title_generation": {"enabled": False}}, "approvals": {"mode": "manual", "timeout": 45}, "platform_toolsets": {"cli": []},
        "quick_commands": {"where": {"type": "exec", "command": "pwd"}},
        **({"plugins": {"enabled": ["open-counter"]}} if alone == "session-open" else {})}))
    if alone == "session-open":
        plugin = home / "plugins/open-counter"
        plugin.mkdir(parents=True)
        (plugin / "plugin.yaml").write_text("name: open-counter\nversion: '1.0'\n")
        (plugin / "__init__.py").write_text(OPEN_COUNTER)
    if alone in {"profiles", "dedicated"}:
        alpha = home / "profiles/alpha"
        alpha.mkdir(parents=True)
        alpha_config = json.loads((home / "config.yaml").read_text())
        if alone == "profiles":
            secondary = ThreadingHTTPServer(("127.0.0.1", 0), ProfileModel)
            secondary.authorization, secondary.requests = [], []
            secondary.blocked, secondary.release = threading.Event(), threading.Event()
            secondary.release.set()
            threading.Thread(target=secondary.serve_forever, daemon=True).start()
            peer.secondary = secondary
            alpha_config["model"]["base_url"] = f"http://127.0.0.1:{secondary.server_port}/v1"
        alpha_config["gateway"] = {"multiplex_profiles": False, "standalone": alone == "dedicated"}
        (alpha / "config.yaml").write_text(json.dumps(alpha_config))
        alpha_url = alpha_config["model"]["base_url"]
        (alpha / ".env").write_text(f"OPENAI_API_KEY=alpha-only\nOPENAI_BASE_URL={alpha_url}\n")
    env = child_env()
    env.update(HOME=os.environ["HOME"], HERMES_HOME=str(home), PYTHONPATH=str(agent),
               OPENAI_API_KEY="loopback-only", OPENAI_BASE_URL=url, HERMES_STATE_DB_GUARD_BYPASS="1", HERMES_DISABLE_LAZY_INSTALLS="1")
    env.update(PYTEST_CURRENT_TEST="talaria native owner fixture", TIRITH_ENABLED="0", AWS_EC2_METADATA_DISABLED="true")
    ran, mode = [], None
    if SERVE:
        try:
            serve(home, peer, env)
        finally:
            peer.release.set()
            peer.shutdown()
            peer.server_close()
        return
    try:
        if alone:
            mode = alone
            run_alone(mode, home, peer, env, alpha)
            ran.append(mode)
        else:
            with daemon(agent, home, env, barrier=False) as (proc, desc):
                for mode in MODES:
                    arm(peer, home, mode)
                    with PHASES.probe(mode):
                        asyncio.run(run_on_owner(mode, home, peer, desc, proc, env))
                    peer.release.set()
                    ran.append(mode)
        mode = None
    finally:
        report_modes(ran, SKIPPED, mode)
        peer.release.set()
        peer.shutdown()
        peer.server_close()
        if secondary is not None:
            secondary.shutdown()
            secondary.server_close()
        PHASES.report()


if __name__ == "__main__":
    main()
