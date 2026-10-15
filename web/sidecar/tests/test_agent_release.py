"""TAL-527: every way a cached agent leaves the cache ends its memory session with the transcript and releases its
LLM clients, under the owning profile's home; shutdown drains the cache. A turn still holding its agent defers the
release until the turn ends."""

from __future__ import annotations

import contextlib
import sys
import threading
import time
import types

import pytest

from talaria_sidecar.errors import RpcError
from talaria_sidecar.methods import Registry, chat, profiles
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
    # Shutdown closes admission for the rest of the process; each test gets a fresh gate.
    monkeypatch.setattr(chat, "_DRAINING", threading.Event(), raising=False)
    monkeypatch.setattr(chat, "_agent_class", lambda: MemoryAgent)

    @contextlib.contextmanager
    def scoped(home):
        _HOME.home = str(home)
        try:
            yield home
        finally:
            _HOME.home = None

    monkeypatch.setattr(chat, "scoped_home", scoped)


def _reviews(monkeypatch) -> None:
    """TAL-897: the Agent's background-review canceller, recording which session's agent it reached and why."""
    module = types.ModuleType("agent.background_review")
    module.cancel_background_review_for_live_turn = lambda agent, *, message, tool_reason: EVENTS.append(("cancel_review", agent.kwargs["session_id"], message))
    # The Agent admits a run token only while no unfinished review holds the slot.
    module.prepare_background_review_run = lambda agent: None if (r := getattr(agent, "_background_review_run", None)) is not None and not r.request_done.is_set() else object()
    monkeypatch.setitem(sys.modules, "agent", types.ModuleType("agent"))
    monkeypatch.setitem(sys.modules, "agent.background_review", module)


def _cancels(count: int = 0) -> list[tuple]:
    """The review cancels so far, once ``count`` arrived (an eviction's cancels run on their own threads)."""
    deadline = time.monotonic() + 2
    while len(cancels := [e for e in EVENTS if e[0] == "cancel_review"]) < count and time.monotonic() < deadline:
        time.sleep(0.01)
    return cancels


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


def test_no_turn_is_admitted_once_shutdown_has_drained(monkeypatch) -> None:
    _setup(monkeypatch)
    registry = Registry(runtime=None)  # type: ignore[arg-type]
    runtime_methods.register(registry)
    ctx = Ctx()
    ctx.server = _Server()
    assert registry.methods["runtime.shutdown"](ctx, {}) == {"ok": True}
    # A call dispatched before stdin closed, or one admitted during the drain, reaches ``start`` after the snapshot.
    with pytest.raises(RpcError) as refused:
        chat.start(Ctx(), _params("st-late", "late"))
    assert refused.value.data.get("condition") == "sidecar_unavailable"
    assert MemoryAgent.instances == [] and chat._AGENT_CACHE == {}


def test_profile_deletion_releases_that_profiles_agents_before_removing_its_home(monkeypatch, tmp_path) -> None:
    _setup(monkeypatch)
    alpha, beta = tmp_path / "profiles" / "alpha", tmp_path / "profiles" / "beta"
    for sid, home in (("alpha-chat", alpha), ("beta-chat", beta)):
        assert chat.start(Ctx(), {**_params(f"st-{sid}", sid), "profile_home": str(home)})["status"] == "completed"
    seen: dict = {}
    monkeypatch.setattr(profiles, "delete_profile", lambda base_home, name: seen.update(name=name, events=list(EVENTS)))
    registry = Registry(runtime=types.SimpleNamespace(load=lambda: None, ensure_current=lambda: None))  # type: ignore[arg-type]
    profiles.register(registry)
    assert registry.methods["profiles.delete"](Ctx(), {"base_home": str(tmp_path), "name": "alpha"}) == {"ok": True}
    # The release finished, under the profile's own home, before the home was removed; other profiles keep theirs.
    assert seen == {"name": "alpha", "events": [("on_session_end", "alpha-chat", TRANSCRIPT, str(alpha)), ("release_clients", "alpha-chat")]}
    assert list(chat._AGENT_CACHE) == ["beta-chat"]


def test_profile_deletion_cancels_that_profiles_background_reviews_before_removing_its_home(monkeypatch, tmp_path) -> None:
    _setup(monkeypatch)
    _reviews(monkeypatch)
    alpha, beta = tmp_path / "profiles" / "alpha", tmp_path / "profiles" / "beta"
    for sid, home in (("alpha-chat", alpha), ("beta-chat", beta)):
        assert chat.start(Ctx(), {**_params(f"st-{sid}", sid), "profile_home": str(home)})["status"] == "completed"
    seen: dict = {}
    monkeypatch.setattr(profiles, "delete_profile", lambda base_home, name: seen.update(cancels=_cancels()))
    registry = Registry(runtime=types.SimpleNamespace(load=lambda: None, ensure_current=lambda: None))  # type: ignore[arg-type]
    profiles.register(registry)
    assert registry.methods["profiles.delete"](Ctx(), {"base_home": str(tmp_path), "name": "alpha"}) == {"ok": True}
    assert seen == {"cancels": [("cancel_review", "alpha-chat", "profile deleted")]}


def test_profile_deletion_waits_for_a_cancelled_review_to_settle(monkeypatch, tmp_path) -> None:
    """A review past the Agent's bounded cancel wait may still save memory: the home stays until it acknowledges."""
    _setup(monkeypatch)
    _reviews(monkeypatch)
    monkeypatch.setattr(chat, "_PROFILE_RELEASE_TIMEOUT", 0.5)
    alpha = tmp_path / "profiles" / "alpha"
    assert chat.start(Ctx(), {**_params("st-slow", "slow"), "profile_home": str(alpha)})["status"] == "completed"
    review = types.SimpleNamespace(cancel_requested=threading.Event(), request_done=threading.Event())
    review.cancel_requested.set()
    MemoryAgent.instances[-1]._background_review_run = review
    deleted: list = []
    monkeypatch.setattr(profiles, "delete_profile", lambda base_home, name: deleted.append(name))
    registry = Registry(runtime=types.SimpleNamespace(load=lambda: None, ensure_current=lambda: None))  # type: ignore[arg-type]
    profiles.register(registry)
    for _attempt in range(2):  # a retry keeps waiting for the cancel the first attempt started
        with pytest.raises(RpcError, match="still saving memory"):
            registry.methods["profiles.delete"](Ctx(), {"base_home": str(tmp_path), "name": "alpha"})
    assert deleted == []
    review.request_done.set()
    assert registry.methods["profiles.delete"](Ctx(), {"base_home": str(tmp_path), "name": "alpha"}) == {"ok": True}
    assert deleted == ["alpha"]


def test_profile_deletion_refuses_once_when_a_review_cancel_fails(monkeypatch, tmp_path) -> None:
    _setup(monkeypatch)
    _reviews(monkeypatch)

    def fail(agent, *, message, tool_reason):
        raise RuntimeError("cancel failed")

    monkeypatch.setattr(sys.modules["agent.background_review"], "cancel_background_review_for_live_turn", fail)
    assert chat.start(Ctx(), {**_params("st-fail", "fail"), "profile_home": str(tmp_path / "profiles" / "alpha")})["status"] == "completed"
    deleted: list = []
    monkeypatch.setattr(profiles, "delete_profile", lambda base_home, name: deleted.append(name))
    registry = Registry(runtime=types.SimpleNamespace(load=lambda: None, ensure_current=lambda: None))  # type: ignore[arg-type]
    profiles.register(registry)
    with pytest.raises(RpcError, match="could not be saved"):
        registry.methods["profiles.delete"](Ctx(), {"base_home": str(tmp_path), "name": "alpha"})
    assert deleted == []
    assert registry.methods["profiles.delete"](Ctx(), {"base_home": str(tmp_path), "name": "alpha"}) == {"ok": True}


def test_concurrent_cancels_of_one_agent_both_settle(monkeypatch) -> None:
    """Two teardowns (say a clear overlapping shutdown) cancel one agent: neither may cancel the other's held slot."""
    _setup(monkeypatch)
    _reviews(monkeypatch)
    module = sys.modules["agent.background_review"]

    def cancel(agent, *, message, tool_reason):
        if (run := getattr(agent, "_background_review_run", None)) is not None:
            run.cancel_requested.set()

    def prepare(agent):
        if (run := getattr(agent, "_background_review_run", None)) is not None and not run.request_done.is_set():
            return None
        run = agent._background_review_run = types.SimpleNamespace(cancel_requested=threading.Event(), request_done=threading.Event())
        time.sleep(0.2)  # installed, not yet returned to the claimant
        return run

    monkeypatch.setattr(module, "cancel_background_review_for_live_turn", cancel)
    monkeypatch.setattr(module, "prepare_background_review_run", prepare)
    agent = types.SimpleNamespace()
    threads = chat._cancel_background_reviews([(agent, "/tmp/unused")], "first") + chat._cancel_background_reviews([(agent, "/tmp/unused")], "second")
    for thread in threads:
        thread.join(3)
    assert [thread.is_alive() for thread in threads] == [False, False]
    assert not any(thread.failed for thread in threads)


def test_shutdown_closes_turn_admission_before_cancelling_reviews(monkeypatch) -> None:
    """A turn admitted after the review owners were collected would fork a review nobody cancels."""
    _setup(monkeypatch)
    assert chat.start(Ctx(), _params("st-adm", "admission"))["status"] == "completed"
    seen: list = []
    cancel = chat._cancel_background_reviews
    monkeypatch.setattr(chat, "_cancel_background_reviews", lambda agents, message: seen.append(chat._DRAINING.is_set()) or cancel(agents, message))
    chat.drain_agents(timeout=1)
    assert seen == [True]


def test_clearing_a_session_mid_turn_stops_its_agent_forking_a_review(monkeypatch) -> None:
    """The server clears a session without stopping its turn; the Agent would fork that turn's review as it returns."""
    _setup(monkeypatch)
    _reviews(monkeypatch)
    gate = threading.Event()
    started = threading.Event()

    class BlockingAgent(MemoryAgent):
        def run_conversation(self, **kwargs):
            started.set()
            gate.wait(5)
            return super().run_conversation(**kwargs)

    monkeypatch.setattr(chat, "_agent_class", lambda: BlockingAgent)
    registry = Registry(runtime=None)  # type: ignore[arg-type]
    chat.register(registry)
    worker = threading.Thread(target=chat.start, args=(Ctx(), _params("st-clear", "cleared")))
    worker.start()
    assert started.wait(5)
    registry.methods["chat.evict_agent"](Ctx(), {"session_id": "cleared", "clear_session": True})
    assert _cancels(1) == [("cancel_review", "cleared", "session deleted or cleared")]
    assert BlockingAgent.instances[-1].skip_background_review is True
    gate.set()
    worker.join(5)


def test_clearing_a_session_before_its_turn_binds_an_agent_fences_and_never_caches_that_agent(monkeypatch) -> None:
    """A clear between the turn's registration and its agent's construction: the agent it builds is the old session's."""
    _setup(monkeypatch)
    _reviews(monkeypatch)
    gate = threading.Event()
    building = threading.Event()

    class SlowAgent(MemoryAgent):
        def __init__(self, **kwargs):
            building.set()
            gate.wait(5)
            super().__init__(**kwargs)

    monkeypatch.setattr(chat, "_agent_class", lambda: SlowAgent)
    registry = Registry(runtime=None)  # type: ignore[arg-type]
    chat.register(registry)
    worker = threading.Thread(target=chat.start, args=(Ctx(), _params("st-early", "early")))
    worker.start()
    assert building.wait(5)
    registry.methods["chat.evict_agent"](Ctx(), {"session_id": "early", "clear_session": True})
    gate.set()
    worker.join(5)
    assert SlowAgent.instances[-1].skip_background_review is True
    assert "early" not in chat._AGENT_CACHE
    assert _ended("early") == _released("early")


def test_a_turn_ending_without_a_clear_keeps_its_review(monkeypatch) -> None:
    _setup(monkeypatch)
    _reviews(monkeypatch)
    assert chat.start(Ctx(), _params("st-kept", "kept"))["status"] == "completed"
    registry = Registry(runtime=None)  # type: ignore[arg-type]
    chat.register(registry)
    registry.methods["chat.evict_agent"](Ctx(), {"session_id": "kept"})
    assert _cancels() == []
    assert not hasattr(MemoryAgent.instances[-1], "skip_background_review")


def test_shutdown_releases_an_agent_a_running_turn_caches_after_the_first_eviction(monkeypatch) -> None:
    _setup(monkeypatch)
    resolving = threading.Event()
    gate = threading.Event()

    def resolve(provider, model):
        resolving.set()
        gate.wait(5)
        return {"model": "m", "provider": "p"}

    monkeypatch.setattr(chat, "_resolve_runtime", resolve)
    worker = threading.Thread(target=chat.start, args=(Ctx(), _params("st-late-cache", "late-cache")))
    worker.start()
    assert resolving.wait(5)  # the run is registered; its agent is not built or cached yet
    registry = Registry(runtime=None)  # type: ignore[arg-type]
    runtime_methods.register(registry)
    ctx = Ctx()
    ctx.server = _Server()
    shutdown = threading.Thread(target=registry.methods["runtime.shutdown"], args=(ctx, {}))
    shutdown.start()
    deadline = time.monotonic() + 5
    while not chat._RUNS["st-late-cache"].cancel.is_set():  # the drain already evicted and is waiting on the turn
        assert time.monotonic() < deadline
        time.sleep(0.01)
    gate.set()
    shutdown.join(5)
    worker.join(5)
    assert EVENTS == _released("late-cache")
    assert chat._AGENT_CACHE == {}


def test_profile_deletion_is_refused_while_a_release_is_still_running(monkeypatch, tmp_path) -> None:
    _setup(monkeypatch)
    monkeypatch.setattr(chat, "_PROFILE_RELEASE_TIMEOUT", 0.2, raising=False)
    flushing = threading.Event()

    class SlowAgent(MemoryAgent):
        def shutdown_memory_provider(self, messages=None):
            flushing.wait(5)
            super().shutdown_memory_provider(messages)

    monkeypatch.setattr(chat, "_agent_class", lambda: SlowAgent)
    alpha = tmp_path / "profiles" / "alpha"
    assert chat.start(Ctx(), {**_params("st-slow", "slow"), "profile_home": str(alpha)})["status"] == "completed"
    deleted: list = []
    monkeypatch.setattr(profiles, "delete_profile", lambda base_home, name: deleted.append(name))
    registry = Registry(runtime=types.SimpleNamespace(load=lambda: None, ensure_current=lambda: None))  # type: ignore[arg-type]
    profiles.register(registry)
    with pytest.raises(RpcError):
        registry.methods["profiles.delete"](Ctx(), {"base_home": str(tmp_path), "name": "alpha"})
    assert deleted == []  # the home stays while the memory flush still runs under it
    flushing.set()
    assert registry.methods["profiles.delete"](Ctx(), {"base_home": str(tmp_path), "name": "alpha"}) == {"ok": True}
    assert deleted == ["alpha"] and EVENTS == [("on_session_end", "slow", TRANSCRIPT, str(alpha)), ("release_clients", "slow")]


@pytest.mark.usefixtures("stub_inference_preflight")
def test_an_agent_evicted_during_a_memory_commit_is_released_after_the_commit(monkeypatch) -> None:
    _setup(monkeypatch)
    committing = threading.Event()
    gate = threading.Event()

    class CommittingAgent(MemoryAgent):
        def commit_memory_session(self, messages=None):
            committing.set()
            gate.wait(5)
            EVENTS.append(("commit", self.kwargs["session_id"]))

    monkeypatch.setattr(chat, "_agent_class", lambda: CommittingAgent)
    assert chat.start(Ctx(), _params("st-commit", "commit"))["status"] == "completed"
    registry = Registry(runtime=None)  # type: ignore[arg-type]
    chat.register(registry)
    reply: dict = {}
    worker = threading.Thread(target=lambda: reply.update(registry.methods["chat.commit_memory"](Ctx(), {"session_id": "commit", "profile_home": "/tmp/unused"})))
    worker.start()
    assert committing.wait(5)
    assert chat.evict_all_agents() == 1
    time.sleep(0.2)
    assert EVENTS == []  # the provider is not ended or shut down under the running commit
    gate.set()
    worker.join(5)
    assert reply == {"committed": True}
    deadline = time.monotonic() + 2
    while len(EVENTS) < 3 and time.monotonic() < deadline:
        time.sleep(0.01)
    assert EVENTS == [("commit", "commit"), *_released("commit")]


def test_a_release_whose_profile_scope_fails_still_closes_clients_and_blocks_the_delete(monkeypatch, tmp_path) -> None:
    _setup(monkeypatch)
    alpha = tmp_path / "profiles" / "alpha"
    assert chat.start(Ctx(), {**_params("st-unscoped", "unscoped"), "profile_home": str(alpha)})["status"] == "completed"

    @contextlib.contextmanager
    def unreadable(home):
        raise RpcError("terminal policy unreadable")
        yield home  # pragma: no cover

    monkeypatch.setattr(chat, "scoped_home", unreadable)
    deleted: list = []
    monkeypatch.setattr(profiles, "delete_profile", lambda base_home, name: deleted.append(name))
    registry = Registry(runtime=types.SimpleNamespace(load=lambda: None, ensure_current=lambda: None))  # type: ignore[arg-type]
    profiles.register(registry)
    with pytest.raises(RpcError):
        registry.methods["profiles.delete"](Ctx(), {"base_home": str(tmp_path), "name": "alpha"})
    # The memory flush could not run under the profile, so its home stays; the LLM clients are closed regardless.
    assert deleted == [] and EVENTS == [("release_clients", "unscoped")]
    # The failed flush is reported once: the agent is gone, so a retry deletes the profile.
    assert registry.methods["profiles.delete"](Ctx(), {"base_home": str(tmp_path), "name": "alpha"}) == {"ok": True}
    assert deleted == ["alpha"]
