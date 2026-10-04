"""``usage.account`` serialises the Agent's account-usage snapshot, driven in-process with a stand-in ``agent.account_usage``."""

from __future__ import annotations

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
    provider: str
    fetched_at: datetime
    windows: tuple[Window, ...] = ()


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
    module = types.ModuleType("agent.account_usage")
    module.fetch_account_usage = lambda provider, base_url=None, api_key=None: snapshot
    monkeypatch.setitem(sys.modules, "agent", types.ModuleType("agent"))
    monkeypatch.setitem(sys.modules, "agent.account_usage", module)

    row = usage.account("anthropic", base_url=None, api_key=None)

    assert row["fetched_at"] == "2026-09-28T07:30:15.250000Z"
    assert [w["reset_at"] for w in row["windows"]] == ["2026-09-28T12:00:00Z", "2026-10-01T07:00:00Z", None]


def test_plain_serialises_naive_datetimes_and_dates_without_inventing_a_zone():
    assert usage._plain({"at": datetime(2026, 9, 28, 12, 0), "day": date(2026, 9, 28)}) == {"at": "2026-09-28T12:00:00", "day": "2026-09-28"}
