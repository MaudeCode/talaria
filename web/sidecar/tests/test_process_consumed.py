"""TAL-532: a deferred wakeup re-checks which completions the agent already holds from its own turn."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from talaria_sidecar.methods import process


def test_consumed_or_poll_observed_processes_are_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    registry = SimpleNamespace(is_completion_consumed=lambda pid: pid == "waited", _poll_observed={"polled"})
    monkeypatch.setattr(process, "_registry", lambda: registry)
    assert process.consumed_ids(["waited", "polled", "sibling"]) == ["waited", "polled"]


def test_no_registry_reports_nothing_consumed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(process, "_registry", lambda: None)
    assert process.consumed_ids(["waited"]) == []
