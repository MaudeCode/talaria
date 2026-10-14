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

    def _replay_startup_warnings(self):
        """The Agent's: a turn start raises what init parked once the callback is bound."""
        pending = getattr(self, "_pending_startup_notices", None)
        if pending and self.notice_callback:
            self._pending_startup_notices = []
            for notice in pending:
                self.notice_callback(notice)

    def _spawn_background_review(self, **kwargs):
        pass

    def run_conversation(self, **kwargs):
        if self.notice_clear_callback and kwargs.get("user_message") == "recovered":
            self.notice_clear_callback(WARNING.key)
        return super().run_conversation(**kwargs)


def test_a_startup_warning_reaches_the_server_once_per_agent_and_its_clear_follows(monkeypatch) -> None:
    _patch(monkeypatch)
    monkeypatch.setattr(chat, "_agent_class", lambda: StartupWarningAgent)
    first = Ctx()
    assert chat.start(first, _params("st-1"))["status"] == "completed"
    notice = {"id": WARNING.id, "key": WARNING.key, "level": "warn", "kind": "sticky", "ttl_ms": None, "text": WARNING.text, "lapses_with_agent": False}
    # A new agent first lapses whatever the agent it replaces raised.
    assert [(event, data) for event, data in first.frames if event.startswith("notice")] == [("notices_reset", {}), ("notice", notice)]
    # The cached agent's next turn raises nothing new; its callbacks now point at this turn's stream.
    second = Ctx()
    assert chat.start(second, {**_params("st-2"), "user_message": "recovered"})["status"] == "completed"
    assert len(FakeAgent.instances) == 1
    assert [(event, data) for event, data in second.frames if event.startswith("notice")] == [("notice_clear", {"key": WARNING.key})]


def test_the_first_turn_on_an_agent_refine_built_lapses_old_notices_and_raises_its_startup_warning(monkeypatch, tmp_path) -> None:
    """TAL-902: ``/refine`` builds the session's agent without a turn's callbacks; its first turn announces it like a new one."""
    _patch(monkeypatch)
    monkeypatch.setattr(chat, "_agent_class", lambda: StartupWarningAgent)
    params = {"profile_home": str(tmp_path), "session_id": "s1", "messages": [{"role": "user", "content": "hi"}], "focus": "", "model": "m", "model_provider": "p"}
    assert chat.refine(params).startswith("⚗ Reviewing this conversation in the background")
    turn = Ctx()
    assert chat.start(turn, {**_params("st-1"), "profile_home": str(tmp_path)})["status"] == "completed"
    assert len(FakeAgent.instances) == 1
    notice = {"id": WARNING.id, "key": WARNING.key, "level": "warn", "kind": "sticky", "ttl_ms": None, "text": WARNING.text, "lapses_with_agent": False}
    assert [(event, data) for event, data in turn.frames if event.startswith("notice")] == [("notices_reset", {}), ("notice", notice)]
    # Announced once: the next turn on the same agent raises nothing new.
    again = Ctx()
    assert chat.start(again, {**_params("st-2"), "profile_home": str(tmp_path)})["status"] == "completed"
    assert [event for event, _data in again.frames if event.startswith("notice")] == []
