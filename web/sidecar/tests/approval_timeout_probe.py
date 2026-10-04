"""Run on the Agent interpreter: one ``chat.start`` turn whose stand-in Agent parks a real gateway approval that
``approvals.timeout`` expires unanswered.

Prints one JSON line with the turn's approval frames and what the Agent still holds afterwards.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.append(sys.argv[1])
os.environ["HERMES_GATEWAY_SESSION"] = "1"

from tools import approval  # noqa: E402
from tools.approval_context import set_current_session_key  # noqa: E402

from talaria_sidecar.methods import chat  # noqa: E402

SID = "timeout-probe"


class Agent:
    def __init__(self, **kwargs):
        pass

    def clear_interrupt(self):
        pass

    def interrupt(self, message, hard_cancel=False):
        pass

    def run_conversation(self, **kwargs):
        set_current_session_key(SID)
        guard = approval.check_all_command_guards("rm -rf /tmp/talaria-timeout-probe", "local")
        return {"final_response": json.dumps({"approved": guard.get("approved")}), "messages": []}


class Ctx:
    cancelled = False

    def __init__(self):
        self.frames: list[tuple[str, dict]] = []

    def emit(self, event, data=None):
        self.frames.append((event, data or {}))


chat._resolve_runtime = lambda provider, model: {"model": "m", "provider": "p"}
chat._agent_class = lambda: Agent
chat._profile_toolsets = lambda: ["terminal"]
chat._profile_fallback_chain = lambda: None
ctx = Ctx()
result = chat.start(ctx, {"profile_home": os.environ["HERMES_HOME"], "session_id": SID, "stream_id": "st-timeout", "user_message": "hi", "conversation_history": [], "model": "m", "model_provider": "p"})
frames = [(event, data) for event, data in ctx.frames if event.startswith("approval")]
print(json.dumps({
    "status": result.get("status"),
    "events": [event for event, _ in frames],
    "resolved": [{"same_id": data.get("approval_id") == frames[0][1].get("approval_id"), "reason": data.get("reason")} for event, data in frames if event == "approval_resolved"],
    "agent_pending": approval.list_gateway_approvals(SID),
}))
