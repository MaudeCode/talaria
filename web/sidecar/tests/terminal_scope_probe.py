"""Run on the Agent interpreter: concurrent ``chat.start`` turns in the root and two named profiles.

A stand-in Agent reads the terminal tool's resolved backend config mid-turn while every
profile's turn is live at once. Prints one JSON line with what each turn saw.
"""

from __future__ import annotations

import json
import os
import sys
import threading
from pathlib import Path

sys.path.append(sys.argv[1])

from talaria_sidecar.methods import chat  # noqa: E402
from tools.terminal_tool import _get_env_config  # noqa: E402

ROOT = Path(os.environ["HERMES_HOME"])
HOMES = {"default": ROOT, "alpha": ROOT / "profiles" / "alpha", "beta": ROOT / "profiles" / "beta"}
FIELDS = ("env_type", "docker_image", "ssh_host", "ssh_user")
barrier = threading.Barrier(len(HOMES), timeout=30)
results: dict = {}


class ObservingAgent:
    def __init__(self, **kwargs):
        self.session_id = kwargs.get("session_id")

    def run_conversation(self, **kwargs):
        barrier.wait()  # every profile's turn is live before anyone reads
        config = _get_env_config()
        results[self.session_id] = {field: config[field] for field in FIELDS}
        barrier.wait()  # and stays live until everyone has read
        return {"final_response": "ok", "messages": [{"role": "assistant", "content": "ok"}]}


class Ctx:
    cancelled = False

    def emit(self, event, data=None):
        pass


class Registry:
    def __init__(self):
        self.methods: dict = {}

    def method(self, name, **_):
        return lambda fn: self.methods.setdefault(name, fn)


chat._resolve_runtime = lambda provider, model: {"model": "m", "provider": "p"}
chat._agent_class = lambda: ObservingAgent
registry = Registry()
chat.register(registry)


def _turn(name: str) -> None:
    params = {"profile_home": str(HOMES[name]), "session_id": name, "stream_id": f"st-{name}", "user_message": "hi",
              "conversation_history": [], "model": "m", "model_provider": "p", "workspace": str(ROOT)}
    try:
        registry.methods["chat.start"](Ctx(), params)
    except Exception as exc:  # noqa: BLE001 - reported to the test
        barrier.abort()
        results[name] = f"{type(exc).__name__}: {exc}"


threads = [threading.Thread(target=_turn, args=(name,)) for name in HOMES]
for thread in threads:
    thread.start()
for thread in threads:
    thread.join()
print(json.dumps(results, sort_keys=True))
