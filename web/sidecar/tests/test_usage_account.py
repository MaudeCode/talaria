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


@dataclass(frozen=True)
class CodexSnapshot:
    """The Agent's Codex snapshot: windows without a duration, plus the same response's usage body on ``raw``."""

    provider: str
    fetched_at: datetime
    windows: tuple[Window, ...] = ()
    details: tuple[str, ...] = ()
    unavailable_reason: str | None = None
    identity: str | None = None
    raw: dict | None = None

    @property
    def available(self) -> bool:
        return bool(self.windows or self.details) and not self.unavailable_reason


# The serialised Codex snapshot the server's quota test replays: a 24-hour primary and a 5-hour secondary, both "Session".
CODEX_DURATIONS_FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "usage_account_codex_durations.json"
_AT = datetime(2026, 9, 28, 7, 59, 30, tzinfo=timezone.utc)


def _codex(windows, rate_limit):
    return CodexSnapshot("openai-codex", _AT, windows=windows, identity="codex:acct-synthetic:user-synthetic",
                         raw={"plan_type": "plus", "email": "synthetic@example.test", "rate_limit": rate_limit})


def test_codex_windows_take_their_duration_from_the_same_response_body(monkeypatch):
    """TAL-1125: the Agent labels an unrecognised duration by position, so 86400 s and 18000 s both read "Session"."""
    snapshot = _codex(
        (Window("Session", 50, datetime(2026, 9, 28, 9, 0, tzinfo=timezone.utc)), Window("Session", 7, datetime(2026, 9, 28, 10, 0, tzinfo=timezone.utc))),
        {"primary_window": {"used_percent": 50, "limit_window_seconds": 86400}, "secondary_window": {"used_percent": 7, "limit_window_seconds": 18000}},
    )
    _fake_agent(monkeypatch, snapshot)
    row = usage.account("openai-codex", base_url=None, api_key=None)
    assert [(w["label"], w.get("limit_window_seconds")) for w in row["windows"]] == [("Session", 86400), ("Session", 18000)]
    # The body served the backfill; the server never reads it, so it stops here. The account identity stays.
    assert "raw" not in row
    assert row["identity"] == "codex:acct-synthetic:user-synthetic"
    assert row == json.loads(CODEX_DURATIONS_FIXTURE.read_text())


def test_codex_backfill_joins_by_position_only_where_labels_agree(monkeypatch):
    weekly, session = Window("Weekly", 40), Window("Session", 15)
    # Weekly-only: the Agent puts the weekly limit in `primary_window` and labels it by its duration.
    _fake_agent(monkeypatch, _codex((weekly,), {"primary_window": {"used_percent": 40, "limit_window_seconds": 604800}}))
    assert [w.get("limit_window_seconds") for w in usage.account("openai-codex", base_url=None, api_key=None)["windows"]] == [604800]
    # A body whose windows do not line up with the Agent's leaves every duration unknown rather than swapping them.
    _fake_agent(monkeypatch, _codex((weekly, session), {"secondary_window": {"used_percent": 15, "limit_window_seconds": 18000}}))
    assert [w.get("limit_window_seconds") for w in usage.account("openai-codex", base_url=None, api_key=None)["windows"]] == [None, None]
    # A window the body skips (no `used_percent`) does not shift the join onto its neighbour.
    _fake_agent(monkeypatch, _codex((weekly,), {"primary_window": {"limit_window_seconds": 18000}, "secondary_window": {"used_percent": 40, "limit_window_seconds": 604800}}))
    assert [w.get("limit_window_seconds") for w in usage.account("openai-codex", base_url=None, api_key=None)["windows"]] == [604800]


def test_codex_backfill_ignores_absent_invalid_and_boolean_durations(monkeypatch):
    for bad in (None, True, False, 0, -18000, "18000", float("nan"), float("inf"), 10**400):
        _fake_agent(monkeypatch, _codex((Window("Session", 15),), {"primary_window": {"used_percent": 15, "limit_window_seconds": bad}}))
        row = usage.account("openai-codex", base_url=None, api_key=None)
        assert row["windows"][0].get("limit_window_seconds") is None, bad
    # No body, or a body without `rate_limit`: nothing to join, and no extra provider read.
    for raw in (None, {}, {"rate_limit": "junk"}):
        _fake_agent(monkeypatch, CodexSnapshot("openai-codex", _AT, windows=(Window("Session", 15),), raw=raw))
        assert usage.account("openai-codex", base_url=None, api_key=None)["windows"][0].get("limit_window_seconds") is None
