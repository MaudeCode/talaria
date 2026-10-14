"""TAL-801: ``chat.start`` with ``voice_turn`` marks the turn for the Agent's ``auxiliary.voice_chat`` route.

The stand-in agent consumes ``_voice_turn_pending`` at turn setup the way ``agent.voice_turn_route`` does: a marked turn
runs on the configured voice model and records its usage under ``voice_chat``; an unmarked one stays on the main model.
"""

from __future__ import annotations

from test_chat_turn import Ctx, FakeAgent, _params, _patch

from talaria_sidecar.methods import chat

VOICE_MODEL = "voice-fast"


class VoiceAgent(FakeAgent):
    turns: list[tuple[str, str]] = []

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.model = kwargs.get("model", "m")
        self._voice_turn_pending = False

    def run_conversation(self, **kwargs):
        # ``begin_voice_turn_route``: consume the mark and bind the configured slot's model for this turn only.
        voice = bool(self._voice_turn_pending)
        self._voice_turn_pending = False
        model = VOICE_MODEL if voice else self.model
        VoiceAgent.turns.append(("voice_chat" if voice else "main", model))
        # The Agent reports the turn's model in its result, then ``end_voice_turn_route`` restores the main one.
        return {**super().run_conversation(**kwargs), "model": model}


def _setup(monkeypatch, route: bool = True):
    _patch(monkeypatch)
    VoiceAgent.turns.clear()
    monkeypatch.setattr(chat, "_agent_class", lambda: VoiceAgent)
    monkeypatch.setattr(chat, "_has_voice_turn_route", lambda: route, raising=False)


def test_a_voice_turn_runs_on_the_voice_route_and_the_next_typed_turn_on_the_main_model(monkeypatch) -> None:
    _setup(monkeypatch)
    voice = chat.start(Ctx(), {**_params("st-1"), "voice_turn": True})
    typed = chat.start(Ctx(), _params("st-2"))
    assert VoiceAgent.turns == [("voice_chat", VOICE_MODEL), ("main", "m")]
    # Each turn reports the model it ran on, which the server records as the reply's model.
    assert (voice["status"], voice["model"]) == ("completed", VOICE_MODEL)
    assert (typed["status"], typed["model"]) == ("completed", "m")
    # Both turns ran on the one cached agent: the mark never outlives its turn.
    assert len(FakeAgent.instances) == 1


def test_a_typed_turn_clears_a_mark_the_agent_never_consumed(monkeypatch) -> None:
    _setup(monkeypatch)
    chat.start(Ctx(), _params("st-1"))
    agent = FakeAgent.instances[0]
    # A voice turn that failed before the Agent reached turn setup leaves its mark behind.
    agent._voice_turn_pending = True
    chat.start(Ctx(), _params("st-2"))
    assert VoiceAgent.turns == [("main", "m"), ("main", "m")]


def test_an_agent_without_the_voice_route_is_left_untouched(monkeypatch) -> None:
    _setup(monkeypatch, route=False)
    chat.start(Ctx(), {**_params("st-1"), "voice_turn": True})
    assert VoiceAgent.turns == [("main", "m")]
