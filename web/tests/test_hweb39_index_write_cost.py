"""HWEB-39: saving one session must not cost a full-store index rewrite.

Covers the three properties the index write path has to keep:
  * concurrent saves coalesce into fewer rewrites than there are savers,
  * the serialized index is smaller for an identical logical payload,
  * an interrupted write leaves the previous index intact, never a partial one.
"""

import json
import threading
import time
from types import SimpleNamespace

import pytest

from api import models

INDEX_ROWS = 2000


def _row(sid, updated_at, title=None):
    return {
        "session_id": sid,
        "title": title or sid,
        "updated_at": updated_at,
        "message_count": 1,
    }


def _session(sid, updated_at, title=None):
    entry = _row(sid, updated_at, title)
    return SimpleNamespace(session_id=sid, compact=lambda: dict(entry))


@pytest.fixture
def index_store(tmp_path, monkeypatch):
    """A synthetic 2000-session index wired up as the active session store."""
    index_path = tmp_path / "_index.json"
    rows = [_row(f"sid-{i}", i) for i in range(INDEX_ROWS)]
    index_path.write_text(json.dumps(rows), encoding="utf-8")
    all_ids = frozenset(row["session_id"] for row in rows)

    monkeypatch.setattr(models, "SESSION_DIR", tmp_path)
    monkeypatch.setattr(models, "SESSION_INDEX_FILE", index_path)
    monkeypatch.setattr(models, "SESSIONS", {})
    monkeypatch.setattr(models, "_persisted_session_ids_snapshot", lambda: all_ids)
    models._PARSED_INDEX_CACHE.clear()

    # The coalescing gate is module-global; leave it clean for the next test.
    models._INDEX_PENDING_ROWS.clear()
    monkeypatch.setattr(models, "_INDEX_PENDING_BATCH", None)
    monkeypatch.setattr(models, "_INDEX_FLUSH_IN_PROGRESS", False)
    yield SimpleNamespace(path=index_path, rows=rows)
    models._INDEX_PENDING_ROWS.clear()
    models._INDEX_PENDING_BATCH = None
    models._INDEX_FLUSH_IN_PROGRESS = False
    models._PARSED_INDEX_CACHE.clear()


def test_concurrent_saves_coalesce_into_fewer_index_rewrites(index_store, monkeypatch):
    savers = 8
    rewrites = []
    first_replace_entered = threading.Event()
    release_first_replace = threading.Event()
    real_replace = models._safe_replace

    def gated_replace(src, dst):
        rewrites.append(str(dst))
        if len(rewrites) == 1:
            first_replace_entered.set()
            assert release_first_replace.wait(timeout=10), "gate never released"
        real_replace(src, dst)

    monkeypatch.setattr(models, "_safe_replace", gated_replace)

    # Saver 0 becomes the flusher and parks inside its rewrite.
    flusher = threading.Thread(
        target=models._queue_session_index_update,
        args=([_session("sid-0", 9000)],),
    )
    flusher.start()
    assert first_replace_entered.wait(timeout=10), "flusher never reached the rewrite"

    # Savers 1..7 land while that rewrite is in flight. Each blocks until the
    # rewrite carrying its own row finishes, so they have to run on threads.
    waiters = [
        threading.Thread(
            target=models._queue_session_index_update,
            args=([_session(f"sid-{i}", 9000 + i)],),
        )
        for i in range(1, savers)
    ]
    for waiter in waiters:
        waiter.start()
    deadline = time.monotonic() + 10
    while len(models._INDEX_PENDING_ROWS) < savers - 1:
        assert time.monotonic() < deadline, "waiters never queued their rows"
        time.sleep(0.01)

    release_first_replace.set()
    for thread in [flusher, *waiters]:
        thread.join(timeout=10)
        assert not thread.is_alive()

    assert len(rewrites) < savers, f"{savers} concurrent saves cost {len(rewrites)} rewrites"

    # Coalescing must not drop anyone's row.
    persisted = {row["session_id"]: row for row in json.loads(index_store.path.read_bytes())}
    assert len(persisted) == INDEX_ROWS
    for i in range(savers):
        assert persisted[f"sid-{i}"]["updated_at"] == 9000 + i


def test_index_bytes_shrink_for_an_identical_logical_payload(index_store):
    models._write_session_index(updates=[_session("sid-0", 0, title="renamed")])

    written = index_store.path.read_bytes()
    entries = json.loads(written)
    pretty = json.dumps(entries, ensure_ascii=False, indent=2).encode("utf-8")

    assert len(written) < len(pretty)
    assert json.loads(pretty) == entries
    assert next(e for e in entries if e["session_id"] == "sid-0")["title"] == "renamed"


@pytest.mark.parametrize("failure_point", ["fsync", "replace"])
def test_interrupted_index_write_leaves_the_previous_index_intact(
    index_store, monkeypatch, failure_point
):
    before = index_store.path.read_bytes()

    def boom(*_args, **_kwargs):
        raise OSError("simulated crash mid-write")

    if failure_point == "fsync":
        monkeypatch.setattr(models.os, "fsync", boom)
    else:
        monkeypatch.setattr(models, "_safe_replace", boom)

    with pytest.raises(OSError):
        models._write_session_index(updates=[_session("sid-0", 9999)])

    after = index_store.path.read_bytes()
    assert after == before
    assert json.loads(after) == index_store.rows
    assert not list(index_store.path.parent.glob("_index*.tmp.*"))


def test_queued_row_is_snapshotted_at_the_moment_of_the_save(index_store, monkeypatch):
    """A row must reflect the state its sidecar write saw, not a later mutation.

    A saver that queues behind an in-flight rewrite hands over its row while its
    own streaming thread keeps mutating the session. If the queue held the live
    object, the index would persist metadata that was never in the sidecar.
    """
    first_replace_entered = threading.Event()
    release_first_replace = threading.Event()
    real_replace = models._safe_replace
    calls = []

    def gated_replace(src, dst):
        calls.append(str(dst))
        if len(calls) == 1:
            first_replace_entered.set()
            assert release_first_replace.wait(timeout=10), "gate never released"
        real_replace(src, dst)

    monkeypatch.setattr(models, "_safe_replace", gated_replace)

    # A mutable stand-in for a session still being written by its own thread.
    live = {"session_id": "sid-7", "title": "at-save-time", "updated_at": 7, "message_count": 1}
    mutating_session = SimpleNamespace(session_id="sid-7", compact=lambda: dict(live))

    flusher = threading.Thread(
        target=models._queue_session_index_update,
        args=([_session("sid-0", 9000)],),
    )
    flusher.start()
    assert first_replace_entered.wait(timeout=10), "flusher never reached the rewrite"

    waiter = threading.Thread(
        target=models._queue_session_index_update,
        args=([mutating_session],),
    )
    waiter.start()
    deadline = time.monotonic() + 10
    while "sid-7" not in models._INDEX_PENDING_ROWS:
        assert time.monotonic() < deadline, "waiter never queued its row"
        time.sleep(0.01)

    # The session moves on after the save that queued it.
    live["title"] = "mutated-after-save"
    live["updated_at"] = 99999

    release_first_replace.set()
    for thread in (flusher, waiter):
        thread.join(timeout=10)
        assert not thread.is_alive()

    persisted = {row["session_id"]: row for row in json.loads(index_store.path.read_bytes())}
    assert persisted["sid-7"]["title"] == "at-save-time"
    assert persisted["sid-7"]["updated_at"] == 7


def test_a_saver_queued_behind_a_failing_rewrite_observes_the_failure(index_store, monkeypatch):
    """A queued saver must never report success for a rewrite that never landed."""
    first_replace_entered = threading.Event()
    release_first_replace = threading.Event()
    calls = []

    def failing_replace(src, dst):
        calls.append(str(dst))
        if len(calls) == 1:
            first_replace_entered.set()
            assert release_first_replace.wait(timeout=10), "gate never released"
        raise OSError("simulated index write failure")

    monkeypatch.setattr(models, "_safe_replace", failing_replace)

    errors = {}

    def save(key, session):
        try:
            models._queue_session_index_update([session])
        except BaseException as exc:  # noqa: BLE001 - recorded for the assertion
            errors[key] = exc

    flusher = threading.Thread(target=save, args=("flusher", _session("sid-0", 9000)))
    flusher.start()
    assert first_replace_entered.wait(timeout=10), "flusher never reached the rewrite"

    waiter = threading.Thread(target=save, args=("waiter", _session("sid-1", 9001)))
    waiter.start()
    deadline = time.monotonic() + 10
    while "sid-1" not in models._INDEX_PENDING_ROWS:
        assert time.monotonic() < deadline, "waiter never queued its row"
        time.sleep(0.01)

    release_first_replace.set()
    for thread in (flusher, waiter):
        thread.join(timeout=10)
        assert not thread.is_alive(), "a failed rewrite stranded a queued saver"

    assert isinstance(errors.get("flusher"), OSError)
    assert isinstance(errors.get("waiter"), OSError)
    # The gate must not stay latched after a failure, or every later save hangs.
    assert models._INDEX_FLUSH_IN_PROGRESS is False


def test_flusher_returns_after_its_own_batch_instead_of_draining_later_ones(
    index_store, monkeypatch
):
    """A saver must not stay on as flusher for unrelated sessions' rewrites.

    ``Session.save()`` runs under its session's mutation lock, so a flusher that
    kept draining a busy store's queue would pin that lock behind other
    sessions' streaming checkpoints indefinitely.
    """
    writers = []
    first_replace_entered = threading.Event()
    release_first_replace = threading.Event()
    real_replace = models._safe_replace

    def gated_replace(src, dst):
        writers.append(threading.current_thread().name)
        if len(writers) == 1:
            first_replace_entered.set()
            assert release_first_replace.wait(timeout=10), "gate never released"
        real_replace(src, dst)

    monkeypatch.setattr(models, "_safe_replace", gated_replace)

    flusher = threading.Thread(
        name="saver-a",
        target=models._queue_session_index_update,
        args=([_session("sid-0", 9000)],),
    )
    flusher.start()
    assert first_replace_entered.wait(timeout=10), "flusher never reached the rewrite"

    waiter = threading.Thread(
        name="saver-b",
        target=models._queue_session_index_update,
        args=([_session("sid-1", 9001)],),
    )
    waiter.start()
    deadline = time.monotonic() + 10
    while "sid-1" not in models._INDEX_PENDING_ROWS:
        assert time.monotonic() < deadline, "waiter never queued its row"
        time.sleep(0.01)

    release_first_replace.set()
    for thread in (flusher, waiter):
        thread.join(timeout=10)
        assert not thread.is_alive()

    # saver-a wrote only its own batch; saver-b picked up the handed-off role.
    assert writers == ["saver-a", "saver-b"]
    persisted = {row["session_id"]: row for row in json.loads(index_store.path.read_bytes())}
    assert persisted["sid-0"]["updated_at"] == 9000
    assert persisted["sid-1"]["updated_at"] == 9001


def test_index_replaced_mid_read_is_never_cached_under_the_new_signature(
    index_store, monkeypatch
):
    """A racy read must not poison the parsed cache with superseded rows.

    ``_read_session_index_entries()`` runs outside the index write lock, so the
    file can be replaced between its read and its stat. Caching the old rows
    under the new file's signature would hand the next targeted write a stale
    baseline and durably revert the save that replaced it.
    """
    path = index_store.path
    real_read_bytes = type(path).read_bytes
    replaced_rows = [dict(row) for row in index_store.rows]
    replaced_rows[1]["title"] = "written-by-the-intervening-save"

    raced = []

    def read_then_replace(self):
        data = real_read_bytes(self)
        if self == path and not raced:
            # Another writer lands between this read and the stat that follows.
            raced.append(True)
            path.write_text(json.dumps(replaced_rows), encoding="utf-8")
        return data

    monkeypatch.setattr(type(path), "read_bytes", read_then_replace)

    stale = models._read_session_index_entries()
    assert stale[1]["title"] == "sid-1", "test did not exercise the mid-read replace"
    assert models._cached_parsed_index(path) is None, "stale rows were cached"

    # The next targeted write must build on the replaced file, not the stale read.
    models._write_session_index(updates=[_session("sid-0", 9000)])
    persisted = {row["session_id"]: row for row in json.loads(path.read_bytes())}
    assert persisted["sid-1"]["title"] == "written-by-the-intervening-save"
    assert persisted["sid-0"]["updated_at"] == 9000
