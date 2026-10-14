"""TAL-803: ``chat.start`` hands the Agent its notice callbacks and forwards each sticky ``AgentNotice`` and clear."""

from __future__ import annotations

from dataclasses import dataclass

from test_chat_turn import Ctx, FakeAgent, _params, _patch
from talaria_sidecar.methods import chat


@dataclass
class Notice:
    """The pinned Agent's ``agent.credits_tracker.AgentNotice``."""

    text: str
    level: str = "info"
    kind: str = "sticky"
    ttl_ms: int | None = None
    key: str | None = None
    id: str | None = None


WARNING = Notice(text="⚠ Memory provider 'honcho' could not be loaded; memory is off.", level="warn", key="startup-warning.1a2b3c4d", id="startup-warning.1a2b3c4d")


class StartupWarningAgent(FakeAgent):
    """Like the Agent's ``_emit_startup_warning`` on a non-CLI platform: a notice raised in ``__init__`` goes to
    ``notice_callback``, else waits in ``_pending_startup_notices`` for a turn that never shows it."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.notice_callback = kwargs.get("notice_callback")
        self.notice_clear_callback = kwargs.get("notice_clear_callback")
        if self.notice_callback:
            self.notice_callback(WARNING)
        else:
            self._pending_startup_notices = [WARNING]

    def run_conversation(self, **kwargs):
        if self.notice_clear_callback and kwargs.get("user_message") == "recovered":
            self.notice_clear_callback(WARNING.key)
        return super().run_conversation(**kwargs)


def test_a_startup_warning_reaches_the_server_once_per_agent_and_its_clear_follows(monkeypatch) -> None:
    _patch(monkeypatch)
    monkeypatch.setattr(chat, "_agent_class", lambda: StartupWarningAgent)
    first = Ctx()
    assert chat.start(first, _params("st-1"))["status"] == "completed"
    notice = {"id": WARNING.id, "key": WARNING.key, "level": "warn", "kind": "sticky", "ttl_ms": None, "text": WARNING.text}
    # A new agent first lapses whatever the agent it replaces raised.
    assert [(event, data) for event, data in first.frames if event.startswith("notice")] == [("notices_reset", {}), ("notice", notice)]
    # The cached agent's next turn raises nothing new; its callbacks now point at this turn's stream.
    second = Ctx()
    assert chat.start(second, {**_params("st-2"), "user_message": "recovered"})["status"] == "completed"
    assert len(FakeAgent.instances) == 1
    assert [(event, data) for event, data in second.frames if event.startswith("notice")] == [("notice_clear", {"key": WARNING.key})]
