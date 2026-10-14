"""TAL-818: ``connectors.*`` round-trips through the Agent's own portal client and connect operation against a synthetic
portal and gateway: catalog, accounts, remove, tools, a policy revision conflict, and a page connect that turns
connected without a chat session."""

from __future__ import annotations

import json
import time

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SidecarProcess, assert_matches
from connectors_portal import Portal, seed_identity, serve
from talaria_sidecar import SIDECAR_RPC_VERSION

pytestmark = pytest.mark.skipif(AGENT_DIR is None or AGENT_PYTHON is None, reason="pinned Hermes Agent checkout with venv not found")


@pytest.fixture
def portal():
    return Portal()


@pytest.fixture
def connected(hermes_home, portal):
    """A sidecar whose profile is signed in to the synthetic portal."""
    with serve(portal) as origin:
        proc = SidecarProcess(hermes_home, env=seed_identity(hermes_home, origin))
        try:
            assert proc.result("runtime.handshake", {"rpc_version": SIDECAR_RPC_VERSION})["compatible"]
            yield proc
        finally:
            proc.close()


def call(proc: SidecarProcess, method: str, home, **params) -> dict:
    message, _ = proc.call(method, {"profile_home": str(home), **params}, timeout=90)
    if "result" in message:
        assert_matches(method, message["result"])
    return message


def result(proc, method, home, **params) -> dict:
    message = call(proc, method, home, **params)
    assert "error" not in message, message["error"]
    return message["result"]


def condition(message: dict) -> str:
    return message["error"]["data"]["condition"]


def test_catalog_accounts_and_remove_round_trip(connected, hermes_home, portal):
    assert result(connected, "connectors.available", hermes_home) == {"available": True}
    catalog = result(connected, "connectors.catalog", hermes_home)
    assert [row["slug"] for row in catalog["connectors"]] == ["gmail", "notion"]
    assert catalog["connectors"][0] == {"slug": "gmail", "name": "Gmail", "description": "Read and send mail.", "category": "communication", "logo_url": None}

    accounts = result(connected, "connectors.accounts", hermes_home)["accounts"]
    assert [(row["connection_id"], row["connector"], row["status"], row["active"]) for row in accounts] == [("conn-notion", "notion", "active", True)]

    assert result(connected, "connectors.remove", hermes_home, connection_id="conn-notion") == {"connection_id": "conn-notion", "connector": "notion", "status": "removed"}
    assert result(connected, "connectors.accounts", hermes_home) == {"accounts": []}
    assert condition(call(connected, "connectors.remove", hermes_home, connection_id="conn-notion")) == "connection_not_found"


def test_tools_list_and_unknown_connector(connected, hermes_home):
    listing = result(connected, "connectors.tools", hermes_home, connector="gmail")
    assert [tool["slug"] for tool in listing["tools"]] == ["gmail_read", "gmail_send"]
    assert condition(call(connected, "connectors.tools", hermes_home, connector="nope")) == "connector_not_found"


def test_policy_writes_and_a_stale_revision_conflicts(connected, hermes_home, portal):
    policy = result(connected, "connectors.policy.get", hermes_home)
    member = next(layer for layer in policy["layers"] if layer["kind"] == "member")
    assert member["revision"] == "rev-1"

    turned_off = result(connected, "connectors.policy.set", hermes_home, connector="gmail", expected_revision="rev-1", enabled=False)
    assert turned_off == {"revision": "rev-2"}
    assert portal.member["disabledConnectors"] == ["gmail"]

    tool_off = result(connected, "connectors.policy.set", hermes_home, connector="notion", expected_revision="rev-2", tool="notion_send", tool_enabled=False)
    assert tool_off == {"revision": "rev-3"}
    assert portal.member["tools"] == {"notion": {"disable": ["notion_send"]}}

    # Another device changed the rules since this page read rev-2: the portal refuses, nothing changes.
    stale = call(connected, "connectors.policy.set", hermes_home, connector="gmail", expected_revision="rev-2", enabled=True)
    assert condition(stale) == "policy_conflict"
    assert portal.member["disabledConnectors"] == ["gmail"]


def test_a_page_connect_turns_connected_without_a_chat_session(connected, hermes_home, portal):
    started = result(connected, "connectors.connect", hermes_home, connector="gmail")
    [target] = started["targets"]
    assert (target["name"], target["state"], started["settled"]) == ("gmail", "initiated", False)
    assert target["connect_url"] == "https://vendor.example.test/authorize/conn-gmail-1"

    # A second Connect while the link is open rejoins the same operation instead of minting another link.
    assert result(connected, "connectors.connect", hermes_home, connector="gmail")["op_id"] == started["op_id"]
    assert portal.connect_count == 1

    portal.finish_authorization("gmail")
    deadline = time.monotonic() + 20
    view = started
    while time.monotonic() < deadline and not view["settled"]:
        time.sleep(0.2)
        view = result(connected, "connectors.operation", hermes_home, op_id=started["op_id"])
    assert view["settled"] and view["targets"][0]["state"] == "connected"
    assert view["targets"][0].get("connect_url") is None
    assert condition(call(connected, "connectors.respond", hermes_home, op_id=started["op_id"], action="continue")) == "operation_settled"


def test_skip_ends_a_page_connect(connected, hermes_home):
    started = result(connected, "connectors.connect", hermes_home, connector="gmail")
    skipped = result(connected, "connectors.respond", hermes_home, op_id=started["op_id"], action="skip", target="gmail")
    assert skipped["settled"] and skipped["targets"][0]["state"] == "skipped"
    assert condition(call(connected, "connectors.operation", hermes_home, op_id="unknown-op")) == "operation_not_found"


def test_connectors_turned_off_close_every_page_action(hermes_home, portal):
    (hermes_home / "config.yaml").write_text("tools:\n  connectors:\n    enabled: false\n", encoding="utf-8")
    with serve(portal) as origin:
        proc = SidecarProcess(hermes_home, env=seed_identity(hermes_home, origin))
        try:
            proc.result("runtime.handshake", {"rpc_version": SIDECAR_RPC_VERSION})
            assert result(proc, "connectors.available", hermes_home) == {"available": False}
            assert condition(call(proc, "connectors.catalog", hermes_home)) == "connectors_unavailable"
        finally:
            proc.close()


CHAT_PROBE = r'''
import json, os, sys, threading
sys.path.append(sys.argv[1])
from tools.connectors import manage_connections
from talaria_sidecar.methods import Registry, chat, connectors

home = os.environ["HERMES_HOME"]
registry = Registry(runtime=None)
chat.register(registry)
frames, tool_results, answers = [], [], []

class Agent:
    def __init__(self, **kwargs):
        self.connection_callback = kwargs.get("connection_callback")
    def interrupt(self, *args, **kwargs):
        pass
    def run_conversation(self, **kwargs):
        # What the Agent's inline executor does for a manage_connections call (agent/inline_tool_executors.py).
        tool_results.append(json.loads(manage_connections({"action": "connect", "connectors": ["gmail"]}, session_id="s-connect",
                                                          tool_call_id="call-1", connection_callback=self.connection_callback)))
        return {"final_response": "ok", "messages": []}

def press_continue(op_id):
    from talaria_sidecar.home import scoped_home
    from pathlib import Path
    with scoped_home(Path(home)):
        answers.append(connectors.respond(Path(home), op_id, "continue", None, {}))

class Ctx:
    cancelled = False
    def emit(self, event, data=None):
        frames.append([event, data])
        if event == "connection":
            threading.Thread(target=press_continue, args=(data["op_id"],)).start()

chat._agent_class = lambda: Agent
chat._resolve_runtime = lambda provider, model: {"model": "m", "provider": "p"}
chat._discover_mcp_tools = lambda run: None
chat._profile_toolsets = lambda: ["connections"]
chat._profile_fallback_chain = lambda: None
chat._main_model_request_overrides = lambda model, provider, base_url="": None
chat.checkpoint_kwargs = lambda: {}
result = chat.start(Ctx(), {"profile_home": home, "session_id": "s-connect", "stream_id": "st-connect", "user_message": "Connect Gmail",
                            "model": "m", "model_provider": "p", **({"connect_card": True} if sys.argv[2] == "card" else {})})
print(json.dumps({"frames": [f for f in frames if f[0] == "connection"], "tool": tool_results, "answers": answers, "status": result["status"]}))
'''


def run_chat_probe(tmp_path, portal, mode: str) -> dict:
    import json
    import subprocess

    from conftest import isolated_env

    home = tmp_path / "hermes"
    home.mkdir()
    with serve(portal) as origin:
        run = subprocess.run([AGENT_PYTHON, "-c", CHAT_PROBE, str(AGENT_DIR), mode], env=isolated_env(home, **seed_identity(home, origin)),
                             capture_output=True, text=True, timeout=90)
    assert run.returncode == 0, run.stderr[-4000:]
    return json.loads(run.stdout.strip().splitlines()[-1])


def test_a_chat_connect_opens_the_card_frame_and_continue_returns_the_tool(tmp_path, portal):
    observed = run_chat_probe(tmp_path, portal, "card")
    [[_, frame]] = observed["frames"]
    assert frame["tool_call_id"] == "call-1" and frame["settled"] is False
    assert [(t["name"], t["state"], t["connect_url"]) for t in frame["targets"]] == [("gmail", "initiated", "https://vendor.example.test/authorize/conn-gmail-1")]
    assert observed["answers"][0]["settled"] is True
    [tool] = observed["tool"]
    assert tool["status"] == "settled" and tool["settled_by"] == "continue"
    assert [(t["name"], t["state"]) for t in tool["targets"]] == [("gmail", "not_connected")]


def test_a_client_without_the_card_keeps_the_agents_plain_connect_link(tmp_path, portal):
    """A client that does not draw the card (the App before it adopts it) never waits on one: the tool answers at once."""
    observed = run_chat_probe(tmp_path, portal, "plain")
    assert observed["frames"] == [] and observed["answers"] == []
    [tool] = observed["tool"]
    assert "https://vendor.example.test/authorize/conn-gmail-1" in json.dumps(tool)
