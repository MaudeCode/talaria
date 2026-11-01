"""TAL-978: ``chat.start`` names the route that served the turn. A provider fallback swaps ``agent.model`` and
``agent.provider`` until the next turn starts; the result carries that served route and the primary model the Agent
requested, so the server can tell a fallback answered."""

from __future__ import annotations

from test_chat_turn import Ctx, FakeAgent, _params, _patch

from talaria_sidecar.methods import chat


class FallbackAgent(FakeAgent):
    """While ``fail_over`` is set, runs on a fallback route the way the Agent's fallback chain does; else the primary."""

    fail_over = False

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.primary = (kwargs.get("model", "m"), kwargs.get("provider", "p"))

    def run_conversation(self, **kwargs):
        self.model, self.provider = ("fallback-model", "fallback-provider") if FallbackAgent.fail_over else self.primary
        return {**super().run_conversation(**kwargs), "model": self.model, "provider": self.provider, "requested_model": self.primary[0]}


def test_start_returns_the_fallback_route_and_the_requested_model(monkeypatch) -> None:
    _patch(monkeypatch)
    monkeypatch.setattr(chat, "_agent_class", lambda: FallbackAgent)
    fields = ("status", "model", "provider", "requested_model")

    def turn(stream: str, fail_over: bool) -> dict:
        monkeypatch.setattr(FallbackAgent, "fail_over", fail_over)
        result = chat.start(Ctx(), _params(stream))
        return {key: result.get(key) for key in fields}

    assert turn("st-1", True) == {"status": "completed", "model": "fallback-model", "provider": "fallback-provider", "requested_model": "m"}
    assert turn("st-2", False) == {"status": "completed", "model": "m", "provider": "p", "requested_model": "m"}
