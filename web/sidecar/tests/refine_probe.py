"""Run on the Agent interpreter: ``chat.refine`` in a named profile with stand-in agents.

Prints one JSON line: per scenario (the session's cached agent, an agent built for a session without one, a running
turn, an empty conversation) the method's output and what each ``_spawn_background_review`` call received, with the
Hermes home and profile credential both at the call and inside the review thread the Agent starts from it.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import types
from pathlib import Path

sys.path.append(sys.argv[1])

from agent.secret_scope import get_secret  # noqa: E402
from hermes_constants import get_hermes_home  # noqa: E402
from tools.thread_context import propagate_context_to_thread  # noqa: E402

from talaria_sidecar.home import scoped_home  # noqa: E402
from talaria_sidecar.methods import Registry, chat  # noqa: E402

ALPHA = Path(os.environ["HERMES_HOME"]) / "profiles" / "alpha"
MESSAGES = [{"role": "user", "content": "deploy with the blue script"}, {"role": "assistant", "content": "deployed"}]


def where() -> dict:
    try:
        secret = get_secret("ALPHA_ONLY")
    except Exception as exc:  # noqa: BLE001 - reported to the test
        secret = type(exc).__name__
    return {"home": str(get_hermes_home()), "secret": secret}


class Agent:
    """The Agent's review entry point, recording its arguments; the fork runs on a thread like the Agent's ``bg-review``."""

    def __init__(self, tools=("memory", "skill_manage"), **kwargs):
        self.valid_tool_names, self.kwargs, self.reviews = set(tools), kwargs, []

    def _spawn_background_review(self, **kwargs):
        review = {**kwargs, "at_call": where()}
        self.reviews.append(review)
        thread = threading.Thread(target=propagate_context_to_thread(lambda: review.update(in_fork=where())))
        thread.start()
        thread.join()


class Built(Agent):
    """An ``AIAgent`` the sidecar builds: the turn's constructor arguments, without the skill tool."""

    instances: list = []

    def __init__(self, **kwargs):
        super().__init__(tools=("memory",), **kwargs)
        Built.instances.append(self)


with scoped_home(ALPHA):  # an earlier named-profile turn leaves the process multiplexing
    pass
registry = Registry(runtime=types.SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
chat.register(registry)
chat._agent_class = lambda: Built
chat._resolve_runtime = lambda provider, model: {"model": model, "provider": provider}
refine = registry.methods["chat.refine"]
out: dict = {}


def call(session_id: str, focus: str, messages=MESSAGES) -> str:
    params = {"profile_home": str(ALPHA), "session_id": session_id, "messages": messages, "focus": focus, "model": "gpt-5.4",
              "model_provider": "openai-codex", "enabled_toolsets": ["memory"], "max_iterations": 7,
              "workspace": "/srv/project", "workspace_local": True}
    return refine(None, params)["output"]


cached = Agent()
chat._AGENT_CACHE["cached"] = (cached, "sig", str(ALPHA))
out["cached"] = {"output": call("cached", "keep deploy steps"), "reviews": cached.reviews, "built": len(Built.instances)}

output = call("fresh", "")
fresh = chat._AGENT_CACHE.get("fresh")
out["built"] = {
    "output": output, "reviews": [r for agent in Built.instances for r in agent.reviews],
    "kwargs": {key: Built.instances[0].kwargs.get(key) for key in ("model", "provider", "enabled_toolsets", "max_iterations", "session_id", "cwd")},
    "cached_for_turn": fresh is not None and fresh[0] is Built.instances[0] and str(fresh[2]) == str(ALPHA),
    "held": len(chat._COMMITTING),
}

busy = Agent()
chat._AGENT_CACHE["busy"] = (busy, "sig", str(ALPHA))
run = chat._Run("stream-busy", "busy", None)
chat._RUNS["stream-busy"], chat._RUNS_BY_SESSION["busy"] = run, "stream-busy"
out["running"] = {"output": call("busy", ""), "reviews": busy.reviews,
                  # A turn admitted after ``refine``'s own check: the claim rechecks and leaves the cached agent alone.
                  "claimed": chat._refine_agent({}, "busy", str(ALPHA)) is not None, "held": len(chat._COMMITTING)}
run.finished.set()

empty = Agent()
chat._AGENT_CACHE["empty"] = (empty, "sig", str(ALPHA))
out["empty"] = {"output": call("empty", "", messages=[]), "reviews": empty.reviews}
print(json.dumps(out))
