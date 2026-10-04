"""``usage.account`` serialises the Agent's account-usage snapshot, driven in-process with a stand-in ``agent.account_usage``."""

from __future__ import annotations

import json
import pathlib
import sys
import types
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

from talaria_sidecar.methods import usage


@dataclass(frozen=True)
class Window:
    label: str
    used_percent: float | None = None
    reset_at: datetime | None = None


@dataclass(frozen=True)
class Snapshot:
    """Mirrors the Agent's ``AccountUsageSnapshot``: ``available`` is a property, so ``asdict``/``vars`` omit it."""

    provider: str
    fetched_at: datetime
    title: str = "Account limits"
    plan: str | None = None
    windows: tuple[Window, ...] = ()
    details: tuple[str, ...] = ()
    unavailable_reason: str | None = None

    @property
    def available(self) -> bool:
        return bool(self.windows or self.details) and not self.unavailable_reason


# The serialised snapshot the server's quota test replays as the sidecar's `usage.account` answer.
AVAILABLE_FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "usage_account_available.json"


def _fake_agent(monkeypatch, snapshot):
    module = types.ModuleType("agent.account_usage")
    module.fetch_account_usage = lambda provider, base_url=None, api_key=None: snapshot
    monkeypatch.setitem(sys.modules, "agent", types.ModuleType("agent"))
    monkeypatch.setitem(sys.modules, "agent.account_usage", module)


def test_account_reads_available_from_the_snapshot_property(monkeypatch):
    fetched_at = datetime(2026, 9, 28, 7, 30, tzinfo=timezone.utc)
    _fake_agent(monkeypatch, Snapshot("anthropic", fetched_at, title="Claude limits", plan="max",
                                      windows=(Window("Current session", 12, datetime(2026, 9, 28, 12, 0, tzinfo=timezone.utc)),)))
    row = usage.account("anthropic", base_url=None, api_key=None)
    assert row["available"] is True
    assert row == json.loads(AVAILABLE_FIXTURE.read_text())

    _fake_agent(monkeypatch, Snapshot("anthropic", fetched_at, unavailable_reason="Anthropic account limits are only available for OAuth-backed Claude accounts."))
    row = usage.account("anthropic", base_url=None, api_key=None)
    assert row["available"] is False
    assert row["unavailable_reason"] == "Anthropic account limits are only available for OAuth-backed Claude accounts."


def test_account_serialises_datetimes_as_iso_8601(monkeypatch):
    snapshot = Snapshot(
        provider="anthropic",
        fetched_at=datetime(2026, 9, 28, 7, 30, 15, 250000, tzinfo=timezone.utc),
        windows=(
            Window("5h", 12, datetime(2026, 9, 28, 12, 0, tzinfo=timezone.utc)),
            Window("Weekly", 30, datetime(2026, 10, 1, 9, 0, tzinfo=timezone(timedelta(hours=2)))),
            Window("Unknown", 5),
        ),
    )
    _fake_agent(monkeypatch, snapshot)

    row = usage.account("anthropic", base_url=None, api_key=None)

    assert row["fetched_at"] == "2026-09-28T07:30:15.250000Z"
    assert [w["reset_at"] for w in row["windows"]] == ["2026-09-28T12:00:00Z", "2026-10-01T07:00:00Z", None]


def test_plain_serialises_naive_datetimes_and_dates_without_inventing_a_zone():
    assert usage._plain({"at": datetime(2026, 9, 28, 12, 0), "day": date(2026, 9, 28)}) == {"at": "2026-09-28T12:00:00", "day": "2026-09-28"}
