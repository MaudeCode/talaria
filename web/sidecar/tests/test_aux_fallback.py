"""``aux.complete`` with ``main_fallback``: the session's main model answers when no auxiliary client is configured
or the auxiliary call fails (predecessor ``_llm_git_commit_message``). Also how calls reach the Agent's ``call_llm``
(TAL-823): its per-task permit wait and clients that cannot stream."""

from __future__ import annotations

import contextlib
import sys
import threading
import types
from types import SimpleNamespace

import pytest

from talaria_sidecar.errors import Cancelled, RpcError
from talaria_sidecar.methods import aux, chat


class FakeAgent:
    calls: list[dict] = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs

    def run_conversation(self, **kwargs):
        FakeAgent.calls.append({"init": self.kwargs, "run": kwargs})
        return {"final_response": "  feat: main model answer  "}


class Ctx:
    def check_cancelled(self):
        return None

    def emit(self, event, data=None):
        return None


def _install_aux_module(monkeypatch, factory):
    module = types.ModuleType("agent.auxiliary_client")
    module.get_text_auxiliary_client = factory
    package = types.ModuleType("agent")
    package.auxiliary_client = module
    monkeypatch.setitem(sys.modules, "agent", package)
    monkeypatch.setitem(sys.modules, "agent.auxiliary_client", module)


def _patch(monkeypatch, factory):
    FakeAgent.calls.clear()
    _install_aux_module(monkeypatch, factory)
    monkeypatch.setattr(chat, "_agent_class", lambda: FakeAgent)
    monkeypatch.setattr(chat, "_resolve_runtime", lambda provider, model: {"model": model or "resolved-m", "provider": provider or "resolved-p", "base_url": "https://llm.example/v1", "api_key": "sk-main", "api_mode": "chat_completions"})


MESSAGES = [{"role": "system", "content": "sys"}, {"role": "user", "content": "diff"}]


def test_unconfigured_auxiliary_falls_back_to_the_main_model(monkeypatch) -> None:
    seen = {}

    def factory(task, *, main_runtime=None):
        seen["main_runtime"] = main_runtime
        return None, None

    _patch(monkeypatch, factory)
    result = aux.complete("compression", MESSAGES, main_runtime={"model": "claude-x", "provider": "anthropic"}, max_tokens=None, temperature=None, ctx=Ctx(), main_fallback=True)
    assert result == {"model": "claude-x", "text": "feat: main model answer", "usage": None, "finish_reason": None}
    # The auxiliary client saw the fully resolved main runtime, not just the hint.
    assert seen["main_runtime"]["api_key"] == "sk-main" and seen["main_runtime"]["model"] == "claude-x"
    call = FakeAgent.calls[0]
    assert call["init"]["model"] == "claude-x" and call["init"]["provider"] == "anthropic" and call["init"]["enabled_toolsets"] == []
    assert call["init"]["api_key"] == "sk-main" and call["init"]["api_mode"] == "chat_completions"
    assert call["run"]["system_message"] == "sys" and call["run"]["user_message"] == "diff" and call["run"]["conversation_history"] == []


def test_without_fallback_the_unconfigured_error_is_kept(monkeypatch) -> None:
    _patch(monkeypatch, lambda task, *, main_runtime=None: (None, None))
    with pytest.raises(RpcError) as excinfo:
        aux.complete("compression", MESSAGES, main_runtime={"model": "m", "provider": "p"}, max_tokens=None, temperature=None, ctx=Ctx())
    assert excinfo.value.data["condition"] == "aux_unconfigured"
    assert FakeAgent.calls == []


def test_a_failing_auxiliary_call_falls_back_to_the_main_model(monkeypatch) -> None:
    class Broken:
        class chat:
            class completions:
                @staticmethod
                def create(**kwargs):
                    raise RuntimeError("aux endpoint down")

    _patch(monkeypatch, lambda task, *, main_runtime=None: (Broken(), "aux-model"))
    result = aux.complete("compression", MESSAGES, main_runtime={"model": "m", "provider": "p"}, max_tokens=None, temperature=None, ctx=Ctx(), main_fallback=True)
    assert result["text"] == "feat: main model answer" and len(FakeAgent.calls) == 1


class RecordingMemoryAgent:
    """Models the Agent's memory contract: an external provider is attached unless ``skip_memory``, every completed
    turn is mirrored into it (``turn_finalizer`` → ``sync_all``), and ``close`` releases it."""

    instances: list["RecordingMemoryAgent"] = []

    def __init__(self, *, skip_memory: bool = False, skip_background_review: bool = False, **kwargs):
        self.kwargs = {"skip_memory": skip_memory, "skip_background_review": skip_background_review, **kwargs}
        self.synced: list[tuple[str, str]] | None = None if skip_memory else []
        self.closed = False
        self.end_session_on_close = None
        RecordingMemoryAgent.instances.append(self)

    def run_conversation(self, *, user_message, **kwargs):
        if self.synced is not None:
            self.synced.append((user_message, "feat: answer"))
        return {"final_response": "feat: answer"}

    def close(self):
        self.end_session_on_close = getattr(self, "_end_session_on_close", True)
        self.closed = True


def test_main_model_fallback_skips_memory_and_closes_the_agent(monkeypatch) -> None:
    RecordingMemoryAgent.instances.clear()
    _patch(monkeypatch, lambda task, *, main_runtime=None: (None, None))
    monkeypatch.setattr(chat, "_agent_class", lambda: RecordingMemoryAgent)
    result = aux.complete("compression", [{"role": "user", "content": "diff with sk-secret"}], main_runtime={"model": "m", "provider": "p"}, max_tokens=None, temperature=None, ctx=Ctx(), main_fallback=True)
    assert result["text"] == "feat: answer"
    (agent,) = RecordingMemoryAgent.instances
    assert not agent.synced, f"the diff reached long-term memory: {agent.synced}"
    assert agent.kwargs["skip_memory"] is True and agent.kwargs["skip_background_review"] is True
    assert agent.closed and agent.end_session_on_close is False


class CancellableCtx(Ctx):
    def __init__(self):
        self.cancel_event = threading.Event()

    def check_cancelled(self):
        if self.cancel_event.is_set():
            raise Cancelled()


def _response(text: str):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=text), finish_reason="stop")], usage=None)


def _install_call_llm(monkeypatch, client, call_llm, semaphore=None) -> None:
    """Fake ``agent.auxiliary_client`` with the Agent's ``call_llm`` seams: the task's permit semaphore and the
    thread-local interrupt protection its protected provider call reads."""
    _patch(monkeypatch, lambda task, *, main_runtime=None: (client, "aux-model"))
    module = sys.modules["agent.auxiliary_client"]
    module.call_llm = call_llm
    module._acquire_sync_aux_semaphore = lambda task: semaphore
    protection = threading.local()

    @contextlib.contextmanager
    def aux_interrupt_protection(active=True, cancel_check=None, cancel_event=None):
        protection.cancel_event = cancel_event
        try:
            yield
        finally:
            protection.cancel_event = None

    module.aux_interrupt_protection = aux_interrupt_protection
    module.protection = protection


STREAMING_CLIENT = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=None, with_streaming_response=None)))


@pytest.mark.parametrize("model", [None, "m"], ids=["auxiliary route", "explicit model"])
def test_a_call_cancelled_while_call_llm_waits_for_the_task_permit_returns_and_never_dispatches(monkeypatch, model) -> None:
    permit = threading.Event()
    entered = threading.Event()
    dispatched = []

    def call_llm(task, *, main_runtime=None, messages, stream=False, **kwargs):
        # The Agent: an uncancellable wait for the task's permit (another call took it), then its protected provider
        # call drops a request whose host cancelled before dispatch.
        entered.set()
        permit.wait(10)
        cancel_event = getattr(sys.modules["agent.auxiliary_client"].protection, "cancel_event", None)
        if cancel_event is not None and cancel_event.is_set():
            raise RuntimeError("auxiliary request explicitly cancelled by host")
        dispatched.append(stream)
        return iter(()) if stream else _response("late title")

    _install_call_llm(monkeypatch, STREAMING_CLIENT, call_llm, threading.BoundedSemaphore(1))
    ctx = CancellableCtx()
    outcome = {}

    def run():
        try:
            outcome["result"] = aux.complete("title_generation", MESSAGES, main_runtime=None, max_tokens=None, temperature=None, ctx=ctx, model=model)
        except BaseException as exc:  # noqa: BLE001
            outcome["error"] = exc

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    assert entered.wait(5)
    ctx.cancel_event.set()
    worker.join(3)
    try:
        assert not worker.is_alive(), "the cancelled call still holds its sidecar worker"
        assert isinstance(outcome.get("error"), Cancelled), outcome
    finally:
        permit.set()
        worker.join(5)
    assert dispatched == []


def test_a_client_that_cannot_stream_is_asked_once_without_stream(monkeypatch) -> None:
    calls = []

    def permit_wrapper(response):
        # The Agent's ``_release_sync_semaphore_after_stream`` over the complete response a shim returns for ``stream=True``.
        yield from response

    def call_llm(task, *, main_runtime=None, messages, stream=False, **kwargs):
        calls.append(stream)
        return permit_wrapper(_response("Shim title")) if stream else _response("Shim title")

    shim = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=None)))
    _install_call_llm(monkeypatch, shim, call_llm)
    result = aux.complete("title_generation", MESSAGES, main_runtime=None, max_tokens=None, temperature=None, ctx=CancellableCtx())
    assert result["text"] == "Shim title" and calls == [False]


def test_a_whole_response_to_a_stream_request_is_read_once(monkeypatch) -> None:
    calls = []

    def call_llm(task, *, main_runtime=None, messages, stream=False, **kwargs):
        # The route resolved to a shim the auxiliary client did not predict: it answers ``stream=True`` whole.
        calls.append(stream)
        return _response("Fallback title")

    _install_call_llm(monkeypatch, STREAMING_CLIENT, call_llm)
    result = aux.complete("title_generation", MESSAGES, main_runtime=None, max_tokens=None, temperature=None, ctx=CancellableCtx())
    assert result["text"] == "Fallback title" and calls == [True]
