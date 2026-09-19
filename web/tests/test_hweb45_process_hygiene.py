"""HWEB-45 — long-running-server resource hygiene.

Four independent defects in the same class (a resource acquired on a process
expected to run for weeks and never released), one test class each:

1. The reveal-in-file-manager and open-in-editor routes fired
   ``subprocess.Popen`` and dropped the handle, leaving a zombie per click.
2. The terminal spawn supervisor recovered from a raising ``_spawn_queue.get()``
   with a bare 10 ms sleep and no log call, so a persistently raising queue
   spun a core silently.
3. Turn-journal shards had no retention path at all.
4. The account-usage probe pool was swept — and refilled — under its global
   lock on a request thread.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from api import logging_hygiene, providers, subprocess_utils, terminal, turn_journal  # noqa: E402


# ═══════════════════════════════════════════════════════════════════════════════
#  1. Detached external-application spawns are reaped
# ═══════════════════════════════════════════════════════════════════════════════


def _assert_reaped(proc: subprocess.Popen) -> None:
    """Fail unless ``proc`` has been waited on (no zombie left in the table)."""
    assert proc.returncode is not None, (
        f"pid {proc.pid} was never waited on — it is a zombie"
    )
    if hasattr(os, "waitpid"):
        with pytest.raises(ChildProcessError):
            os.waitpid(proc.pid, os.WNOHANG)


class _FakeHandler:
    """Minimal stand-in for the BaseHTTPRequestHandler the routes are given."""

    command = "POST"


class _FakeSession:
    def __init__(self, workspace: Path):
        self.workspace = str(workspace)


@pytest.fixture
def spawned(monkeypatch):
    """Replace every detached spawn with a real, immediately-exiting child.

    The routes hand ``open`` / ``explorer.exe`` / ``xdg-open`` / the configured
    editor a path; running those for real would open GUI applications on the
    test host. Substituting the argv keeps the process lifecycle — the thing
    under test — completely real.
    """
    procs: list[subprocess.Popen] = []
    real_popen = subprocess.Popen

    def fake_popen(cmd, **kwargs):
        proc = real_popen([sys.executable, "-c", ""], **kwargs)
        procs.append(proc)
        return proc

    monkeypatch.setattr(subprocess_utils.subprocess, "Popen", fake_popen)
    return procs


class TestDetachedSpawnsAreReaped:
    def test_helper_reaps_a_fast_exiting_child(self, spawned):
        proc = subprocess_utils.spawn_detached_app(["open", "-R", "/tmp"])
        assert spawned == [proc]
        _assert_reaped(proc)

    def test_slow_child_is_parked_and_swept(self, monkeypatch):
        """A child that outlives the inline wait is reaped by the sweep, not leaked."""
        monkeypatch.setattr(
            subprocess_utils, "_DETACHED_SPAWN_REAP_TIMEOUT_SECONDS", 0.01
        )
        proc = subprocess_utils.spawn_detached_app(
            [sys.executable, "-c", "import time; time.sleep(0.4)"]
        )
        assert proc in subprocess_utils._PENDING_DETACHED_SPAWNS
        proc.wait(timeout=10)
        # ``wait`` already reaped it here; the sweep must still drop the entry so
        # the pending set does not grow one handle per slow spawn.
        subprocess_utils.reap_detached_spawns()
        assert proc not in subprocess_utils._PENDING_DETACHED_SPAWNS

    def test_reveal_route_leaves_no_zombie(self, tmp_path, monkeypatch, spawned):
        from api import routes

        target = tmp_path / "note.txt"
        target.write_text("hi", encoding="utf-8")
        monkeypatch.setattr(
            routes, "_file_ops_session_or_error", lambda h, sid: _FakeSession(tmp_path)
        )
        monkeypatch.setattr(routes, "j", lambda handler, payload, **kw: True)
        monkeypatch.setattr(routes, "bad", lambda handler, msg, *a, **kw: pytest.fail(msg))

        for system in ("Darwin", "Windows", "Linux"):
            monkeypatch.setattr(routes.platform, "system", lambda s=system: s)
            routes._handle_file_reveal(
                _FakeHandler(), {"session_id": "s1", "path": "note.txt"}
            )

        assert len(spawned) == 3
        for proc in spawned:
            _assert_reaped(proc)

    def test_open_in_editor_route_leaves_no_zombie(self, tmp_path, monkeypatch, spawned):
        from api import routes

        target = tmp_path / "note.txt"
        target.write_text("hi", encoding="utf-8")
        monkeypatch.setattr(
            routes, "_file_ops_session_or_error", lambda h, sid: _FakeSession(tmp_path)
        )
        monkeypatch.setattr(routes, "j", lambda handler, payload, **kw: True)
        monkeypatch.setattr(routes, "bad", lambda handler, msg, *a, **kw: pytest.fail(msg))
        monkeypatch.setattr(routes.shutil, "which", lambda cmd: sys.executable)

        routes._handle_file_open_vscode(
            _FakeHandler(), {"session_id": "s1", "path": "note.txt"}
        )

        assert len(spawned) == 1
        _assert_reaped(spawned[0])

    def test_no_bare_popen_left_in_the_two_routes(self):
        """Every external-app launch in these handlers goes through the helper."""
        src = (Path(__file__).resolve().parent.parent / "api" / "routes.py").read_text(
            encoding="utf-8"
        )
        for handler_name in ("_handle_file_reveal", "_handle_file_open_vscode"):
            start = src.index(f"def {handler_name}(handler, body):")
            body = src[start : src.index("\ndef ", start)]
            assert "subprocess.Popen(" not in body, handler_name
            assert "spawn_detached_app(" in body, handler_name


# ═══════════════════════════════════════════════════════════════════════════════
#  2. The terminal spawn supervisor logs once and backs off
# ═══════════════════════════════════════════════════════════════════════════════


class _StopLoop(Exception):
    pass


class TestSpawnSupervisorBackoff:
    @pytest.fixture(autouse=True)
    def _reset_supervisor_backoff(self):
        terminal._spawn_supervisor_failing = False
        terminal._spawn_supervisor_backoff_seconds = (
            terminal._SPAWN_SUPERVISOR_BACKOFF_MIN_SECONDS
        )
        yield
        terminal._spawn_supervisor_failing = False
        terminal._spawn_supervisor_backoff_seconds = (
            terminal._SPAWN_SUPERVISOR_BACKOFF_MIN_SECONDS
        )

    def test_raising_queue_get_logs_once_and_backs_off(self, monkeypatch, caplog):
        """A persistently raising get must not spin at 100 Hz, and must say so."""
        slept: list[float] = []

        class _RaisingQueue:
            def get(self):
                raise RuntimeError("queue is broken")

        def fake_sleep(seconds):
            slept.append(seconds)
            if len(slept) >= 6:
                raise _StopLoop

        monkeypatch.setattr(terminal, "_spawn_queue", _RaisingQueue())
        monkeypatch.setattr(terminal.time, "sleep", fake_sleep)

        with caplog.at_level(logging.DEBUG, logger=terminal.__name__):
            with pytest.raises(_StopLoop):
                terminal._spawn_supervisor_loop()

        warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
        assert len(warnings) == 1, [r.getMessage() for r in warnings]
        assert "spawn supervisor" in warnings[0].getMessage()

        # Strictly increasing until the cap: the old code slept 0.01 forever.
        assert slept[0] == terminal._SPAWN_SUPERVISOR_BACKOFF_MIN_SECONDS
        assert slept == sorted(slept)
        assert slept[-1] > slept[0]
        assert max(slept) <= terminal._SPAWN_SUPERVISOR_BACKOFF_MAX_SECONDS

    def test_backoff_is_capped(self, monkeypatch):
        for _ in range(40):
            monkeypatch.setattr(terminal.time, "sleep", lambda s: None)
            terminal._spawn_supervisor_backoff(RuntimeError("boom"), "loop")
        assert (
            terminal._spawn_supervisor_backoff_seconds
            == terminal._SPAWN_SUPERVISOR_BACKOFF_MAX_SECONDS
        )

    def test_recovery_resets_the_backoff_and_logs_again_next_run(self, monkeypatch):
        monkeypatch.setattr(terminal.time, "sleep", lambda s: None)
        terminal._spawn_supervisor_backoff(RuntimeError("boom"), "loop")
        assert terminal._spawn_supervisor_failing is True

        terminal._spawn_supervisor_recovered()
        assert terminal._spawn_supervisor_failing is False
        assert (
            terminal._spawn_supervisor_backoff_seconds
            == terminal._SPAWN_SUPERVISOR_BACKOFF_MIN_SECONDS
        )


# ═══════════════════════════════════════════════════════════════════════════════
#  3. Journal retention and WebUI log rotation
# ═══════════════════════════════════════════════════════════════════════════════


def _settled(turn_id: str) -> list[dict]:
    return [
        {"event": "submitted", "turn_id": turn_id, "created_at": 1},
        {"event": "completed", "turn_id": turn_id, "created_at": 2},
    ]


def _write_shard(
    journal_dir: Path,
    name: str,
    age_days: float,
    events: list[dict] | None = None,
    raw: bool = False,
) -> Path:
    journal_dir.mkdir(parents=True, exist_ok=True)
    path = journal_dir / name
    # Default to one settled turn: well-formed evidence that the session is done,
    # which is what most of these cases want the retention gate to act on.
    rows = events if events is not None else _settled("t0")
    if not raw:
        # Fill in what `append_turn_journal_event` always writes, so a fixture
        # only has to state the fields its case is actually about. An explicit
        # key in the row still wins.
        stem = name[: -len(".jsonl")]
        tilde = stem.find("~")
        sid = stem[:tilde] if tilde > 0 else stem
        rows = [{"version": 1, "session_id": sid, **row} for row in rows]
    path.write_text(
        "".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8"
    )
    if age_days:
        stamp = time.time() - age_days * 24 * 60 * 60
        os.utime(path, (stamp, stamp))
    return path


# Above pid_max on every supported platform, so `_pid_is_running` reports it dead
# and the emptied shard is unlinked. Never use a plausible pid here: CI runs in a
# container where low pids like 1111 are live, and a live owner is deliberately
# kept as a zero-byte file instead.
_DEAD_PID = 4194304


def _write_sidecar(root: Path, session_id: str, body: str | None = None) -> Path:
    """The live `{sid}.json` whose absence means the session awaits repair."""
    path = root / f"{session_id}.json"
    path.write_text(
        body
        if body is not None
        else json.dumps({"session_id": session_id, "messages": []}),
        encoding="utf-8",
    )
    return path


class TestTurnJournalRetention:
    def test_expired_shards_are_pruned_and_live_shards_are_not(self, tmp_path):
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        expired = _write_shard(journal_dir, f"old-session~{_DEAD_PID}.jsonl", age_days=30)
        legacy_expired = _write_shard(journal_dir, "legacy-session.jsonl", age_days=30)
        live = _write_shard(journal_dir, f"new-session~{_DEAD_PID}.jsonl", age_days=0)
        just_inside = _write_shard(journal_dir, f"recent~{_DEAD_PID}.jsonl", age_days=13)
        for sid in ("old-session", "legacy-session", "new-session", "recent"):
            _write_sidecar(tmp_path, sid)

        result = turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        assert result["pruned"] == 2
        assert result["bytes_reclaimed"] > 0
        assert not expired.exists()
        # No pid in the legacy name means no owner to prove dead: emptied, kept.
        assert legacy_expired.exists()
        assert legacy_expired.stat().st_size == 0
        assert live.exists()
        assert just_inside.exists()

    def test_this_process_own_shard_is_truncated_not_unlinked(self, tmp_path):
        """A server up past the retention window must reclaim its own storage.

        Unlinking would race ``append_turn_journal_event``, which reopens the
        path on every call — so the bytes go and the inode stays.
        """
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        mine = _write_shard(
            journal_dir,
            f"mine~{os.getpid()}.jsonl",
            age_days=90,
            events=_settled("t1"),
        )
        _write_sidecar(tmp_path, "mine")

        result = turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        assert result["pruned"] == 1
        assert mine.exists()
        assert mine.stat().st_size == 0

    def test_the_truncated_shard_still_accepts_appends(self, tmp_path):
        """The whole point of truncating: the session keeps working afterwards."""
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        mine = _write_shard(
            journal_dir,
            f"mine~{os.getpid()}.jsonl",
            age_days=90,
            events=_settled("t1"),
        )
        _write_sidecar(tmp_path, "mine")
        turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        turn_journal.append_turn_journal_event(
            "mine", {"event": "submitted"}, session_dir=tmp_path
        )

        assert mine.stat().st_size > 0
        events = turn_journal.read_turn_journal("mine", session_dir=tmp_path)["events"]
        assert [event["event"] for event in events] == ["submitted"]

    def test_an_already_emptied_shard_is_not_counted_again(self, tmp_path):
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        _write_shard(
            journal_dir,
            f"mine~{os.getpid()}.jsonl",
            age_days=90,
            events=_settled("t1"),
        )
        _write_sidecar(tmp_path, "mine")

        first = turn_journal.prune_stale_turn_journals(session_dir=tmp_path)
        second = turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        assert first["pruned"] == 1
        assert second["pruned"] == 0

    def test_an_emptied_shard_is_unlinked_once_its_owner_exits(self, tmp_path):
        """Otherwise every restart leaks one permanent zero-byte file per session."""
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        journal_dir.mkdir(parents=True, exist_ok=True)
        # A shard a previous run truncated and could not unlink while it lived.
        emptied = journal_dir / f"restarted~{_DEAD_PID}.jsonl"
        emptied.touch()
        stamp = time.time() - 90 * 24 * 60 * 60
        os.utime(emptied, (stamp, stamp))
        _write_sidecar(tmp_path, "restarted")

        result = turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        assert not emptied.exists()
        assert result["pruned"] == 1
        assert result["bytes_reclaimed"] == 0

    def test_an_emptied_shard_of_a_live_owner_is_left_alone(self, tmp_path):
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        journal_dir.mkdir(parents=True, exist_ok=True)
        emptied = journal_dir / f"mine~{os.getpid()}.jsonl"
        emptied.touch()
        stamp = time.time() - 90 * 24 * 60 * 60
        os.utime(emptied, (stamp, stamp))
        _write_sidecar(tmp_path, "mine")

        result = turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        assert emptied.exists()
        assert result["pruned"] == 0

    def test_release_declines_when_the_shard_changed_under_the_lock(self, tmp_path):
        """An append between the scan and the truncate aborts the whole attempt."""
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        mine = _write_shard(
            journal_dir, f"mine~{os.getpid()}.jsonl", age_days=0, events=_settled("t1")
        )
        size_before = mine.stat().st_size

        released = turn_journal._release_expired_shard(mine, expected_mtime=1.0)

        assert released is False
        assert mine.stat().st_size == size_before

    def test_a_live_foreign_pid_shard_is_emptied_but_not_unlinked(self, tmp_path):
        """Another live process may still append — never unlink out from under it."""
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        alive = _write_shard(
            journal_dir,
            f"shared~{os.getppid()}.jsonl",
            age_days=90,
            events=_settled("t1"),
        )
        _write_sidecar(tmp_path, "shared")

        result = turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        assert result["pruned"] == 1
        assert alive.exists()
        assert alive.stat().st_size == 0

    def test_an_event_without_a_turn_id_keeps_the_session(self, tmp_path):
        """Valid JSON, unusable evidence: it derives to nothing and looks settled."""
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        shard = _write_shard(
            journal_dir,
            f"no-turn-id~{_DEAD_PID}.jsonl",
            age_days=90,
            events=[{"event": "submitted", "created_at": 1}],
        )
        _write_sidecar(tmp_path, "no-turn-id")

        result = turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        assert result["pruned"] == 0
        assert shard.exists()

    @pytest.mark.parametrize(
        "created_at", [None, "1700000000", float("nan"), float("inf"), True]
    )
    def test_a_non_finite_or_absent_timestamp_keeps_the_session(
        self, tmp_path, created_at
    ):
        """`float(x or 0)` accepted all of these; a settled-looking session then
        lost its evidence, which is what this gate exists to prevent."""
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        events = [
            {"event": "submitted", "turn_id": "t1", "created_at": created_at},
            {"event": "completed", "turn_id": "t1", "created_at": 2},
        ]
        shard = _write_shard(
            journal_dir, f"odd~{_DEAD_PID}.jsonl", age_days=90, events=events
        )
        _write_sidecar(tmp_path, "odd")

        result = turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        assert result["pruned"] == 0
        assert shard.exists()

    def test_a_double_terminal_turn_keeps_the_session(self, tmp_path):
        """`completed` and `interrupted` on one turn is a contradiction the
        journal is the only remaining record of."""
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        events = [
            {"event": "submitted", "turn_id": "t1", "created_at": 1},
            {"event": "completed", "turn_id": "t1", "created_at": 2},
            {"event": "interrupted", "turn_id": "t1", "created_at": 3},
        ]
        shard = _write_shard(
            journal_dir, f"clash~{_DEAD_PID}.jsonl", age_days=90, events=events
        )
        _write_sidecar(tmp_path, "clash")
        _, collisions = turn_journal.derive_turn_journal_states(events)
        assert collisions, "fixture must actually produce a collision"

        result = turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        assert result["pruned"] == 0
        assert shard.exists()

    @pytest.mark.parametrize("missing", ["version", "session_id"])
    def test_an_event_missing_writer_fields_keeps_the_session(self, tmp_path, missing):
        """Every append sets both; an event without them came from elsewhere."""
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        rows = [
            {
                "version": 1,
                "session_id": "partial",
                "event": "completed",
                "turn_id": "t1",
                "created_at": 1,
            }
        ]
        rows[0].pop(missing)
        shard = _write_shard(
            journal_dir,
            f"partial~{_DEAD_PID}.jsonl",
            age_days=90,
            events=rows,
            raw=True,
        )
        _write_sidecar(tmp_path, "partial")

        result = turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        assert result["pruned"] == 0
        assert shard.exists()

    @pytest.mark.parametrize("version", [2, "1", None, 0, 1.5])
    def test_an_unsupported_journal_version_keeps_the_session(self, tmp_path, version):
        """A newer server may share this state directory; its events mean
        something this reader cannot judge, so it must not delete them."""
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        shard = _write_shard(
            journal_dir,
            f"future~{_DEAD_PID}.jsonl",
            age_days=90,
            events=[
                {
                    "version": version,
                    "session_id": "future",
                    "event": "completed",
                    "turn_id": "t1",
                    "created_at": 1,
                }
            ],
            raw=True,
        )
        _write_sidecar(tmp_path, "future")

        result = turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        assert result["pruned"] == 0
        assert shard.exists()

    def test_the_writer_and_the_retention_reader_agree_on_the_version(self, tmp_path):
        """Whatever `append_turn_journal_event` stamps must be prunable."""
        written = turn_journal.append_turn_journal_event(
            "agree", {"event": "completed"}, session_dir=tmp_path
        )

        assert written["version"] == turn_journal._SUPPORTED_JOURNAL_VERSION
        assert turn_journal._event_is_well_formed(written, "agree") is True

    @pytest.mark.parametrize("version", [True, 1.0])
    def test_a_version_equal_to_one_but_not_an_int_keeps_the_session(
        self, tmp_path, version
    ):
        """Python says `True == 1` and `1.0 == 1`; the writer emits an int."""
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        assert version == turn_journal._SUPPORTED_JOURNAL_VERSION, "premise"
        shard = _write_shard(
            journal_dir,
            f"looselike~{_DEAD_PID}.jsonl",
            age_days=90,
            events=[
                {
                    "version": version,
                    "session_id": "looselike",
                    "event": "completed",
                    "turn_id": "t1",
                    "created_at": 1,
                }
            ],
            raw=True,
        )
        _write_sidecar(tmp_path, "looselike")

        result = turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        assert result["pruned"] == 0
        assert shard.exists()

    @pytest.mark.parametrize("claimed", ["someone-else", None])
    def test_a_sidecar_that_names_another_session_keeps_the_journal(
        self, tmp_path, claimed
    ):
        """A sidecar copied under the wrong filename is a valid session file
        that is not *this* session, and neither _msg_count nor the audit says so."""
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        shard = _write_shard(
            journal_dir, f"borrowed~{_DEAD_PID}.jsonl", age_days=90, events=_settled("t1")
        )
        payload = {"messages": [{"role": "user", "content": "hi"}]}
        if claimed is not None:
            payload["session_id"] = claimed
        _write_sidecar(tmp_path, "borrowed", body=json.dumps(payload))

        from api.session_recovery import _msg_count

        assert _msg_count(tmp_path / "borrowed.json") >= 0, "fixture must look valid"

        result = turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        assert result["pruned"] == 0
        assert shard.exists()

    def test_an_event_claiming_another_session_keeps_the_session(self, tmp_path):
        """A shard whose events name a different session is not evidence of
        *this* session being settled."""
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        shard = _write_shard(
            journal_dir,
            f"mixed~{_DEAD_PID}.jsonl",
            age_days=90,
            events=[
                {
                    "version": 1,
                    "session_id": "someone-else",
                    "event": "completed",
                    "turn_id": "t1",
                    "created_at": 1,
                }
            ],
            raw=True,
        )
        _write_sidecar(tmp_path, "mixed")

        result = turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        assert result["pruned"] == 0
        assert shard.exists()

    def test_a_missing_created_at_key_keeps_the_session(self, tmp_path):
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        shard = _write_shard(
            journal_dir,
            f"nokey~{_DEAD_PID}.jsonl",
            age_days=90,
            events=[
                {"event": "submitted", "turn_id": "t1"},
                {"event": "completed", "turn_id": "t1", "created_at": 2},
            ],
        )
        _write_sidecar(tmp_path, "nokey")

        result = turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        assert result["pruned"] == 0
        assert shard.exists()

    def test_a_non_numeric_created_at_keeps_the_session_without_raising(self, tmp_path):
        """The event is unusable evidence, but must not abort the pass."""
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        shard = _write_shard(
            journal_dir,
            f"bad-clock~{_DEAD_PID}.jsonl",
            age_days=90,
            events=[
                {"event": "submitted", "turn_id": "t1", "created_at": "yesterday"},
                {"event": "completed", "turn_id": "t1", "created_at": "today"},
            ],
        )
        settled = _write_shard(
            journal_dir,
            f"fine~{_DEAD_PID}.jsonl",
            age_days=90,
            events=_settled("t2"),
        )
        _write_sidecar(tmp_path, "bad-clock")
        _write_sidecar(tmp_path, "fine")

        result = turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        assert shard.exists()
        # The healthy session in the same pass is still reclaimed.
        assert not settled.exists()
        assert result["pruned"] == 1

    def test_a_session_with_a_pending_turn_is_kept(self, tmp_path):
        """A nonterminal turn is still auditable/repairable — never drop it."""
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        pending = _write_shard(
            journal_dir,
            f"pending~{_DEAD_PID}.jsonl",
            age_days=90,
            events=[{"event": "submitted", "turn_id": "t1", "created_at": 1}],
        )
        settled = _write_shard(
            journal_dir, f"settled~{_DEAD_PID}.jsonl", age_days=90, events=_settled("t2")
        )
        _write_sidecar(tmp_path, "pending")
        _write_sidecar(tmp_path, "settled")

        result = turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        assert result["pruned"] == 1
        assert pending.exists()
        assert not settled.exists()

    def test_a_malformed_line_keeps_the_session(self, tmp_path):
        """A crash-torn event is the evidence recovery flags — never destroy it."""
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        journal_dir.mkdir(parents=True, exist_ok=True)
        torn = journal_dir / f"torn~{_DEAD_PID}.jsonl"
        torn.write_text(
            "".join(json.dumps(row) + "\n" for row in _settled("t1"))
            + '{"event":"submi',
            encoding="utf-8",
        )
        stamp = time.time() - 90 * 24 * 60 * 60
        os.utime(torn, (stamp, stamp))
        _write_sidecar(tmp_path, "torn")

        result = turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        assert result["pruned"] == 0
        assert torn.exists()

    def test_a_missing_sidecar_keeps_the_session(self, tmp_path):
        """No `{sid}.json` means the session awaits repair; the journal is it."""
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        orphan = _write_shard(
            journal_dir, f"orphan~{_DEAD_PID}.jsonl", age_days=90, events=_settled("t1")
        )

        result = turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        assert result["pruned"] == 0
        assert orphan.exists()

    @pytest.mark.parametrize("body", ["{}", "[]", '{"messages": "no"}', "null"])
    def test_a_json_but_not_session_shaped_sidecar_keeps_the_session(
        self, tmp_path, body
    ):
        """Decodable is not the same as usable. `{}` passed a bare dict check
        while `session_recovery._msg_count` calls it invalid."""
        from api.session_recovery import _msg_count

        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        shard = _write_shard(
            journal_dir, f"shapeless~{_DEAD_PID}.jsonl", age_days=90, events=_settled("t1")
        )
        _write_sidecar(tmp_path, "shapeless", body=body)
        assert _msg_count(tmp_path / "shapeless.json") < 0, "fixture must be invalid"

        result = turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        assert result["pruned"] == 0
        assert shard.exists()

    def test_an_unparseable_sidecar_keeps_the_session(self, tmp_path):
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        shard = _write_shard(
            journal_dir, f"corrupt~{_DEAD_PID}.jsonl", age_days=90, events=_settled("t1")
        )
        _write_sidecar(tmp_path, "corrupt", body="{not json")

        result = turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        assert result["pruned"] == 0
        assert shard.exists()

    def test_a_recovery_finding_keeps_the_session(self, tmp_path):
        """A sidecar that parses fine can still be `shrunken_live` vs its .bak.

        Only `audit_session_recovery` can see that, which is why the RFC gates
        pruning on the audit rather than on the sidecar's shape.
        """
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        shrunken = _write_shard(
            journal_dir, f"shrunk~{_DEAD_PID}.jsonl", age_days=90, events=_settled("t1")
        )
        healthy = _write_shard(
            journal_dir, f"whole~{_DEAD_PID}.jsonl", age_days=90, events=_settled("t2")
        )
        # A live sidecar with fewer messages than its backup is `shrunken_live`.
        _write_sidecar(
            tmp_path,
            "shrunk",
            body=json.dumps({"session_id": "shrunk", "messages": []}),
        )
        (tmp_path / "shrunk.json.bak").write_text(
            json.dumps({"messages": [{"role": "user", "content": "hi"}]}),
            encoding="utf-8",
        )
        _write_sidecar(tmp_path, "whole")

        from api.session_recovery import audit_session_recovery

        audit = audit_session_recovery(tmp_path)
        assert any(
            item["session_id"] == "shrunk" for item in audit["items"]
        ), "fixture must actually produce a recovery finding"

        result = turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        assert shrunken.exists()
        assert not healthy.exists()
        assert result["pruned"] == 1

    def test_an_untrustworthy_audit_retains_everything(self, tmp_path, monkeypatch):
        """No audit, no pruning — the RFC's precondition cannot be assumed met."""
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        shard = _write_shard(
            journal_dir, f"any~{_DEAD_PID}.jsonl", age_days=90, events=_settled("t1")
        )
        _write_sidecar(tmp_path, "any")
        monkeypatch.setattr(
            turn_journal, "_sessions_with_recovery_findings", lambda root: None
        )

        result = turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        assert result["pruned"] == 0
        assert shard.exists()

    def test_retention_is_disabled_without_advisory_locks(self, tmp_path, monkeypatch):
        """Windows has no appender lock, so truncation could erase an append."""
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        shard = _write_shard(
            journal_dir, f"winlike~{_DEAD_PID}.jsonl", age_days=90, events=_settled("t1")
        )
        _write_sidecar(tmp_path, "winlike")
        monkeypatch.setattr(turn_journal, "_fcntl", None)

        result = turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        assert result["pruned"] == 0
        assert shard.exists()
        assert shard.stat().st_size > 0

    def test_a_junk_created_at_no_longer_raises_out_of_derive(self):
        """It used to take down the retention pass and the recovery audit."""
        events = [
            {"event": "submitted", "turn_id": "t1", "created_at": "yesterday"},
            {"event": "completed", "turn_id": "t1", "created_at": None},
        ]

        states, collisions = turn_journal.derive_turn_journal_states(events)

        assert set(states) == {"t1"}
        assert collisions == []

    def test_a_turn_completed_under_another_pid_is_prunable(self, tmp_path):
        """Shards merge per session: half a turn read alone must not look pending."""
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        first = _write_shard(
            journal_dir,
            f"split~{_DEAD_PID}.jsonl",
            age_days=90,
            events=[{"event": "submitted", "turn_id": "t1", "created_at": 1}],
        )
        second = _write_shard(
            journal_dir,
            f"split~{_DEAD_PID + 1}.jsonl",
            age_days=90,
            events=[{"event": "completed", "turn_id": "t1", "created_at": 2}],
        )
        _write_sidecar(tmp_path, "split")

        result = turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        assert result["pruned"] == 2
        assert not first.exists()
        assert not second.exists()

    def test_one_live_shard_keeps_the_whole_session(self, tmp_path):
        """A session written to yesterday keeps its older shards for the merge."""
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        old_shard = _write_shard(journal_dir, f"chatty~{_DEAD_PID}.jsonl", age_days=90)
        new_shard = _write_shard(journal_dir, f"chatty~{_DEAD_PID + 1}.jsonl", age_days=1)
        _write_sidecar(tmp_path, "chatty")

        result = turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        assert result["pruned"] == 0
        assert old_shard.exists()
        assert new_shard.exists()

    def test_dry_run_counts_without_deleting(self, tmp_path):
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        expired = _write_shard(
            journal_dir, f"old~{_DEAD_PID}.jsonl", age_days=30, events=_settled("t1")
        )
        _write_sidecar(tmp_path, "old")

        result = turn_journal.prune_stale_turn_journals(
            session_dir=tmp_path, dry_run=True
        )

        assert result["pruned"] == 1
        assert expired.exists()

    def test_missing_journal_directory_is_a_no_op(self, tmp_path):
        assert turn_journal.prune_stale_turn_journals(session_dir=tmp_path) == {
            "examined": 0,
            "pruned": 0,
            "bytes_reclaimed": 0,
        }

    def test_retention_window_comes_from_the_environment(self, tmp_path, monkeypatch):
        monkeypatch.setenv(turn_journal._TURN_JOURNAL_RETENTION_DAYS_ENV, "1")
        journal_dir = tmp_path / turn_journal.TURN_JOURNAL_DIR_NAME
        two_days = _write_shard(
            journal_dir, f"two-days~{_DEAD_PID}.jsonl", age_days=2, events=_settled("t1")
        )
        _write_sidecar(tmp_path, "two-days")

        turn_journal.prune_stale_turn_journals(session_dir=tmp_path)

        assert not two_days.exists()


class TestWebuiLogRotation:
    def test_oversized_log_is_copy_truncated_in_place(self, tmp_path):
        log = tmp_path / "bootstrap-8787.log"
        log.write_bytes(b"x" * 4096)
        inode_before = log.stat().st_ino

        assert logging_hygiene.rotate_webui_log(path=log, max_bytes=1024) is True

        # Same inode: an inherited O_APPEND descriptor keeps writing to the file
        # the server was started with. A rename would have orphaned it.
        assert log.stat().st_ino == inode_before
        assert log.stat().st_size == 0
        assert (tmp_path / "bootstrap-8787.log.1").read_bytes() == b"x" * 4096

    def test_writes_after_rotation_land_at_the_start_of_the_file(self, tmp_path):
        """An O_APPEND writer holding the fd across rotation must not leave a hole."""
        log = tmp_path / "bootstrap-8787.log"
        log.write_bytes(b"x" * 4096)
        with open(log, "ab") as held:
            logging_hygiene.rotate_webui_log(path=log, max_bytes=1024)
            held.write(b"after\n")
            held.flush()
        assert log.read_bytes() == b"after\n"

    def test_ctl_log_file_env_selects_the_sink(self, tmp_path, monkeypatch):
        """`ctl.sh start` execs bootstrap --foreground, which never makes a
        bootstrap-<port>.log — it exports its own sink instead."""
        ctl_log = tmp_path / "webui.log"
        ctl_log.write_bytes(b"x")
        monkeypatch.setenv(logging_hygiene._WEBUI_LOG_FILE_ENV, str(ctl_log))

        assert logging_hygiene.webui_log_path() == ctl_log

    def test_ctl_absolutizes_a_relative_log_path(self):
        """A relative override resolves against the invocation cwd, not the
        server's — ctl.sh must absolutize before redirecting and exporting."""
        ctl = (Path(__file__).resolve().parent.parent / "ctl.sh").read_text(
            encoding="utf-8"
        )
        assert 'LOG_FILE="${PWD}/${LOG_FILE}"' in ctl
        assert 'export HERMES_WEBUI_LOG_FILE="${LOG_FILE}"' in ctl

    def test_every_launcher_exports_its_log_sink(self):
        """Each launcher that redirects stdout must tell the server where.

        ctl.sh and the WSL autostart script both run bootstrap --foreground,
        which execs in place and never creates a bootstrap-<port>.log.
        """
        root = Path(__file__).resolve().parent.parent
        for script, var in (
            ("ctl.sh", "LOG_FILE"),
            ("scripts/wsl/hermes_webui_autostart.sh", "WEBUI_LOG"),
        ):
            text = (root / script).read_text(encoding="utf-8")
            assert "export HERMES_WEBUI_LOG_FILE=" in text, script
            # A relative path resolves differently in the shell and the server.
            assert f'{var}="${{PWD}}/${{{var}}}"' in text, script

    def test_bootstrap_sink_is_the_last_resort(self, monkeypatch):
        """Nothing configured and no file-backed descriptor: fall back."""
        from api.config import PORT

        monkeypatch.delenv(logging_hygiene._WEBUI_LOG_FILE_ENV, raising=False)
        monkeypatch.setattr(logging_hygiene, "_path_for_fd", lambda fd: None)

        assert logging_hygiene.webui_log_paths() == [
            Path(logging_hygiene.webui_log_paths()[0].parent) / f"bootstrap-{PORT}.log"
        ]

    def test_the_sink_is_discovered_from_the_descriptor(self, tmp_path, monkeypatch):
        """No launcher told us this path — the OS did.

        This is what covers a launchd plist, or any future launcher that
        forgets to export its sink.
        """
        monkeypatch.delenv(logging_hygiene._WEBUI_LOG_FILE_ENV, raising=False)
        sink = tmp_path / "launchd-stdout.log"
        fd = os.open(sink, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
        try:
            discovered = logging_hygiene._path_for_fd(fd)
        finally:
            os.close(fd)

        assert discovered is not None
        assert discovered.resolve() == sink.resolve()

    def test_separate_stdout_and_stderr_sinks_are_both_returned(
        self, tmp_path, monkeypatch
    ):
        """A launchd plist points StandardOutPath and StandardErrorPath apart."""
        monkeypatch.delenv(logging_hygiene._WEBUI_LOG_FILE_ENV, raising=False)
        out = tmp_path / "launchd-stdout.log"
        err = tmp_path / "launchd-stderr.log"
        monkeypatch.setattr(
            logging_hygiene, "_path_for_fd", lambda fd: out if fd == 1 else err
        )

        assert logging_hygiene.webui_log_paths() == [out, err]

    def test_both_sinks_are_rotated(self, tmp_path, monkeypatch):
        monkeypatch.delenv(logging_hygiene._WEBUI_LOG_FILE_ENV, raising=False)
        out = tmp_path / "launchd-stdout.log"
        err = tmp_path / "launchd-stderr.log"
        for log in (out, err):
            log.write_bytes(b"x" * 4096)
        monkeypatch.setattr(
            logging_hygiene, "_path_for_fd", lambda fd: out if fd == 1 else err
        )

        assert logging_hygiene.rotate_webui_log(max_bytes=1024) is True

        assert out.stat().st_size == 0
        assert err.stat().st_size == 0
        assert (tmp_path / "launchd-stdout.log.1").read_bytes() == b"x" * 4096
        assert (tmp_path / "launchd-stderr.log.1").read_bytes() == b"x" * 4096

    def test_a_relative_override_does_not_shadow_the_descriptors(
        self, tmp_path, monkeypatch
    ):
        """The launcher opened the relative path against its own cwd; the server
        would resolve it against a different one, so the descriptors win."""
        real = tmp_path / "actual-sink.log"
        monkeypatch.setenv(logging_hygiene._WEBUI_LOG_FILE_ENV, "webui.log")
        monkeypatch.setattr(logging_hygiene, "_path_for_fd", lambda fd: real)

        assert logging_hygiene.webui_log_paths() == [real]

    def test_an_absolute_override_still_wins(self, tmp_path, monkeypatch):
        chosen = tmp_path / "chosen.log"
        other = tmp_path / "other.log"
        monkeypatch.setenv(logging_hygiene._WEBUI_LOG_FILE_ENV, str(chosen))
        monkeypatch.setattr(logging_hygiene, "_path_for_fd", lambda fd: other)

        assert logging_hygiene.webui_log_paths() == [chosen]

    def test_a_non_file_descriptor_is_not_a_sink(self, monkeypatch):
        """A terminal or pipe has nothing to rotate."""
        read_fd, write_fd = os.pipe()
        try:
            assert logging_hygiene._path_for_fd(write_fd) is None
        finally:
            os.close(read_fd)
            os.close(write_fd)

    def test_rotation_truncates_the_inode_it_copied(self, tmp_path, monkeypatch):
        """An external rotator renaming the file mid-sequence must not cause the
        fresh replacement to be erased."""
        log = tmp_path / "webui.log"
        log.write_bytes(b"old" * 2048)
        real_copyfileobj = logging_hygiene.shutil.copyfileobj

        def rename_midway(src, dst, *a, **kw):
            real_copyfileobj(src, dst, *a, **kw)
            # An external rotator moves our inode aside and a new log appears.
            log.rename(tmp_path / "webui.log.external")
            log.write_bytes(b"fresh")

        monkeypatch.setattr(logging_hygiene.shutil, "copyfileobj", rename_midway)

        logging_hygiene.rotate_webui_log(path=log, max_bytes=1024)

        # The replacement is untouched; the old inode we held is the one emptied.
        assert log.read_bytes() == b"fresh"
        assert (tmp_path / "webui.log.external").stat().st_size == 0

    def test_log_under_the_cap_is_left_alone(self, tmp_path):
        log = tmp_path / "bootstrap-8787.log"
        log.write_bytes(b"x" * 100)
        assert logging_hygiene.rotate_webui_log(path=log, max_bytes=1024) is False
        assert log.stat().st_size == 100
        assert not (tmp_path / "bootstrap-8787.log.1").exists()

    def test_missing_log_is_a_no_op(self, tmp_path):
        assert (
            logging_hygiene.rotate_webui_log(path=tmp_path / "absent.log", max_bytes=1)
            is False
        )

    def test_zero_cap_disables_rotation(self, tmp_path):
        log = tmp_path / "bootstrap-8787.log"
        log.write_bytes(b"x" * 4096)
        assert logging_hygiene.rotate_webui_log(path=log, max_bytes=0) is False
        assert log.stat().st_size == 4096


class TestHygieneRunsOnTheReaperTick:
    def test_reaper_tick_drives_retention_rotation_and_eviction(self, monkeypatch):
        from api import background_process as bp

        called: list[str] = []
        monkeypatch.setattr(bp, "_retention_last_run", None)
        monkeypatch.setattr(
            providers,
            "_cleanup_account_usage_probe_workers",
            lambda **kw: called.append("evict"),
        )
        monkeypatch.setattr(
            logging_hygiene, "rotate_webui_log", lambda **kw: called.append("rotate")
        )
        monkeypatch.setattr(
            subprocess_utils, "reap_detached_spawns", lambda: called.append("reap")
        )
        monkeypatch.setattr(
            turn_journal,
            "prune_stale_turn_journals",
            lambda **kw: called.append("turn")
            or {"examined": 0, "pruned": 0, "bytes_reclaimed": 0},
        )
        from api import run_journal

        monkeypatch.setattr(
            run_journal, "schedule_run_journal_prune", lambda **kw: called.append("run")
        )

        bp._run_process_hygiene()

        assert set(called) == {"evict", "rotate", "reap", "turn", "run"}

    def test_retention_is_coalesced_but_cheap_sweeps_are_not(self, monkeypatch):
        """Retention must not re-scan every 60 s tick; eviction must run on each."""
        from api import background_process as bp
        from api import run_journal

        cheap: list[int] = []
        retention: list[int] = []
        monkeypatch.setattr(bp, "_retention_last_run", None)
        monkeypatch.setattr(
            providers,
            "_cleanup_account_usage_probe_workers",
            lambda **kw: cheap.append(1),
        )
        monkeypatch.setattr(logging_hygiene, "rotate_webui_log", lambda **kw: None)
        monkeypatch.setattr(subprocess_utils, "reap_detached_spawns", lambda: 0)
        monkeypatch.setattr(
            turn_journal,
            "prune_stale_turn_journals",
            lambda **kw: retention.append(1)
            or {"examined": 0, "pruned": 0, "bytes_reclaimed": 0},
        )
        monkeypatch.setattr(run_journal, "schedule_run_journal_prune", lambda **kw: None)

        bp._run_process_hygiene()
        bp._run_process_hygiene()
        bp._run_process_hygiene()

        assert len(cheap) == 3
        assert len(retention) == 1

    def test_a_failing_step_does_not_abort_the_rest(self, monkeypatch, caplog):
        from api import background_process as bp
        from api import run_journal

        monkeypatch.setattr(bp, "_retention_last_run", None)
        monkeypatch.setattr(
            providers,
            "_cleanup_account_usage_probe_workers",
            lambda **kw: (_ for _ in ()).throw(RuntimeError("boom")),
        )
        reaped: list[int] = []
        monkeypatch.setattr(logging_hygiene, "rotate_webui_log", lambda **kw: None)
        monkeypatch.setattr(
            subprocess_utils, "reap_detached_spawns", lambda: reaped.append(1)
        )
        monkeypatch.setattr(
            turn_journal,
            "prune_stale_turn_journals",
            lambda **kw: {"examined": 0, "pruned": 0, "bytes_reclaimed": 0},
        )
        monkeypatch.setattr(run_journal, "schedule_run_journal_prune", lambda **kw: None)

        with caplog.at_level(logging.WARNING, logger=bp.__name__):
            bp._run_process_hygiene()

        assert reaped == [1]
        assert any("probe-pool eviction" in r.getMessage() for r in caplog.records)


# ═══════════════════════════════════════════════════════════════════════════════
#  4. The probe pool is never refilled under its global lock on a request path
# ═══════════════════════════════════════════════════════════════════════════════


class _StubProc:
    """Stand-in for a probe worker subprocess that answers nothing."""

    def __init__(self):
        self.stdin = self
        self.stdout = self
        self.terminated = False

    def write(self, _data):
        return None

    def flush(self):
        return None

    def readline(self):
        return ""

    def close(self):
        return None

    def poll(self):
        return None if not self.terminated else 0

    def terminate(self):
        self.terminated = True

    def wait(self, timeout=None):
        self.terminated = True
        return 0

    def kill(self):
        self.terminated = True


@pytest.fixture
def probe_pool(monkeypatch):
    """Isolate the module-global probe pool and record every spawn attempt."""
    monkeypatch.setattr(providers, "_account_usage_worker_pool", {})
    spawns: list[bool] = []

    def fake_popen(*args, **kwargs):
        # ``acquire(blocking=False)`` failing means some frame up the stack still
        # holds the pool lock — the exact defect this ticket removes.
        acquired = providers._account_usage_worker_pool_lock.acquire(blocking=False)
        spawns.append(acquired)
        if acquired:
            providers._account_usage_worker_pool_lock.release()
        return _StubProc()

    monkeypatch.setattr(providers.subprocess, "Popen", fake_popen)
    return spawns


class TestProbePoolLockHygiene:
    def test_usage_fetch_spawns_no_subprocess_under_the_pool_lock(
        self, tmp_path, probe_pool
    ):
        providers._agent_fetch_account_usage_for_home("anthropic", tmp_path)

        assert probe_pool, "expected the fetch to launch a probe worker"
        assert all(probe_pool), "a probe subprocess was spawned while holding the pool lock"

    def test_cleanup_spawns_nothing_at_all(self, tmp_path, probe_pool):
        """Eviction shrinks the pool; the next fetch refills it off the lock."""
        key = str(Path(tmp_path))
        workers = [
            providers._AccountUsageProbeWorker(Path(tmp_path))
            for _ in range(providers._ACCOUNT_USAGE_WORKERS_PER_HOME)
        ]
        for worker in workers:
            worker.last_used = time.monotonic() - 10 * 60
        providers._account_usage_worker_pool[key] = workers

        providers._cleanup_account_usage_probe_workers()

        assert probe_pool == []
        assert key not in providers._account_usage_worker_pool

    def test_fetch_no_longer_sweeps_the_pool_on_the_request_path(
        self, tmp_path, monkeypatch, probe_pool
    ):
        swept: list[int] = []
        monkeypatch.setattr(
            providers,
            "_cleanup_account_usage_probe_workers",
            lambda **kw: swept.append(1),
        )

        providers._agent_fetch_account_usage_for_home("anthropic", tmp_path)

        assert swept == []

    def test_pool_refills_lazily_on_the_next_fetch(self, tmp_path, probe_pool):
        key = str(Path(tmp_path))
        worker = providers._get_account_usage_probe_worker(Path(tmp_path))
        assert worker is not None
        worker._lock.release()
        assert (
            len(providers._account_usage_worker_pool[key])
            == providers._ACCOUNT_USAGE_WORKERS_PER_HOME
        )
        assert probe_pool == [], "constructing a pool worker must not spawn a process"

    def test_worker_construction_holds_no_process(self, tmp_path):
        worker = providers._AccountUsageProbeWorker(Path(tmp_path))
        assert worker._proc is None


def test_pool_lock_is_not_reentrant():
    """The violation detector above relies on a non-reentrant pool lock."""
    assert not isinstance(providers._account_usage_worker_pool_lock, type(threading.RLock()))
