"""``chat.start`` turn lifecycle with a stand-in Agent: no interrupt on a normal finish, interrupt on cancel, stale interrupts cleared."""

from __future__ import annotations

import contextlib
import threading

from talaria_sidecar.methods import chat


class FakeAgent:
    instances: list["FakeAgent"] = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.interrupts: list[tuple] = []
        self.cleared = 0
        self.block: threading.Event | None = None
        FakeAgent.instances.append(self)

    def clear_interrupt(self):
        self.cleared += 1

    def interrupt(self, message, hard_cancel=False):
        self.interrupts.append((message, hard_cancel))
        if self.block is not None:
            self.block.set()

    def run_conversation(self, **kwargs):
        if self.block is not None:
            self.block.wait(5)
        return {"final_response": "ok", "messages": [{"role": "assistant", "content": "ok"}]}


class Ctx:
    cancelled = False

    def __init__(self):
        self.frames: list[tuple[str, dict]] = []

    def emit(self, event, data=None):
        self.frames.append((event, data or {}))


def _params(stream_id: str, session_id: str = "s1") -> dict:
    return {"profile_home": "/tmp/unused", "session_id": session_id, "stream_id": stream_id, "user_message": "hi", "conversation_history": [], "model": "m", "model_provider": "p"}


def _patch(monkeypatch):
    FakeAgent.instances.clear()
    chat._AGENT_CACHE.clear()
    monkeypatch.setattr(chat, "_resolve_runtime", lambda provider, model: {"model": "m", "provider": "p"})
    monkeypatch.setattr(chat, "_agent_class", lambda: FakeAgent)
    monkeypatch.setattr(chat, "scoped_home", lambda home: contextlib.nullcontext(home))


def test_a_finished_turn_never_interrupts_the_cached_agent(monkeypatch) -> None:
    _patch(monkeypatch)
    first = chat.start(Ctx(), _params("st-1"))
    assert first["status"] == "completed", first
    agent = FakeAgent.instances[0]
    assert agent.interrupts == []
    # The second turn reuses the cached agent and is not aborted by anything the first turn left behind.
    second = chat.start(Ctx(), _params("st-2"))
    assert second["status"] == "completed", second
    assert FakeAgent.instances == [agent]
    assert agent.interrupts == []
    assert agent.cleared == 2


def test_cancel_interrupts_the_running_turn_and_the_next_turn_starts_clean(monkeypatch) -> None:
    _patch(monkeypatch)
    ctx = Ctx()
    result: dict = {}
    gate = threading.Event()
    original = chat._agent_class

    def blocking_agent_class():
        cls = original()
        instance_hook = cls
        return instance_hook

    monkeypatch.setattr(chat, "_agent_class", blocking_agent_class)
    started = threading.Event()

    def run():
        # Block the fake turn until it is interrupted.
        FakeAgent.instances.clear()
        orig_init = FakeAgent.__init__

        def init(self, **kwargs):
            orig_init(self, **kwargs)
            self.block = gate
            started.set()

        monkeypatch.setattr(FakeAgent, "__init__", init)
        result.update(chat.start(ctx, _params("st-3", "s2")))

    worker = threading.Thread(target=run)
    worker.start()
    assert started.wait(5)
    assert chat.register.__module__  # module import sanity
    run_obj = chat._run_for({"stream_id": "st-3"})
    assert run_obj is not None
    run_obj.cancel.set()
    worker.join(5)
    assert not worker.is_alive()
    agent = FakeAgent.instances[0]
    assert agent.interrupts == [("Cancelled by user", True)]
    assert result["status"] == "cancelled", result
    # The next turn on the same session clears the interrupt the cancel left on the cached agent.
    agent.block = None
    follow = chat.start(Ctx(), _params("st-4", "s2"))
    assert follow["status"] == "completed", follow
    assert agent.cleared >= 2


def test_a_rotated_credential_never_reuses_the_cached_agent(monkeypatch) -> None:
    _patch(monkeypatch)
    runtime = {"model": "m", "provider": "p", "api_key": "sk-old"}
    monkeypatch.setattr(chat, "_resolve_runtime", lambda provider, model: dict(runtime))
    assert chat.start(Ctx(), _params("st-5", "s3"))["status"] == "completed"
    assert chat.start(Ctx(), _params("st-6", "s3"))["status"] == "completed"
    assert len(FakeAgent.instances) == 1
    runtime["api_key"] = "sk-rotated"
    assert chat.start(Ctx(), _params("st-7", "s3"))["status"] == "completed"
    assert len(FakeAgent.instances) == 2
    assert FakeAgent.instances[-1].kwargs["api_key"] == "sk-rotated"
    # runtime.env drops every cached agent as well.
    assert chat.evict_all_agents() == 1
    assert chat.start(Ctx(), _params("st-8", "s3"))["status"] == "completed"
    assert len(FakeAgent.instances) == 3
