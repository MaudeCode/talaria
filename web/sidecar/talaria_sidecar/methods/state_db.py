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
from ..home import profile_home_param
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


def sync_session_title(home: Path, session_id: str, title: str) -> bool:
    if not title:
        return False
    db = _session_db(home)
    if not db:
        return False
    try:
        db.ensure_session(session_id=session_id, source="webui")
        source = getattr(db, "TITLE_SOURCE_LLM", "llm")
        try:
            db.set_auto_title(session_id, title, source=source)
        except ValueError:
            alt = db.get_next_title_in_lineage(title)
            if alt and alt != title:
                db.set_auto_title(session_id, alt, source=source)
        return True
    except Exception:  # noqa: BLE001
        log.debug("Failed to sync auto title", exc_info=True)
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


def _clean_artifacts(sessions_dir: Path, removed_id: str) -> bool:
    if not _is_safe_session_id(removed_id):
        return False
    ok = True
    for suffix in (".json", ".jsonl"):
        artifact = sessions_dir / f"{removed_id}{suffix}"
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
            alive = alive_query(conn, pending_ids)
        except Exception:  # noqa: BLE001 - fail closed, retry later
            complete = False
            continue
        still_pending = []
        for removed_id in pending_ids:
            if removed_id in alive or not _clean_artifacts(sessions_dir, removed_id):
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


def _delete_locked(sid: str, home: Path) -> bool:
    stale_complete = _process_stale_manifests(home)
    db_path = home / "state.db"
    if not db_path.exists():
        return False
    with closing(sqlite3.connect(str(db_path))) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("BEGIN IMMEDIATE")
        columns = {row[1] for row in conn.execute("PRAGMA table_info(sessions)").fetchall()}
        if not {"id", "parent_session_id"}.issubset(columns):
            return False
        selected = ["id", "parent_session_id"] + [c if c in columns else f"NULL AS {c}" for c in ("model_config", "source", "end_reason", "started_at", "ended_at")]
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
                "branched_from": model_config.get("_branched_from"), "model_config_known": known, "source": row["source"],
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
        delegate_ids = sorted(found - {sid})
        all_removed = [sid, *delegate_ids]
        placeholders = ",".join("?" * len(all_removed))
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
        sessions_dir = home / "sessions"
        sessions_dir.mkdir(parents=True, exist_ok=True)
        base = f".cleanup_manifest_{uuid.uuid4().hex}"
        manifest, tmp = sessions_dir / f"{base}.json", sessions_dir / f"{base}.tmp"
        try:
            tmp.write_text(json.dumps(sorted(str(i) for i in all_removed)), encoding="utf-8")
            tmp.rename(manifest)
        except OSError:
            log.warning("Failed to write cleanup manifest", exc_info=True)
            tmp.unlink(missing_ok=True)
            conn.rollback()
            return False
        conn.commit()

        def alive_after_commit(c, ids):
            try:
                return _alive_set(c, ids)
            except Exception:  # noqa: BLE001 - fail closed: treat as alive
                return set(ids)

        cleanup_complete = _process_manifests(conn, sessions_dir, alive_query=alive_after_commit)
        return stale_complete and cleanup_complete


def delete_cli_session(home: Path, sid: str) -> bool:
    try:
        with _thread_lock(home), _process_lock(home):
            return _delete_locked(sid, home)
    except Exception:  # noqa: BLE001
        log.warning("Failed to delete CLI session %s from state.db", sid, exc_info=True)
        return False


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
        return {"ok": sync_session_title(profile_home_param(params), _session_id(params), str(params.get("title") or ""))}

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
        return {"ok": delete_cli_session(profile_home_param(params).resolve(), sid)}
