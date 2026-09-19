"""Crash-safe WebUI turn journal helpers.

The journal is deliberately tiny: one JSONL file per session, append-only events,
and read helpers that tolerate malformed lines. Recovery and repair can then
reason about submitted turns without depending on in-memory stream state.
"""
from __future__ import annotations

import json
import math
import os
import re
import threading
import time
import uuid
from collections import OrderedDict
from contextlib import contextmanager
from pathlib import Path
from typing import Iterable

try:  # pragma: no cover - fcntl is unavailable on Windows.
    import fcntl as _fcntl
except ImportError:  # pragma: no cover
    _fcntl = None

TURN_JOURNAL_DIR_NAME = "_turn_journal"
# The journal format this module writes and knows how to reason about. Retention
# refuses to delete a shard carrying anything else: a newer server sharing the
# same state directory may write events whose semantics this reader cannot judge.
_SUPPORTED_JOURNAL_VERSION = 1
_TERMINAL_EVENTS = {"completed", "interrupted"}
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
_STREAM_TURN_CACHE_MAX = 4096
_TURN_JOURNAL_RETENTION_DAYS_ENV = "HERMES_WEBUI_TURN_JOURNAL_RETENTION_DAYS"
_TURN_JOURNAL_DEFAULT_RETENTION_DAYS = 14.0
_STREAM_TURN_CACHE: "OrderedDict[tuple[str, str], str]" = OrderedDict()
_STREAM_TURN_CACHE_LOCK = threading.Lock()


def _default_session_dir() -> Path:
    from api.models import SESSION_DIR

    return Path(SESSION_DIR)


def _journal_path(session_id: str, session_dir: Path | None = None) -> Path:
    sid = str(session_id or "").strip()
    if not sid or "/" in sid or "\\" in sid or not _SESSION_ID_RE.fullmatch(sid):
        raise ValueError("invalid session_id")
    root = Path(session_dir) if session_dir is not None else _default_session_dir()
    return root / TURN_JOURNAL_DIR_NAME / f"{sid}~{os.getpid()}.jsonl"


def _make_turn_id() -> str:
    return f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{uuid.uuid4().hex[:12]}"


@contextmanager
def _journal_file_lock(file_obj):
    """Serialize multi-process journal writes when advisory locks exist.

    ``O_APPEND`` keeps normal same-process appends simple, but a long JSONL event
    can exceed POSIX's small atomic-write boundary.  On Unix, take an advisory
    lock around the single event write+fsync so two WebUI worker processes cannot
    interleave large submitted-message payloads into corrupted JSONL.  Platforms
    without ``fcntl`` keep the previous best-effort append behavior.
    """
    if _fcntl is None:
        yield
        return
    _fcntl.flock(file_obj.fileno(), _fcntl.LOCK_EX)
    try:
        yield
    finally:
        _fcntl.flock(file_obj.fileno(), _fcntl.LOCK_UN)


def append_turn_journal_event(
    session_id: str,
    event: dict,
    *,
    session_dir: Path | None = None,
) -> dict:
    """Append one turn journal event and fsync it before returning.

    The returned event is the exact payload written, with default ``version``,
    ``session_id``, ``turn_id``, and ``created_at`` fields filled in.
    """
    if not isinstance(event, dict):
        raise TypeError("event must be a dict")
    event_name = str(event.get("event") or "").strip()
    if not event_name:
        raise ValueError("event is required")
    payload = dict(event)
    payload.setdefault("version", _SUPPORTED_JOURNAL_VERSION)
    payload["session_id"] = str(session_id)
    payload.setdefault("turn_id", _make_turn_id())
    payload.setdefault("created_at", time.time())
    if event_name in _TERMINAL_EVENTS:
        payload.setdefault("terminal", True)

    path = _journal_path(session_id, session_dir=session_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    # A directory entry only needs to be made durable when this process creates
    # its pid-scoped shard. Re-fsyncing the directory after every append adds no
    # durability (the entry already exists) and was a measurable per-event tax.
    created_shard = not path.exists()
    line = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
    fd = os.open(path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as fh:
        with _journal_file_lock(fh):
            fh.write(line)
            fh.flush()
            os.fsync(fh.fileno())
    o_directory = getattr(os, "O_DIRECTORY", None)
    if created_shard and o_directory is not None:
        try:
            dir_fd = os.open(path.parent, o_directory)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError:
            pass
    stream_id = str(payload.get("stream_id") or "").strip()
    turn_id = str(payload.get("turn_id") or "").strip()
    if stream_id and turn_id:
        key = (str(path.parent.parent.resolve()), f"{session_id}:{stream_id}")
        with _STREAM_TURN_CACHE_LOCK:
            _STREAM_TURN_CACHE[key] = turn_id
            _STREAM_TURN_CACHE.move_to_end(key)
            while len(_STREAM_TURN_CACHE) > _STREAM_TURN_CACHE_MAX:
                _STREAM_TURN_CACHE.popitem(last=False)
    return payload


def _safe_created_at(event: dict) -> float:
    """Coerce an event timestamp, treating junk as epoch rather than raising.

    Every consumer orders events by ``created_at``, and a single hand-edited or
    crash-torn value used to raise straight out of
    :func:`derive_turn_journal_states` — taking down the retention pass and
    ``audit_session_recovery`` with it, on every run, for as long as the value
    existed. Ordering degrades; nothing else breaks.
    """
    try:
        return float((event or {}).get("created_at") or 0)
    except (TypeError, ValueError):
        return 0.0


def read_turn_journal(session_id: str, *, session_dir: Path | None = None) -> dict:
    """Read a session journal, merging all pid-scoped shards and returning valid events plus malformed lines."""
    sid = str(session_id or "").strip()
    if not sid or "/" in sid or "\\" in sid or not _SESSION_ID_RE.fullmatch(sid):
        raise ValueError("invalid session_id")
    root = Path(session_dir) if session_dir is not None else _default_session_dir()
    journal_dir = root / TURN_JOURNAL_DIR_NAME
    events: list[dict] = []
    malformed: list[dict] = []
    # Collect pid-scoped shards ({sid}~{pid}.jsonl) plus legacy ({sid}.jsonl).
    # The ~ separator cannot appear in session IDs (_SESSION_ID_RE allows only [A-Za-z0-9_.-]),
    # so the glob is unambiguous even for dotted-numeric session IDs like "sess.123".
    shards: list[Path] = list(journal_dir.glob(f"{sid}~*.jsonl")) if journal_dir.exists() else []
    legacy = journal_dir / f"{sid}.jsonl"
    if legacy.exists():
        shards.append(legacy)
    if not shards:
        return {"session_id": str(session_id), "events": [], "malformed": []}
    for shard in shards:
        try:
            lines = shard.read_text(encoding="utf-8").splitlines()
        except FileNotFoundError:
            continue
        for line_no, raw in enumerate(lines, start=1):
            if not raw.strip():
                continue
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                malformed.append({"line": line_no, "raw": raw, "shard": shard.name})
                continue
            if isinstance(event, dict):
                events.append(event)
            else:
                malformed.append({"line": line_no, "raw": raw, "shard": shard.name})
    events.sort(key=_safe_created_at)
    return {"session_id": str(session_id), "events": events, "malformed": malformed}


def derive_turn_journal_states(events: Iterable[dict]) -> tuple[dict[str, dict], list[dict]]:
    '''Return the latest event per ``turn_id`` and any terminal-collision entries.

    The first element is the latest event per turn_id (same overwrite-by-timestamp
    behaviour as before).  The second element is a list of collision records, one
    per turn_id that had more than one terminal event.  Each collision record
    contains ``turn_id`` and the ``events`` list (in ascending created_at order).

    A collision means the same logical turn recorded both ``completed`` and
    ``interrupted`` terminal events -- the derived state still picks the latest
    by timestamp, but callers can now detect and audit the double-terminal
    situation explicitly rather than having it silently collapse.
    '''
    states: dict[str, dict] = {}
    # Collect all terminal events per turn_id to detect collisions
    terminal_events: dict[str, list[dict]] = {}
    for event in events:
        if not isinstance(event, dict):
            continue
        turn_id = str(event.get('turn_id') or '').strip()
        if not turn_id:
            continue
        # Track terminal events for collision detection
        if is_terminal_turn_event(event):
            terminal_events.setdefault(turn_id, []).append(event)
        # Existing latest-by-timestamp derivation
        previous = states.get(turn_id)
        if previous is None or _safe_created_at(event) >= _safe_created_at(previous):
            states[turn_id] = event

    # Build collision list: turn_ids with more than one terminal event
    collisions = [
        {'turn_id': tid, 'events': sorted(evts, key=_safe_created_at)}
        for tid, evts in terminal_events.items()
        if len(evts) > 1
    ]
    return states, collisions

def _latest_turn_id_for_stream(events: Iterable[dict], stream_id: str) -> str | None:
    stream = str(stream_id or "").strip()
    if not stream:
        return None
    latest: str | None = None
    for event in events:
        if not isinstance(event, dict):
            continue
        if str(event.get("stream_id") or "") != stream:
            continue
        turn_id = str(event.get("turn_id") or "").strip()
        if turn_id:
            latest = turn_id
    return latest


def append_turn_journal_event_for_stream(
    session_id: str,
    stream_id: str,
    event: dict,
    *,
    session_dir: Path | None = None,
) -> dict:
    """Append a lifecycle event for the turn associated with ``stream_id``."""
    payload = dict(event)
    payload["stream_id"] = str(stream_id)
    if not payload.get("turn_id"):
        root = Path(session_dir) if session_dir is not None else _default_session_dir()
        key = (str(root.resolve()), f"{session_id}:{stream_id}")
        with _STREAM_TURN_CACHE_LOCK:
            turn_id = _STREAM_TURN_CACHE.get(key)
            if turn_id:
                _STREAM_TURN_CACHE.move_to_end(key)
        if not turn_id:
            # Restart / cache-eviction fallback: scan durable history once, then
            # append_turn_journal_event repopulates the bounded process cache.
            journal = read_turn_journal(session_id, session_dir=session_dir)
            turn_id = _latest_turn_id_for_stream(journal.get("events") or [], stream_id)
        if turn_id:
            payload["turn_id"] = turn_id
    return append_turn_journal_event(session_id, payload, session_dir=session_dir)


def iter_turn_journal_session_ids(session_dir: Path) -> list[str]:
    journal_dir = Path(session_dir) / TURN_JOURNAL_DIR_NAME
    if not journal_dir.exists():
        return []
    session_ids: set[str] = set()
    for path in journal_dir.glob("*.jsonl"):
        if not path.is_file():
            continue
        stem = path.stem  # e.g. "sid-1~12345" or "sid-1"
        tilde = stem.find("~")
        if tilde > 0:
            session_ids.add(stem[:tilde])
        else:
            session_ids.add(stem)
    return sorted(session_ids)


def delete_turn_journal(session_id: str, *, session_dir: Path | None = None) -> int:
    """Remove every turn-journal shard for ``session_id``.

    Deletes both the pid-scoped shards (``{sid}~{pid}.jsonl``) written by
    :func:`append_turn_journal_event` and the legacy single-file form
    (``{sid}.jsonl``) that :func:`read_turn_journal` still merges. Returns the
    number of files removed. Invalid/empty ids and a missing journal directory
    are treated as a no-op so callers can invoke this unconditionally on delete.
    """
    sid = str(session_id or "").strip()
    # Reject "."/".." for parity with delete_run_journal — the regex permits
    # dots, and a traversal id has no legitimate use here.
    if sid in (".", "..") or not sid or "/" in sid or "\\" in sid or not _SESSION_ID_RE.fullmatch(sid):
        return 0
    root = Path(session_dir) if session_dir is not None else _default_session_dir()
    root_key = str(root.resolve())
    with _STREAM_TURN_CACHE_LOCK:
        for key in [
            key for key in _STREAM_TURN_CACHE
            if key[0] == root_key and key[1].startswith(f"{sid}:")
        ]:
            _STREAM_TURN_CACHE.pop(key, None)
    journal_dir = root / TURN_JOURNAL_DIR_NAME
    if not journal_dir.exists():
        return 0
    removed = 0
    shards = list(journal_dir.glob(f"{sid}~*.jsonl"))
    legacy = journal_dir / f"{sid}.jsonl"
    if legacy.exists():
        shards.append(legacy)
    for shard in shards:
        try:
            shard.unlink()
            removed += 1
        except FileNotFoundError:
            pass
        except OSError:
            # Best-effort cleanup; the caller logs the overall delete outcome.
            pass
    return removed


def _retention_seconds_from_env() -> float:
    raw = os.environ.get(
        _TURN_JOURNAL_RETENTION_DAYS_ENV,
        str(_TURN_JOURNAL_DEFAULT_RETENTION_DAYS),
    )
    try:
        days = float(raw)
    except (TypeError, ValueError):
        days = _TURN_JOURNAL_DEFAULT_RETENTION_DAYS
    return max(0.0, days) * 24 * 60 * 60


def _sessions_with_recovery_findings(root: Path) -> set[str] | None:
    """Session ids the recovery audit has anything to say about, or ``None``.

    ``docs/rfcs/turn-journal.md`` gates pruning on sidecar/index recovery having
    no findings, and only the audit knows what a finding is: a live sidecar can
    parse perfectly and still be ``shrunken_live`` because its ``.json.bak``
    holds more messages, and index findings are invisible from the file alone.

    Run once per pass, not once per session — the audit walks the whole state
    directory. The import is local because ``api.session_recovery`` imports this
    module at load time; by the time retention runs, both are resolved.
    ``None`` means the audit could not be trusted, and the caller retains
    everything.
    """
    try:
        from api.session_recovery import audit_session_recovery  # noqa: PLC0415

        audit = audit_session_recovery(root)
    except Exception:
        return None
    return {
        str(item.get("session_id") or "")
        for item in (audit.get("items") or [])
        if item.get("session_id")
    }


def _event_is_well_formed(event: object, session_id: str) -> bool:
    """True when an event carries the fields the settled check depends on.

    A line can be valid JSON and still be unusable evidence — a ``submitted``
    with no ``turn_id`` derives into nothing and would read as settled, and a
    non-numeric ``created_at`` makes ``derive_turn_journal_states`` raise and
    take the whole retention pass down with it. ``append_turn_journal_event``
    fills all three in, so anything missing them was not written by this code
    path and is uncertainty, not evidence of a settled session.
    Deliberately stricter than :func:`_safe_created_at`, which stays lenient
    because ordering may degrade on junk. Here junk must fail closed.
    """
    if not isinstance(event, dict):
        return False
    if not str(event.get("turn_id") or "").strip():
        return False
    if not str(event.get("event") or "").strip():
        return False
    # `version` and `session_id` are set on every append — the former by
    # `setdefault`, the latter unconditionally — so an event without them, or
    # claiming a different session, did not come from this writer. The version
    # must match, not merely be present: a `version: 2` shard from a newer
    # server sharing this state directory holds data whose semantics this
    # reader cannot judge, and judging it wrongly means deleting it.
    version = event.get("version")
    # `True == 1` and `1.0 == 1` in Python, so equality alone is not identity of
    # format. The writer emits an int; anything else is an unknown shape.
    if isinstance(version, bool) or not isinstance(version, int):
        return False
    if version != _SUPPORTED_JOURNAL_VERSION:
        return False
    if str(event.get("session_id") or "") != str(session_id):
        return False
    created_at = event.get("created_at")
    # A real number, not "whatever coerces": `float(x or 0)` accepted a missing
    # or null timestamp as epoch, which let a corrupted `submitted` sort behind
    # a valid `completed` and read as settled. bool is an int subclass, so
    # exclude it explicitly.
    if isinstance(created_at, bool) or not isinstance(created_at, (int, float)):
        return False
    return math.isfinite(created_at)


def _session_sidecar_is_intact(session_id: str, root: Path) -> bool:
    """True when the session's live sidecar is a readable, session-shaped file.

    Complements the recovery-audit gate rather than duplicating it: the audit
    walks the sidecars it can read, so a ``{sid}.json`` that is absent,
    unreadable, or not session-shaped produces no finding at all — and that is
    exactly the case where the journal is the sole surviving evidence.

    Delegates the *shape* question to ``session_recovery._msg_count`` instead of
    re-deriving what a session file looks like. A parallel check here drifted
    from it once already: ``{}`` is a mapping and passed, while ``_msg_count``
    correctly calls it invalid. One definition, one answer.

    Identity is checked here on top, because ``_msg_count`` deliberately does
    not care whose session it is reading.
    """
    path = root / f"{session_id}.json"
    try:
        from api.session_recovery import _msg_count  # noqa: PLC0415

        if _msg_count(path) < 0:
            return False
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return False
    # A sidecar copied under the wrong filename is a readable, message-bearing
    # session file that simply is not *this* session — and neither `_msg_count`
    # nor the recovery audit notices the mismatch. Deleting this journal on its
    # word would destroy the correctly-identified evidence.
    claimed = str((payload or {}).get("session_id") or "")
    return claimed == str(session_id)


def _session_is_prunable(session_id: str, root: Path) -> bool:
    """True only on positive evidence that nothing still needs this journal.

    Fails closed on every uncertainty, because each one is a case the recovery
    audit exists to catch:

    * an id ``read_turn_journal`` rejects, or a shard it cannot read;
    * a malformed line — a crash-torn event is exactly the evidence recovery
      flags for manual review, and deleting it destroys the only record;
    * an event that is not the shape ``append_turn_journal_event`` produces —
      missing ``turn_id``, ``event``, a matching ``session_id``, a
      ``version`` equal to the one this module writes, or
      a present, finite, numeric ``created_at``. None of these reach the
      malformed list, because they decode perfectly well;
    * a turn holding both ``completed`` and ``interrupted``, which
      ``derive_turn_journal_states`` reports as a collision;
    * a nonterminal turn, which the startup audit still reports as pending;
    * a missing or unparseable live sidecar. The recovery audit walks only the
      sidecars it can parse, so it never reports these — the journal is the
      session's sole surviving evidence.

    Recovery *findings* are a separate gate, applied once per pass by
    :func:`_sessions_with_recovery_findings`.
    """
    try:
        journal = read_turn_journal(session_id, session_dir=root)
    except (ValueError, OSError):
        return False
    if journal.get("malformed"):
        return False
    events = journal.get("events") or []
    if not all(_event_is_well_formed(event, session_id) for event in events):
        return False
    states, collisions = derive_turn_journal_states(events)
    # A turn that recorded both `completed` and `interrupted` is an anomaly
    # `derive_turn_journal_states` goes out of its way to surface. The derived
    # state picks one by timestamp and looks settled; the journal is the only
    # place the contradiction is still visible.
    if collisions:
        return False
    if any(not is_terminal_turn_event(event) for event in states.values()):
        return False
    # The audit gate below is about *recovery* findings; it does not notice a
    # sidecar that is simply gone or unreadable, because it only walks the
    # sidecars it can parse. Both checks are needed.
    return _session_sidecar_is_intact(session_id, root)


def _pid_is_running(pid: int) -> bool:
    """Host-local liveness for the pid in a shard name; unknown counts as alive."""
    if pid <= 0 or os.name != "posix":
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except (PermissionError, OSError):
        return True
    return True


def _shard_owner_pid(path: Path) -> int:
    """The pid encoded in ``{sid}~{pid}.jsonl``, or 0 for the legacy form."""
    stem = path.stem
    tilde = stem.find("~")
    if tilde <= 0:
        return 0
    try:
        return int(stem[tilde + 1:])
    except ValueError:
        return 0


def _release_expired_shard(path: Path, expected_mtime: float) -> bool:
    """Reclaim one expired shard's bytes. Returns ``True`` when it did.

    Every shard — this process's or another's — is emptied under the same
    advisory lock :func:`append_turn_journal_event` takes, with an ``fstat``
    recheck that aborts the whole attempt if an append landed between the
    directory scan and here. Truncation is what makes this safe: the appender
    reopens the path on every call, so unlinking races a writer that has already
    opened the inode and its event would land in an unlinked file and vanish,
    whereas an ``O_APPEND`` writer blocked on the lock simply resumes at
    offset 0 and loses nothing.

    The emptied file is then unlinked once its owning pid is provably gone — the
    shards a restart loop leaves behind, which is the accumulation vector. A
    shard kept because its owner was still alive is revisited on a later pass
    and released then, so an empty inode outlives its process until the next
    expiry rather than forever. An unparseable name or a platform without a safe
    liveness probe keeps it; ``delete_turn_journal`` releases it with the
    session either way.

    Without ``fcntl`` — Windows — :func:`_journal_file_lock` is a documented
    no-op, so nothing stops a first append from landing between the ``fstat``
    and the ``truncate`` and being erased. There is no second mechanism to fall
    back on, because synchronizing here alone would not help: the appender does
    not take one either. So this fails closed and reclaims nothing on those
    platforms rather than risking a lost event.

    Residual, stated rather than papered over: pid liveness is host-local, so a
    second WebUI process on *another* host sharing this state directory over a
    network filesystem could still be appending to a shard whose pid looks dead
    here. Advisory locks are unreliable on those filesystems regardless, and the
    shard must also have been silent for the whole retention window.
    """
    if _fcntl is None:
        return False
    owner = _shard_owner_pid(path)
    owner_is_gone = bool(owner) and not _pid_is_running(owner)
    try:
        with open(path, "r+b") as fh:
            with _journal_file_lock(fh):
                current = os.fstat(fh.fileno())
                if current.st_mtime != expected_mtime:
                    return False
                if not current.st_size and not owner_is_gone:
                    # Already emptied and its owner may still append: nothing to
                    # reclaim, and nothing safe to remove.
                    return False
                if current.st_size:
                    fh.truncate(0)
                if owner_is_gone:
                    try:
                        path.unlink()
                    except OSError:
                        pass
    except OSError:
        return False
    return True


def prune_stale_turn_journals(
    *,
    session_dir: Path | None = None,
    now: float | None = None,
    retention_seconds: float | None = None,
    dry_run: bool = False,
) -> dict:
    """Reclaim settled turn-journal shards nothing has appended to in the window.

    The run journal's retention keys off a terminal run event; the turn journal
    has no such per-file marker, because a shard stays open for as long as its
    session might submit another turn. So a session's shards are expired only
    when both hold:

    * no shard of that session has been written to inside the retention window;
    * :func:`_session_is_prunable` finds positive evidence the session is
      settled — judged on the *merged* journal, because a turn submitted under
      one pid can be completed under another and half a turn read alone looks
      pending;
    * ``audit_session_recovery`` reports nothing about it. That is the RFC's
      precondition, and only the audit can see a ``shrunken_live`` sidecar or an
      index finding. It runs once per pass, and an audit that cannot be trusted
      retains everything.

    Every expired shard is emptied under the appender's own advisory lock, and
    the empty file is unlinked only when its owning pid is provably gone — so a
    long-running server reclaims its storage without racing a writer in this or
    any other process. See :func:`_release_expired_shard`.

    Returns ``{"examined", "pruned", "bytes_reclaimed"}`` counted in shards.
    ``dry_run`` counts without touching anything.
    """
    root = Path(session_dir) if session_dir is not None else _default_session_dir()
    journal_dir = root / TURN_JOURNAL_DIR_NAME
    retention = float(
        _retention_seconds_from_env()
        if retention_seconds is None
        else max(0.0, retention_seconds)
    )
    cutoff = float(now if now is not None else time.time()) - retention
    result = {"examined": 0, "pruned": 0, "bytes_reclaimed": 0}
    if not journal_dir.is_dir():
        return result

    by_session: dict[str, list[tuple[Path, os.stat_result]]] = {}
    for path in sorted(journal_dir.glob("*.jsonl")):
        try:
            if not path.is_file():
                continue
            stat = path.stat()
        except OSError:
            continue
        result["examined"] += 1
        stem = path.stem  # "sid~12345" or legacy "sid"
        tilde = stem.find("~")
        session_id = stem[:tilde] if tilde > 0 else stem
        by_session.setdefault(session_id, []).append((path, stat))

    if not by_session:
        return result
    flagged = _sessions_with_recovery_findings(root)
    if flagged is None:
        # The audit is the RFC's precondition; without a trustworthy answer,
        # retain everything.
        return result

    for session_id, shards in by_session.items():
        if any(stat.st_mtime >= cutoff for _, stat in shards):
            continue
        if session_id in flagged:
            continue
        if not _session_is_prunable(session_id, root):
            continue
        for path, stat in shards:
            # No size guard here. An already-emptied shard still has an inode to
            # release once its owner exits, and skipping it left one permanent
            # zero-byte file per session per restart — the growth this pass
            # exists to stop. `_release_expired_shard` decides what is left to do.
            if dry_run:
                if not stat.st_size:
                    continue
                result["pruned"] += 1
                result["bytes_reclaimed"] += int(stat.st_size)
                continue
            if not _release_expired_shard(path, stat.st_mtime):
                continue
            result["pruned"] += 1
            result["bytes_reclaimed"] += int(stat.st_size)
    return result


def is_terminal_turn_event(event: dict) -> bool:
    return str((event or {}).get("event") or "") in _TERMINAL_EVENTS
