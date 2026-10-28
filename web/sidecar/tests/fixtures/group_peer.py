"""Disposable two-profile native driver; inference stays on a synthetic loopback provider."""
from http.server import ThreadingHTTPServer
import json
import base64
import os
from pathlib import Path
import sys
import threading
import time

agent = Path(os.environ["HERMES_WEBUI_AGENT_DIR"])
sys.path[:0] = [str(agent), str(agent / "tests/gateway/fixtures"), str(Path(__file__).resolve().parents[1])]
from local_recovery_probe import Model, child_env, daemon
from authority_controls_peer import ModelPeer as ApprovalModel
from conftest import SidecarProcess


class RoomModel(Model):
    def do_POST(self):
        if self.server.mode == "approval":
            return ApprovalModel.do_POST(self)
        if self.server.mode == "stop":
            self.server.blocked.set()
            self.server.release.wait(30)
        if self.server.mode == "partial" and self.headers.get("Authorization") == "Bearer helper-fixture":
            self.rfile.read(int(self.headers["Content-Length"]))
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"synthetic member refusal","type":"authentication_error"}}')
            return
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.requests.append(request)
        message = {"role": "assistant", "content": "Fixture member reply"}
        # Echoing the native discussion prompt would mention every peer and invent extra rounds.
        if request.get("stream"):
            body = ("data: " + json.dumps({"id": "room", "choices": [{"index": 0, "delta": message, "finish_reason": "stop"}]}) + "\n\ndata: [DONE]\n\n").encode()
        else:
            body = json.dumps({"id": "room", "choices": [{"index": 0, "message": message, "finish_reason": "stop"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream" if request.get("stream") else "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass


def probe(home, peer):
    sidecar = SidecarProcess(home)
    def call(action, **fields):
        response, _ = sidecar.call("gateway.groups", {"profile_home": str(home), "subject": "talaria-fixture",
                                                      "operation": {"action": action, **fields}})
        assert "result" in response, response
        assert response["result"]["state"] == "available", response
        return response["result"]["value"]
    def wait_for(room_id, predicate):
        deadline = time.monotonic() + 40
        while True:
            value = call("state", room_id=room_id)
            if predicate(value):
                return value
            assert time.monotonic() < deadline, value
            time.sleep(.1)

    try:
        caps = call("capabilities")
        assert caps["driver"] is True
        assert {"default", "helper"}.issubset(caps["seatable_profiles"]), caps
        members = [{"member_id": name, "profile": name, "handle": name} for name in ("default", "helper")]
        room = call("create", room_id="fixture-room", name="Discussion", members=members)["room"]
        assert room["room_id"] == "fixture-room", room
        assert [m["profile"] for m in room["members"]] == [m["profile"] for m in members], room
        stale, _ = sidecar.call("gateway.groups", {"profile_home": str(home), "subject": "talaria-fixture",
            "expected_room": {"room_id": "fixture-room", "gateway_id": "foreign", "authority_epoch": room["authority_epoch"]},
            "operation": {"action": "rename", "room_id": "fixture-room", "event_id": "stale-rename", "name": "Wrong source"}})
        assert stale["result"]["state"] == "refused", stale
        assert call("state", room_id="fixture-room")["room"]["name"] == "Discussion"
        attachment = call("attachment.upload", room_id="fixture-room", upload_id="note", kind="file", name="note.txt",
                          mime="text/plain", data_base64=base64.b64encode(b"disposable note").decode())
        manifest = {k: attachment[k] for k in ("attachment_id", "kind", "name", "mime", "size")}
        large_bytes = b"x" * 6_400_000
        large = call("attachment.upload", room_id="fixture-room", upload_id="large", kind="file", name="large.txt",
                     mime="text/plain", data_base64=base64.b64encode(large_bytes).decode())
        large_manifest = {k: large[k] for k in ("attachment_id", "kind", "name", "mime", "size")}
        denied, _ = sidecar.call("gateway.groups", {"profile_home": str(home), "subject": "other-viewer",
            "operation": {"action": "state", "room_id": "fixture-room"}})
        assert denied["result"]["state"] == "refused", denied
        for event_id in ("uncommitted", "foreign-event"):
            denied, _ = sidecar.call("gateway.groups", {"profile_home": str(home), "subject": "talaria-fixture",
                "operation": {"action": "attachment.download", "room_id": "fixture-room", "event_id": event_id,
                              "attachment_id": manifest["attachment_id"]}})
            assert denied["result"]["state"] != "available", denied
        sent = call("send", room_id="fixture-room", event_id="fixture-send", payload={"text": "GROUP_HELLO", "thread_id": "fixture-thread", "attachments": [manifest, large_manifest]})
        assert sent["accepted"] and sent["client_event_id"] == "fixture-send", sent
        downloaded = call("attachment.download", room_id="fixture-room", event_id=sent["event"]["event_id"], attachment_id=manifest["attachment_id"])
        assert base64.b64decode(downloaded["data_base64"]) == b"disposable note", downloaded
        assert str(home) not in json.dumps(downloaded), downloaded
        large_download = call("attachment.download", room_id="fixture-room", event_id=sent["event"]["event_id"], attachment_id=large_manifest["attachment_id"])
        assert base64.b64decode(large_download["data_base64"]) == large_bytes
        deadline = time.monotonic() + 60
        while True:
            log = call("log", room_id="fixture-room", since_seq=0, limit=100)
            replies = [e for e in log["events"] if e["kind"] == "message.member"]
            if {e["payload"]["member_id"] for e in replies} == {"default", "helper"}:
                break
            assert time.monotonic() < deadline, log
            time.sleep(.1)
        seqs = [e["seq"] for e in log["events"]]
        assert seqs == sorted(set(seqs)), log
        first = call("log", room_id="fixture-room", since_seq=0, limit=2)
        rest = call("log", room_id="fixture-room", since_seq=first["cursor"], limit=100)
        assert [e["seq"] for e in first["events"] + rest["events"] if e["seq"] <= log["cursor"]] == seqs
        assert call("state", room_id="fixture-room")["room"]["room_id"] == "fixture-room"
        wait_for("fixture-room", lambda s: not s["driver_status"]["working"])
        call("disband", room_id="fixture-room", cancel_id="fixture-disband")
        assert call("list")["rooms"] == []

        peer.mode = "approval"
        call("create", room_id="approval-room", name="Approval", members=members)
        call("send", room_id="approval-room", event_id="approval-send", payload={"text": "GROUP_APPROVAL"})
        state = wait_for("approval-room", lambda s: any(a.get("kind") == "approval" for a in s["driver_status"]["pending_actions"]))
        action = next(a for a in state["driver_status"]["pending_actions"] if a["kind"] == "approval")
        fields = {k: action[k] for k in ("member_id", "task_id", "execution_generation", "request_id")}
        denied, _ = sidecar.call("gateway.groups", {"profile_home": str(home), "subject": "talaria-fixture",
            "operation": {"action": "approve", "room_id": "approval-room", **fields,
                          "execution_generation": fields["execution_generation"] + 1, "choice": "deny"}})
        assert denied["result"]["state"] != "available", denied
        assert call("approve", room_id="approval-room", **fields, choice="deny")["approved"]
        duplicate, _ = sidecar.call("gateway.groups", {"profile_home": str(home), "subject": "talaria-fixture",
            "operation": {"action": "approve", "room_id": "approval-room", **fields, "choice": "deny"}})
        assert duplicate["result"]["state"] != "available", duplicate
        answered = {(fields["task_id"], fields["request_id"])}
        deadline = time.monotonic() + 40
        while True:
            current = call("state", room_id="approval-room")["driver_status"]
            if not current["working"]:
                break
            for pending in current["pending_actions"]:
                if pending["kind"] == "approval" and (pending["task_id"], pending["request_id"]) not in answered:
                    answer = {k: pending[k] for k in ("member_id", "task_id", "execution_generation", "request_id")}
                    call("approve", room_id="approval-room", **answer, choice="deny")
                    answered.add((answer["task_id"], answer["request_id"]))
            assert time.monotonic() < deadline, current
            time.sleep(.1)
        assert (home / "approval-disposable/owned.txt").read_text() == "keep"
        call("disband", room_id="approval-room", cancel_id="approval-disband")

        peer.mode = "stop"
        peer.release.clear()
        call("create", room_id="stop-room", name="Stop race", members=members)
        call("send", room_id="stop-room", event_id="stop-send", payload={"text": "GROUP_STOP"})
        call("stop", room_id="stop-room", cancel_id="stop-race")
        peer.release.set()
        wait_for("stop-room", lambda s: not s["driver_status"]["working"])
        stopped = call("log", room_id="stop-room", since_seq=0, limit=100)
        assert not any(e["kind"] == "message.member" for e in stopped["events"]), stopped
        call("disband", room_id="stop-room", cancel_id="stop-disband")

        peer.mode = "partial"
        call("create", room_id="partial-room", name="Partial failure", members=members)
        call("send", room_id="partial-room", event_id="partial-send", payload={"text": "GROUP_PARTIAL"})
        deadline = time.monotonic() + 40
        while True:
            log = call("log", room_id="partial-room", since_seq=0, limit=100)
            if any(e["kind"] == "message.member" for e in log["events"]) and any(e["kind"] == "turn.failed" for e in log["events"]):
                break
            assert time.monotonic() < deadline, log
            time.sleep(.1)
        call("disband", room_id="partial-room", cancel_id="partial-disband")
    finally:
        sidecar.close()


def main():
    home = Path(os.environ["HERMES_HOME"])
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    peer = ThreadingHTTPServer(("127.0.0.1", 0), RoomModel)
    peer.mode = "plain"
    target = home / "approval-disposable"
    target.mkdir()
    (target / "owned.txt").write_text("keep")
    import shlex
    peer.command = "rm -r -- " + shlex.quote(str(target))
    peer.requests, peer.blocked, peer.release = [], threading.Event(), threading.Event()
    peer.release.set()
    threading.Thread(target=peer.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{peer.server_port}/v1"
    helper = home / "profiles/helper"
    helper.mkdir(parents=True)
    config = {"gateway": {"multiplex_profiles": True},
              "model": {"provider": "custom", "default": "room-fixture", "base_url": url},
              "hosted_rooms": {"profiles": {"helper": str(helper)}},
              "auxiliary": {"title_generation": {"enabled": False}}, "approvals": {"mode": "manual", "timeout": 45},
              "platform_toolsets": {"cli": ["terminal"], "bot_room": ["terminal"]}}
    (home / "config.yaml").write_text(json.dumps(config))
    (helper / "config.yaml").write_text(json.dumps({**config, "gateway": {"multiplex_profiles": False}}))
    (helper / ".env").write_text(f"OPENAI_API_KEY=helper-fixture\nOPENAI_BASE_URL={url}\n")
    env = child_env() | dict(HOME=os.environ["HOME"], HERMES_HOME=str(home), PYTHONPATH=str(agent),
        OPENAI_API_KEY="loopback-only", OPENAI_BASE_URL=url, HERMES_STATE_DB_GUARD_BYPASS="1",
        HERMES_DISABLE_LAZY_INSTALLS="1", PYTEST_CURRENT_TEST="talaria room fixture", TIRITH_ENABLED="0",
        AWS_EC2_METADATA_DISABLED="true")
    try:
        with daemon(agent, home, env, barrier=False):
            probe(home, peer)
    finally:
        peer.release.set()
        peer.shutdown()
        peer.server_close()


if __name__ == "__main__":
    main()
