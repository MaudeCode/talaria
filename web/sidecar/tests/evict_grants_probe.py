"""Run on the Agent interpreter: evict a session's cached agent the way model switch/truncate and delete/clear do.

Prints one JSON line: whether an "allow for session" grant and a parked approval survive a cache-only eviction (idle
and during a live run), whether the live run keeps its cached agent, and what a delete/clear eviction leaves behind.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import types

sys.path.append(sys.argv[1])
os.environ["HERMES_GATEWAY_SESSION"] = "1"

from tools import approval  # noqa: E402
from tools.approval_context import set_current_session_key  # noqa: E402

from talaria_sidecar.methods import Registry, chat  # noqa: E402

SID = "evict-probe"
PATTERN = "recursive delete"
COMMAND = "rm -rf /tmp/talaria-evict-probe"
approval.register_gateway_notify(SID, lambda data: None)
registry = Registry(runtime=types.SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
chat.register(registry)
evict = registry.methods["chat.evict_agent"]
out: dict = {}

# Model switch / truncate on an idle session.
approval.approve_session(SID, PATTERN)
chat._AGENT_CACHE[SID] = (object(), "sig")
out["idle_evicted"] = evict(None, {"session_id": SID})["evicted"]
out["grant_after_switch"] = approval.is_approved(SID, PATTERN)

# Model switch while a turn is parked on an approval.
guard: dict = {}


def _guard() -> None:
    set_current_session_key(SID)
    guard["result"] = approval.check_all_command_guards(COMMAND, "local")


chat._AGENT_CACHE[SID] = (object(), "sig")
run = chat._Run("evict-stream", SID, None)
chat._RUNS["evict-stream"], chat._RUNS_BY_SESSION[SID] = run, "evict-stream"
waiter = threading.Thread(target=_guard)
waiter.start()
deadline = time.monotonic() + 20
while not approval.list_gateway_approvals(SID):
    if time.monotonic() > deadline:
        raise SystemExit("timed out waiting for the parked approval")
    time.sleep(0.02)
out["live_evicted"] = evict(None, {"session_id": SID})["evicted"]
out["live_agent_cached"] = SID in chat._AGENT_CACHE
out["pending_after_switch"] = len(approval.list_gateway_approvals(SID))
run.finished.set()
chat._RUNS.pop("evict-stream"), chat._RUNS_BY_SESSION.pop(SID)

# Delete / clear ends the session's approval state.
out["clear_evicted"] = evict(None, {"session_id": SID, "clear_session": True})["evicted"]
waiter.join(20)
out["grant_after_clear"] = approval.is_approved(SID, PATTERN)
out["parked_released"] = guard.get("result", {}).get("approved")
print(json.dumps(out))
