"""``kanban.*``: Hermes Kanban boards through ``hermes_cli.kanban_db`` (ported from api/kanban_bridge.py).

Every method takes ``profile_home`` (the kanban root lives under the Hermes
home) and an optional ``board`` slug. Query-string parsing stays in the
server; the sidecar receives typed params.
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, is_dataclass
from typing import Any

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext

BOARD_COLUMNS = ["triage", "todo", "ready", "running", "blocked", "done"]


class NotFound(RpcError):
    def __init__(self, message: str):
        super().__init__(message, condition="not_found")


class Conflict(RpcError):
    def __init__(self, message: str):
        super().__init__(message, condition="conflict")


def _kb():
    try:
        from hermes_cli import kanban_db as kb
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"kanban unavailable: {exc}", condition="kanban_unavailable") from exc
    return kb


def _board(params: dict):
    raw = params.get("board")
    if raw is None or (isinstance(raw, str) and raw.strip() == ""):
        return None
    kb = _kb()
    try:
        normed = kb._normalize_board_slug(raw)
    except (ValueError, AttributeError) as exc:
        raise InvalidParams(f"invalid board slug: {raw!r}") from exc
    if not normed:
        return None
    default_slug = getattr(kb, "DEFAULT_BOARD", "default")
    if normed != default_slug and not kb.board_exists(normed):
        raise NotFound(f"board {normed!r} does not exist")
    return normed


def _connect_module():
    """Newer Agents moved connect helpers to ``hermes_cli.kanban_db_connect``."""
    try:
        from hermes_cli import kanban_db_connect

        return kanban_db_connect
    except Exception:  # noqa: BLE001 - older Agent keeps them on kanban_db
        return _kb()


def _conn(board=None):
    kb = _kb()
    kb.init_db(board=board)
    module = _connect_module()
    closing = getattr(module, "connect_closing", None)
    return closing(board=board) if closing is not None else module.connect(board=board)


def _obj_dict(value):
    if value is None:
        return None
    if is_dataclass(value):
        return asdict(value)
    if isinstance(value, dict):
        return dict(value)
    return dict(getattr(value, "__dict__", {}))


def _claim_live(conn, task) -> bool:
    """Whether a running task's worker process still holds its claim (the Agent's ``_claim_is_live``).

    Releasing that claim (block, a direct status change) leaves the worker running, so the
    server offers those writes only once the worker is gone. Unknown liveness counts as live.
    """
    if getattr(task, "status", None) != "running":
        return False
    try:
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task.id,)).fetchone()
        if row is None:
            return False
        columns = row.keys()
        claim = {k: row[k] if k in columns else None for k in ("status", "claim_lock", "worker_pid", "worker_started_at")}
        return bool(_kb()._claim_is_live(claim))
    except Exception:  # noqa: BLE001 - an older Agent without the helper
        return bool(getattr(task, "claim_lock", None) and getattr(task, "worker_pid", None))


def _task_dict(task, conn):
    data = _obj_dict(task)
    if not data:
        return data
    # Facts the server's card policy needs (TAL-557): the Agent completes a non-review task only with
    # stored or supplied evidence, and refuses to release a live worker's claim.
    data["claim_live"] = _claim_live(conn, task)
    data["has_completion_evidence"] = bool(str(data.get("result") or "").strip())
    try:
        age = _kb().task_age(task)
    except Exception:  # noqa: BLE001
        age = None
    data["age_seconds"] = age
    data["age"] = age
    data.setdefault("progress", None)
    return data


def _latest_event_id(conn) -> int:
    try:
        row = conn.execute("SELECT COALESCE(MAX(id), 0) AS latest FROM task_events").fetchone()
        return int(row["latest"] or 0)
    except Exception:  # noqa: BLE001
        return 0


def _link_counts(conn, tasks):
    counts = {task.id: {"parents": 0, "children": 0} for task in tasks}
    try:
        rows = conn.execute("SELECT parent_id, child_id FROM task_links").fetchall()
    except Exception:  # noqa: BLE001
        return counts
    for row in rows:
        counts.setdefault(row["parent_id"], {"parents": 0, "children": 0})["children"] += 1
        counts.setdefault(row["child_id"], {"parents": 0, "children": 0})["parents"] += 1
    return counts


def _comment_counts(conn):
    try:
        rows = conn.execute("SELECT task_id, COUNT(*) AS n FROM task_comments GROUP BY task_id").fetchall()
    except Exception:  # noqa: BLE001
        return {}
    return {row["task_id"]: int(row["n"] or 0) for row in rows}


def _validate_status(status: str) -> str:
    value = str(status or "").strip().lower()
    if value not in set(BOARD_COLUMNS) | {"archived"}:
        raise InvalidParams(f"invalid status: {value}")
    return value


def _set_status_direct(conn, task_id: str, new_status: str) -> bool:
    kb = _kb()
    with kb.write_txn(conn):
        prev = conn.execute("SELECT status, current_run_id FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if prev is None:
            return False
        was_running = prev["status"] == "running"
        cur = conn.execute(
            "UPDATE tasks SET status = ?, "
            "  claim_lock = CASE WHEN ? = 'running' THEN claim_lock ELSE NULL END, "
            "  claim_expires = CASE WHEN ? = 'running' THEN claim_expires ELSE NULL END, "
            "  worker_pid = CASE WHEN ? = 'running' THEN worker_pid ELSE NULL END "
            "WHERE id = ?",
            (new_status, new_status, new_status, new_status, task_id),
        )
        if cur.rowcount != 1:
            return False
        run_id = None
        if was_running and new_status != "running" and prev["current_run_id"]:
            try:
                run_id = kb._end_run(conn, task_id, outcome="reclaimed", status="reclaimed", summary=f"status changed to {new_status} (webui/direct)")
            except Exception:  # noqa: BLE001
                run_id = None
        conn.execute(
            "INSERT INTO task_events (task_id, run_id, kind, payload, created_at) VALUES (?, ?, 'status', ?, ?)",
            (task_id, run_id, json.dumps({"status": new_status, "source": "webui"}), int(time.time())),
        )
    if new_status in ("done", "ready") and hasattr(kb, "recompute_ready"):
        try:
            kb.recompute_ready(conn)
        except Exception:  # noqa: BLE001
            pass
    return True


def _patch_task(conn, task_id: str, body: dict) -> None:
    kb = _kb()
    task = kb.get_task(conn, task_id)
    if not task:
        raise NotFound("task not found")
    updates: dict[str, Any] = {}
    if "title" in body:
        title = str(body.get("title") or "").strip()
        if not title:
            raise InvalidParams("title is required")
        updates["title"] = title
    if "body" in body:
        updates["body"] = body.get("body") or None
    if "tenant" in body:
        updates["tenant"] = body.get("tenant") or None
    if "priority" in body:
        try:
            updates["priority"] = int(body.get("priority") or 0)
        except (TypeError, ValueError):
            raise InvalidParams("priority must be an integer")
    for field, value in updates.items():
        if hasattr(task, field):
            try:
                setattr(task, field, value)
            except Exception:  # noqa: BLE001
                pass
    if updates:
        assignments = ", ".join(f"{field} = ?" for field in updates)
        conn.execute(f"UPDATE tasks SET {assignments} WHERE id = ?", [*updates.values(), task_id])
        if hasattr(kb, "_append_event"):
            kb._append_event(conn, task_id, "updated", {"fields": list(updates), "source": "webui"})
    if "assignee" in body and not kb.assign_task(conn, task_id, body.get("assignee") or None):
        raise NotFound("task not found")
    if "status" not in body or body.get("status") in (None, ""):
        return
    status = _validate_status(body.get("status"))
    if status == "done":
        if not kb.complete_task(conn, task_id, result=body.get("result"), summary=body.get("summary")):
            raise NotFound("task not found")
    elif status == "blocked":
        if not kb.block_task(conn, task_id, reason=body.get("block_reason") or body.get("reason")):
            raise NotFound("task not found")
    elif status == "archived":
        if not kb.archive_task(conn, task_id):
            raise NotFound("task not found")
    elif status == "running":
        raise InvalidParams("Cannot set status to 'running' directly; use the dispatcher/claim path")
    elif status == "ready":
        current = kb.get_task(conn, task_id)
        if not current:
            raise NotFound("task not found")
        if current.status == "blocked":
            if not kb.unblock_task(conn, task_id):
                raise NotFound("task not found")
        elif not _set_status_direct(conn, task_id, "ready"):
            raise NotFound("task not found")
    elif status in ("triage", "todo"):
        if not _set_status_direct(conn, task_id, status):
            raise NotFound("task not found")


def _board_meta(meta):
    if not isinstance(meta, dict):
        return meta
    out = dict(meta)
    for key in ("directory", "db_path", "path"):
        if out.get(key) is not None:
            out[key] = str(out[key])
    return out


def _board_counts(slug):
    kb = _kb()
    if not kb.board_exists(slug):
        return {}
    try:
        conn = _connect_module().connect(board=slug)
    except Exception:  # noqa: BLE001
        return {}
    try:
        rows = conn.execute("SELECT status, COUNT(*) AS n FROM tasks WHERE status != 'archived' GROUP BY status").fetchall()
        return {row["status"]: int(row["n"] or 0) for row in rows}
    except Exception:  # noqa: BLE001
        return {}
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


def _normalize_existing_slug(slug) -> str:
    kb = _kb()
    try:
        normed = kb._normalize_board_slug(slug)
    except (ValueError, AttributeError) as exc:
        raise InvalidParams(f"invalid board slug: {slug!r}") from exc
    if not normed or not kb.board_exists(normed):
        raise NotFound(f"board {slug!r} does not exist")
    return normed


def _current_board() -> str:
    try:
        return _kb().get_current_board()
    except Exception:  # noqa: BLE001
        return "default"


def _str(params: dict, key: str) -> str | None:
    raw = params.get(key)
    if raw is None:
        return None
    text = str(raw).strip()
    return text or None


def _int(params: dict, key: str, default=None, *, minimum=None, maximum=None):
    raw = params.get(key)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    if minimum is not None:
        value = max(minimum, value)
    if maximum is not None:
        value = min(maximum, value)
    return value


def _bool(params: dict, key: str, default: bool = False) -> bool:
    raw = params.get(key)
    if raw is None:
        return default
    if isinstance(raw, bool):
        return raw
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


# ── payload builders ──────────────────────────────────────────────────────

def board_payload(params: dict) -> dict:
    board = _board(params)
    kb = _kb()
    tenant, assignee = _str(params, "tenant"), _str(params, "assignee")
    include_archived, only_mine = _bool(params, "include_archived"), _bool(params, "only_mine")
    since = _int(params, "since", None, minimum=0)
    profile = None
    if only_mine and not assignee:
        profile = _str(params, "profile") or "default"
        assignee = profile
    with _conn(board=board) as conn:
        latest = _latest_event_id(conn)
        if since is not None and since >= latest:
            return {"changed": False, "latest_event_id": latest, "read_only": False}
        tasks = kb.list_tasks(conn, tenant=tenant, assignee=assignee, include_archived=include_archived)
        link_counts, comment_counts = _link_counts(conn, tasks), _comment_counts(conn)

        def row(task):
            data = _task_dict(task, conn)
            data["link_counts"] = link_counts.get(task.id, {"parents": 0, "children": 0})
            data["comment_count"] = comment_counts.get(task.id, 0)
            return data

        columns = [{"name": name, "tasks": [row(t) for t in tasks if t.status == name]} for name in BOARD_COLUMNS]
        if include_archived:
            columns.append({"name": "archived", "tasks": [row(t) for t in tasks if t.status == "archived"]})
        return {
            "columns": columns,
            "tenants": sorted({t.tenant for t in tasks if getattr(t, "tenant", None)}),
            "assignees": sorted({t.assignee for t in tasks if getattr(t, "assignee", None)}),
            "latest_event_id": latest,
            "changed": True,
            "read_only": False,
            "filters": {"tenant": tenant, "assignee": assignee, "include_archived": include_archived, "only_mine": only_mine, "profile": profile},
        }


def create_task_payload(params: dict) -> dict:
    body = params.get("task") or {}
    title = str(body.get("title") or "").strip()
    if not title:
        raise InvalidParams("title is required")
    try:
        priority = int(body.get("priority") or 0)
    except (TypeError, ValueError):
        raise InvalidParams("priority must be an integer")
    kb = _kb()
    with _conn(board=_board(params)) as conn:
        task_id = kb.create_task(
            conn, title=title, body=body.get("body") or None, assignee=body.get("assignee") or None, created_by=body.get("created_by") or "webui",
            tenant=body.get("tenant") or None, priority=priority, parents=body.get("parents") or (), triage=bool(body.get("triage") or False),
            workspace_kind=body.get("workspace_kind") or "scratch", workspace_path=body.get("workspace_path") or None,
            idempotency_key=body.get("idempotency_key") or None, max_runtime_seconds=body.get("max_runtime_seconds") or None, skills=body.get("skills") or None,
        )
        if body.get("status"):
            _patch_task(conn, task_id, {"status": body.get("status")})
        return {"task": _task_dict(kb.get_task(conn, task_id), conn), "read_only": False}


def patch_task_payload(params: dict) -> dict:
    task_id = str(params.get("task_id") or "").strip()
    if not task_id:
        raise InvalidParams("task_id is required")
    kb = _kb()
    with _conn(board=_board(params)) as conn:
        _patch_task(conn, task_id, params.get("patch") or {})
        return {"task": _task_dict(kb.get_task(conn, task_id), conn), "read_only": False}


def comment_payload(params: dict) -> dict:
    task_id = str(params.get("task_id") or "").strip()
    body = str(params.get("body") or "").strip()
    if not task_id:
        raise InvalidParams("task_id is required")
    if not body:
        raise InvalidParams("body is required")
    kb = _kb()
    with _conn(board=_board(params)) as conn:
        if not kb.get_task(conn, task_id):
            raise NotFound("task not found")
        comment_id = kb.add_comment(conn, task_id, params.get("author") or "webui", body)
        return {"ok": True, "comment_id": comment_id, "read_only": False}


def link_payload(params: dict, *, unlink: bool) -> dict:
    parent_id, child_id = str(params.get("parent_id") or "").strip(), str(params.get("child_id") or "").strip()
    if not parent_id or not child_id:
        raise InvalidParams("parent_id and child_id are required")
    kb = _kb()
    with _conn(board=_board(params)) as conn:
        if not kb.get_task(conn, parent_id):
            raise NotFound("parent task not found")
        if not kb.get_task(conn, child_id):
            raise NotFound("child task not found")
        if unlink:
            changed = kb.unlink_tasks(conn, parent_id, child_id)
            return {"ok": True, "changed": bool(changed), "parent_id": parent_id, "child_id": child_id, "read_only": False}
        kb.link_tasks(conn, parent_id, child_id)
        return {"ok": True, "parent_id": parent_id, "child_id": child_id, "read_only": False}


def task_detail_payload(params: dict) -> dict:
    task_id = str(params.get("task_id") or "").strip()
    kb = _kb()
    with _conn(board=_board(params)) as conn:
        task = kb.get_task(conn, task_id)
        if not task:
            raise NotFound("task not found")
        return {
            "task": _task_dict(task, conn),
            "comments": [_obj_dict(c) for c in kb.list_comments(conn, task_id)],
            "events": [_obj_dict(e) for e in kb.list_events(conn, task_id)],
            "links": {"parents": kb.parent_ids(conn, task_id), "children": kb.child_ids(conn, task_id)},
            "runs": [_obj_dict(r) for r in kb.list_runs(conn, task_id)],
            "read_only": False,
        }


def events_payload(params: dict) -> dict:
    since = _int(params, "since", 0, minimum=0)
    limit = _int(params, "limit", 200, minimum=1, maximum=200)
    with _conn(board=_board(params)) as conn:
        rows = conn.execute(
            "SELECT id, task_id, run_id, kind, payload, created_at FROM task_events WHERE id > ? ORDER BY id ASC LIMIT ?", (since, limit)
        ).fetchall()
        events, cursor = [], since
        for row in rows:
            try:
                payload = json.loads(row["payload"]) if row["payload"] else None
            except Exception:  # noqa: BLE001
                payload = None
            events.append({"id": row["id"], "task_id": row["task_id"], "run_id": row["run_id"], "kind": row["kind"], "payload": payload, "created_at": row["created_at"]})
            cursor = int(row["id"])
        latest = _latest_event_id(conn)
        if not events:
            cursor = latest if since >= latest else since
        return {"events": events, "cursor": cursor, "latest_event_id": cursor, "read_only": False}


def config_payload(params: dict) -> dict:
    kb = _kb()
    try:
        with _conn(board=_board(params)) as conn:
            try:
                assignees = list(kb.known_assignees(conn))
            except Exception:  # noqa: BLE001
                assignees = []
    except Exception:  # noqa: BLE001
        assignees = []
    try:
        from hermes_cli.config import load_config

        cfg = load_config() or {}
    except Exception:  # noqa: BLE001
        cfg = {}
    k = ((cfg.get("dashboard") or {}).get("kanban") or {})
    return {
        "columns": BOARD_COLUMNS, "assignees": assignees, "default_tenant": k.get("default_tenant") or "",
        "lane_by_profile": bool(k.get("lane_by_profile", True)), "include_archived_by_default": bool(k.get("include_archived_by_default", False)),
        "render_markdown": bool(k.get("render_markdown", True)), "read_only": False,
    }


def stats_payload(params: dict) -> dict:
    kb = _kb()
    with _conn(board=_board(params)) as conn:
        if hasattr(kb, "board_stats"):
            return kb.board_stats(conn)
        rows = conn.execute("SELECT status, assignee, COUNT(*) AS n FROM tasks WHERE status != 'archived' GROUP BY status, assignee").fetchall()
        by_status: dict[str, int] = {}
        by_assignee: dict[str, int] = {}
        for row in rows:
            n = int(row["n"] or 0)
            by_status[row["status"]] = by_status.get(row["status"], 0) + n
            assignee = row["assignee"] or "unassigned"
            by_assignee[assignee] = by_assignee.get(assignee, 0) + n
        return {"by_status": by_status, "by_assignee": by_assignee}


def assignees_payload(params: dict) -> dict:
    kb = _kb()
    with _conn(board=_board(params)) as conn:
        try:
            assignees = list(kb.known_assignees(conn))
        except Exception:  # noqa: BLE001
            rows = conn.execute("SELECT DISTINCT assignee FROM tasks WHERE assignee IS NOT NULL AND assignee != '' ORDER BY assignee").fetchall()
            assignees = [row["assignee"] for row in rows]
    return {"assignees": assignees}


def task_log_payload(params: dict) -> dict:
    task_id = str(params.get("task_id") or "").strip()
    kb = _kb()
    tail = _int(params, "tail", None, minimum=1, maximum=2_000_000)
    with _conn(board=_board(params)) as conn:
        if not kb.get_task(conn, task_id):
            raise NotFound("task not found")
    if not hasattr(kb, "read_worker_log"):
        return {"task_id": task_id, "path": "", "exists": False, "size_bytes": 0, "content": "", "truncated": False}
    content = kb.read_worker_log(task_id, tail_bytes=tail)
    log_path = kb.worker_log_path(task_id) if hasattr(kb, "worker_log_path") else None
    try:
        size = log_path.stat().st_size if log_path and log_path.exists() else 0
    except OSError:
        size = 0
    return {"task_id": task_id, "path": str(log_path or ""), "exists": content is not None, "size_bytes": size, "content": content or "", "truncated": bool(tail and size > tail)}


def bulk_payload(params: dict) -> dict:
    body = params.get("bulk") or {}
    ids = [str(i).strip() for i in (body.get("ids") or []) if str(i).strip()]
    if not ids:
        raise InvalidParams("ids is required")
    kb = _kb()
    results = []
    with _conn(board=_board(params)) as conn:
        for task_id in ids:
            entry: dict[str, Any] = {"id": task_id, "ok": True}
            try:
                if not kb.get_task(conn, task_id):
                    entry.update(ok=False, error="not found")
                    results.append(entry)
                    continue
                if body.get("archive"):
                    if not kb.archive_task(conn, task_id):
                        entry.update(ok=False, error="archive refused")
                elif body.get("status") is not None:
                    _patch_task(conn, task_id, {"status": body.get("status")})
                if body.get("assignee") is not None and not kb.assign_task(conn, task_id, body.get("assignee") or None):
                    entry.update(ok=False, error="assign refused")
                if body.get("priority") is not None:
                    try:
                        priority = int(body.get("priority"))
                    except (TypeError, ValueError):
                        entry.update(ok=False, error="priority must be an integer")
                    else:
                        conn.execute("UPDATE tasks SET priority = ? WHERE id = ?", (priority, task_id))
                        if hasattr(kb, "_append_event"):
                            kb._append_event(conn, task_id, "reprioritized", {"priority": priority, "source": "webui"})
            except Exception as exc:  # noqa: BLE001 - per-row outcome
                entry.update(ok=False, error=str(exc))
            results.append(entry)
    return {"results": results, "read_only": False}


def dispatch_payload(params: dict) -> dict:
    kb = _kb()
    if not hasattr(kb, "dispatch_once"):
        raise InvalidParams("dispatcher is unavailable")
    with _conn(board=_board(params)) as conn:
        result = kb.dispatch_once(conn, dry_run=_bool(params, "dry_run"), max_spawn=_int(params, "max", 8, minimum=1, maximum=100))
    if isinstance(result, dict):
        return result
    try:
        return asdict(result)
    except TypeError:
        return {"result": str(result)}


def task_action_payload(params: dict) -> dict:
    kb = _kb()
    task_id = str(params.get("task_id") or "").strip()
    action = str(params.get("action") or "")
    if not task_id:
        raise InvalidParams("task_id is required")
    with _conn(board=_board(params)) as conn:
        if not kb.get_task(conn, task_id):
            raise NotFound("task not found")
        if action == "block":
            ok = kb.block_task(conn, task_id, reason=params.get("reason"))
        elif action == "unblock":
            if hasattr(kb, "unblock_task"):
                ok = kb.unblock_task(conn, task_id)
            else:
                _patch_task(conn, task_id, {"status": "ready"})
                ok = True
        else:
            raise InvalidParams(f"invalid action: {action}")
        if not ok:
            raise Conflict(f"{action} refused")
        return {"task": _task_dict(kb.get_task(conn, task_id), conn), "read_only": False}


def list_boards_payload(params: dict) -> dict:
    kb = _kb()
    boards = kb.list_boards(include_archived=_bool(params, "include_archived"))
    current = _current_board()
    visible = {(_board_meta(m).get("slug")) for m in boards}
    if current not in visible:
        try:
            kb.clear_current_board()
        except Exception:  # noqa: BLE001
            pass
        current = getattr(kb, "DEFAULT_BOARD", "default")
    out = []
    for raw in boards:
        meta = _board_meta(raw)
        slug = meta.get("slug")
        if slug is None:
            continue
        meta["is_current"] = slug == current
        meta["counts"] = _board_counts(slug)
        meta["total"] = sum(meta["counts"].values()) if meta["counts"] else 0
        out.append(meta)
    return {"boards": out, "current": current, "read_only": False}


def create_board_payload(params: dict) -> dict:
    kb = _kb()
    body = params.get("board_spec") or {}
    slug = str(body.get("slug") or "").strip()
    if not slug:
        raise InvalidParams("slug is required")
    kwargs = {}
    if "default_workdir" in body:
        kwargs["default_workdir"] = str(body.get("default_workdir") or "")
    try:
        meta = kb.create_board(slug, name=body.get("name") or None, description=body.get("description") or None, icon=body.get("icon") or None, color=body.get("color") or None, **kwargs)
    except (ValueError, AttributeError) as exc:
        raise InvalidParams(str(exc)) from exc
    if body.get("switch"):
        try:
            kb.set_current_board(meta["slug"])
        except (ValueError, AttributeError) as exc:
            raise InvalidParams(str(exc)) from exc
    return {"board": _board_meta(meta), "current": _current_board(), "read_only": False}


def update_board_payload(params: dict) -> dict:
    kb = _kb()
    body = params.get("board_spec") or {}
    normed = _normalize_existing_slug(params.get("slug"))
    kwargs = {}
    if "default_workdir" in body:
        kwargs["default_workdir"] = str(body.get("default_workdir") or "")
    archived = body.get("archived")
    if isinstance(archived, str):
        archived = archived.strip().lower() in {"1", "true", "yes", "on"}
    meta = kb.write_board_metadata(normed, name=body.get("name"), description=body.get("description"), icon=body.get("icon"), color=body.get("color"),
                                   archived=archived if isinstance(archived, bool) else None, **kwargs)
    return {"board": _board_meta(meta), "read_only": False}


def delete_board_payload(params: dict) -> dict:
    kb = _kb()
    normed = _normalize_existing_slug(params.get("slug"))
    if normed == getattr(kb, "DEFAULT_BOARD", "default"):
        raise InvalidParams("cannot remove the default board")
    res = kb.remove_board(normed, archive=not _bool(params, "delete"))
    return {"result": _board_meta(res) if isinstance(res, dict) else res, "current": _current_board(), "read_only": False}


def switch_board_payload(params: dict) -> dict:
    normed = _normalize_existing_slug(params.get("slug"))
    _kb().set_current_board(normed)
    return {"current": normed, "read_only": False}


def poll_events(params: dict) -> dict:
    """One SSE poll pass: events after ``since`` (the server owns the loop and heartbeat)."""
    return events_payload(params)


def normalize_board_payload(params: dict) -> dict:
    """The slug a ``board`` query resolves to (predecessor ``_resolve_board``), for the events stream's ``hello``."""
    resolved = _board(params)
    return {"board": resolved if resolved is not None else str(params.get("board") or "")}


METHODS = {
    "kanban.normalize_board": normalize_board_payload,
    "kanban.board": board_payload,
    "kanban.boards": list_boards_payload,
    "kanban.create_board": create_board_payload,
    "kanban.update_board": update_board_payload,
    "kanban.delete_board": delete_board_payload,
    "kanban.switch_board": switch_board_payload,
    "kanban.task": task_detail_payload,
    "kanban.create_task": create_task_payload,
    "kanban.patch_task": patch_task_payload,
    "kanban.task_action": task_action_payload,
    "kanban.comment": comment_payload,
    "kanban.link": lambda p: link_payload(p, unlink=False),
    "kanban.unlink": lambda p: link_payload(p, unlink=True),
    "kanban.events": events_payload,
    "kanban.config": config_payload,
    "kanban.stats": stats_payload,
    "kanban.assignees": assignees_payload,
    "kanban.task_log": task_log_payload,
    "kanban.bulk": bulk_payload,
    "kanban.dispatch": dispatch_payload,
}


def register(registry) -> None:
    for name, func in METHODS.items():
        def handler(ctx: CallContext, params: dict, _func=func):
            # Predecessor ``handle_kanban_*`` mapping of the store's exceptions: LookupError → 404, ValueError → 400,
            # RuntimeError → 409; anything else stays an internal error (Python's opaque 500).
            with scoped_home(profile_home_param(params)):
                try:
                    return _func(params)
                except RpcError:
                    raise
                except LookupError as exc:
                    raise RpcError(str(exc), condition="not_found") from exc
                except ValueError as exc:
                    raise InvalidParams(str(exc)) from exc
                except RuntimeError as exc:
                    raise RpcError(str(exc), condition="refused") from exc

        registry.method(name)(handler)
