"""Run on the Agent interpreter: park two real gateway approvals, turn YOLO on through ``approval.set_yolo``, turn it off.

Prints one JSON line with the choice each parked waiter was released with, whether its pattern stayed
session-approved after YOLO turned off, and whether the same command parks a fresh approval again.
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

SID = "yolo-probe"
COMMANDS = ["rm -rf /tmp/talaria-yolo-probe-a", "chmod -R 777 /tmp/talaria-yolo-probe-b"]
choices: list[str] = []
approval.register_gateway_notify(SID, lambda data: None)
real_persist = approval._persist_choice


def _record(session_key, choice, warnings):
    choices.append(choice)
    return real_persist(session_key, choice, warnings)


approval._persist_choice = _record


def _guard(command: str, out: dict) -> None:
    set_current_session_key(SID)
    out[command] = approval.check_all_command_guards(command, "local")


def _wait_parked(count: int, *, guard: threading.Thread | None = None) -> bool:
    """True once ``count`` approvals are parked; False when ``guard`` finished without parking (it never prompted)."""
    deadline = time.monotonic() + 20
    while len(approval.list_gateway_approvals(SID)) < count:
        if guard is not None and not guard.is_alive():
            return False
        if time.monotonic() > deadline:
            raise SystemExit(f"timed out waiting for {count} parked approvals")
        time.sleep(0.02)
    return True


registry = Registry(runtime=types.SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
chat.register(registry)
results: dict = {}
threads = [threading.Thread(target=_guard, args=(command, results)) for command in COMMANDS]
for thread in threads:
    thread.start()
_wait_parked(len(COMMANDS))
keys = [key for entry in approval.list_gateway_approvals(SID) for key in (entry.get("pattern_keys") or [entry.get("pattern_key")])]
enabled = registry.methods["approval.set_yolo"](None, {"session_id": SID, "enabled": True})
for thread in threads:
    thread.join(20)
registry.methods["approval.set_yolo"](None, {"session_id": SID, "enabled": False})
still_approved = [approval.is_approved(SID, key) for key in keys]
again: dict = {}
retry = threading.Thread(target=_guard, args=(COMMANDS[0], again))
retry.start()
prompts_again = _wait_parked(1, guard=retry)
approval.resolve_gateway_approval(SID, "deny", resolve_all=True)
retry.join(20)
print(json.dumps({"released": enabled["released"], "choices": choices, "approved": [results[c].get("approved") for c in COMMANDS], "still_approved": still_approved, "prompts_again": prompts_again}))
