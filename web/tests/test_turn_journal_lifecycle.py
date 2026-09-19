import os
import stat

from api.turn_journal import (
    append_turn_journal_event,
    append_turn_journal_event_for_stream,
    derive_turn_journal_states,
)


def test_append_turn_journal_event_for_stream_reuses_submitted_turn_id(tmp_path):
    submitted = append_turn_journal_event(
        "sid-1",
        {"event": "submitted", "turn_id": "turn-1", "stream_id": "stream-1", "content": "hello"},
        session_dir=tmp_path,
    )

    worker = append_turn_journal_event_for_stream(
        "sid-1",
        "stream-1",
        {"event": "worker_started"},
        session_dir=tmp_path,
    )

    assert submitted["turn_id"] == "turn-1"
    assert worker["turn_id"] == "turn-1"
    states, _ = derive_turn_journal_states([submitted, worker])
    assert states["turn-1"]["event"] == "worker_started"


def test_stream_turn_cache_avoids_reparsing_history_for_each_lifecycle_event(tmp_path, monkeypatch):
    append_turn_journal_event(
        "sid-cache",
        {"event": "submitted", "turn_id": "turn-cache", "stream_id": "stream-cache"},
        session_dir=tmp_path,
    )

    monkeypatch.setattr(
        "api.turn_journal.read_turn_journal",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("warm stream-to-turn lookup reread the full journal")
        ),
    )
    worker = append_turn_journal_event_for_stream(
        "sid-cache",
        "stream-cache",
        {"event": "worker_started"},
        session_dir=tmp_path,
    )
    completed = append_turn_journal_event_for_stream(
        "sid-cache",
        "stream-cache",
        {"event": "completed"},
        session_dir=tmp_path,
    )

    assert worker["turn_id"] == "turn-cache"
    assert completed["turn_id"] == "turn-cache"


def test_turn_journal_fsyncs_parent_directory_only_when_shard_is_created(tmp_path, monkeypatch):
    real_fsync = os.fsync
    directory_fsyncs = []

    def tracking_fsync(fd):
        if stat.S_ISDIR(os.fstat(fd).st_mode):
            directory_fsyncs.append(fd)
        return real_fsync(fd)

    monkeypatch.setattr(os, "fsync", tracking_fsync)
    append_turn_journal_event(
        "sid-dir-sync",
        {"event": "submitted", "stream_id": "stream-dir-sync"},
        session_dir=tmp_path,
    )
    append_turn_journal_event_for_stream(
        "sid-dir-sync",
        "stream-dir-sync",
        {"event": "worker_started"},
        session_dir=tmp_path,
    )

    assert len(directory_fsyncs) == 1


def test_append_turn_journal_event_for_stream_falls_back_to_new_turn_for_missing_stream(tmp_path):
    event = append_turn_journal_event_for_stream(
        "sid-1",
        "stream-missing",
        {"event": "interrupted", "reason": "no submitted event found"},
        session_dir=tmp_path,
    )

    assert event["stream_id"] == "stream-missing"
    assert event["turn_id"]
    assert event["event"] == "interrupted"


def test_append_turn_journal_event_skips_directory_fsync_without_o_directory(tmp_path, monkeypatch):
    monkeypatch.delattr(os, "O_DIRECTORY", raising=False)

    event = append_turn_journal_event(
        "sid-windows",
        {"event": "submitted", "content": "hello"},
        session_dir=tmp_path,
    )

    assert event["event"] == "submitted"
    journal_dir = tmp_path / "_turn_journal"
    shards = list(journal_dir.glob(f"sid-windows~{os.getpid()}.jsonl"))
    assert len(shards) == 1, f"expected one pid-scoped shard, found: {list(journal_dir.iterdir())}"
