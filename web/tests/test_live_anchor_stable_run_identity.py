"""Stable run identity regressions for live Anchor scene projection/hydration."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")


def test_runtime_journal_snapshot_preserves_run_id_separately_from_stream_id(
    monkeypatch,
):
    from api import routes

    session_id = "session-stable-run"
    run_id = "run-stable-1"
    stream_id = "stream-transport-1"
    events = [
        {
            "event": "token",
            "seq": 1,
            "event_id": f"{run_id}:1",
            "run_id": run_id,
            "created_at": 1.0,
            "payload": {"text": "working"},
        },
        {
            "event": "reasoning",
            "seq": 2,
            "event_id": f"{run_id}:2",
            "run_id": run_id,
            "created_at": 2.0,
            "payload": {"text": "checking"},
        },
        {
            "event": "tool",
            "seq": 3,
            "event_id": f"{run_id}:3",
            "run_id": run_id,
            "created_at": 3.0,
            "payload": {"name": "terminal", "tid": "call-1"},
        },
        {
            "event": "tool_complete",
            "seq": 4,
            "event_id": f"{run_id}:4",
            "run_id": run_id,
            "created_at": 4.0,
            "payload": {"name": "terminal", "tid": "call-1", "preview": "ok"},
        },
    ]

    monkeypatch.setattr(
        routes,
        "find_run_summary",
        lambda lookup_id: {
            "session_id": session_id,
            # The current summary is keyed by the legacy lookup id, while the
            # durable event envelope already carries the stable run identity.
            "run_id": stream_id,
            "stream_id": stream_id,
            "last_seq": 4,
            "last_event_id": f"{run_id}:4",
        },
    )
    monkeypatch.setattr(
        routes,
        "read_run_event_tail",
        lambda loaded_session_id, lookup_id: {"events": events},
    )

    snapshot = routes._run_journal_live_snapshot(stream_id)
    scene = snapshot["anchor_activity_scene"]

    assert snapshot["stream_id"] == stream_id
    assert scene["identity"]["run_id"] == run_id
    assert scene["identity"]["stream_id"] == stream_id
    assert scene["activity_rows"]
    assert [row["role"] for row in scene["activity_rows"]] == [
        "prose",
        "thinking",
        "tool",
    ]
    assert {row["run_id"] for row in scene["activity_rows"]} == {run_id}
    assert {row["stream_id"] for row in scene["activity_rows"]} == {stream_id}
    assert {row["identity"]["run_id"] for row in scene["activity_rows"]} == {run_id}
    assert {row["identity"]["stream_id"] for row in scene["activity_rows"]} == {
        stream_id
    }


def test_runtime_journal_lifecycle_shell_preserves_stable_run_id(monkeypatch):
    from api import routes

    run_id = "run-stable-lifecycle"
    stream_id = "stream-transport-lifecycle"
    event = {
        "event": "metering",
        "seq": 1,
        "event_id": f"{run_id}:1",
        "run_id": run_id,
        "payload": {},
    }
    monkeypatch.setattr(
        routes,
        "find_run_summary",
        lambda lookup_id: {
            "session_id": "session-stable-lifecycle",
            "run_id": stream_id,
            "stream_id": stream_id,
            "last_seq": 1,
            "last_event_id": f"{run_id}:1",
        },
    )
    monkeypatch.setattr(
        routes,
        "read_run_event_tail",
        lambda loaded_session_id, lookup_id: {"events": [event]},
    )

    snapshot = routes._run_journal_live_snapshot(stream_id)
    scene = snapshot["anchor_activity_scene"]
    row = scene["activity_rows"][0]

    assert row["role"] == "lifecycle"
    assert row["run_id"] == run_id
    assert row["stream_id"] == stream_id
    assert row["identity"]["run_id"] == run_id
    assert row["identity"]["stream_id"] == stream_id


@pytest.mark.parametrize(
    ("event_run_id", "event_id"),
    [
        ({"bad": "id"}, None),
        ("run-conflicting-envelope", "run-conflicting-event-id:1"),
    ],
)
def test_runtime_journal_malformed_envelope_run_id_falls_back_to_transport_cursor(
    monkeypatch,
    event_run_id,
    event_id,
):
    from api import routes

    stream_id = "stream-current-1"
    event = {
        "event": "token",
        "seq": 1,
        "run_id": event_run_id,
        "payload": {"text": "hello"},
    }
    if event_id is not None:
        event["event_id"] = event_id

    monkeypatch.setattr(
        routes,
        "find_run_summary",
        lambda lookup_id: {
            "session_id": "session-malformed-envelope",
            "run_id": stream_id,
            "stream_id": stream_id,
            "last_seq": 1,
            "last_event_id": f"{stream_id}:1",
        },
    )
    monkeypatch.setattr(
        routes,
        "read_run_event_tail",
        lambda loaded_session_id, lookup_id: {"events": [event]},
    )

    snapshot = routes._run_journal_live_snapshot(stream_id)
    scene = snapshot["anchor_activity_scene"]
    row = scene["activity_rows"][0]

    assert scene["identity"]["run_id"] == stream_id
    assert row["run_id"] == stream_id
    assert row["identity"]["run_id"] == stream_id
    assert snapshot["last_event_id"] == f"{stream_id}:1"
    assert (
        routes._parse_run_journal_after_seq(
            {"after_event_id": [snapshot["last_event_id"]]},
            stream_id,
        )
        == 1
    )
