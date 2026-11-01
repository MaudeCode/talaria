"""TAL-532: a deferred wakeup re-checks which completions the agent already holds from its own turn."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from talaria_sidecar.methods import process


def test_only_wait_or_log_consumed_processes_are_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    """TAL-1560: a poll preview saw only a short tail, so it leaves the full completion to the autonomous wakeup."""
    registry = SimpleNamespace(is_completion_consumed=lambda pid: pid == "waited", _poll_observed={"polled", "waited"})
    monkeypatch.setattr(process, "_registry", lambda: registry)
    assert process.consumed_ids(["waited", "polled", "sibling"]) == ["waited"]


def test_a_failed_consumed_read_reports_nothing_for_that_process(monkeypatch: pytest.MonkeyPatch) -> None:
    def consumed(pid: str) -> bool:
        if pid == "broken":
            raise RuntimeError("registry unavailable")
        return pid == "waited"
    monkeypatch.setattr(process, "_registry", lambda: SimpleNamespace(is_completion_consumed=consumed))
    assert process.consumed_ids(["broken", "waited"]) == ["waited"]


def test_no_registry_reports_nothing_consumed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(process, "_registry", lambda: None)
    assert process.consumed_ids(["waited"]) == []


def test_only_a_completion_reports_its_consumed_exit(monkeypatch: pytest.MonkeyPatch) -> None:
    """TAL-724: an awaited exit says nothing about the watch notices the same process raised."""
    registry = SimpleNamespace(is_completion_consumed=lambda pid: pid == "proc_w")
    monkeypatch.setattr(process, "_registry", lambda: registry)
    owned = {"session_id": "proc_w", "session_key": "s", "origin_ui_session_id": "s"}
    assert process._event_row({**owned, "type": "watch_match"})["consumed"] is False
    assert process._event_row({**owned, "type": "watch_disabled"})["consumed"] is False
    assert process._event_row({**owned, "type": "completion"})["consumed"] is True
    assert process._event_row(owned)["consumed"] is True
