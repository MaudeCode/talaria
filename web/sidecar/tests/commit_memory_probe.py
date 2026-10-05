"""Run on the Agent interpreter: ``chat.commit_memory`` for a cached Agent in a named profile.

Prints one JSON line with what a recording memory provider saw at ``on_session_end``: the messages, the Hermes home and
the profile's credential, after a named-profile call has switched the process to multiplexing.
"""

from __future__ import annotations

import json
import os
import sys
import types
from pathlib import Path

sys.path.append(sys.argv[1])

from agent.memory_manager import MemoryManager  # noqa: E402
from agent.memory_provider import MemoryProvider  # noqa: E402
from agent.secret_scope import get_secret  # noqa: E402
from hermes_constants import get_hermes_home  # noqa: E402
from run_agent import AIAgent  # noqa: E402

from talaria_sidecar.home import scoped_home  # noqa: E402
from talaria_sidecar.methods import Registry, chat  # noqa: E402

SID = "commit-probe"
ALPHA = Path(os.environ["HERMES_HOME"]) / "profiles" / "alpha"
MESSAGES = [{"role": "user", "content": "remember the blue door"}, {"role": "assistant", "content": "noted"}]
seen: list = []


class Recording(MemoryProvider):
    name = "recording"

    def is_available(self) -> bool:
        return True

    def initialize(self, session_id: str, **kwargs) -> None:
        pass

    def get_tool_schemas(self) -> list:
        return []

    def on_session_end(self, messages) -> None:
        try:
            secret = get_secret("ALPHA_ONLY")
        except Exception as exc:  # noqa: BLE001 - reported to the test
            secret = type(exc).__name__
        seen.append({"messages": list(messages), "home": str(get_hermes_home()), "secret": secret})


manager = MemoryManager()
manager.add_provider(Recording())
agent = AIAgent.__new__(AIAgent)
agent._memory_manager, agent.context_compressor, agent.session_id, agent._session_messages = manager, None, SID, list(MESSAGES)

with scoped_home(ALPHA):  # an earlier named-profile turn leaves the process multiplexing
    pass
registry = Registry(runtime=types.SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
chat.register(registry)
chat._AGENT_CACHE[SID] = (agent, "sig")
result = registry.methods["chat.commit_memory"](None, {"session_id": SID, "profile_home": str(ALPHA)})
print(json.dumps({"result": result, "seen": seen}))
