"""TAL-532: a deferred wakeup re-checks which completions the agent already holds from its own turn."""

from __future__ import annotations

import sys
from types import SimpleNamespace

import pytest

from talaria_sidecar.methods import process


def test_a_failed_consumed_read_reports_nothing_for_that_process(monkeypatch: pytest.MonkeyPatch) -> None:
    """Only the Agent's wait/log consumption counts: a poll preview saw only a short tail, so it leaves the full
    completion to the autonomous wakeup (TAL-1560)."""
    def consumed(pid: str) -> bool:
        if pid == "broken":
            raise RuntimeError("registry unavailable")
        return pid == "waited"
    registry = SimpleNamespace(is_completion_consumed=consumed, _poll_observed={"polled", "waited"})
    monkeypatch.setattr(process, "_registry", lambda: registry)
    assert process.consumed_ids(["broken", "polled", "waited"]) == ["waited"]


def test_no_registry_reports_nothing_consumed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(process, "_registry", lambda: None)
    assert process.consumed_ids(["waited"]) == []


def test_only_a_completion_reports_its_consumed_exit(monkeypatch: pytest.MonkeyPatch) -> None:
    """TAL-724: an awaited exit says nothing about the watch notices the same process raised."""
    registry = SimpleNamespace(is_completion_consumed=lambda pid: pid == "proc_w")
    monkeypatch.setattr(process, "_registry", lambda: registry)
    monkeypatch.setitem(sys.modules, "tools.process_registry_notifications", SimpleNamespace(is_child_process_notification=lambda row: False))
    owned = {"session_id": "proc_w", "session_key": "s", "origin_ui_session_id": "s"}
    assert process._event_row({**owned, "type": "watch_match"})["consumed"] is False
    assert process._event_row({**owned, "type": "watch_disabled"})["consumed"] is False
    assert process._event_row({**owned, "type": "completion"})["consumed"] is True
    assert process._event_row(owned)["consumed"] is True
