"""``aux.complete`` with ``main_fallback``: the session's main model answers when no auxiliary client is configured
or the auxiliary call fails (predecessor ``_llm_git_commit_message``)."""

from __future__ import annotations

import sys
import types

import pytest

from talaria_sidecar.errors import RpcError
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
    assert result == {"model": "claude-x", "text": "feat: main model answer", "usage": None}
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
