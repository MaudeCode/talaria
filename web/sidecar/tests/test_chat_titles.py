"""Talaria owns titles; modern Agents skip their auxiliary title call on every turn."""

from __future__ import annotations

import pytest

from test_chat_turn import Ctx, FakeAgent, _params, _patch

from talaria_sidecar.methods import chat


def test_modern_agent_skips_title_calls_on_new_and_cached_turns(monkeypatch):
    _patch(monkeypatch)
    title_calls = []
    turns = []
    session_db = object()
    monkeypatch.setattr(chat, "_acquire_session_db", lambda home: session_db)
    monkeypatch.setattr(chat, "_execution_session_id", lambda db, sid: sid)

    class TitleAgent(FakeAgent):
        def run_conversation(self, user_message, conversation_history, task_id, system_message=None,
                             persist_user_message=None, title_user_message=None):
            assert self.kwargs["session_db"] is session_db
            # Agent's turn-start hook uses the override only for titling, leaving model and stored text alone.
            title_text = user_message if title_user_message is None else title_user_message
            if title_text.strip():
                title_calls.append(title_text)
            turns.append((user_message, persist_user_message, system_message))
            return super().run_conversation()

    monkeypatch.setattr(chat, "_agent_class", lambda: TitleAgent)
    for index in range(2):
        result = chat.start(Ctx(), {**_params(f"st-title-{index}"), "user_message": "[Workspace::v1: /w]\nhello",
                                   "persist_user_message": "hello", "system_message": "system"})
        assert result["status"] == "completed", result
    assert title_calls == []
    assert turns == [("[Workspace::v1: /w]\nhello", "hello", "system")] * 2
    assert len(FakeAgent.instances) == 1


@pytest.mark.parametrize("uninspectable", [False, True])
def test_older_or_uninspectable_agent_keeps_existing_arguments(monkeypatch, uninspectable):
    _patch(monkeypatch)
    calls = []

    class LegacyAgent(FakeAgent):
        def run_conversation(self, user_message, conversation_history, task_id, system_message=None):
            calls.append((user_message, conversation_history, task_id, system_message))
            return super().run_conversation()

    if uninspectable:
        LegacyAgent.run_conversation.__signature__ = "unavailable"
    monkeypatch.setattr(chat, "_agent_class", lambda: LegacyAgent)
    result = chat.start(Ctx(), {**_params("st-legacy"), "system_message": "system"})
    assert result["status"] == "completed", result
    assert calls == [("hi", [], "s1", "system")]


def test_kwargs_only_agent_is_not_assumed_to_support_title_override(monkeypatch):
    _patch(monkeypatch)
    calls = []

    class WrapperAgent(FakeAgent):
        def run_conversation(self, **kwargs):
            calls.append(kwargs)
            return super().run_conversation(**kwargs)

    monkeypatch.setattr(chat, "_agent_class", lambda: WrapperAgent)
    assert chat.start(Ctx(), _params("st-wrapper"))["status"] == "completed"
    assert calls == [{"user_message": "hi", "conversation_history": [], "task_id": "s1"}]


def test_turn_signature_is_inspected_once_per_agent_class(monkeypatch):
    _patch(monkeypatch)

    class FirstAgent(FakeAgent):
        pass

    class SecondAgent(FakeAgent):
        def run_conversation(self, **kwargs):
            return super().run_conversation(**kwargs)

    signature = chat.inspect.signature
    inspected = []

    def count_signature(target):
        function = getattr(target, "__func__", target)
        if function in (FirstAgent.run_conversation, SecondAgent.run_conversation):
            inspected.append(function)
        return signature(target)

    monkeypatch.setattr(chat.inspect, "signature", count_signature)
    for index, cls in enumerate((FirstAgent, FirstAgent, SecondAgent, SecondAgent)):
        monkeypatch.setattr(chat, "_agent_class", lambda: cls)
        assert chat.start(Ctx(), _params(f"st-inspect-{index}", f"s{index}"))["status"] == "completed"
    assert inspected == [FirstAgent.run_conversation, SecondAgent.run_conversation]
