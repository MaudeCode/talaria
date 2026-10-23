"""Real Agent/stdio probe; only HTTP transport, clock and native timer are controlled."""
import base64
import json
import os
from pathlib import Path
import socket
import sys
import threading
import time

sys.path.append(sys.argv[1])


def blocked(*args, **kwargs):
    raise AssertionError("real network is forbidden")


socket.create_connection = blocked
socket.socket.connect = blocked
import httpx
from hermes_cli import guest_handoff as handoff

clock = [float(os.environ["HANDOFF_EPOCH"])]
handoff._now = lambda: clock[0]
claims = []


def jwt(subject="account_fixture"):
    def segment(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b"=").decode()
    return ".".join([segment({"alg": "none"}), segment({
        "sub": subject, "client_id": "hermes-cli", "account_tier": "standard",
        "scope": "inference:invoke", "exp": int(time.time()) + 86400,
        "email": "fixture@example.invalid", "managed_tools": True,
    }), "sig"])


ACCOUNT_TOKEN = jwt()


def respond(request):
    path = request.url.path
    if path == "/api/oauth/device/code":
        return httpx.Response(200, json={"device_code": "fixture", "user_code": "FIXTURE",
            "verification_uri": "https://portal.example.invalid/device",
            "verification_uri_complete": "https://portal.example.invalid/device", "expires_in": 600, "interval": 1})
    if path == "/api/oauth/token":
        return httpx.Response(200, json={"access_token": ACCOUNT_TOKEN, "refresh_token": "synthetic_refresh",
            "expires_in": 86400, "scope": "inference:invoke",
            "inference_base_url": "https://inference-api.nousresearch.com/v1"})
    assert path == "/api/anonymous/claim", path
    bearer = request.headers["authorization"].removeprefix("Bearer ")
    payload = bearer.split(".")[1]
    assert json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["sub"] == "account_fixture"
    claims.append(json.loads(request.content)["token"])
    if os.environ.get("HANDOFF_TRANSIENT") == "1" and len(claims) == 1:
        return httpx.Response(503, json={"error": "temporarily_unavailable"}, headers={"retry-after": "300"})
    return httpx.Response(200, json={"status": "claimed", "account_email": "fixture@example.invalid",
        "connectors": {"kind": "moved", "moved_toolkits": ["calendar"], "dropped_toolkits": []},
        "cohort_carried": False})


RealClient = httpx.Client


class Client(RealClient):
    def __init__(self, *args, **kwargs):
        kwargs.pop("verify", None)
        super().__init__(*args, **kwargs, transport=httpx.MockTransport(respond))


httpx.Client = Client


class ControlledStop:
    def __init__(self):
        self.condition = threading.Condition()
        self.stopped = False
        self.ticks = 0
        self.waiting = threading.Event()

    def clear(self):
        with self.condition:
            self.stopped = False

    def set(self):
        with self.condition:
            self.stopped = True
            self.condition.notify_all()

    def wait(self, delay):
        with self.condition:
            self.waiting.set()
            self.condition.wait_for(lambda: self.stopped or self.ticks)
            if self.stopped:
                return True
            self.ticks -= 1
            return False

    def tick(self):
        with self.condition:
            self.waiting.clear()
            self.ticks += 1
            self.condition.notify_all()
        assert self.waiting.wait(10), "native worker did not finish its tick"


stop = ControlledStop()
handoff._worker_stop = stop


def snapshot():
    records = list(handoff._load(handoff._records_path())["records"].values())
    return {"records": [{"state": r["state"], "attempts": r["attempts"],
        "credential_retained": "anon_token" in r, "due": handoff._due(r, clock[0]),
        "moved": (r.get("result") or {}).get("moved_toolkits", [])} for r in records],
        "claims": len(claims), "worker_alive": bool(handoff._worker_thread and handoff._worker_thread.is_alive())}


if sys.argv[2] == "seed":
    from hermes_cli.anon_sign_in import run_sign_in
    states = list(run_sign_in())
    assert states[-1].ok, repr(states[-1])
    print(json.dumps(snapshot()))
else:
    from talaria_sidecar import __main__ as main
    from talaria_sidecar.methods import oauth
    original_build = main.build_methods

    def build(runtime):
        methods = original_build(runtime)

        def tick(ctx, params):
            clock[0] += params.get("advance", 301)
            if handoff._worker_thread and handoff._worker_thread.is_alive():
                assert stop.waiting.wait(10)
                stop.tick()
            return snapshot()

        def inspect(ctx, params):
            return snapshot()

        def flow_join(ctx, params):
            flow = oauth._flow(Path(os.environ["HERMES_HOME"]), params["flow_id"])
            for thread in threading.enumerate():
                if thread.name == f"oauth-{flow.flow_id[:6]}":
                    thread.join(15)
                    assert not thread.is_alive()
            return oauth.poll(flow.home, flow.flow_id)

        def native_start(ctx, params):
            from hermes_cli.nous_auth_keepalive import start_nous_auth_keepalive
            previous = handoff._worker_thread
            assert start_nous_auth_keepalive(interval_seconds=0) is None
            assert handoff._worker_thread is previous
            if params.get("construct"):
                from run_agent import AIAgent
                agent = AIAgent(model="fixture-model", provider="nous", api_key="synthetic_key",
                    base_url="https://inference-api.nousresearch.com/v1", enabled_toolsets=[],
                    skip_memory=True, skip_background_review=True, skip_context_files=True, quiet_mode=True)
                try:
                    assert handoff._worker_thread is previous, "Nous agent duplicated native worker"
                finally:
                    agent.close()
            return snapshot()

        methods.update({"probe.tick": tick, "probe.inspect": inspect,
                        "probe.flow_join": flow_join, "probe.native_start": native_start})
        return methods

    main.build_methods = build
    try:
        assert main.main() == 0
        assert handoff._worker_thread is None, "process teardown retained the native worker"
    finally:
        handoff.stop_worker()
