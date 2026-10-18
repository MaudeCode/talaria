"""TAL-821: ``chat.start`` turns the Agent's live rate-limit wait line (``thinking_callback``, written by
``turn_recovery.compute_error_backoff``) into ``rate_limit_wait`` frames with the provider and the reset time, and clears
the wait when the Agent moves on. The wait lines are the pinned Agent's real ``_emit_diagnostic_wait`` strings."""

from __future__ import annotations

import threading
import time

import pytest

from test_chat_turn import Ctx, FakeAgent, _params, _patch
from talaria_sidecar.methods import Registry, chat

FREE_BUSY_WITH_RESET = "⏳ the free model is busy — resets in ~17m, retrying in 600s (attempt 1/3)"
FREE_BUSY = "⏳ the free model is busy — retrying in 600s (attempt 1/3)"
RATE_LIMITED = "⏳ rate limited — resets in ~1h 5m, retrying in 60s (attempt 2/3)"
SPINNER = "(｡◕‿◕｡) pondering..."


def _run(monkeypatch, *lines):
    """One turn on a stand-in agent that writes ``lines`` to its live status line, then answers."""
    _patch(monkeypatch)

    def run_conversation(self, **kwargs):
        # Like the Agent, which writes its live status line only when a driver wired one.
        status_line = self.kwargs.get("thinking_callback") or (lambda text: None)
        for line in lines:
            status_line(line)
        self.kwargs["stream_delta_callback"]("ok")
        return {"final_response": "ok", "messages": [{"role": "assistant", "content": "ok"}]}

    monkeypatch.setattr(FakeAgent, "run_conversation", run_conversation)
    ctx = Ctx()
    before = time.time()
    assert chat.start(ctx, _params("rl-1"))["status"] == "completed"
    return before, [(event, data) for event, data in ctx.frames if event in ("rate_limit_wait", "token")]


@pytest.mark.parametrize(("line", "seconds", "kind"), [(FREE_BUSY_WITH_RESET, 17 * 60, "reset"), (FREE_BUSY, 600, "retry"), (RATE_LIMITED, 65 * 60, "reset")])
def test_a_rate_limit_wait_reports_its_reset_and_clears_when_the_agent_retries(monkeypatch, line, seconds, kind) -> None:
    before, frames = _run(monkeypatch, line, "", SPINNER)
    assert [event for event, _data in frames] == ["rate_limit_wait", "rate_limit_wait", "token"]
    wait, clear, token = frames
    assert wait[1]["provider"] == "p" and wait[1]["until_kind"] == kind
    assert before + seconds <= wait[1]["until"] <= time.time() + seconds
    # The retry's spinner line ends the wait before any text streams.
    assert clear == ("rate_limit_wait", {"provider": None, "until": None})
    assert token == ("token", {"text": "ok"})


@pytest.mark.parametrize("line", ["⏳ waiting on provider — retrying in 4s (attempt 1/3)", "⏳ provider overloaded — resets in ~45s, retrying in 30s (attempt 1/5)", SPINNER, "", "⏱️ Rate limited. Waiting 2.0s (attempt 1/3)..."])
def test_other_status_lines_report_no_wait(monkeypatch, line) -> None:
    _before, frames = _run(monkeypatch, line)
    assert frames == [("token", {"text": "ok"})]


def test_stop_during_the_wait_ends_the_turn(monkeypatch) -> None:
    _patch(monkeypatch)
    waiting = threading.Event()

    def run_conversation(self, **kwargs):
        self.block = threading.Event()
        (self.kwargs.get("thinking_callback") or (lambda text: None))(FREE_BUSY)
        waiting.set()
        self.block.wait(5)
        return {"final_response": "", "messages": [], "interrupted": True}

    monkeypatch.setattr(FakeAgent, "run_conversation", run_conversation)
    ctx = Ctx()
    result: dict = {}
    worker = threading.Thread(target=lambda: result.update(chat.start(ctx, _params("rl-stop"))))
    worker.start()
    assert waiting.wait(5)
    registry = Registry(runtime=None)  # type: ignore[arg-type]
    chat.register(registry)
    assert registry.methods["chat.interrupt"](Ctx(), {"stream_id": "rl-stop"})["ok"] is True
    worker.join(5)
    assert not worker.is_alive()
    assert FakeAgent.instances[0].interrupts == [("Cancelled by user", True)]
    assert result["status"] == "cancelled", result
    assert [event for event, _data in ctx.frames if event == "rate_limit_wait"] == ["rate_limit_wait"]


@pytest.mark.parametrize("lines, expected", [
    (["⚙ processing prompt — 0%", "⚙ processing prompt — 42%", "⚙ processing prompt — 100%", ""], [0, 42, 100, None]),
    (["⚙ processing prompt", "(｡◕‿◕｡) pondering..."], ["unknown", None]),
    (["I am processing prompt — 42%", "42%", "thinking", "⚙ processing prompt — nope%"], []),
])
def test_prompt_reading_callback_progress_and_clear(monkeypatch, lines, expected):
    _patch(monkeypatch)

    def run_conversation(self, **kwargs):
        for line in lines:
            self.kwargs["thinking_callback"](line)
        self.kwargs["stream_delta_callback"]("ok")
        return {"final_response": "ok", "messages": [{"role": "assistant", "content": "ok"}]}

    monkeypatch.setattr(FakeAgent, "run_conversation", run_conversation)
    ctx = Ctx()
    assert chat.start(ctx, _params("prompt-progress"))["status"] == "completed"
    phases = [data["phase"] for event, data in ctx.frames if event == "provider_phase"]
    assert phases == [None if value is None else {"phase": "prompt_reading", "progress_percent": None if value == "unknown" else value} for value in expected]
