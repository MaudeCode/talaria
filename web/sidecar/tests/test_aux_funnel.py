"""TAL-823: ``aux.complete``'s default route runs through the pinned Agent's ``call_llm``, so a Talaria title call
reaches the Agent's auxiliary plugin hooks and carries a custom provider's ``extra_body``. A stub OpenAI-compatible
endpoint and a synthetic hook plugin live in a disposable home."""

from __future__ import annotations

import json
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, SidecarProcess, assert_matches, isolated_env, requires_agent

pytestmark = requires_agent


class _Stub(BaseHTTPRequestHandler):
    bodies: list[dict] = []

    def log_message(self, *args):  # noqa: D102 - quiet
        pass

    def do_GET(self):  # noqa: N802 - model probes: no metadata
        self.send_response(404)
        self.end_headers()

    def do_POST(self):  # noqa: N802 - streams the title in two token chunks
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        _Stub.bodies.append(body)
        if not body.get("stream"):
            data = json.dumps({"id": "c1", "object": "chat.completion", "created": 0, "model": "stub-model",
                               "choices": [{"index": 0, "message": {"role": "assistant", "content": "Ship it"}, "finish_reason": "stop"}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for delta, finish in (({"role": "assistant", "content": "Ship "}, None), ({"content": "it"}, None), ({}, "stop")):
            chunk = {"id": "c1", "object": "chat.completion.chunk", "created": 0, "model": "stub-model", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")


@pytest.fixture
def llm():
    _Stub.bodies = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Stub)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}/v1"
    server.shutdown()


HOOK_PLUGIN = """import json, os

def _record(event):
    def hook(**kwargs):
        with open(os.environ["HERMES_HOME"] + "/aux-hooks.jsonl", "a") as out:
            out.write(json.dumps({"event": event, "aux_task": kwargs.get("aux_task")}) + "\\n")
    return hook

def register(ctx):
    ctx.register_hook("pre_auxiliary_call", _record("pre"))
    ctx.register_hook("post_auxiliary_call", _record("post"))
"""


def _title_call(hermes_home, llm) -> list[dict]:
    """One Talaria title call through the default auxiliary route; its token frames and result are unchanged.
    Returns the hook plugin's records."""
    plugin = hermes_home / "plugins" / "aux_probe"
    plugin.mkdir(parents=True)
    (plugin / "plugin.yaml").write_text(json.dumps({"name": "aux_probe", "version": "0.1.0", "description": "aux hook probe"}))
    (plugin / "__init__.py").write_text(HOOK_PLUGIN)
    config = {
        "model": {"provider": "custom", "default": "stub-model", "base_url": llm, "api_key": "sk-stub"},
        "custom_providers": [{"name": "stub", "base_url": llm, "api_key": "sk-stub", "extra_body": {"user": "talaria-probe"}}],
        "plugins": {"enabled": ["aux_probe"]},
    }
    # JSON is valid YAML.
    (hermes_home / "config.yaml").write_text(json.dumps(config))
    proc = SidecarProcess(hermes_home)
    try:
        params = {"profile_home": str(hermes_home), "task": "title_generation", "messages": [{"role": "system", "content": "Title it."}, {"role": "user", "content": "ship it?"}], "max_tokens": 64}
        message, frames = proc.call("aux.complete", params, timeout=60)
    finally:
        proc.close()
    assert "error" not in message, message
    assert_matches("aux.complete", message["result"])
    assert message["result"]["text"] == "Ship it" and message["result"]["finish_reason"] == "stop"
    assert [frame["data"]["text"] for frame in frames if frame["event"] == "token"] == ["Ship ", "it"]
    records = hermes_home / "aux-hooks.jsonl"
    return [json.loads(line) for line in records.read_text().splitlines()] if records.exists() else []


def test_a_title_call_reaches_the_plugin_hooks_with_the_custom_provider_extra_body(hermes_home, llm) -> None:
    assert _title_call(hermes_home, llm) == [{"event": "pre", "aux_task": "title_generation"}, {"event": "post", "aux_task": "title_generation"}]
    (body,) = _Stub.bodies
    assert body["stream"] is True and body.get("user") == "talaria-probe", body


# Runs on the Agent interpreter: the test holds the task's only permit on the Agent's own semaphore, so the call is
# known to queue behind it; the cancel lands while it waits, and the permit is released only after the call returned.
QUEUED_CANCEL = """
import threading, time
from agent import auxiliary_client
from talaria_sidecar.errors import Cancelled
from talaria_sidecar.methods import aux

class Ctx:
    def __init__(self):
        self.cancel_event = threading.Event()
    def check_cancelled(self):
        if self.cancel_event.is_set():
            raise Cancelled()
    def emit(self, event, data=None):
        pass

permit = auxiliary_client._acquire_sync_aux_semaphore("title_generation")
assert permit is not None and permit.acquire(timeout=10), "the task has no permit limit"
ctx, outcome = Ctx(), {}
def call():
    try:
        outcome["result"] = aux.complete("title_generation", [{"role": "user", "content": "ship it?"}], main_runtime=None, max_tokens=64, temperature=None, ctx=ctx)
    except BaseException as exc:
        outcome["error"] = exc
caller = threading.Thread(target=call)
caller.start()
deadline = time.monotonic() + 30
while not (helpers := [t for t in threading.enumerate() if t.name == "aux-title_generation"]):
    assert caller.is_alive() and time.monotonic() < deadline, outcome
    time.sleep(0.01)
ctx.cancel_event.set()
caller.join(30)
assert not caller.is_alive() and isinstance(outcome.get("error"), Cancelled), outcome
permit.release()  # the queued call now takes the permit; the Agent drops it before dispatch
helpers[0].join(30)
assert not helpers[0].is_alive(), "the queued call never finished"
"""


def test_a_title_cancelled_while_queued_for_the_task_permit_never_reaches_the_provider(hermes_home, llm) -> None:
    config = {"model": {"provider": "custom", "default": "stub-model", "base_url": llm, "api_key": "sk-stub"},
              "auxiliary": {"title_generation": {"max_concurrency": 1}}}
    (hermes_home / "config.yaml").write_text(json.dumps(config))
    run = subprocess.run([AGENT_PYTHON, "-c", QUEUED_CANCEL], env=isolated_env(hermes_home, PYTHONPATH=f"{SIDECAR_ROOT}:{AGENT_DIR}"),
                         capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stdout + run.stderr[-4000:]
    assert _Stub.bodies == []
