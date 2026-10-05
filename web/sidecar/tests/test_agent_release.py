"""TAL-527: every way a cached agent leaves the cache ends its memory session with the transcript and releases its
LLM clients, under the owning profile's home; shutdown drains the cache. A turn still holding its agent defers the
release until the turn ends."""

from __future__ import annotations

import contextlib
import threading
import time

from talaria_sidecar.methods import Registry, chat
from talaria_sidecar.methods import runtime as runtime_methods
from test_chat_turn import Ctx, FakeAgent, _params, _patch

EVENTS: list[tuple] = []
_HOME = threading.local()


class MemoryAgent(FakeAgent):
    """The Agent's session-end surface: a turn republishes ``_session_messages``, ``shutdown_memory_provider(messages)``
    hands them to the memory provider's ``on_session_end``, and ``release_clients`` closes the LLM clients."""

    def run_conversation(self, **kwargs):
        result = super().run_conversation(**kwargs)
        self._session_messages = [{"role": "user", "content": kwargs["user_message"]}, *result["messages"]]
        return result

    def shutdown_memory_provider(self, messages=None):
        EVENTS.append(("on_session_end", self.kwargs["session_id"], messages, getattr(_HOME, "home", None)))

    def release_clients(self):
        EVENTS.append(("release_clients", self.kwargs["session_id"]))


TRANSCRIPT = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "ok"}]


def _setup(monkeypatch):
    _patch(monkeypatch)
    EVENTS.clear()
    monkeypatch.setattr(chat, "_agent_class", lambda: MemoryAgent)

    @contextlib.contextmanager
    def scoped(home):
        _HOME.home = str(home)
        try:
            yield home
        finally:
            _HOME.home = None

    monkeypatch.setattr(chat, "scoped_home", scoped)


def _ended(session_id: str, timeout: float = 2.0) -> list[tuple]:
    """The session's release events once both arrive (releases run on daemon threads)."""
    deadline = time.monotonic() + timeout
    while True:
        events = [e for e in EVENTS if e[1] == session_id]
        if len(events) >= 2 or time.monotonic() > deadline:
            return events
        time.sleep(0.01)


def _released(session_id: str) -> list[tuple]:
    return [("on_session_end", session_id, TRANSCRIPT, "/tmp/unused"), ("release_clients", session_id)]


def test_lru_eviction_ends_the_memory_session_and_releases_clients(monkeypatch) -> None:
    _setup(monkeypatch)
    monkeypatch.setattr(chat, "_AGENT_CACHE_MAX", 2)
    for sid in ("lru-1", "lru-2", "lru-3"):
        assert chat.start(Ctx(), _params(f"st-{sid}", sid))["status"] == "completed"
    assert _ended("lru-1") == _released("lru-1")
    assert [e for e in EVENTS if e[1] != "lru-1"] == []


def test_a_model_switch_releases_the_replaced_agent(monkeypatch) -> None:
    _setup(monkeypatch)
    assert chat.start(Ctx(), _params("st-a", "switch"))["status"] == "completed"
    assert chat.start(Ctx(), {**_params("st-b", "switch"), "model": "other"})["status"] == "completed"
    assert len(MemoryAgent.instances) == 2
    assert _ended("switch") == _released("switch")


def test_evict_agent_and_runtime_env_release_their_agents(monkeypatch) -> None:
    _setup(monkeypatch)
    registry = Registry(runtime=None)  # type: ignore[arg-type]
    chat.register(registry)
    assert chat.start(Ctx(), _params("st-e", "evicted"))["status"] == "completed"
    assert registry.methods["chat.evict_agent"](Ctx(), {"session_id": "evicted"}) == {"evicted": True}
    assert _ended("evicted") == _released("evicted")
    assert chat.start(Ctx(), _params("st-env", "env"))["status"] == "completed"
    assert chat.evict_all_agents() == 1
    assert _ended("env") == _released("env")


def test_an_agent_dropped_during_its_turn_is_released_when_the_turn_ends(monkeypatch) -> None:
    _setup(monkeypatch)
    gate = threading.Event()
    started = threading.Event()

    class BlockingAgent(MemoryAgent):
        def run_conversation(self, **kwargs):
            started.set()
            gate.wait(5)
            return super().run_conversation(**kwargs)

    monkeypatch.setattr(chat, "_agent_class", lambda: BlockingAgent)
    worker = threading.Thread(target=chat.start, args=(Ctx(), _params("st-live", "live")))
    worker.start()
    assert started.wait(5)
    assert chat.evict_all_agents() == 1
    time.sleep(0.2)
    assert EVENTS == []  # the running turn still owns its memory provider and clients
    gate.set()
    worker.join(5)
    assert _ended("live") == _released("live")


class _Server:
    exit_code = None

    def request_shutdown(self, exit_code=0):
        self.exit_code = exit_code


def test_runtime_shutdown_releases_every_cached_agent_before_exiting(monkeypatch) -> None:
    _setup(monkeypatch)
    for sid in ("down-1", "down-2"):
        assert chat.start(Ctx(), _params(f"st-{sid}", sid))["status"] == "completed"
    registry = Registry(runtime=None)  # type: ignore[arg-type]
    runtime_methods.register(registry)
    ctx = Ctx()
    ctx.server = _Server()
    assert registry.methods["runtime.shutdown"](ctx, {}) == {"ok": True}
    # The drain waited for the releases: they are complete by the time the shutdown reply goes out.
    assert sorted(EVENTS, key=lambda e: (e[1], e[0])) == [*_released("down-1"), *_released("down-2")]
    assert ctx.server.exit_code == 0
    assert chat._AGENT_CACHE == {}


def test_shutdown_stops_a_running_turn_and_waits_for_its_release(monkeypatch) -> None:
    _setup(monkeypatch)
    started = threading.Event()

    class RunningAgent(MemoryAgent):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            self.block = threading.Event()  # released only by ``interrupt``

        def run_conversation(self, **kwargs):
            started.set()
            return super().run_conversation(**kwargs)

    monkeypatch.setattr(chat, "_agent_class", lambda: RunningAgent)
    result: dict = {}
    worker = threading.Thread(target=lambda: result.update(chat.start(Ctx(), _params("st-run", "running"))))
    worker.start()
    assert started.wait(5)
    registry = Registry(runtime=None)  # type: ignore[arg-type]
    runtime_methods.register(registry)
    ctx = Ctx()
    ctx.server = _Server()
    assert registry.methods["runtime.shutdown"](ctx, {}) == {"ok": True}
    # The drain stopped the turn and waited for the turn's own release before the process may exit.
    assert EVENTS == _released("running")
    worker.join(5)
    assert result["status"] == "cancelled"
