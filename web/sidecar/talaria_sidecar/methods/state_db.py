"""``state_db.*``: writes to the Agent's ``state.db`` through its session store (``agent_store``).

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

from .. import agent_store
from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext

log = logging.getLogger("talaria_sidecar.state_db")
STATE_DB_CONNECT_TIMEOUT_S = 5.0
_SAFE_SESSION_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_cleanup_locks_guard = threading.Lock()
_cleanup_locks: dict[str, threading.Lock] = {}


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
    """Give back a store handle (a cached agent's or a write pin); the final one closes it."""
    if db is None:
        return
    try:
        agent_store.release(db)
    except Exception:  # noqa: BLE001
        log.warning("releasing a state.db handle failed", exc_info=True)


def _write(home: Path, what: str, op, *, level: int = logging.DEBUG) -> bool:
    """Run ``op(db)`` on the shared handle; False without a state.db or when it fails. A failed write unpins the handle,
    so the next one reopens it unless another holder keeps it."""
    db_path = home / "state.db"
    if not db_path.exists():
        return False
    try:
        db = agent_store.acquire(home)
    except ImportError as exc:
        raise RpcError("hermes_state unavailable", condition="state_db_unavailable") from exc
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
    return _write(home, "request a prompt refresh", agent_store.request_prompt_refresh, level=logging.WARNING)


def sync_session_start(home: Path, session_id: str, model=None) -> bool:
    return _write(home, "sync session start", lambda db: agent_store.ensure_session(db, session_id, source="webui", model=model))


def sync_session_usage(home: Path, session_id: str, *, input_tokens=0, output_tokens=0, estimated_cost=None, model=None, title=None,
                       message_count=None, cache_read_tokens=0, cache_write_tokens=0, api_call_count=None) -> bool:
    def op(db) -> None:
        # The token update's own row guard creates the session with this source, like ``ensure_session``.
        agent_store.set_usage(
            db, session_id, input_tokens=input_tokens, output_tokens=output_tokens, cache_read_tokens=cache_read_tokens,
            cache_write_tokens=cache_write_tokens, api_call_count=api_call_count or 0, estimated_cost=estimated_cost, model=model, source="webui",
        )
        if title:
            try:
                agent_store.set_title(db, session_id, title, manual=True)
            except Exception:  # noqa: BLE001
                log.debug("Failed to sync session title", exc_info=True)
        if message_count is not None:
            try:
                agent_store.set_message_count(db, session_id, message_count)
            except Exception:  # noqa: BLE001
                log.debug("Failed to sync message count", exc_info=True)

    return _write(home, "sync session usage", op)


def sync_session_title(home: Path, session_id: str, title: str, *, manual: bool = False, derived: bool = False, replace_automatic: bool = False) -> bool:
    """A manual (user-requested) title lands with ``user`` provenance; an auto title is ``llm``, or ``derived`` for the
    server's local summary (TAL-2588), and never replaces a user name. ``replace_automatic`` lets an adaptive refresh
    replace an earlier automatic title at ``llm`` provenance (TAL-2631)."""
    if not title:
        return False

    def op(db) -> None:
        agent_store.ensure_session(db, session_id, source="webui")
        try:
            agent_store.set_title(db, session_id, title, manual=manual, derived=derived, replace_automatic=replace_automatic)
        except ValueError:
            alt = agent_store.next_title_in_lineage(db, title)
            if alt and alt != title:
                agent_store.set_title(db, session_id, alt, manual=manual, derived=derived, replace_automatic=replace_automatic)

    return _write(home, "sync session title", op)


def append_message(home: Path, session_id: str, *, role: str, content: str, tool_name=None, timestamp=None) -> bool:
    """TAL-258 (predecessor ``_persist_handoff_summary_to_state_db``): one row through the Agent's transcript append,
    which also bumps the session's ``message_count``. False without a state.db or when the write fails."""
    return _write(home, f"append a {role} row to state.db for {session_id}",
                  lambda db: agent_store.append_message(db, session_id, role=role, content=content, tool_name=tool_name or None, timestamp=timestamp),
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
# How long the guards a storage-interface delete takes outlive a sidecar that dies holding them.
_DELETE_GUARD_TTL_S = 60.0
# The Agent's local conversation owner receipt, keyed by the conversation's creation id.
_LOCAL_POLICY_PREFIX = "gateway.local_policy.v1:"


class _ActiveWriteGuard(Exception):
    """Another Agent process holds a live turn lease or compression lock on a row the delete would remove."""


def _delete_locked(sid: str, home: Path) -> dict:
    """TAL-2673: ``committed`` is true only once nothing of ``sid`` is left in state.db; the server refuses the delete
    otherwise. ``ok`` false with ``committed`` true means only the transcript file cleanup is pending."""
    stale_complete = _process_stale_manifests(home)
    db_path = home / "state.db"
    if not db_path.exists():  # no rows to retire; a pending manifest it cannot check stays a cleanup failure
        return {"ok": stale_complete, "committed": True, "deleted_ids": []}
    if agent_store.native():  # the branch below serves Agents before v0.23.3
        result = _delete_conversation(sid, home)
        return {**result, "ok": result["ok"] and stale_complete}
    agent_db = _legacy_session_db(home)
    if agent_db is None:
        return {"ok": False, "committed": False}
    try:
        guarded = _write_guard_check(agent_db)
        if guarded is None:  # fail closed: without the Agent's guard, a live writer's rows cannot be told apart
            log.warning("Agent has no session write-guard check; state.db rows are kept")
            return {"ok": False, "committed": False}
        from hermes_state_mutation_retirement import delete_in_transaction

        result = _delete_runtime_rows(sid, home, agent_db, guarded, delete_in_transaction)
        return {**result, "ok": result["ok"] and stale_complete}
    finally:
        _close(agent_db)


def _legacy_session_db(home: Path):
    """A writer ``SessionDB`` of an Agent before the storage interface, or None when it does not open."""
    try:
        from hermes_state import SessionDB
    except ImportError as exc:
        raise RpcError("hermes_state unavailable", condition="state_db_unavailable") from exc
    try:
        return SessionDB(home / "state.db")
    except Exception as exc:  # noqa: BLE001
        log.debug("Failed to open state.db under %s: %s", home, exc)
        return None


def _delete_conversation(requested: str, home: Path) -> dict:
    """The storage interface's delete of the conversation's whole footprint, the rows the Agent's own canonical delete
    reaches: the compression chain both ways, every local reset segment, delegate subtrees and their continuations. An
    owner receipt that does not hold refuses first. The interface has no read of another holder's guards, so the
    sidecar takes the Agent's turn lease and compression lock on every row under its own holder: any it cannot take is
    a live writer's, and nothing is removed. Holding them all, it records the cleanup manifest (a failed one removes
    nothing) and deletes every row in one transaction, which the retirement fence refuses while queued, started or
    unknown work owns one. Then the plugin hook and retired media, as the Agent runs them after its own delete; the
    manifest owns the transcript files, since the Agent's file sweep would also take the legacy name of a live
    ``session_<id>`` session's own transcript."""
    from gateway.session_ingress_media import native_inputs_root
    from persistence import AuthorityRefusal
    from session_retention import collect_retired_media, emit_session_deleted

    with scoped_home(home, read_only=True):
        media_root = str(native_inputs_root())
    db = agent_store.acquire(home)
    holder, leased, locked = f"talaria-sidecar-delete:{uuid.uuid4().hex}", [], []
    try:
        def members(ids: list[str]) -> list[tuple]:
            rows = [row for sid in ids if (row := db.sessions.get(sid)) is not None]
            return [(row.session_id, row.chat_id, row.user_id, row.session_key, row.source, dict(row.model_config)) for row in rows]

        _check_local_receipt(requested, lambda sid: getattr(db.sessions.get(sid), "chat_id", None), db.state_meta.get, members)
        reach = [sid for sid in db.runtime.delete_footprint(requested, owner=None).targets if db.sessions.get(sid) is not None]
        if not reach:
            return {"ok": _process_stale_manifests(home), "committed": True, "deleted_ids": []}
        for sid in reach:
            if not db.coordination.try_acquire_turn_lease(session_id=sid, holder=holder, ttl_seconds=_DELETE_GUARD_TTL_S):
                raise _ActiveWriteGuard
            leased.append(sid)
            if not db.coordination.try_acquire_compression_lock(session_id=sid, holder=holder, ttl_seconds=_DELETE_GUARD_TTL_S):
                raise _ActiveWriteGuard
            locked.append(sid)
        manifest = _write_cleanup_manifest(home, reach)
        try:
            outcome = db.sessions.delete_many(reach, skip_guarded=False, include_compression_chain=False, media_root=media_root)
        except BaseException as exc:
            manifest.unlink(missing_ok=True)  # nothing was removed: no files to clean
            if isinstance(exc, AuthorityRefusal) and exc.reason in ("session_busy", "unknown_execution"):
                raise _ActiveWriteGuard from exc
            raise
        deleted_ids = list(outcome.removed_ids)
        if extra := sorted(set(deleted_ids) - set(reach)):
            _write_cleanup_manifest(home, extra)
        emit_session_deleted(db.scope.profile_dir, deleted_ids, reason="delete", primary=requested, sessions_dir=home / "sessions")
        try:
            collect_retired_media(db, db.scope.profile_dir)
        except Exception:  # noqa: BLE001 - committed; the manifest keeps the files for the next delete
            log.warning("Failed to collect retired session media", exc_info=True)
            return {"ok": False, "committed": True, "deleted_ids": deleted_ids}
        return {"ok": _process_stale_manifests(home), "committed": True, "deleted_ids": deleted_ids}
    finally:
        for sid in locked:
            db.coordination.release_compression_lock(session_id=sid, holder=holder)
        for sid in leased:
            db.coordination.release_turn_lease(session_id=sid, holder=holder)
        agent_store.release(db)


def _write_guard_check(agent_db):
    """The Agent's own user-delete guard, ``(conn, ids) -> bool``: true when a live turn lease or compression lock protects
    any id; expired or dead-holder guards are reclaimed. None, refusing the delete, on an Agent without that guard."""
    guarded_ids = getattr(agent_db, "_guarded_ids", None)
    if guarded_ids is not None:
        return lambda conn, ids: bool(guarded_ids(conn, ids))
    return None


def _write_cleanup_manifest(home: Path, removed_ids: list[str]) -> Path:
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
    return manifest


def _check_local_receipt(requested: str, owner_of, meta, members_of, validate=None) -> None:
    """Refuse (``ValueError``) to delete a local conversation whose owner receipt does not hold: the Agent's owner lookup
    falls back to the physical id on an unreadable receipt, so its delete would take one segment and strand the rest.
    ``members_of(ids)`` gives each existing row as ``(id, chat_id, user_id, session_key, source, model_config)``."""
    owner = owner_of(requested)
    raw = meta(_LOCAL_POLICY_PREFIX + owner) if owner else None
    if raw is None:
        return
    if len(raw) > 1_000_000:
        raise ValueError("local receipt exceeds read budget")
    receipt = json.loads(raw)
    ids = receipt.get("lineage", [owner])
    if (receipt.get("session_id") != owner or not isinstance(ids, list) or not ids
            or len(ids) > _COMPRESSION_CHAIN_CAP or not all(isinstance(sid, str) and sid for sid in ids)):
        raise ValueError("invalid local receipt")
    if validate is not None:
        validate(receipt)
    members = members_of(ids)
    if len(members) != len(ids) or any(tuple(member)[1:4] != (owner, receipt["principal_id"], receipt["route"]) for member in members):
        raise ValueError("local receipt owner mismatch")
    for member in members:
        config = member[5]
        if member[0] != owner and (member[4] == 'tool' or any(config.get(key) is not None for key in ('_branched_from', '_delegate_from'))):
            raise ValueError("explicit child is not a local continuation")


def _delete_runtime_rows(requested: str, home: Path, agent_db, guarded, delete_in_transaction) -> dict:
    """The Agent's canonical target/retirement transaction, under Talaria's user-delete guard.

    Compression and receipt-backed reset segments are one conversation, even when the caller names its tip.
    The Agent owns delegate/fork boundaries, live-ledger refusals, receipt compaction and tombstones.
    """
    from hermes_state_mutation_guards import delete_targets
    from hermes_state_runtime import RuntimeStoreError
    from hermes_state_media import collect_retired_media

    def write(conn):
        from hermes_state_local_lineage import validate_local_lineage

        def one(sql: str, *args):
            row = conn.execute(sql, args).fetchone()
            return row[0] if row else None

        def members(ids: list[str]) -> list[tuple]:
            rows = conn.execute("SELECT id,chat_id,user_id,session_key,source,model_config FROM sessions WHERE id IN (SELECT value FROM json_each(?))",
                                (json.dumps(ids),)).fetchall()
            return [(*tuple(row)[:5], json.loads(row[5] or '{}')) for row in rows]

        _check_local_receipt(requested, lambda sid: one("SELECT chat_id FROM sessions WHERE id=?", sid),
                             lambda key: one("SELECT value FROM state_meta WHERE key=?", key), members,
                             lambda receipt: validate_local_lineage(conn, receipt))
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
        return {"ok": False, "committed": True, "deleted_ids": deleted_ids}
    return {"ok": _process_stale_manifests(home), "committed": True, "deleted_ids": deleted_ids}


def delete_cli_session(home: Path, sid: str) -> dict:
    """Delete ``sid`` with its whole conversation: the Agent's canonical targets take every compression and
    receipt-backed reset segment."""
    try:
        with _thread_lock(home), _process_lock(home):
            return _delete_locked(sid, home)
    except _ActiveWriteGuard:  # the uncommitted transaction rolls back on close: nothing is removed
        return {"ok": False, "committed": False, "refused": "active_turn"}
    except Exception:  # noqa: BLE001 - a write-lock timeout or failed manifest rolls the transaction back
        log.warning("Failed to delete CLI session %s from state.db", sid, exc_info=True)
        return {"ok": False, "committed": False}


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
        return {"ok": sync_session_title(profile_home_param(params), _session_id(params), str(params.get("title") or ""), manual=params.get("manual") is True,
                                         derived=params.get("title_source") == "derived", replace_automatic=params.get("replace_automatic") is True)}

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
