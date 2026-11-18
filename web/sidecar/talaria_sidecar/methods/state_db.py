"""``state_db.*``: writes to the Agent's ``state.db`` through ``hermes_state.SessionDB``.

Ported from api/state_sync.py (usage/title mirroring) and
api/models.py::delete_cli_session (lineage-aware CLI session deletion with
cleanup manifests). Read-only projections stay in the TypeScript server.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import threading
import time
import uuid
from contextlib import closing, contextmanager
from pathlib import Path

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext

log = logging.getLogger("talaria_sidecar.state_db")
STATE_DB_CONNECT_TIMEOUT_S = 5.0
_SAFE_SESSION_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_cleanup_locks_guard = threading.Lock()
_cleanup_locks: dict[str, threading.Lock] = {}


def _session_db(home: Path):
    try:
        from hermes_state import SessionDB
    except ImportError as exc:
        raise RpcError("hermes_state unavailable", condition="state_db_unavailable") from exc
    db_path = home / "state.db"
    if not db_path.exists():
        return None
    try:
        return SessionDB(db_path)
    except Exception as exc:  # noqa: BLE001
        log.debug("Failed to open state.db at %s: %s", db_path, exc)
        return None


def _session_id(params: dict) -> str:
    sid = str(params.get("session_id") or "").strip()
    if not sid:
        raise InvalidParams("session_id is required")
    return sid


# TAL-1191: write RPCs borrow the Agent's shared registry handle for the home's state.db (the one cached chat agents
# hold) instead of a full writer open and close-time checkpoint per call. One extra reference per home stays pinned for
# _IDLE_RELEASE_S after its last write; the registry hands out a fresh generation once the file is replaced.
_IDLE_RELEASE_S = 60.0
_pins_lock = threading.Lock()
# home -> (pinned reference, monotonic idle deadline). One idle thread per pinned home re-arms itself to the latest
# deadline, so a burst of writes moves a deadline instead of starting a thread per write (TAL-1746).
_pins: dict[str, tuple[object, float]] = {}
_idle_threads: dict[str, threading.Thread] = {}


def release_session_db(db) -> None:
    """Give back a registry reference (a cached agent's or a write pin); the final one closes the handle."""
    if db is None:
        return
    try:
        from hermes_state_registry import release_or_close

        release_or_close(db)
    except Exception:  # noqa: BLE001
        log.warning("releasing a state.db handle failed", exc_info=True)


def _write(home: Path, what: str, op, *, level: int = logging.DEBUG) -> bool:
    """Run ``op(db)`` on the shared handle; False without a state.db or when it fails. A failed write unpins the handle,
    so the next one reopens it unless another holder keeps it."""
    try:
        from hermes_state_registry import acquire
    except ImportError as exc:
        raise RpcError("hermes_state unavailable", condition="state_db_unavailable") from exc
    db_path = home / "state.db"
    if not db_path.exists():
        return False
    try:
        db = acquire(db_path)
    except Exception as exc:  # noqa: BLE001
        log.debug("Failed to open state.db at %s: %s", db_path, exc)
        return False
    key = os.path.realpath(home)
    # This call's reference keeps the same generation open; a retired one (replaced file) closes before its replacement
    # is written, so its close-time checkpoint cannot carry the new rows into the old inode.
    _pin(key, None)
    ok = False
    try:
        op(db)
        ok = True
    except Exception:  # noqa: BLE001
        log.log(level, "Failed to %s", what, exc_info=True)
    if ok and db_path.exists():
        _pin(key, db)
    else:
        release_session_db(db)
    return ok


def _pin(key: str, db) -> None:
    """Make ``db`` (this call's reference) the home's pin with a fresh idle deadline, giving back the previous pin."""
    with _pins_lock:
        previous = _pins.pop(key, None)
        if db is not None:
            _pins[key] = (db, time.monotonic() + _IDLE_RELEASE_S)
            if key not in _idle_threads:
                thread = threading.Thread(target=_expire, args=(key,), daemon=True, name="state-db-idle-release")
                _idle_threads[key] = thread
                thread.start()
    if previous is not None:  # outside the lock: a final release checkpoints
        release_session_db(previous[0])


def _expire(key: str) -> None:
    """The home's idle thread: sleep to the pin's current deadline and release it once no write moved it. It exits
    when the pin is gone, and a later write starts a new one."""
    while True:
        with _pins_lock:
            pinned = _pins.get(key)
            remaining = pinned[1] - time.monotonic() if pinned is not None else 0.0
            if pinned is None or remaining <= 0:
                if pinned is not None:
                    del _pins[key]
                _idle_threads.pop(key, None)
                break
        time.sleep(remaining)
    if pinned is not None:
        release_session_db(pinned[0])


def release_home(home) -> None:
    """Give back the pinned handle for ``home`` before its profile is deleted."""
    _pin(os.path.realpath(home), None)


def release_all() -> None:
    """Shutdown: give back every pinned handle, so the final release still checkpoints once per process."""
    with _pins_lock:
        keys = list(_pins)
    for key in keys:
        _pin(key, None)


def request_prompt_refresh(home: Path) -> bool:
    """Every continuing session in ``home`` rebuilds its stored system prompt once, on its next turn. False without a
    state.db."""
    return _write(home, "request a prompt refresh", lambda db: db.request_prompt_refresh(), level=logging.WARNING)


def sync_session_start(home: Path, session_id: str, model=None) -> bool:
    return _write(home, "sync session start", lambda db: db.ensure_session(session_id=session_id, source="webui", model=model))


def sync_session_usage(home: Path, session_id: str, *, input_tokens=0, output_tokens=0, estimated_cost=None, model=None, title=None,
                       message_count=None, cache_read_tokens=0, cache_write_tokens=0, api_call_count=None) -> bool:
    def op(db) -> None:
        # The token update's own row guard creates the session with this source, like ``ensure_session``.
        db.update_token_counts(
            session_id=session_id, input_tokens=input_tokens, output_tokens=output_tokens, cache_read_tokens=cache_read_tokens,
            cache_write_tokens=cache_write_tokens, api_call_count=api_call_count or 0, estimated_cost_usd=estimated_cost, model=model, absolute=True,
            source="webui",
        )
        if title:
            try:
                db.set_session_title(session_id, title)
            except Exception:  # noqa: BLE001
                log.debug("Failed to sync session title", exc_info=True)
        if message_count is not None:
            try:
                db._execute_write(lambda conn: conn.execute("UPDATE sessions SET message_count = ? WHERE id = ?", (message_count, session_id)))
            except Exception:  # noqa: BLE001
                log.debug("Failed to sync message count", exc_info=True)

    return _write(home, "sync session usage", op)


def sync_session_title(home: Path, session_id: str, title: str, *, manual: bool = False) -> bool:
    """A manual (user-requested) title lands with ``user`` provenance; an auto title is ``llm`` and never replaces a user name."""
    if not title:
        return False

    def op(db) -> None:
        db.ensure_session(session_id=session_id, source="webui")
        source = getattr(db, "TITLE_SOURCE_LLM", "llm")

        def write(value: str) -> None:
            if manual:
                db.set_session_title(session_id, value)
            else:
                db.set_auto_title(session_id, value, source=source)

        try:
            write(title)
        except ValueError:
            alt = db.get_next_title_in_lineage(title)
            if alt and alt != title:
                write(alt)

    return _write(home, "sync session title", op)


def append_message(home: Path, session_id: str, *, role: str, content: str, tool_name=None, timestamp=None) -> bool:
    """TAL-258 (predecessor ``_persist_handoff_summary_to_state_db``): one row through ``SessionDB.append_message``,
    which also bumps the session's ``message_count``. False without a state.db or when the write fails."""
    return _write(home, f"append a {role} row to state.db for {session_id}",
                  lambda db: db.append_message(session_id, role, content=content, tool_name=tool_name or None, timestamp=timestamp),
                  level=logging.WARNING)


def _close(db) -> None:
    try:
        db.close()
    except Exception:  # noqa: BLE001
        pass


# ── CLI session deletion ──────────────────────────────────────────────────

@contextmanager
def _process_lock(home: Path):
    lock_path = home / ".session_cleanup.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(fd, "r+b", buffering=0) as lock_file:
        try:
            import fcntl
        except ImportError as exc:
            raise RuntimeError("cross-process session cleanup locking is unavailable") from exc
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def _thread_lock(home: Path) -> threading.Lock:
    key = os.fspath(home)
    with _cleanup_locks_guard:
        lock = _cleanup_locks.get(key)
        if lock is None:
            lock = _cleanup_locks[key] = threading.Lock()
        return lock


def _is_safe_session_id(sid) -> bool:
    return isinstance(sid, str) and bool(_SAFE_SESSION_ID.match(sid))


def _clean_artifacts(sessions_dir: Path, removed_id: str, *, keep_legacy: bool) -> bool:
    if not _is_safe_session_id(removed_id):
        return False
    ok = True
    # ``session_<id>.json`` is the legacy snapshot older Agents wrote; it can carry plaintext secrets. It is kept while a
    # live session's id is ``session_<id>``, because then it is that session's own transcript.
    names = [f"{removed_id}.json", f"{removed_id}.jsonl"] + ([] if keep_legacy else [f"session_{removed_id}.json"])
    for name in names:
        artifact = sessions_dir / name
        if artifact.exists():
            try:
                artifact.unlink(missing_ok=True)
            except OSError:
                ok = False
    try:
        for path in list(sessions_dir.glob(f"request_dump_{removed_id}_*.json")):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                ok = False
    except OSError:
        ok = False
    return ok


def _process_manifests(conn, sessions_dir: Path, *, alive_query) -> bool:
    """Retry every pending manifest; True when nothing remains pending."""
    complete = True
    for mp in sorted(sessions_dir.glob(".cleanup_manifest_*.json")):
        try:
            pending_ids = json.loads(mp.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            complete = False
            continue
        if not isinstance(pending_ids, list) or not all(isinstance(item, str) for item in pending_ids):
            complete = False
            continue
        if not pending_ids:
            mp.unlink(missing_ok=True)
            continue
        try:
            alive = alive_query(conn, pending_ids + [f"session_{i}" for i in pending_ids])
        except Exception:  # noqa: BLE001 - fail closed, retry later
            complete = False
            continue
        still_pending = []
        for removed_id in pending_ids:
            if removed_id in alive or not _clean_artifacts(sessions_dir, removed_id, keep_legacy=f"session_{removed_id}" in alive):
                still_pending.append(removed_id)
        if still_pending:
            tmp = mp.with_suffix(".tmp")
            try:
                tmp.write_text(json.dumps(still_pending), encoding="utf-8")
                tmp.rename(mp)
            except OSError:
                log.warning("Failed to rewrite manifest %s", mp, exc_info=True)
            complete = False
        else:
            mp.unlink(missing_ok=True)
    return complete


def _alive_set(conn, ids: list[str]) -> set[str]:
    cursor = conn.execute("SELECT id FROM sessions WHERE id IN ({})".format(",".join("?" * len(ids))), ids)
    return {row[0] for row in cursor.fetchall()}


def _process_stale_manifests(home: Path) -> bool:
    db_path, sessions_dir = home / "state.db", home / "sessions"
    if not sessions_dir.exists() or not sorted(sessions_dir.glob(".cleanup_manifest_*.json")):
        return True
    if not db_path.exists():
        return False
    try:
        with closing(sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True, timeout=STATE_DB_CONNECT_TIMEOUT_S)) as conn:
            return _process_manifests(conn, sessions_dir, alive_query=_alive_set)
    except Exception:  # noqa: BLE001
        return False


# The Agent's ``_CHAIN_CAP`` and the server's ``COMPRESSION_CHAIN_CAP``: the most hops a compression-chain walk takes.
_COMPRESSION_CHAIN_CAP = 1000


class _ActiveWriteGuard(Exception):
    """Another Agent process holds a live turn lease or compression lock on a row the delete would remove."""


def _delete_locked(sid: str, home: Path) -> dict:
    stale_complete = _process_stale_manifests(home)
    db_path = home / "state.db"
    if not db_path.exists():
        return {"ok": False}
    agent_db = _session_db(home)
    if agent_db is None:
        return {"ok": False}
    try:
        guarded = _write_guard_check(agent_db)
        if guarded is None:  # fail closed: without the Agent's guard, a live writer's rows cannot be told apart
            log.warning("Agent has no session write-guard check; state.db rows are kept")
            return {"ok": False}
        from hermes_state_mutation_retirement import delete_in_transaction

        result = _delete_runtime_rows(sid, home, agent_db, guarded, delete_in_transaction)
        return {**result, "ok": result["ok"] and stale_complete}
    finally:
        _close(agent_db)


def _write_guard_check(agent_db):
    """The Agent's own user-delete guard, ``(conn, ids) -> bool``: true when a live turn lease or compression lock protects
    any id; expired or dead-holder guards are reclaimed. None, refusing the delete, on an Agent without that guard."""
    guarded_ids = getattr(agent_db, "_guarded_ids", None)
    if guarded_ids is not None:
        return lambda conn, ids: bool(guarded_ids(conn, ids))
    return None


def _write_cleanup_manifest(home: Path, removed_ids: list[str]) -> None:
    sessions_dir = home / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)
    base = f".cleanup_manifest_{uuid.uuid4().hex}"
    manifest, tmp = sessions_dir / f"{base}.json", sessions_dir / f"{base}.tmp"
    try:
        tmp.write_text(json.dumps(sorted(removed_ids)), encoding="utf-8")
        tmp.rename(manifest)
    except OSError:
        tmp.unlink(missing_ok=True)
        raise


def _delete_runtime_rows(requested: str, home: Path, agent_db, guarded, delete_in_transaction) -> dict:
    """The Agent's canonical target/retirement transaction, under Talaria's user-delete guard.

    Compression and receipt-backed reset segments are one conversation, even when the caller names its tip.
    The Agent owns delegate/fork boundaries, live-ledger refusals, receipt compaction and tombstones.
    """
    from hermes_state_mutation_guards import delete_targets
    from hermes_state_runtime import RuntimeStoreError
    from hermes_state_media import collect_retired_media

    def write(conn):
        # The Agent's owner lookup falls back to the physical id on an unreadable receipt; refuse before that loses its owner.
        row = conn.execute("SELECT chat_id FROM sessions WHERE id=?", (requested,)).fetchone()
        owner = row[0] if row else None
        saved = conn.execute("SELECT value FROM state_meta WHERE key=?", ("gateway.local_policy.v1:" + owner,)).fetchone() if owner else None
        if saved is not None:
            from hermes_state_local_lineage import validate_local_lineage
            raw = saved[0]
            if len(raw) > 1_000_000:
                raise ValueError("local receipt exceeds read budget")
            receipt = json.loads(raw)
            ids = receipt.get("lineage", [owner])
            if (receipt.get("session_id") != owner or not isinstance(ids, list) or not ids
                    or len(ids) > _COMPRESSION_CHAIN_CAP or not all(isinstance(sid, str) and sid for sid in ids)):
                raise ValueError("invalid local receipt")
            validate_local_lineage(conn, receipt)
            members = conn.execute("SELECT id,chat_id,user_id,session_key,source,model_config FROM sessions WHERE id IN (SELECT value FROM json_each(?))",
                                   (json.dumps(ids),)).fetchall()
            if len(members) != len(ids) or any(tuple(member)[1:4] != (owner, receipt["principal_id"], receipt["route"]) for member in members):
                raise ValueError("local receipt owner mismatch")
            for member in members:
                config = json.loads(member[5] or '{}')
                if member[0] != owner and (member[4] == 'tool' or any(config.get(key) is not None for key in ('_branched_from', '_delegate_from'))):
                    raise ValueError("explicit child is not a local continuation")
        # Preserve the older user-delete guard over the complete canonical set, including closed ancestors.
        if guarded(conn, delete_targets(conn, requested)):
            raise _ActiveWriteGuard
        try:
            _, result = delete_in_transaction(agent_db, conn, requested, {})
        except RuntimeStoreError as exc:
            if exc.reason in ("session_busy", "unknown_execution"):
                raise _ActiveWriteGuard from exc
            raise
        # Publish cleanup intent before the database commit; a failed manifest rolls back retirement too.
        _write_cleanup_manifest(home, result["deleted_ids"])
        return result["deleted_ids"]

    deleted_ids = agent_db._execute_write(write)
    # Agent v0.22.3+ tells the profile's plugins after the commit, like its own deletes; the emitter is fail-open.
    import hermes_state_common
    emit_session_deleted = getattr(hermes_state_common, "emit_session_deleted", None)
    if emit_session_deleted is not None:
        emit_session_deleted(agent_db, deleted_ids, reason="delete", primary=requested, sessions_dir=home / "sessions")
    try:
        collect_retired_media(agent_db)
    except Exception:  # noqa: BLE001 - retirement committed; retain its targets for caller cleanup and manifest retry
        log.warning("Failed to collect retired session media", exc_info=True)
        return {"ok": False, "deleted_ids": deleted_ids}
    return {"ok": _process_stale_manifests(home), "deleted_ids": deleted_ids}


def delete_cli_session(home: Path, sid: str) -> dict:
    """Delete ``sid`` with its whole conversation: the Agent's canonical targets take every compression and
    receipt-backed reset segment, so ``include_compression_lineage`` needs no separate walk."""
    try:
        with _thread_lock(home), _process_lock(home):
            return _delete_locked(sid, home)
    except _ActiveWriteGuard:  # the uncommitted transaction rolls back on close: nothing is removed
        return {"ok": False, "refused": "active_turn"}
    except Exception:  # noqa: BLE001
        log.warning("Failed to delete CLI session %s from state.db", sid, exc_info=True)
        return {"ok": False}


def prune_advice(home: Path) -> dict | None:
    """The Agent's low-disk session auto-prune question for ``home`` (v0.22.3 ``hermes_cli.prune_advisor``) in its own
    words; None while the Agent would not ask (disk not low, ``sessions.auto_prune`` set, snoozed)."""
    from hermes_cli import prune_advisor

    advice, stale = prune_advisor.cached_advice(home)
    if advice is None and not stale:
        return None
    if advice is None or stale:
        # Measures state.db (seconds on a large store), on this request's own worker thread.
        advice = prune_advisor.advise(home)
    return {"lines": prune_advisor.advice_lines(advice, command_prefix="/")} if advice else None


def register(registry) -> None:
    @registry.method("state_db.sync_start")
    def start(ctx: CallContext, params: dict) -> dict:
        return {"ok": sync_session_start(profile_home_param(params), _session_id(params), params.get("model"))}

    @registry.method("state_db.sync_usage")
    def usage(ctx: CallContext, params: dict) -> dict:
        return {"ok": sync_session_usage(
            profile_home_param(params), _session_id(params), input_tokens=int(params.get("input_tokens") or 0), output_tokens=int(params.get("output_tokens") or 0),
            estimated_cost=params.get("estimated_cost"), model=params.get("model"), title=params.get("title"), message_count=params.get("message_count"),
            cache_read_tokens=int(params.get("cache_read_tokens") or 0), cache_write_tokens=int(params.get("cache_write_tokens") or 0), api_call_count=params.get("api_call_count"),
        )}

    @registry.method("state_db.sync_title")
    def title(ctx: CallContext, params: dict) -> dict:
        return {"ok": sync_session_title(profile_home_param(params), _session_id(params), str(params.get("title") or ""), manual=params.get("manual") is True)}

    @registry.method("state_db.request_prompt_refresh")
    def prompt_refresh(ctx: CallContext, params: dict) -> dict:
        return {"ok": request_prompt_refresh(profile_home_param(params))}

    @registry.method("state_db.append_message")
    def append(ctx: CallContext, params: dict) -> dict:
        role = str(params.get("role") or "").strip()
        if not role:
            raise InvalidParams("role is required")
        content = params.get("content")
        if not isinstance(content, str):
            raise InvalidParams("content must be a string")
        return {"ok": append_message(profile_home_param(params), _session_id(params), role=role, content=content, tool_name=params.get("tool_name"), timestamp=params.get("timestamp"))}

    @registry.method("state_db.delete_cli_session")
    def delete(ctx: CallContext, params: dict) -> dict:
        sid = _session_id(params)
        if not _is_safe_session_id(sid):
            raise InvalidParams("unsafe session_id")
        return delete_cli_session(profile_home_param(params).resolve(), sid)

    @registry.method("state_db.prune_advice")
    def prune_advice_(ctx: CallContext, params: dict) -> dict:
        home = profile_home_param(params)
        with scoped_home(home):
            return {"advice": prune_advice(home)}
