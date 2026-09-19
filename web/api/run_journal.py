"""Append-only WebUI run event journal helpers.

This is the first #1925 journal/replay slice.  It mirrors SSE events emitted by
the existing in-process streaming path without changing execution ownership.
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import weakref
from collections import OrderedDict
from pathlib import Path
from typing import Any, Iterable

logger = logging.getLogger(__name__)

RUN_JOURNAL_DIR_NAME = "_run_journal"
_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
# Weak values preserve same-path mutual exclusion while a writer/append call is
# alive without retaining one lock forever per historical run. Stateful writers
# hold their lock strongly; free-function appenders hold the local lock across
# reserve+write. The guard still serializes dictionary structure access.
_WRITER_LOCKS: "weakref.WeakValueDictionary[tuple[str, str, str], threading.Lock]" = weakref.WeakValueDictionary()
_WRITER_LOCKS_GUARD = threading.Lock()
# Retention must not unlink a journal while a stateful writer still owns an
# open/reusable handle for it.  On Unix, later writes to that handle would
# succeed against the unlinked inode and return event ids whose rows are no
# longer discoverable for replay.  Counts support the defensive case where two
# writer objects target the same run.
_ACTIVE_WRITER_COUNTS: dict[str, int] = {}
_ACTIVE_WRITER_COUNTS_LOCK = threading.Lock()
# Next-seq to assign per run-journal file path, kept in memory so repeat appends
# to the same run do not re-parse the whole file on every call. The per-path
# ``_lock_for(path)`` serializes same-path reserve→append so seqs stay monotonic
# and file order matches; ``_SEQ_CACHE_LOCK`` (below) additionally guards every
# *structural* access to the dict (reserve/note/evict) so ``delete_run_journal``
# can iterate + drop keys while a concurrent append on ANOTHER path inserts one,
# without a ``dictionary changed size during iteration`` crash. See
# ``_reserve_next_seq`` and ``delete_run_journal`` (which evicts stale entries).
_SEQ_CACHE: dict[str, int] = {}
_SEQ_CACHE_LOCK = threading.Lock()
# Summary callers only need terminal state and the latest cursor. Re-parsing a
# completed journal's full payload (which can include multi-megabyte tool or
# session results) on every status/reconnect probe is needless. This process
# cache is keyed by a complete stat identity, so it is never used after an
# atomic replacement, append, truncate, or same-path file recreation.
_SUMMARY_CACHE_MAX_ENTRIES = 128
_SUMMARY_CACHE: OrderedDict[str, tuple[tuple[int, int, int, int, int], dict]] = OrderedDict()
_SUMMARY_CACHE_LOCK = threading.Lock()
# Events that mark a run terminal in the journal / summary sense.
TERMINAL_SSE_EVENTS = frozenset({"done", "cancel", "apperror", "error", "stream_end"})
# Events that should close an SSE relay drain loop. `done` is intentionally
# excluded: background title generation and `stream_end` are emitted after
# `done`, and breaking early would drop them. `apperror` is included because
# it terminates with no trailing `stream_end`.
SSE_RELAY_CLOSE_EVENTS = frozenset({"stream_end", "cancel", "apperror", "error"})
# Back-compat alias used by older call sites / tests.
_TERMINAL_SSE_EVENTS = TERMINAL_SSE_EVENTS
_FSYNC_MODE_ENV = "HERMES_WEBUI_RUN_JOURNAL_FSYNC"
_FSYNC_MODE_EAGER = "eager"
_FSYNC_MODE_TERMINAL_ONLY = "terminal-only"
_SESSION_REPLAY_MAX_BYTES = 4 * 1024 * 1024
_SESSION_REPLAY_MAX_ROWS = 4096
_SESSION_REPLAY_READ_CHUNK_BYTES = 64 * 1024
_LIVE_SNAPSHOT_MAX_BYTES = 1024 * 1024
_LIVE_SNAPSHOT_MAX_ROWS = 512
_RUN_SUMMARY_MAX_BYTES = 4 * 1024 * 1024
_RUN_SUMMARY_MAX_ROWS = 512
_SNAPSHOT_ARGS_MAX_ITEMS = 64
_SNAPSHOT_ARGS_MAX_DEPTH = 8
_SNAPSHOT_ARGS_MAX_STRING_CHARS = 8192
_SNAPSHOT_ARGS_MAX_TOTAL_CHARS = 64 * 1024
_SNAPSHOT_ARGS_TRUNCATED_SUFFIX = "...[truncated]"
_PRUNED_SUMMARY_SUFFIX = ".summary.json"
_RUN_JOURNAL_RETENTION_DAYS_ENV = "HERMES_WEBUI_RUN_JOURNAL_RETENTION_DAYS"
_RUN_JOURNAL_KEEP_RECENT_ENV = "HERMES_WEBUI_RUN_JOURNAL_KEEP_RECENT"
_RUN_JOURNAL_DEFAULT_RETENTION_DAYS = 14.0
_RUN_JOURNAL_DEFAULT_KEEP_RECENT = 3
_RUN_JOURNAL_PRUNE_INTERVAL_SECONDS = 6 * 60 * 60
_RUN_JOURNAL_TAIL_MAX_BYTES = 64 * 1024 * 1024
_RUN_JOURNAL_TAIL_MAX_EVENTS = 32
_PRUNE_THREAD: threading.Thread | None = None
_PRUNE_LAST_STARTED = 0.0
_PRUNE_LOCK = threading.Lock()


def _default_session_dir() -> Path:
    from api.models import SESSION_DIR

    return Path(SESSION_DIR)


def _validate_id(value: str, field: str) -> str:
    cleaned = str(value or "").strip()
    if not cleaned or "/" in cleaned or "\\" in cleaned or not _SAFE_ID_RE.fullmatch(cleaned):
        raise ValueError(f"invalid {field}")
    return cleaned


def _run_path(session_id: str, run_id: str, session_dir: Path | None = None) -> Path:
    sid = _validate_id(session_id, "session_id")
    rid = _validate_id(run_id, "run_id")
    root = Path(session_dir) if session_dir is not None else _default_session_dir()
    return root / RUN_JOURNAL_DIR_NAME / sid / f"{rid}.jsonl"


def _lock_for(path: Path) -> threading.Lock:
    key = (str(path.parent), path.name, str(os.getpid()))
    with _WRITER_LOCKS_GUARD:
        lock = _WRITER_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _WRITER_LOCKS[key] = lock
        return lock


def _register_active_writer(path: Path) -> None:
    key = str(path)
    with _ACTIVE_WRITER_COUNTS_LOCK:
        _ACTIVE_WRITER_COUNTS[key] = _ACTIVE_WRITER_COUNTS.get(key, 0) + 1


def _unregister_active_writer(path: Path) -> None:
    key = str(path)
    with _ACTIVE_WRITER_COUNTS_LOCK:
        remaining = _ACTIVE_WRITER_COUNTS.get(key, 0) - 1
        if remaining > 0:
            _ACTIVE_WRITER_COUNTS[key] = remaining
        else:
            _ACTIVE_WRITER_COUNTS.pop(key, None)


def _has_active_writer(path: Path) -> bool:
    with _ACTIVE_WRITER_COUNTS_LOCK:
        return _ACTIVE_WRITER_COUNTS.get(str(path), 0) > 0


def _summary_cache_signature(path: Path) -> tuple[int, int, int, int, int] | None:
    """Return the complete filesystem identity used for summary-cache validity.

    Includes ``st_ctime_ns`` so a same-inode, same-size rewrite that restores the
    original ``mtime_ns`` (e.g. an atomic replace) still invalidates the cache —
    ctime advances on any metadata/content change and cannot be forged back.
    """
    try:
        stat = path.stat()
    except OSError:
        return None
    return (
        int(stat.st_dev),
        int(stat.st_ino),
        int(stat.st_size),
        int(stat.st_mtime_ns),
        int(stat.st_ctime_ns),
    )


def _get_cached_summary(path: Path) -> dict | None:
    signature = _summary_cache_signature(path)
    if signature is None:
        return None
    key = str(path)
    with _SUMMARY_CACHE_LOCK:
        cached = _SUMMARY_CACHE.get(key)
        if cached is None:
            return None
        cached_signature, summary = cached
        if cached_signature != signature:
            _SUMMARY_CACHE.pop(key, None)
            return None
        _SUMMARY_CACHE.move_to_end(key)
        return dict(summary)


def _cache_summary(
    path: Path,
    summary: dict,
    *,
    expected_signature: tuple[int, int, int, int, int] | None = None,
) -> None:
    signature = _summary_cache_signature(path)
    # The pre-read signature is an enforced TOCTOU precondition. In particular,
    # a journal created after a missing-file read has ``None -> signature`` and
    # must not cache the empty/unknown result under the new file's identity.
    if signature is None or signature != expected_signature:
        return
    key = str(path)
    with _SUMMARY_CACHE_LOCK:
        _SUMMARY_CACHE[key] = (signature, dict(summary))
        _SUMMARY_CACHE.move_to_end(key)
        while len(_SUMMARY_CACHE) > _SUMMARY_CACHE_MAX_ENTRIES:
            _SUMMARY_CACHE.popitem(last=False)


def _discard_cached_summary(path: Path) -> None:
    with _SUMMARY_CACHE_LOCK:
        _SUMMARY_CACHE.pop(str(path), None)


def _read_jsonl(path: Path) -> tuple[list[dict], list[dict]]:
    events: list[dict] = []
    malformed: list[dict] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return events, malformed
    for line_no, raw in enumerate(lines, start=1):
        if not raw.strip():
            continue
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            malformed.append({"line": line_no, "raw": raw})
            continue
        if isinstance(parsed, dict):
            events.append(parsed)
        else:
            malformed.append({"line": line_no, "raw": raw})
    return events, malformed


def _pruned_summary_path(path: Path) -> Path:
    return path.with_name(f"{path.stem}{_PRUNED_SUMMARY_SUFFIX}")


def _load_pruned_summary(path: Path) -> dict | None:
    summary_path = _pruned_summary_path(path)
    try:
        parsed = json.loads(summary_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return None
    return dict(parsed) if isinstance(parsed, dict) else None


def _read_tail_events(path: Path) -> list[dict]:
    """Read only the bounded tail needed to classify a settled journal."""
    try:
        size = path.stat().st_size
        start = max(0, size - _RUN_JOURNAL_TAIL_MAX_BYTES)
        with path.open("rb") as fh:
            fh.seek(start)
            raw = fh.read(_RUN_JOURNAL_TAIL_MAX_BYTES)
    except (FileNotFoundError, OSError):
        return []
    if start:
        newline = raw.find(b"\n")
        if newline < 0:
            return []
        raw = raw[newline + 1 :]
    events: list[dict] = []
    for line in raw.splitlines()[-_RUN_JOURNAL_TAIL_MAX_EVENTS:]:
        try:
            parsed = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        if isinstance(parsed, dict):
            events.append(parsed)
    return events


def _summary_from_tail(session_id: str, run_id: str, events: list[dict]) -> dict | None:
    if not events or str(events[-1].get("event") or "") not in TERMINAL_SSE_EVENTS:
        return None
    summary = _summary_from_events(session_id, run_id, events)
    last = events[-1]
    last_seq = int(last.get("seq") or 0)
    if last_seq <= 0:
        return None
    summary["event_count"] = last_seq
    summary["last_seq"] = last_seq
    summary["journal_pruned"] = True
    return summary


def _write_pruned_summary(path: Path, summary: dict) -> Path:
    summary_path = _pruned_summary_path(path)
    tmp_path = summary_path.with_name(
        f".{summary_path.name}.{os.getpid()}.{threading.get_ident()}.tmp"
    )
    payload = json.dumps(summary, ensure_ascii=False, separators=(",", ":")) + "\n"
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with tmp_path.open("w", encoding="utf-8") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, summary_path)
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
    return summary_path


def _parse_run_journal_event_id(raw: str | None) -> tuple[str | None, int | None]:
    raw = str(raw or "").strip()
    if not raw:
        return None, None
    if ":" in raw:
        run_id, tail = raw.rsplit(":", 1)
    else:
        run_id, tail = None, raw
    try:
        seq = max(0, int(tail))
    except (TypeError, ValueError):
        return run_id or None, None
    return run_id or None, seq


def _snapshot_args_take_budget(budget: dict[str, int], amount: int) -> int:
    remaining = max(0, int(budget.get("remaining") or 0))
    take = min(remaining, max(0, amount))
    budget["remaining"] = remaining - take
    return take


def _bound_snapshot_args_string(value: str, budget: dict[str, int]) -> str:
    max_chars = min(len(value), _SNAPSHOT_ARGS_MAX_STRING_CHARS)
    take = _snapshot_args_take_budget(budget, max_chars)
    out = value[:take]
    if take < len(value):
        suffix_take = _snapshot_args_take_budget(budget, len(_SNAPSHOT_ARGS_TRUNCATED_SUFFIX))
        out += _SNAPSHOT_ARGS_TRUNCATED_SUFFIX[:suffix_take]
    return out


def _bound_run_journal_snapshot_value(value: Any, budget: dict[str, int], depth: int) -> Any:
    if budget.get("remaining", 0) <= 0:
        return None
    if isinstance(value, str):
        return _bound_snapshot_args_string(value, budget)
    if isinstance(value, dict):
        if depth >= _SNAPSHOT_ARGS_MAX_DEPTH:
            return {}
        out: dict[str, Any] = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= _SNAPSHOT_ARGS_MAX_ITEMS or budget.get("remaining", 0) <= 0:
                break
            bounded_key = _bound_snapshot_args_string(str(key), budget)
            if not bounded_key:
                continue
            out[bounded_key] = _bound_run_journal_snapshot_value(item, budget, depth + 1)
        return out
    if isinstance(value, (list, tuple)):
        if depth >= _SNAPSHOT_ARGS_MAX_DEPTH:
            return []
        return [
            _bound_run_journal_snapshot_value(item, budget, depth + 1)
            for item in value[:_SNAPSHOT_ARGS_MAX_ITEMS]
            if budget.get("remaining", 0) > 0
        ]
    if isinstance(value, (bool, int, float)) or value is None:
        try:
            _snapshot_args_take_budget(budget, len(json.dumps(value)))
        except (TypeError, ValueError):
            return None
        return value
    return _bound_snapshot_args_string(str(value), budget)


def bound_run_journal_snapshot_args(args: Any) -> Any:
    """Return recovery tool args with realistic values intact and pathological payloads bounded."""
    if args is None:
        return {}
    budget = {"remaining": _SNAPSHOT_ARGS_MAX_TOTAL_CHARS}
    return _bound_run_journal_snapshot_value(args, budget, 0)


def _next_seq(path: Path) -> int:
    events, _malformed = _read_jsonl(path)
    seqs = [int(event.get("seq") or 0) for event in events if isinstance(event.get("seq"), int)]
    return (max(seqs) + 1) if seqs else 1


def _reserve_next_seq(path: Path) -> int:
    """Reserve and return the next seq for ``path``, advancing the in-memory cache.

    Callers MUST hold ``_lock_for(path)``. The first append per path in this
    process seeds the cache from ``_next_seq(path)`` (one file read); every later
    append is a pure in-memory increment, avoiding the O(n) re-parse that
    re-reading the whole journal on every append caused (O(n^2) over a run).
    Because ``RunJournalWriter`` and the free ``append_run_event`` share this one
    cache under the same per-path lock, their seqs stay monotonic and gapless
    even when both write the same path. ``_SEQ_CACHE_LOCK`` additionally makes the
    dict get+set atomic against a concurrent cross-path eviction.
    """
    key = str(path)
    with _SEQ_CACHE_LOCK:
        nxt = _SEQ_CACHE.get(key)
        if nxt is not None:
            _SEQ_CACHE[key] = nxt + 1
            return nxt
    # Cache miss: seed from disk WITHOUT holding the module-global lock, so a
    # slow first-access file read for one path can't block every other path's
    # cache ops. The caller holds the per-path lock, so only one thread per path
    # can reach this branch — no double-seed, and no same-path writer can race
    # the value in between.
    seeded = _next_seq(path)
    with _SEQ_CACHE_LOCK:
        _SEQ_CACHE[key] = seeded + 1
        return seeded


def _note_assigned_seq(path: Path, seq: int) -> None:
    """Keep the cache at least one past an explicitly-supplied ``seq``.

    Callers MUST hold ``_lock_for(path)``. When an append carries a caller-chosen
    ``seq`` rather than drawing from the cache, advance the cache so a later
    cache-based append on the same path cannot re-issue an already-used seq.
    """
    key = str(path)
    nxt = int(seq) + 1
    with _SEQ_CACHE_LOCK:
        if _SEQ_CACHE.get(key, 0) < nxt:
            _SEQ_CACHE[key] = nxt


def _discard_seq_cache(path: Path) -> None:
    """Release the next-sequence hint after a writer lifecycle is finished.

    The journal on disk remains authoritative. If an unusual late append occurs
    after teardown, ``_reserve_next_seq`` safely seeds itself from that durable
    tail again instead of retaining one process-global entry per historical run.
    """
    with _SEQ_CACHE_LOCK:
        _SEQ_CACHE.pop(str(path), None)


def _terminal_state_for_event(event_name: str, payload) -> str | None:
    name = str(event_name or "")
    if name == "done" or name == "stream_end":
        if isinstance(payload, dict):
            explicit_state = str(payload.get("terminal_state") or "").strip().lower()
            if explicit_state in {"tool_limit_reached"}:
                return explicit_state
        return "completed"
    if name == "cancel":
        return "interrupted-by-user"
    if name in {"apperror", "error"}:
        err_type = str((payload or {}).get("type") or "").strip().lower() if isinstance(payload, dict) else ""
        if err_type == "tool_limit_reached":
            return "tool_limit_reached"
        if err_type in {"cancelled", "canceled"}:
            return "interrupted-by-user"
        if err_type == "interrupted":
            return "interrupted-by-crash"
        return "errored"
    return None


def _run_journal_fsync_mode() -> str:
    raw = os.environ.get(_FSYNC_MODE_ENV, _FSYNC_MODE_TERMINAL_ONLY)
    mode = str(raw or "").strip().lower()
    if mode in {_FSYNC_MODE_EAGER, _FSYNC_MODE_TERMINAL_ONLY}:
        return mode
    return _FSYNC_MODE_TERMINAL_ONLY


def _should_fsync_event(terminal_state: str | None) -> bool:
    if _run_journal_fsync_mode() == _FSYNC_MODE_EAGER:
        return True
    return bool(terminal_state)


def _fsync_parent_dir(path: Path) -> None:
    try:
        dir_fd = os.open(path.parent, getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except OSError:
        pass


def _event_created_at(event: dict, *, fallback: float = 0.0) -> float:
    try:
        return float(event.get("created_at") or fallback)
    except (TypeError, ValueError):
        return fallback


def _iter_bounded_raw_jsonl_lines(path: Path, *, max_bytes: int, retained_bytes: int = 0):
    line_no = 0
    buffered = bytearray()
    total_bytes = int(retained_bytes)
    try:
        with path.open("rb") as fh:
            while True:
                chunk = fh.read(_SESSION_REPLAY_READ_CHUNK_BYTES)
                if not chunk:
                    if buffered:
                        if total_bytes + len(buffered) > max_bytes:
                            raise ValueError("replay_limit_bytes")
                        line_no += 1
                        total_bytes += len(buffered)
                        yield line_no, bytes(buffered), total_bytes
                    return
                start = 0
                while start < len(chunk):
                    newline = chunk.find(b"\n", start)
                    if newline == -1:
                        buffered.extend(chunk[start:])
                        if total_bytes + len(buffered) > max_bytes:
                            raise ValueError("replay_limit_bytes")
                        break
                    buffered.extend(chunk[start : newline + 1])
                    if total_bytes + len(buffered) > max_bytes:
                        raise ValueError("replay_limit_bytes")
                    line_no += 1
                    total_bytes += len(buffered)
                    yield line_no, bytes(buffered), total_bytes
                    buffered.clear()
                    start = newline + 1
    except FileNotFoundError:
        return


def append_run_event(
    session_id: str,
    run_id: str,
    event_name: str,
    payload=None,
    *,
    session_dir: Path | None = None,
    seq: int | None = None,
    created_at: float | None = None,
) -> dict:
    """Append one durable run event and fsync it according to the journal policy."""
    path = _run_path(session_id, run_id, session_dir=session_dir)
    payload = payload if payload is not None else {}
    event_name = str(event_name or "").strip()
    if not event_name:
        raise ValueError("event_name is required")
    with _lock_for(path):
        if seq is not None:
            assigned_seq = int(seq)
            _note_assigned_seq(path, assigned_seq)
        else:
            assigned_seq = _reserve_next_seq(path)
        terminal_state = _terminal_state_for_event(event_name, payload)
        event = {
            "version": 1,
            "event_id": f"{run_id}:{assigned_seq}",
            "seq": assigned_seq,
            "run_id": str(run_id),
            "session_id": str(session_id),
            "event": event_name,
            "type": event_name,
            "created_at": float(created_at if created_at is not None else time.time()),
            "terminal": bool(terminal_state),
            "terminal_state": terminal_state,
            "payload": payload,
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        created_file = not path.exists()
        line = json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n"
        fd = os.open(path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as fh:
            fh.write(line)
            fh.flush()
            if _should_fsync_event(terminal_state):
                os.fsync(fh.fileno())
        _discard_cached_summary(path)
        if created_file:
            _fsync_parent_dir(path)
        if event_name in SSE_RELAY_CLOSE_EVENTS:
            _discard_seq_cache(path)
    if terminal_state and session_dir is None:
        schedule_run_journal_prune()
    return event


class RunJournalWriter:
    """Stateful writer for one WebUI stream/run."""

    def __init__(self, session_id: str, run_id: str, *, session_dir: Path | None = None):
        self.session_id = _validate_id(session_id, "session_id")
        self.run_id = _validate_id(run_id, "run_id")
        self.session_dir = Path(session_dir) if session_dir is not None else None
        self._path = _run_path(self.session_id, self.run_id, session_dir=self.session_dir)
        self._lock = _lock_for(self._path)
        self._fh = None
        self._registered = True
        _register_active_writer(self._path)

    def append_sse_event(self, event_name: str, payload=None) -> dict:
        # Reservation and append must be one critical section.  Reserving here
        # and then releasing the lock before ``append_run_event`` reacquired it
        # allowed another writer to reserve+append seq N+1 first, leaving the
        # physical journal in [N+1, N] order. Replay consumes file order, so the
        # sequence assignment must be atomic with the durable append.
        event_name = str(event_name or "").strip()
        if not event_name:
            raise ValueError("event_name is required")
        payload = payload if payload is not None else {}
        terminal_state = _terminal_state_for_event(event_name, payload)
        with self._lock:
            if not self._registered:
                raise RuntimeError("run journal writer is closed")
            seq = _reserve_next_seq(self._path)
            event = {
                "version": 1,
                "event_id": f"{self.run_id}:{seq}",
                "seq": seq,
                "run_id": self.run_id,
                "session_id": self.session_id,
                "event": event_name,
                "type": event_name,
                "created_at": float(time.time()),
                "terminal": bool(terminal_state),
                "terminal_state": terminal_state,
                "payload": payload,
            }
            self._path.parent.mkdir(parents=True, exist_ok=True)
            created_file = not self._path.exists()
            try:
                if self._fh is None or self._fh.closed:
                    fd = os.open(self._path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
                    self._fh = os.fdopen(fd, "a", encoding="utf-8")
                self._fh.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
                # Flush before returning: put_gateway_event/put emits to the SSE
                # queue only after this method, preserving durable-before-visible
                # replay semantics while avoiding open/close on every delta.
                self._fh.flush()
                if _should_fsync_event(terminal_state):
                    os.fsync(self._fh.fileno())
                _discard_cached_summary(self._path)
                if created_file:
                    _fsync_parent_dir(self._path)
                if event_name in SSE_RELAY_CLOSE_EVENTS:
                    self._fh.close()
                    self._fh = None
                    _discard_seq_cache(self._path)
            except Exception:
                self._close_locked()
                raise
        if terminal_state and self.session_dir is None:
            schedule_run_journal_prune()
        return event

    def _close_locked(self) -> None:
        fh = self._fh
        self._fh = None
        if fh is None:
            return
        try:
            fh.flush()
        finally:
            fh.close()

    def close(self) -> None:
        """Flush and close this writer's reusable journal handle."""
        with self._lock:
            self._close_locked()
            _discard_seq_cache(self._path)
            if self._registered:
                self._registered = False
                _unregister_active_writer(self._path)

    def __del__(self):  # pragma: no cover - deterministic callers use close().
        try:
            self.close()
        except Exception:
            pass


def read_run_events(
    session_id: str,
    run_id: str,
    *,
    after_seq: int | None = None,
    max_seq: int | None = None,
    session_dir: Path | None = None,
) -> dict:
    path = _run_path(session_id, run_id, session_dir=session_dir)
    events, malformed = _read_jsonl(path)
    if after_seq is not None:
        events = [event for event in events if int(event.get("seq") or 0) > int(after_seq)]
    if max_seq is not None:
        events = [event for event in events if int(event.get("seq") or 0) <= int(max_seq)]
    return {
        "session_id": str(session_id),
        "run_id": str(run_id),
        "events": events,
        "malformed": malformed,
    }


def read_run_event_tail(
    session_id: str,
    run_id: str,
    *,
    session_dir: Path | None = None,
    max_bytes: int = _LIVE_SNAPSHOT_MAX_BYTES,
    max_rows: int = _LIVE_SNAPSHOT_MAX_ROWS,
) -> dict:
    """Read a bounded recent window for active-run recovery snapshots."""
    sid = _validate_id(session_id, "session_id")
    rid = _validate_id(run_id, "run_id")
    path = _run_path(sid, rid, session_dir=session_dir)
    byte_limit = max(1, int(max_bytes))
    row_limit = max(1, int(max_rows))
    try:
        size = path.stat().st_size
        start = max(0, size - byte_limit)
        with path.open("rb") as fh:
            fh.seek(start)
            raw = fh.read(byte_limit)
    except (FileNotFoundError, OSError):
        return {
            "session_id": sid,
            "run_id": rid,
            "events": [],
            "malformed": [],
            "truncated": False,
        }

    if start:
        newline = raw.find(b"\n")
        raw = b"" if newline < 0 else raw[newline + 1 :]
    raw_lines = raw.splitlines()
    rows_truncated = len(raw_lines) > row_limit
    selected = raw_lines[-row_limit:]
    events: list[dict] = []
    malformed: list[dict] = []
    for offset, line in enumerate(selected, start=1):
        if not line.strip():
            continue
        try:
            parsed = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            malformed.append({"tail_line": offset})
            continue
        if isinstance(parsed, dict):
            events.append(parsed)
        else:
            malformed.append({"tail_line": offset})
    return {
        "session_id": sid,
        "run_id": rid,
        "events": events,
        "malformed": malformed,
        "truncated": bool(start or rows_truncated),
    }


def read_run_event_window(
    session_id: str,
    run_id: str,
    *,
    start_offset: int = 0,
    session_dir: Path | None = None,
    max_bytes: int = _LIVE_SNAPSHOT_MAX_BYTES,
    max_rows: int = _LIVE_SNAPSHOT_MAX_ROWS,
) -> dict:
    """Read a bounded window of complete rows forward from a byte offset.

    The inverse of ``read_run_event_tail``: recovery that keeps a cursor walks
    the journal from where it left off instead of taking one clipped tail.
    ``next_offset`` is the byte just past the last row returned, so the caller
    can persist it and continue. ``truncated`` means rows remain past this
    window (or a single row is larger than it); an offset that no longer sits
    on a row boundary falls back to the start of the file.
    """
    sid = _validate_id(session_id, "session_id")
    rid = _validate_id(run_id, "run_id")
    path = _run_path(sid, rid, session_dir=session_dir)
    byte_limit = max(1, int(max_bytes))
    row_limit = max(1, int(max_rows))
    start = max(0, int(start_offset or 0))
    try:
        size = path.stat().st_size
        with path.open("rb") as fh:
            if start > size:
                start = 0
            if start:
                fh.seek(start - 1)
                boundary = fh.read(2)
                if boundary[:1] == b"\n":
                    fh.seek(start)
                elif boundary[1:2] == b"\n":
                    # The previous window consumed an unterminated final row
                    # whose newline has since been written: step over it.
                    start += 1
                    fh.seek(start)
                else:
                    start = 0
                    fh.seek(0)
            raw = fh.read(byte_limit)
    except (FileNotFoundError, OSError):
        # Not end of file: the journal could not be read at all. Callers that
        # keep state across reads must not treat this as the run's end.
        return {
            "session_id": sid,
            "run_id": rid,
            "events": [],
            "malformed": [],
            "truncated": False,
            "unavailable": True,
            "window_full": False,
            "next_offset": start,
        }

    end = raw.rfind(b"\n")
    lines = raw[: end + 1].split(b"\n")[:-1] if end >= 0 else []
    suffix = raw[end + 1 :]
    unterminated_row = None
    if suffix.strip() and start + len(raw) >= size:
        # The file ends without a newline. A writer that crashed after its
        # final row was written but before the newline leaves exactly this
        # shape, and the tail reader accepts it; a row still being written is
        # not valid JSON yet and stays unconsumed.
        try:
            candidate = json.loads(suffix.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            candidate = None
        if isinstance(candidate, dict):
            unterminated_row = suffix
            lines.append(suffix)
    rows_truncated = len(lines) > row_limit
    selected = lines[:row_limit]
    consumed = sum(len(line) + 1 for line in selected)
    if unterminated_row is not None and selected and selected[-1] is unterminated_row:
        consumed -= 1
    events: list[dict] = []
    row_offsets: list[int] = []
    malformed: list[dict] = []
    row_start = start
    for offset, line in enumerate(selected, start=1):
        this_row = row_start
        row_start += len(line) + 1
        if not line.strip():
            continue
        try:
            parsed = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            malformed.append({"window_line": offset})
            continue
        if isinstance(parsed, dict):
            events.append(parsed)
            row_offsets.append(this_row)
        else:
            malformed.append({"window_line": offset})
    next_offset = start + consumed
    return {
        "session_id": sid,
        "run_id": rid,
        "events": events,
        # Byte offset of each returned event's row, parallel to ``events``.
        "row_offsets": row_offsets,
        "malformed": malformed,
        "truncated": bool(rows_truncated or next_offset < size),
        # Distinguishes "one row is larger than the window" (full window, no
        # newline) from "the last row is still being written" (short read).
        "window_full": len(raw) >= byte_limit,
        "unavailable": False,
        "next_offset": next_offset,
    }


def select_authoritative_terminal_event(events: Iterable[dict]) -> dict | None:
    """Return the terminal event that owns the run's settled outcome.

    ``stream_end`` is transport closure, so a preceding semantic terminal event
    (done, cancel, or error) remains authoritative. Among semantic terminal
    events, the latest journal row wins.
    """
    terminal_events = [
        event
        for event in events
        if isinstance(event, dict) and event.get("terminal")
    ]
    return next(
        (
            event
            for event in reversed(terminal_events)
            if event.get("event") != "stream_end"
        ),
        terminal_events[-1] if terminal_events else None,
    )


def _summary_from_events(session_id: str, run_id: str, events: Iterable[dict]) -> dict:
    ordered = [event for event in events if isinstance(event, dict)]
    last = ordered[-1] if ordered else None
    terminal = select_authoritative_terminal_event(ordered)
    status = terminal.get("terminal_state") if terminal else ("running" if ordered else "unknown")
    return {
        "session_id": str(session_id),
        "run_id": str(run_id),
        "stream_id": str(run_id),
        "event_count": len(ordered),
        "last_seq": int((last or {}).get("seq") or 0),
        "last_event_id": (last or {}).get("event_id"),
        "terminal": bool(terminal),
        "terminal_state": status,
        "last_event": (last or {}).get("event"),
    }


def latest_run_summary(session_id: str, run_id: str, *, session_dir: Path | None = None) -> dict:
    path = _run_path(session_id, run_id, session_dir=session_dir)
    if not path.exists():
        pruned = _load_pruned_summary(path)
        if pruned is not None:
            return pruned
    cached = _get_cached_summary(path)
    if cached is not None:
        return cached
    pre_read_signature = _summary_cache_signature(path)
    tail = read_run_event_tail(
        session_id,
        run_id,
        session_dir=session_dir,
        max_bytes=_RUN_SUMMARY_MAX_BYTES,
        max_rows=_RUN_SUMMARY_MAX_ROWS,
    )
    events = tail.get("events") or []
    summary = _summary_from_events(session_id, run_id, events)
    if events:
        summary["event_count"] = int(events[-1].get("seq") or len(events))
    summary["journal_truncated"] = bool(tail.get("truncated"))
    _cache_summary(path, summary, expected_signature=pre_read_signature)
    return summary


def session_journal_fingerprint(session_id: str, *, session_dir: Path | None = None) -> tuple[int, float, int]:
    """Cheap, bounded fingerprint of a session's run journal: (file_count, max_mtime, total_size).

    Reads only directory + per-file stat metadata (never parses journal bodies), so it stays
    O(runs) and cannot be tipped over by a large ``done`` row. Used to detect that the journal
    advanced during an idle live-subscribe wait — a run that starts AND finishes inside a single
    keepalive tick leaves the journal changed but never materializes a live in-memory stream, so a
    no-cursor idle subscriber would otherwise miss it until a manual refresh. Returns (0, 0.0, 0)
    when the session has no journal yet. Invalid ids resolve to the empty fingerprint rather than
    raising so callers can probe unconditionally.
    """
    try:
        sid = _validate_id(session_id, "session_id")
    except ValueError:
        return (0, 0.0, 0)
    root = Path(session_dir) if session_dir is not None else _default_session_dir()
    session_root = root / RUN_JOURNAL_DIR_NAME / sid
    if not session_root.exists():
        return (0, 0.0, 0)
    count = 0
    max_mtime = 0.0
    total_size = 0
    for path in session_root.glob("*.jsonl"):
        try:
            st = path.stat()
        except OSError:
            continue
        count += 1
        total_size += st.st_size
        if st.st_mtime > max_mtime:
            max_mtime = st.st_mtime
    return (count, max_mtime, total_size)


def find_run_summary(run_id: str, *, session_dir: Path | None = None) -> dict | None:
    rid = _validate_id(run_id, "run_id")
    root = Path(session_dir) if session_dir is not None else _default_session_dir()
    journal_root = root / RUN_JOURNAL_DIR_NAME
    for path in journal_root.glob(f"*/{rid}.jsonl"):
        session_id = path.parent.name
        summary = _get_cached_summary(path)
        if summary is None:
            pre_read_signature = _summary_cache_signature(path)
            tail = read_run_event_tail(
                session_id,
                rid,
                session_dir=root,
                max_bytes=_RUN_SUMMARY_MAX_BYTES,
                max_rows=_RUN_SUMMARY_MAX_ROWS,
            )
            events = tail.get("events") or []
            summary = _summary_from_events(session_id, rid, events)
            if events:
                summary["event_count"] = int(events[-1].get("seq") or len(events))
            summary["journal_truncated"] = bool(tail.get("truncated"))
            _cache_summary(path, summary, expected_signature=pre_read_signature)
        summary["path"] = str(path)
        return summary
    for summary_path in journal_root.glob(f"*/{rid}{_PRUNED_SUMMARY_SUFFIX}"):
        path = summary_path.with_name(f"{rid}.jsonl")
        summary = _load_pruned_summary(path)
        if summary is not None:
            summary["path"] = str(summary_path)
            return summary
    return None


def read_session_run_events(
    session_id: str,
    *,
    after_event_id: str | None = None,
    session_dir: Path | None = None,
    max_bytes: int = _SESSION_REPLAY_MAX_BYTES,
    max_rows: int = _SESSION_REPLAY_MAX_ROWS,
) -> dict:
    """Replay durable run-journal rows for one session after an opaque cursor."""
    sid = _validate_id(session_id, "session_id")
    cursor_run_id, cursor_seq = _parse_run_journal_event_id(after_event_id)
    raw_cursor = str(after_event_id or "").strip()
    if raw_cursor and cursor_run_id is not None:
        try:
            cursor_run_id = _validate_id(cursor_run_id, "run_id")
        except ValueError:
            cursor_seq = None
    if raw_cursor:
        try:
            if int(raw_cursor.rsplit(":", 1)[-1]) < 0:
                cursor_seq = None
        except (TypeError, ValueError):
            pass
    if raw_cursor and (cursor_run_id is None or cursor_seq is None or cursor_seq <= 0):
        return {
            "session_id": sid,
            "cursor_run_id": cursor_run_id,
            "cursor_seq": cursor_seq,
            "status": "cursor_invalid",
            "events": [],
        }
    if not raw_cursor:
        return {
            "session_id": sid,
            "cursor_run_id": None,
            "cursor_seq": None,
            "status": "ok",
            "events": [],
        }
    root = Path(session_dir) if session_dir is not None else _default_session_dir()
    session_root = root / RUN_JOURNAL_DIR_NAME / sid
    runs: list[tuple[float, str, list[dict]]] = []
    retained_rows = 0
    retained_bytes = 0
    for path in sorted(session_root.glob("*.jsonl")) if session_root.exists() else []:
        run_id = path.stem
        try:
            run_id = _validate_id(run_id, "run_id")
        except ValueError:
            continue
        events: list[dict] = []
        expected_seq = 1
        try:
            for _line_no, raw, total_bytes in _iter_bounded_raw_jsonl_lines(
                path,
                max_bytes=max_bytes,
                retained_bytes=retained_bytes,
            ):
                retained_bytes = total_bytes
                if not raw.strip():
                    continue
                try:
                    event = json.loads(raw.decode("utf-8"))
                    seq = int(event.get("seq")) if isinstance(event, dict) else 0
                except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
                    return {"session_id": sid, "cursor_run_id": cursor_run_id, "cursor_seq": cursor_seq, "status": "replay_malformed", "events": []}
                if (
                    seq != expected_seq
                    or event.get("event_id") != f"{run_id}:{seq}"
                    or event.get("run_id") != run_id
                    or event.get("session_id") != sid
                ):
                    return {"session_id": sid, "cursor_run_id": cursor_run_id, "cursor_seq": cursor_seq, "status": "replay_noncontiguous", "events": []}
                expected_seq += 1
                retained_rows += 1
                if retained_rows > max_rows:
                    return {"session_id": sid, "cursor_run_id": cursor_run_id, "cursor_seq": cursor_seq, "status": "replay_limit_rows", "events": []}
                events.append(event)
        except FileNotFoundError:
            continue
        except ValueError as exc:
            if str(exc) == "replay_limit_bytes":
                return {"session_id": sid, "cursor_run_id": cursor_run_id, "cursor_seq": cursor_seq, "status": "replay_limit_bytes", "events": []}
            raise
        created_at = min((_event_created_at(event) for event in events), default=path.stat().st_mtime)
        runs.append((created_at, run_id, events))
    runs.sort(key=lambda run: (run[0], run[1]))
    cursor_index = next((index for index, (_created_at, run_id, _events) in enumerate(runs) if run_id == cursor_run_id), None)
    if cursor_index is None:
        if cursor_run_id and _pruned_summary_path(
            session_root / f"{cursor_run_id}.jsonl"
        ).exists():
            return {
                "session_id": sid,
                "cursor_run_id": cursor_run_id,
                "cursor_seq": cursor_seq,
                "status": "cursor_pruned",
                "events": [],
            }
        foreign_paths = root.joinpath(RUN_JOURNAL_DIR_NAME).glob(f"*/{cursor_run_id}.jsonl") if cursor_run_id else []
        foreign_session_id = next((path.parent.name for path in foreign_paths if path.parent.name != sid), "")
        status = "cursor_run_missing"
        if foreign_session_id:
            status = "cursor_session_mismatch"
        return {
            "session_id": sid,
            "cursor_run_id": cursor_run_id,
            "cursor_seq": cursor_seq,
            "status": status,
            "events": [],
        }
    cursor_events = runs[cursor_index][2]
    if cursor_seq is None or cursor_seq > len(cursor_events):
        return {"session_id": sid, "cursor_run_id": cursor_run_id, "cursor_seq": cursor_seq, "status": "cursor_event_missing", "events": []}
    replay_events = [event for event in cursor_events if event["seq"] > cursor_seq]
    for _created_at, _run_id, events in runs[cursor_index + 1:]:
        replay_events.extend(events)
    return {
        "session_id": sid,
        "cursor_run_id": cursor_run_id,
        "cursor_seq": cursor_seq,
        "status": "ok",
        "events": replay_events,
    }


def _retention_seconds_from_env() -> float:
    raw = os.environ.get(
        _RUN_JOURNAL_RETENTION_DAYS_ENV,
        str(_RUN_JOURNAL_DEFAULT_RETENTION_DAYS),
    )
    try:
        days = float(raw)
    except (TypeError, ValueError):
        days = _RUN_JOURNAL_DEFAULT_RETENTION_DAYS
    return max(0.0, days) * 24 * 60 * 60


def _retention_keep_recent_from_env() -> int:
    raw = os.environ.get(
        _RUN_JOURNAL_KEEP_RECENT_ENV,
        str(_RUN_JOURNAL_DEFAULT_KEEP_RECENT),
    )
    try:
        return max(0, int(raw))
    except (TypeError, ValueError):
        return _RUN_JOURNAL_DEFAULT_KEEP_RECENT


def prune_settled_run_journals(
    *,
    session_dir: Path | None = None,
    now: float | None = None,
    retention_seconds: float | None = None,
    keep_recent: int | None = None,
    dry_run: bool = False,
) -> dict:
    """Compact expired terminal journals while preserving active recovery data."""
    root = Path(session_dir) if session_dir is not None else _default_session_dir()
    journal_root = root / RUN_JOURNAL_DIR_NAME
    retention = float(
        _retention_seconds_from_env()
        if retention_seconds is None
        else max(0.0, retention_seconds)
    )
    cutoff = float(now if now is not None else time.time()) - retention
    keep = (
        _retention_keep_recent_from_env()
        if keep_recent is None
        else max(0, int(keep_recent))
    )
    result = {
        "examined": 0,
        "terminal": 0,
        "pruned": 0,
        "bytes_reclaimed": 0,
    }
    if retention <= 0 or not journal_root.exists():
        return result

    for session_root in journal_root.iterdir():
        if not session_root.is_dir() or not _SAFE_ID_RE.fullmatch(session_root.name):
            continue
        terminal_runs: list[tuple[int, Path, dict]] = []
        for path in session_root.glob("*.jsonl"):
            result["examined"] += 1
            try:
                stat = path.stat()
            except OSError:
                continue
            events = _read_tail_events(path)
            summary = _summary_from_tail(session_root.name, path.stem, events)
            if summary is None:
                continue
            result["terminal"] += 1
            terminal_runs.append((int(stat.st_mtime_ns), path, summary))

        terminal_runs.sort(key=lambda item: (item[0], item[1].name), reverse=True)
        for index, (_mtime_ns, path, _summary) in enumerate(terminal_runs):
            if index < keep:
                continue
            lock = _lock_for(path)
            with lock:
                # ``done`` is terminal for summary/status purposes but is not
                # the relay-close event: title/title_status and stream_end can
                # still follow.  A live RunJournalWriter therefore remains the
                # lifecycle owner until its deterministic close and retention
                # must leave its path in place.
                if _has_active_writer(path):
                    continue
                try:
                    stat = path.stat()
                except OSError:
                    continue
                if stat.st_mtime > cutoff:
                    continue
                events = _read_tail_events(path)
                current = _summary_from_tail(session_root.name, path.stem, events)
                if current is None:
                    continue
                if dry_run:
                    result["pruned"] += 1
                    result["bytes_reclaimed"] += int(stat.st_size)
                    continue
                current.update(
                    {
                        "journal_pruned": True,
                        "journal_pruned_at": float(
                            now if now is not None else time.time()
                        ),
                        "original_size": int(stat.st_size),
                        "original_mtime": float(stat.st_mtime),
                    }
                )
                try:
                    _write_pruned_summary(path, current)
                    path.unlink()
                except OSError:
                    logger.warning(
                        "run-journal retention failed for %s",
                        path,
                        exc_info=True,
                    )
                    continue
                _discard_cached_summary(path)
                with _SEQ_CACHE_LOCK:
                    _SEQ_CACHE.pop(str(path), None)
                result["pruned"] += 1
                result["bytes_reclaimed"] += int(stat.st_size)
            # A terminal run cannot have a legitimate future writer. Release
            # the per-path lock entry after pruning so retention, not only full
            # session deletion, bounds this process-global cache. Do this after
            # leaving ``with lock`` and only if the mapping still owns the same
            # object; a replacement mapping must never be evicted accidentally.
            if not dry_run and not path.exists():
                key = (str(path.parent), path.name, str(os.getpid()))
                with _WRITER_LOCKS_GUARD:
                    if _WRITER_LOCKS.get(key) is lock:
                        _WRITER_LOCKS.pop(key, None)
    return result


def schedule_run_journal_prune(*, delay_seconds: float = 0.0) -> bool:
    """Schedule one non-blocking retention pass, coalesced to once per interval."""
    global _PRUNE_LAST_STARTED, _PRUNE_THREAD

    started_at = time.monotonic()
    with _PRUNE_LOCK:
        if _PRUNE_THREAD is not None and _PRUNE_THREAD.is_alive():
            return False
        if started_at - _PRUNE_LAST_STARTED < _RUN_JOURNAL_PRUNE_INTERVAL_SECONDS:
            return False
        _PRUNE_LAST_STARTED = started_at

        def _runner() -> None:
            if delay_seconds > 0:
                time.sleep(float(delay_seconds))
            try:
                result = prune_settled_run_journals()
                if result["pruned"]:
                    logger.info(
                        "run-journal retention pruned %d files (%d bytes)",
                        result["pruned"],
                        result["bytes_reclaimed"],
                    )
            except Exception:
                logger.warning("run-journal retention pass failed", exc_info=True)

        _PRUNE_THREAD = threading.Thread(
            target=_runner,
            name="hermes-webui-run-journal-retention",
            daemon=True,
        )
        _PRUNE_THREAD.start()
        return True


def delete_run_journal(session_id: str, *, session_dir: Path | None = None) -> bool:
    """Remove the entire per-session run-journal directory (``_run_journal/{sid}/``).

    The run journal stores one directory per session containing a ``{rid}.jsonl``
    file per run, so removing the session's directory clears every run's full
    request/response payloads. Invalid/empty ids and a missing directory are a
    no-op so callers can invoke this unconditionally on delete. Returns ``True``
    if a directory was removed, ``False`` otherwise.
    """
    import shutil

    sid = str(session_id or "").strip()
    # Reject path-traversal ids: the regex below permits dots, so a bare "." or
    # ".." would resolve `root / RUN_JOURNAL_DIR_NAME / sid` to the journal ROOT
    # (or its parent) and rmtree the wrong directory. The route call site only
    # passes real sids, but this is a public helper — guard it directly.
    if sid in (".", "..") or not sid or "/" in sid or "\\" in sid or not _SAFE_ID_RE.fullmatch(sid):
        return False
    root = Path(session_dir) if session_dir is not None else _default_session_dir()
    session_journal_dir = root / RUN_JOURNAL_DIR_NAME / sid
    if not session_journal_dir.exists():
        return False
    shutil.rmtree(session_journal_dir, ignore_errors=True)
    removed = not session_journal_dir.exists()
    # Evict any writer locks the removed runs left behind. `_lock_for` keys are
    # ``(str(path.parent), path.name, pid)`` and every run file for this session
    # lives directly under ``session_journal_dir``, so drop all keys whose parent
    # dir matches — pid-independent — to keep `_WRITER_LOCKS` from growing forever.
    # Guard on confirmed removal: `rmtree(ignore_errors=True)` can silently leave
    # the directory (locked files on Windows, permission transients). If the files
    # still exist their locks are still live — evicting them would hand a later
    # `_lock_for` caller a brand-new Lock, breaking mutual exclusion with a writer
    # still holding the old one.
    if removed:
        dir_key = str(session_journal_dir)
        with _WRITER_LOCKS_GUARD:
            for key in [k for k in _WRITER_LOCKS if k[0] == dir_key]:
                del _WRITER_LOCKS[key]
        # Drop cached next-seq entries for the removed runs too. Every run file
        # for this session lives directly under ``session_journal_dir``, so its
        # cache key's parent dir matches. Without this, a run re-created at the
        # same path would resume the stale cached seq instead of restarting at 1.
        # Hold ``_SEQ_CACHE_LOCK`` — the SAME mutex ``_reserve_next_seq``/
        # ``_note_assigned_seq`` take — so a concurrent append on another path
        # cannot mutate the dict mid-iteration (``dictionary changed size``).
        with _SEQ_CACHE_LOCK:
            for cache_key in [entry for entry in _SEQ_CACHE if str(Path(entry).parent) == dir_key]:
                del _SEQ_CACHE[cache_key]
        with _SUMMARY_CACHE_LOCK:
            for cache_key in [entry for entry in _SUMMARY_CACHE if str(Path(entry).parent) == dir_key]:
                del _SUMMARY_CACHE[cache_key]
    return removed


def stale_interrupted_event(session_id: str, run_id: str, *, after_seq: int | None = None) -> dict | None:
    summary = latest_run_summary(session_id, run_id)
    if summary.get("terminal") or not summary.get("event_count"):
        return None
    seq = int(summary.get("last_seq") or 0) + 1
    if after_seq is not None and seq <= int(after_seq):
        return None
    payload = {
        "type": "interrupted",
        "recovery_control": True,
        "message": "The live worker stopped before this run finished.",
        "hint": "The transcript was restored to the last journaled event. Start a new turn if you still need the task to continue.",
        "session_id": session_id,
        "stream_id": run_id,
        "journal_last_seq": summary.get("last_seq"),
    }
    return {
        "version": 1,
        "event_id": f"{run_id}:{seq}",
        "seq": seq,
        "run_id": run_id,
        "session_id": session_id,
        "event": "apperror",
        "type": "apperror",
        "created_at": time.time(),
        "terminal": True,
        "terminal_state": "lost-worker-bookkeeping",
        "payload": payload,
        "synthetic": True,
    }
