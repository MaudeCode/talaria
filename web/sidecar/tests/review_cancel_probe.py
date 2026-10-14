"""Run on the Agent interpreter: evict and drain agents whose post-turn background review fork the Agent admitted.

Prints one JSON line: per scenario (a cache-only eviction, a delete/clear eviction of a cached and of a running turn's
agent, a shutdown drain), the interrupts the admitted review fork received and which reviews the agent can still fork:
a post-turn one (``skip_background_review``), a deferred one the Agent's idle queue dispatches, and one whose spawn was
already under way when the session ended. Also how long a delete/clear eviction waited on a review that never
acknowledges.
"""

from __future__ import annotations

import contextvars
import json
import os
import sys
import time
import types

sys.path.append(sys.argv[1])

from agent.background_review import finish_background_review_run, prepare_background_review_run  # noqa: E402
from agent.review_idle_queue import QUEUE, _PendingReview  # noqa: E402

from talaria_sidecar.methods import Registry, chat  # noqa: E402

registry = Registry(runtime=types.SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
chat.register(registry)
evict = registry.methods["chat.evict_agent"]
HOME = os.environ["HERMES_HOME"]
out: dict = {}


class Review:
    """The admitted review fork; acknowledging ends its request phase the way the Agent's review thread does."""

    def __init__(self, parent, run, acknowledge: bool):
        self.parent, self.run, self.acknowledge, self.interrupts = parent, run, acknowledge, []

    def hard_interrupt(self, message=None, *, tool_reason=None):
        self.interrupts.append([message, tool_reason])
        if self.acknowledge:
            finish_background_review_run(self.parent, self.run)


class Parent:
    """The parent agent. Like the Agent's, ``_spawn_background_review_now`` (what the idle queue calls for a deferred
    review) forks only once it holds the review slot."""

    def _spawn_background_review_now(self, **kwargs):
        run = prepare_background_review_run(self)
        if run is None:
            return False
        finish_background_review_run(self, run)
        return True


def reviews_left(parent) -> list:
    """Which reviews ``parent`` can still fork: a post-turn one, a deferred one the idle queue dispatches, and one whose
    spawn had already resolved the method before the session ended."""
    left = [] if getattr(parent, "skip_background_review", False) else ["post-turn"]
    if not left:  # an ended agent's cancel claims its review slot on its own thread
        deadline = time.monotonic() + 3
        while getattr(parent, "_talaria_review_slot", None) is None and time.monotonic() < deadline:
            time.sleep(0.02)
    spawned = []
    parent.__dict__.setdefault("_spawn_background_review_now", lambda **kwargs: spawned.append(Parent._spawn_background_review_now(parent, **kwargs)))
    QUEUE._dispatch(_PendingReview(parent, "probe", {}, 0.0, contextvars.copy_context()))
    if spawned == [True]:
        left.append("deferred")
    if Parent._spawn_background_review_now(parent):
        left.append("in-flight")
    return left


def admitted(acknowledge: bool = True):
    parent = Parent()
    run = prepare_background_review_run(parent)
    review = Review(parent, run, acknowledge)
    assert run.begin_request(review)
    return parent, review


def settled(review) -> list:
    """The fork's interrupts once the Agent's off-thread interrupt had time to land."""
    deadline = time.monotonic() + 3
    while not review.interrupts and time.monotonic() < deadline:
        time.sleep(0.02)
    return review.interrupts


# Model switch / truncate: the user only left the session, so its review keeps running.
parent, review = admitted()
chat._AGENT_CACHE["switch"] = (parent, "sig", HOME)
evict(None, {"session_id": "switch"})
time.sleep(0.3)
out["switch"] = review.interrupts
out["switch_review_live"] = parent._background_review_run is not None
finish_background_review_run(parent, review.run)
out["switch_left"] = reviews_left(parent)

# Delete / clear of an idle session.
parent, review = admitted()
chat._AGENT_CACHE["deleted"] = (parent, "sig", HOME)
evict(None, {"session_id": "deleted", "clear_session": True})
out["deleted"] = settled(review)
out["deleted_left"] = reviews_left(parent)

# Delete / clear while a turn still runs on the session's agent.
parent, review = admitted()
run = chat._Run("running-stream", "running", None)
run.agent = parent
chat._RUNS["running-stream"], chat._RUNS_BY_SESSION["running"] = run, "running-stream"
evict(None, {"session_id": "running", "clear_session": True})
out["running"] = settled(review)
out["running_left"] = reviews_left(parent)
run.finished.set()
chat._RUNS.pop("running-stream"), chat._RUNS_BY_SESSION.pop("running")

# A review that never acknowledges does not hold up the eviction.
parent, review = admitted(acknowledge=False)
chat._AGENT_CACHE["wedged"] = (parent, "sig", HOME)
started = time.monotonic()
out["wedged_evicted"] = evict(None, {"session_id": "wedged", "clear_session": True})["evicted"]
out["wedged_seconds"] = round(time.monotonic() - started, 1)
out["wedged"] = settled(review)
# The fork acknowledges late; the Agent would requeue a cancelled review on the idle queue.
finish_background_review_run(parent, review.run)
deadline = time.monotonic() + 3
while parent._background_review_run is None and time.monotonic() < deadline:
    time.sleep(0.02)
out["wedged_left"] = reviews_left(parent)

# Shutdown.
parent, review = admitted()
chat._AGENT_CACHE["drained"] = (parent, "sig", HOME)
chat.drain_agents()
out["drained"] = settled(review)
out["drained_left"] = reviews_left(parent)
print(json.dumps(out))
