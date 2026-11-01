"""TAL-1510: the installed Agent's MCP events owner, observed through ``mcp.events``.

Real discovery connects a stub stdio server that never advertises ``events``; the native utility tools are
dispatched through the Agent's registry and consent gate (the human answer is the only replaced boundary).
Subscribe, refresh, lapse and revoke are native route and grant writes: no public endpoint, webhook delivery
or external subscription is involved. Each observation must equal the shared contract fixture's sidecar data."""
import importlib.util
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, sys.argv[1])
stub, fixture_path = sys.argv[2], sys.argv[3]
fixture = {case["name"]: case for case in json.loads(Path(fixture_path).read_text())["cases"]}
home = Path(os.environ["HERMES_HOME"])


def configure(public_url=None):
    webhook = f"platforms:\n  webhook:\n    extra:\n      public_url: {json.dumps(public_url)}\n" if public_url else ""
    (home / "config.yaml").write_text(webhook + "mcp_servers:\n"
                                      f"  events:\n    command: {json.dumps(sys.executable)}\n    args: [{json.dumps(stub)}, events]\n    events: true\n"
                                      f"  plain:\n    command: {json.dumps(sys.executable)}\n    args: [{json.dumps(stub)}, plain]\n")


home.mkdir(parents=True, exist_ok=True)
configure()
from talaria_sidecar.home import scoped_home  # noqa: E402
from talaria_sidecar.methods.mcp import events  # noqa: E402

servers = {"events": {"command": "stub", "events": True}}
if importlib.util.find_spec("tools.mcp_tool_events") is None:
    with scoped_home(home):
        assert events(servers) == fixture["older_agent"]["data"], events(servers)
    print(json.dumps({"agent": "without MCP events"}))
    raise SystemExit(0)

from tools.mcp_tool_discovery import discover_mcp_tools  # noqa: E402
from tools.mcp_tool_events import _route_name, _store_grant, _write_route  # noqa: E402
from tools.registry import registry  # noqa: E402


def observe(now=None):
    with scoped_home(home):
        return events(servers, now=now)


def server_row(data):
    return {**data, "servers": [row for row in data["servers"] if row["name"] == "events"]}


with scoped_home(home):
    discover_mcp_tools()
    names = registry.get_all_tool_names()
# The opted-in server gets the utilities although its parsed capabilities carry no ``events``; the other does not.
assert {"mcp__events__list_event_types", "mcp__events__subscribe_event", "mcp__events__unsubscribe_event"} <= set(names), names
assert not any(name.startswith("mcp__plain__") and name.endswith("_event_types") for name in names), names
assert server_row(observe()) == fixture["opt_in_without_public_url"]["data"], observe()
with scoped_home(home):
    plain = events({"events": {}, "plain": {}})["servers"][1]
assert plain == {"name": "plain", "utilities": 0, "subscriptions": fixture["opt_out"]["data"]["servers"][0]["subscriptions"]}, plain

# Native utilities stay callable through the Agent's own dispatch and consent gate.
asked = []
def answer(value):
    def respond(*args, **kwargs):
        asked.append(kwargs.get("surface"))
        return value
    return respond
with scoped_home(home), patch("tools.approval_prompt.request_elicitation_consent", side_effect=answer("decline")):
    refused = json.loads(registry.dispatch("mcp__events__subscribe_event", {"name": "tick"}))
assert "did not approve" in refused["error"], refused
with scoped_home(home), patch("tools.approval_prompt.request_elicitation_consent", side_effect=answer("accept")):
    blocked = json.loads(registry.dispatch("mcp__events__subscribe_event", {"name": "tick"}))
assert "public_url" in json.dumps(blocked), blocked
with scoped_home(home):
    missing = json.loads(registry.dispatch("mcp__events__unsubscribe_event", {"name": "tick"}))
assert "No subscription" in json.dumps(missing), missing
assert asked == ["mcp-events/events", "mcp-events/events"], asked

configure("http://insecure.example")
assert observe()["callback"] == "not_https", observe()
configure("https://events.example")
assert observe()["callback"] == "ready", observe()

# Subscribe: native route then grant; a second route is paused in the webhook dashboard.
now = time.time()
iso = lambda seconds: datetime.fromtimestamp(now + seconds, timezone.utc).isoformat()  # noqa: E731
route = lambda name, enabled=True: {"secret": "whsec_synthetic", "prompt": "p", "deliver": "log", "enabled": enabled,  # noqa: E731
                                    "mcp_event": {"server": "events", "name": name, "arguments": {}}}
tick, paused = _route_name("events", "tick", {}), _route_name("events", "paused", {})
with scoped_home(home):
    _write_route(tick, route("tick"))
    assert server_row(observe(now))["servers"][0]["subscriptions"]["pending"] == 1
    _store_grant(tick, {"id": "sub-1", "refreshBefore": iso(3600)}, "https://events.example/webhooks/" + tick)
    _write_route(paused, route("paused", enabled=False))
data = server_row(observe(now))
assert data == fixture["connected_subscription"]["data"], data
assert "whsec_synthetic" not in json.dumps(data) and "sub-1" not in json.dumps(data), data

# Refresh renews the grant; without one the record goes overdue at its refresh time, then lapses at expiry.
with scoped_home(home):
    _store_grant(tick, {"id": "sub-1", "refreshBefore": iso(7200)}, "https://events.example/webhooks/" + tick)
assert observe(now + 3600)["servers"][0]["subscriptions"]["active"] == 1, observe(now + 3600)
assert observe(now + 6000)["servers"][0]["subscriptions"]["refresh_overdue"] == 1, observe(now + 6000)
assert observe(now + 7300)["servers"][0]["subscriptions"]["lapsed"] == 1, observe(now + 7300)

# Revocation (the Agent removes a refused or unsubscribed route) leaves nothing behind.
with scoped_home(home):
    _write_route(tick, None)
    _write_route(paused, None)
assert server_row(observe(now)) == fixture["revoked_subscription"]["data"], observe(now)
print(json.dumps({"utilities": "native", "consent": asked, "states": "observed"}))
