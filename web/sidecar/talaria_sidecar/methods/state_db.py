"""``state_db.*``: writes to the Agent's ``state.db`` through ``hermes_state.SessionDB``.

Ported from api/state_sync.py (usage/title mirroring) and
api/models.py::delete_cli_session (lineage-aware CLI session deletion with
cleanup manifests). Read-only projections stay in the TypeScript server.
"""

from __future__ import annotations

import datetime
import json
import logging
import math
import os
import re
import sqlite3
import threading
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


def sync_session_start(home: Path, session_id: str, model=None) -> bool:
    db = _session_db(home)
    if not db:
        return False
    try:
        db.ensure_session(session_id=session_id, source="webui", model=model)
        return True
    except Exception:  # noqa: BLE001
        log.debug("Failed to sync session start", exc_info=True)
        return False
    finally:
        _close(db)


def sync_session_usage(home: Path, session_id: str, *, input_tokens=0, output_tokens=0, estimated_cost=None, model=None, title=None,
                       message_count=None, cache_read_tokens=0, cache_write_tokens=0, api_call_count=None) -> bool:
    db = _session_db(home)
    if not db:
        return False
    try:
        db.ensure_session(session_id=session_id, source="webui", model=model)
        db.update_token_counts(
            session_id=session_id, input_tokens=input_tokens, output_tokens=output_tokens, cache_read_tokens=cache_read_tokens,
            cache_write_tokens=cache_write_tokens, api_call_count=api_call_count or 0, estimated_cost_usd=estimated_cost, model=model, absolute=True,
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
        return True
    except Exception:  # noqa: BLE001
        log.debug("Failed to sync session usage", exc_info=True)
        return False
    finally:
        _close(db)


def sync_session_title(home: Path, session_id: str, title: str, *, manual: bool = False) -> bool:
    """A manual (user-requested) title lands with ``user`` provenance; an auto title is ``llm`` and never replaces a user name."""
    if not title:
        return False
    db = _session_db(home)
    if not db:
        return False
    try:
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
        return True
    except Exception:  # noqa: BLE001
        log.debug("Failed to sync session title", exc_info=True)
        return False
    finally:
        _close(db)


def append_message(home: Path, session_id: str, *, role: str, content: str, tool_name=None, timestamp=None) -> bool:
    """TAL-258 (predecessor ``_persist_handoff_summary_to_state_db``): one row through ``SessionDB.append_message``,
    which also bumps the session's ``message_count``. False without a state.db or when the write fails."""
    db = _session_db(home)
    if not db:
        return False
    try:
        db.append_message(session_id, role, content=content, tool_name=tool_name or None, timestamp=timestamp)
        return True
    except Exception:  # noqa: BLE001
        log.warning("Failed to append a %s row to state.db for %s", role, session_id, exc_info=True)
        return False
    finally:
        _close(db)


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


def _timestamp_value(value):
    if isinstance(value, bool) or value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(float(value)) else None
    if isinstance(value, datetime.datetime):
        parsed = value
    elif isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        try:
            numeric = float(raw)
            return numeric if math.isfinite(numeric) else None
        except ValueError:
            try:
                parsed = datetime.datetime.fromisoformat(raw[:-1] + "+00:00" if raw.endswith("Z") else raw)
            except ValueError:
                return None
    else:
        return None
    if parsed.tzinfo is None:
        return None
    try:
        numeric = parsed.timestamp()
    except (OverflowError, OSError, ValueError):
        return None
    return numeric if math.isfinite(numeric) else None


def _is_continuation(parent: dict, child: dict) -> bool:
    """The server's ``isContinuationSession``: ``child`` resumes ``parent`` after a compression or CLI close."""
    lower = lambda v: str(v or "").strip().lower()  # noqa: E731
    if lower(child.get("session_source")) == "fork":
        return False
    if child.get("source") == "tool" or any(child.get(k) is not None for k in ("branched_from", "delegate_from", "reset_from")):
        return False
    if lower(parent.get("source")) and lower(child.get("source")) and lower(parent.get("source")) != lower(child.get("source")):
        return False
    if parent.get("end_reason") not in ("compression", "cli_close"):
        return False
    if parent.get("ended_at") is None:
        return True
    try:
        started, ended = float(child.get("started_at") or 0), float(parent["ended_at"])
    except (TypeError, ValueError):
        return False
    return math.isfinite(started) and math.isfinite(ended) and started + 1.0 >= ended


# The Agent's ``_CHAIN_CAP`` and the server's ``COMPRESSION_CHAIN_CAP``: the most hops a compression-chain walk takes.
_COMPRESSION_CHAIN_CAP = 1000


def _compression_lineage(records: list[dict], sid: str) -> list[str]:
    """The server's ``stateDbCompressionLineage``: ``sid`` then each single continuation, up to ``_COMPRESSION_CHAIN_CAP``
    hops, root first."""
    by_id = {r["id"]: r for r in records}
    children: dict[str, list[dict]] = {}
    for r in records:
        children.setdefault(r["parent_id"], []).append(r)
    lineage, current = [sid], by_id.get(sid)
    for _ in range(_COMPRESSION_CHAIN_CAP):
        if current is None:
            break
        nxt = [r for r in children.get(current["id"], []) if _is_continuation(current, r)]
        if len(nxt) != 1 or nxt[0]["id"] in lineage:
            break
        current = nxt[0]
        lineage.append(current["id"])
    return lineage


class _ActiveWriteGuard(Exception):
    """Another Agent process holds a live turn lease or compression lock on a row the delete would remove."""


def _delete_locked(sid: str, home: Path, include_lineage: bool) -> dict:
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
        try:
            from hermes_state_mutation_retirement import delete_in_transaction
        except ModuleNotFoundError as exc:
            if exc.name != "hermes_state_mutation_retirement":
                raise
            result = _delete_rows(sid, include_lineage, home, db_path, guarded)
        else:
            result = _delete_runtime_rows(sid, home, agent_db, guarded, delete_in_transaction)
        return {**result, "ok": result["ok"] and stale_complete}
    finally:
        _close(agent_db)


def _write_guard_check(agent_db):
    """The Agent's own user-delete guard, ``(conn, ids) -> bool``: true when a live turn lease or compression lock protects
    any id; expired or dead-holder guards are reclaimed. ``_guarded_ids`` from v0.21.6, the per-row check before it."""
    guarded_ids = getattr(agent_db, "_guarded_ids", None)
    if guarded_ids is not None:
        return lambda conn, ids: bool(guarded_ids(conn, ids))
    rejects = getattr(agent_db, "_write_guards_reject", None)
    if rejects is not None:
        return lambda conn, ids: any(rejects(conn, i, allow_closed_compression_parent=True) for i in ids)
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
    """Extend the legacy delete with the Agent's canonical target/retirement transaction.

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


def _delete_rows(requested: str, include_lineage: bool, home: Path, db_path: Path, guarded) -> dict:
    with closing(sqlite3.connect(str(db_path))) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("BEGIN IMMEDIATE")
        columns = {row[1] for row in conn.execute("PRAGMA table_info(sessions)").fetchall()}
        if not {"id", "parent_session_id"}.issubset(columns):
            return {"ok": False}
        selected = ["id", "parent_session_id"] + [c if c in columns else f"NULL AS {c}" for c in ("model_config", "source", "session_source", "end_reason", "started_at", "ended_at", "chat_id")]
        rows = conn.execute(f"SELECT {', '.join(selected)} FROM sessions").fetchall()
        records = []
        for row in rows:
            model_config: dict = {}
            raw = row["model_config"]
            known = raw in (None, "")
            if not known:
                try:
                    parsed = json.loads(raw)
                except (TypeError, ValueError):
                    parsed = None
                if isinstance(parsed, dict):
                    model_config, known = parsed, True
            records.append({
                "id": row["id"], "parent_id": row["parent_session_id"], "delegate_from": model_config.get("_delegate_from"),
                "branched_from": model_config.get("_branched_from"), "model_config_known": known, "source": row["source"], "session_source": row["session_source"],
                "reset_from": model_config.get("_reset_from"), "chat_id": row["chat_id"],
                "end_reason": row["end_reason"], "started_at": row["started_at"], "ended_at": row["ended_at"],
            })
        by_id = {r["id"]: r for r in records}

        def must_preserve(record, parent) -> bool:
            if record["branched_from"] is not None:
                return True
            end_reason = parent.get("end_reason")
            if end_reason == "compression":
                return True
            if end_reason != "branched":
                return False
            started_at, parent_ended_at = _timestamp_value(record["started_at"]), _timestamp_value(parent.get("ended_at"))
            if started_at is None or parent_ended_at is None:
                return True
            return started_at >= parent_ended_at

        def lineage_parent(record):
            if record["delegate_from"] is not None:
                return by_id.get(record["delegate_from"]) or {}
            return by_id.get(record["parent_id"]) or {}

        def delegates_of(sid: str) -> list[str]:
            preserved = {r["id"] for r in records if r["id"] != sid and must_preserve(r, lineage_parent(r))}
            while True:
                descendants = {r["id"] for r in records if r["id"] != sid and r["parent_id"] in preserved}
                new_ids = descendants - preserved
                if not new_ids:
                    break
                preserved.update(new_ids)
            found, frontier = {sid}, {sid}
            while frontier:
                next_frontier = set()
                for record in records:
                    row_id = record["id"]
                    if row_id in found or row_id in preserved:
                        continue
                    parent_id, delegate_from = record["parent_id"], record["delegate_from"]
                    if delegate_from not in frontier and parent_id not in frontier:
                        continue
                    if must_preserve(record, lineage_parent(record)):
                        continue
                    if delegate_from is not None:
                        if delegate_from in frontier:
                            next_frontier.add(row_id)
                        continue
                    if record["source"] != "subagent":
                        continue
                    if parent_id in frontier and record["model_config_known"]:
                        next_frontier.add(row_id)
                found.update(next_frontier)
                frontier = next_frontier
            return sorted(found - {sid})

        # TAL-792: the compression continuations are resolved here, in the delete transaction, so one that a compression
        # finished after the caller looked is guarded and removed too; one transaction removes them all, tip first.
        sids = _compression_lineage(records, requested) if include_lineage else [requested]
        plan = [(sid, delegates_of(sid)) for sid in reversed(sids)]
        all_removed = list(dict.fromkeys(i for sid, delegate_ids in plan for i in (sid, *delegate_ids)))
        if _has_retained_runtime_history(conn, records, all_removed):
            return {"ok": False, "refused": "runtime_history_unsupported"}
        # The Agent's own user-delete guard, checked over every row before any is removed. A live writer's turn lease or
        # compression lock refuses the whole delete; expired or dead-holder guards are reclaimed.
        if guarded(conn, all_removed):
            raise _ActiveWriteGuard
        placeholders = ",".join("?" * len(all_removed))
        for sid, delegate_ids in plan:
            for child_id in delegate_ids:
                conn.execute("DELETE FROM messages WHERE session_id = ?", (child_id,))
            for child_id in delegate_ids:
                conn.execute("UPDATE sessions SET parent_session_id = NULL WHERE parent_session_id = ?", (child_id,))
            for child_id in delegate_ids:
                conn.execute("DELETE FROM sessions WHERE id = ?", (child_id,))
            conn.execute("UPDATE sessions SET parent_session_id = NULL WHERE parent_session_id = ?", (sid,))
            conn.execute("DELETE FROM messages WHERE session_id = ?", (sid,))
            conn.execute("DELETE FROM sessions WHERE id = ?", (sid,))
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        for table in ("compression_locks", "session_model_usage", "telegram_dm_topic_bindings"):
            if table in tables:
                conn.execute(f"DELETE FROM {table} WHERE session_id IN ({placeholders})", all_removed)
        try:
            _write_cleanup_manifest(home, all_removed)
        except OSError:
            log.warning("Failed to write cleanup manifest", exc_info=True)
            conn.rollback()
            return {"ok": False}
        conn.commit()
        return {"ok": _process_stale_manifests(home), "deleted_ids": all_removed}


def _has_retained_runtime_history(conn, records: list[dict], removed_ids: list[str]) -> bool:
    """Read-only downgrade fence, never a replacement for the Agent's retirement/receipt validator."""
    targets = set(removed_ids)
    by_id = {r["id"]: r for r in records}
    # Inspect the logical family, including compressed delegates the legacy plan would detach.
    # This only refuses deletion; the installed Agent remains the sole canonical retirement implementation.
    while True:
        connected = set()
        for child in records:
            parent = by_id.get(child["parent_id"])
            if parent and (child['id'] in targets or parent['id'] in targets):
                # Only markers actually copied from this parent are known to be inherited.
                edge = {**child, **{k: None for k in ('branched_from', 'delegate_from', 'reset_from') if child[k] == parent[k]}}
                if _is_continuation(parent, edge):
                    connected.update((parent['id'], child['id']))
            if child['branched_from'] is None and child['reset_from'] is None and (child['delegate_from'] in targets
                    or (child['delegate_from'] is None and child['source'] == 'subagent' and child['parent_id'] in targets
                        and child['model_config_known'])):
                connected.add(child['id'])
        if connected.issubset(targets):
            break
        targets.update(connected)
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    placeholders = ','.join('?' for _ in targets)
    for table, column in (("session_admissions", "target_session_id"), ("worker_executions", "session_id")):
        if table in tables and conn.execute(f"SELECT 1 FROM {table} WHERE {column} IN ({placeholders}) LIMIT 1", tuple(targets)).fetchone():
            return True
    if 'state_meta' not in tables:
        return False
    # The key and stored chat owner still identify a reset receipt when its JSON is unreadable.
    owners = targets | {r["chat_id"] for r in records if r["id"] in targets and isinstance(r["chat_id"], str)}
    for key, raw in conn.execute("SELECT key,value FROM state_meta WHERE key GLOB 'gateway.*'"):
        if key.startswith('gateway.local_policy.v1:') and key.removeprefix('gateway.local_policy.v1:') in owners:
            return True
        if key.startswith('gateway.retired_session.v1.') and key.removeprefix('gateway.retired_session.v1.') in targets:
            return True
        try:
            receipt = json.loads(raw)
        except (TypeError, ValueError):
            continue
        if not isinstance(receipt, dict):
            continue
        lineage = receipt.get('lineage')
        entry = receipt.get('entry')
        ids = [receipt.get('session_id'), receipt.get('target_session_id'),
               entry.get('session_id') if isinstance(entry, dict) else None,
               *(lineage if isinstance(lineage, list) else [])]
        if any(isinstance(sid, str) and sid in targets for sid in ids):
            return True
    return False


def delete_cli_session(home: Path, sid: str, include_lineage: bool = False) -> dict:
    try:
        with _thread_lock(home), _process_lock(home):
            return _delete_locked(sid, home, include_lineage)
    except _ActiveWriteGuard:  # the uncommitted transaction rolls back on close: nothing is removed
        return {"ok": False, "refused": "active_turn"}
    except Exception:  # noqa: BLE001
        log.warning("Failed to delete CLI session %s from state.db", sid, exc_info=True)
        return {"ok": False}


def prune_advice(home: Path) -> dict | None:
    """The Agent's low-disk session auto-prune question for ``home`` (v0.22.3 ``hermes_cli.prune_advisor``) in its own
    words; None while the Agent would not ask (disk not low, ``sessions.auto_prune`` set, snoozed) or has no advisor."""
    try:
        from hermes_cli import prune_advisor
    except ImportError:
        return None
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
        return delete_cli_session(profile_home_param(params).resolve(), sid, params.get("include_compression_lineage") is True)

    @registry.method("state_db.prune_advice")
    def prune_advice_(ctx: CallContext, params: dict) -> dict:
        home = profile_home_param(params)
        with scoped_home(home):
            return {"advice": prune_advice(home)}
