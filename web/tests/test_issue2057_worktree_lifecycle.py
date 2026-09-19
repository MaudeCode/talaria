import os
import sqlite3
import time
from pathlib import Path
from types import SimpleNamespace

import api.models as models
import api.routes as routes
from api.models import SESSIONS, Session


def _capture_post(monkeypatch, body):
    captured = {}
    monkeypatch.setattr(routes, "_check_csrf", lambda handler: True)
    monkeypatch.setattr(routes, "read_body", lambda handler: body)
    monkeypatch.setattr(
        routes,
        "j",
        lambda handler, payload, status=200, extra_headers=None: captured.update(
            payload=payload,
            status=status,
        )
        or True,
    )
    return captured


def _isolate_session_store(tmp_path, monkeypatch):
    session_dir = tmp_path / "sessions"
    session_dir.mkdir()
    monkeypatch.setattr(models, "SESSION_DIR", session_dir)
    monkeypatch.setattr(models, "SESSION_INDEX_FILE", session_dir / "_index.json")
    monkeypatch.setattr(routes, "SESSION_DIR", session_dir)
    monkeypatch.setattr(routes, "SESSION_INDEX_FILE", session_dir / "_index.json")
    SESSIONS.clear()
    return session_dir


def _worktree_session(tmp_path, session_id):
    repo = tmp_path / "repo"
    worktree = repo / ".worktrees" / f"hermes-{session_id}"
    worktree.mkdir(parents=True)
    s = Session(
        session_id=session_id,
        title="Worktree session",
        workspace=str(worktree),
        worktree_path=str(worktree),
        worktree_branch=f"hermes/{session_id}",
        worktree_repo_root=str(repo),
    )
    s.save()
    return s, worktree


def _make_state_db(path, sid, *, source="telegram"):
    conn = sqlite3.connect(str(path))
    conn.executescript(
        """
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            source TEXT,
            model TEXT,
            message_count INTEGER DEFAULT 0,
            started_at REAL,
            title TEXT,
            cwd TEXT
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            role TEXT,
            content TEXT,
            timestamp REAL
        );
        """
    )
    conn.execute(
        "INSERT INTO sessions (id, source, model, message_count, started_at, title, cwd) "
        "VALUES (?, ?, 'MiniMax-M3', 2, 1781024055.0, 'Telegram chat', ?)",
        (sid, source, str(path.parent)),
    )
    conn.execute(
        "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'user', 'hi', 1781024055.0)",
        (sid,),
    )
    conn.execute(
        "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'assistant', 'hello', 1781024056.0)",
        (sid,),
    )
    conn.commit()
    conn.close()


def test_delete_worktree_session_reports_retained_worktree_without_cleanup(tmp_path, monkeypatch):
    session_dir = _isolate_session_store(tmp_path, monkeypatch)
    session, worktree = _worktree_session(tmp_path, "wtdelete1")
    captured = _capture_post(monkeypatch, {"session_id": session.session_id})
    monkeypatch.setattr(routes, "_lookup_cli_session_metadata", lambda sid: {})
    monkeypatch.setattr(routes, "_is_messaging_session_id", lambda sid: False)
    monkeypatch.setattr(models, "delete_cli_session", lambda sid: True)

    assert routes.handle_post(object(), SimpleNamespace(path="/api/session/delete")) is True

    assert captured["status"] == 200
    assert captured["payload"]["ok"] is True
    assert captured["payload"]["state_db_cleanup_failed"] is False
    assert captured["payload"]["worktree_retained"] is True
    assert captured["payload"]["worktree_path"] == str(worktree.resolve())
    assert captured["payload"]["worktree_branch"] == "hermes/wtdelete1"
    assert not (session_dir / "wtdelete1.json").exists()
    assert worktree.exists(), "session delete must not remove the git worktree directory"


def test_delete_refuses_live_worker_before_mutating_sidecar_or_index(tmp_path, monkeypatch):
    from api import config

    session_dir = _isolate_session_store(tmp_path, monkeypatch)
    sid = "activedelete1"
    session = Session(
        session_id=sid,
        title="Active delete",
        messages=[{"role": "user", "content": "still running"}],
    )
    session.save()
    captured = _capture_post(monkeypatch, {"session_id": sid})
    monkeypatch.setattr(
        routes,
        "bad",
        lambda handler, message, status=400: captured.update(
            payload={"error": message}, status=status
        )
        or True,
    )
    monkeypatch.setattr(routes, "_lookup_cli_session_metadata", lambda value: {})
    monkeypatch.setattr(routes, "_is_messaging_session_id", lambda value: False)
    config.register_active_run(
        "active-delete-stream",
        session_id=sid,
        started_at=1.0,
        phase="cancelling",
        cancelled_at=time.time(),
    )
    try:
        assert routes.handle_post(object(), SimpleNamespace(path="/api/session/delete")) is True
    finally:
        config.unregister_active_run("active-delete-stream")

    assert captured["status"] == 409
    assert "active run" in captured["payload"]["error"].lower()
    assert (session_dir / f"{sid}.json").exists()
    assert sid in (session_dir / "_index.json").read_text(encoding="utf-8")

    # Once the paused worker has definitively exited (unregistered above), the
    # same request can delete. No stale worker remains that can save afterward.
    captured.clear()
    assert routes.handle_post(object(), SimpleNamespace(path="/api/session/delete")) is True
    assert captured["status"] == 200
    assert not (session_dir / f"{sid}.json").exists()
    assert sid not in (session_dir / "_index.json").read_text(encoding="utf-8")


def test_delete_rechecks_worker_ownership_after_waiting_for_session_lock(tmp_path, monkeypatch):
    from api import config

    session_dir = _isolate_session_store(tmp_path, monkeypatch)
    sid = "delete-lock-race"
    Session(
        session_id=sid,
        title="Delete lock race",
        messages=[{"role": "user", "content": "claimed concurrently"}],
    ).save()
    captured = _capture_post(monkeypatch, {"session_id": sid})
    monkeypatch.setattr(
        routes,
        "bad",
        lambda handler, message, status=400: captured.update(
            payload={"error": message}, status=status
        )
        or True,
    )
    monkeypatch.setattr(routes, "_lookup_cli_session_metadata", lambda value: {})
    monkeypatch.setattr(routes, "_is_messaging_session_id", lambda value: False)

    class ClaimingLock:
        def acquire(self, timeout=None):
            config.register_active_run(
                "delete-lock-race-stream",
                session_id=sid,
                phase="running",
            )
            return True

        def release(self):
            return None

    monkeypatch.setattr(routes, "_get_session_agent_lock", lambda value: ClaimingLock())
    try:
        assert routes.handle_post(object(), SimpleNamespace(path="/api/session/delete")) is True
    finally:
        config.unregister_active_run("delete-lock-race-stream")

    assert captured["status"] == 409
    assert (session_dir / f"{sid}.json").exists()
    assert sid in (session_dir / "_index.json").read_text(encoding="utf-8")


def test_delete_sidecar_unlink_failure_is_non_destructive_and_non_success(
    tmp_path, monkeypatch
):
    from api import background_process, config, run_journal, session_drafts, terminal, turn_journal, upload

    session_dir = _isolate_session_store(tmp_path, monkeypatch)
    sid = "unlinkfaildelete1"
    session = Session(
        session_id=sid,
        title="Unlink failure",
        messages=[{"role": "user", "content": "must remain recoverable"}],
    )
    session.save()
    sidecar = session_dir / f"{sid}.json"
    backup = session_dir / f"{sid}.json.bak"
    backup.write_text("backup must remain", encoding="utf-8")
    turn_journal.append_turn_journal_event(
        sid,
        {"event": "submitted", "stream_id": "unlink-stream", "content": "keep"},
        session_dir=session_dir,
    )
    run_writer = run_journal.RunJournalWriter(
        sid, "unlink-stream", session_dir=session_dir
    )
    run_writer.append_sse_event("token", {"text": "keep"})
    run_writer.close()
    turn_path = session_dir / "_turn_journal" / f"{sid}~{os.getpid()}.jsonl"
    run_path = session_dir / "_run_journal" / sid / "unlink-stream.jsonl"
    attachment_dir = tmp_path / "attachments" / sid
    attachment_dir.mkdir(parents=True)
    (attachment_dir / "keep.txt").write_text("keep", encoding="utf-8")

    captured = _capture_post(monkeypatch, {"session_id": sid})
    monkeypatch.setattr(
        routes,
        "bad",
        lambda handler, message, status=400: captured.update(
            payload={"error": message}, status=status
        )
        or True,
    )
    monkeypatch.setattr(routes, "_lookup_cli_session_metadata", lambda value: {})
    monkeypatch.setattr(routes, "_is_messaging_session_id", lambda value: False)
    cleanup_calls = []
    monkeypatch.setattr(
        routes,
        "prune_session_from_index",
        lambda value: cleanup_calls.append(("index", value)),
    )
    monkeypatch.setattr(
        routes,
        "_record_webui_deleted_session_tombstone",
        lambda value: cleanup_calls.append(("tombstone", value)),
    )
    monkeypatch.setattr(
        routes,
        "_publish_session_list_changed",
        lambda *args, **kwargs: cleanup_calls.append(("publish", sid)),
    )
    monkeypatch.setattr(
        config,
        "_evict_session_agent",
        lambda value: cleanup_calls.append(("agent", value)),
    )
    monkeypatch.setattr(
        models,
        "delete_cli_session",
        lambda value: cleanup_calls.append(("state-db", value)) or True,
    )
    monkeypatch.setattr(
        session_drafts,
        "delete_session_draft",
        lambda value: cleanup_calls.append(("draft", value)),
    )
    monkeypatch.setattr(
        turn_journal,
        "delete_turn_journal",
        lambda value: cleanup_calls.append(("turn-journal", value)),
    )
    monkeypatch.setattr(
        run_journal,
        "delete_run_journal",
        lambda value: cleanup_calls.append(("run-journal", value)),
    )
    monkeypatch.setattr(
        background_process,
        "forget_bg_task_completion_dedup",
        lambda value: cleanup_calls.append(("background", value)),
    )
    monkeypatch.setattr(
        terminal,
        "close_terminal",
        lambda value: cleanup_calls.append(("terminal", value)),
    )
    monkeypatch.setattr(upload, "_session_attachment_dir", lambda value: attachment_dir)

    real_unlink = Path.unlink

    def fail_sidecar_unlink(path, *args, **kwargs):
        if path == sidecar:
            raise PermissionError("sidecar locked")
        return real_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail_sidecar_unlink)

    assert routes.handle_post(object(), SimpleNamespace(path="/api/session/delete")) is True

    assert captured["status"] == 500
    assert captured["payload"] == {"error": "Failed to delete session data"}
    assert cleanup_calls == []
    assert sidecar.exists()
    assert backup.exists()
    assert turn_path.exists()
    assert run_path.exists()
    assert attachment_dir.exists()
    assert sid in SESSIONS
    assert sid in (session_dir / "_index.json").read_text(encoding="utf-8")


def test_delete_session_records_tombstone_when_state_db_delete_fails(tmp_path, monkeypatch):
    session_dir = _isolate_session_store(tmp_path, monkeypatch)
    sid = "dbfaildelete1"
    session = Session(
        session_id=sid,
        title="Delete failure",
        messages=[{"role": "user", "content": "keep deleted"}],
    )
    session.save()
    (session_dir / f"{sid}.json.bak").write_text("backup", encoding="utf-8")
    captured = _capture_post(monkeypatch, {"session_id": sid})
    monkeypatch.setattr(routes, "_lookup_cli_session_metadata", lambda value: {})
    monkeypatch.setattr(routes, "_is_messaging_session_id", lambda value: False)

    def fail_delete(value):
        raise RuntimeError("state.db locked")

    real_unlink = Path.unlink

    def fail_backup_unlink(path, *args, **kwargs):
        if path.name == f"{sid}.json.bak":
            raise PermissionError("backup locked")
        return real_unlink(path, *args, **kwargs)

    monkeypatch.setattr(models, "delete_cli_session", fail_delete)
    monkeypatch.setattr(Path, "unlink", fail_backup_unlink)

    assert routes.handle_post(object(), SimpleNamespace(path="/api/session/delete")) is True

    assert captured["status"] == 200
    assert captured["payload"]["ok"] is True
    assert captured["payload"]["state_db_cleanup_failed"] is True
    assert not (session_dir / f"{sid}.json").exists()
    assert sid in models._load_webui_deleted_session_tombstone()


def test_delete_messaging_session_reopens_read_only_without_deleted_webui_tombstone(
    tmp_path, monkeypatch
):
    session_dir = _isolate_session_store(tmp_path, monkeypatch)
    sid = "telegramdelete1"
    state_db = tmp_path / "state.db"
    _make_state_db(state_db, sid)
    monkeypatch.setattr(models, "_active_state_db_path", lambda: state_db)
    session = Session(session_id=sid, title="Telegram chat")
    session.save()
    captured = _capture_post(monkeypatch, {"session_id": sid})
    cli_meta = {
        "session_id": sid,
        "source_tag": "telegram",
        "raw_source": "telegram",
        "session_source": "messaging",
    }
    monkeypatch.setattr(routes, "_lookup_cli_session_metadata", lambda value: cli_meta)
    monkeypatch.setattr(routes, "_is_messaging_session_id", lambda value: True)
    delete_calls = []
    monkeypatch.setattr(models, "delete_cli_session", lambda value: delete_calls.append(value))

    assert routes.handle_post(object(), SimpleNamespace(path="/api/session/delete")) is True
    sess, reason = routes._claim_or_synthesize_cli_session(sid)

    assert captured["status"] == 200
    assert captured["payload"]["ok"] is True
    assert captured["payload"]["state_db_cleanup_failed"] is False
    assert not (session_dir / f"{sid}.json").exists()
    assert sid not in models._load_webui_deleted_session_tombstone()
    assert delete_calls == []
    assert reason == "not_claimable"
    assert sess is not None
    assert sess.read_only is True
    assert sess.session_source == "messaging"


def test_archive_worktree_session_reports_retained_worktree_without_cleanup(tmp_path, monkeypatch):
    _isolate_session_store(tmp_path, monkeypatch)
    session, worktree = _worktree_session(tmp_path, "wtarchive1")
    captured = _capture_post(
        monkeypatch,
        {"session_id": session.session_id, "archived": True},
    )

    assert routes.handle_post(object(), SimpleNamespace(path="/api/session/archive")) is True

    assert captured["status"] == 200
    assert captured["payload"]["ok"] is True
    assert captured["payload"]["session"]["archived"] is True
    assert captured["payload"]["worktree_retained"] is True
    assert captured["payload"]["worktree_path"] == str(worktree.resolve())
    assert worktree.exists(), "session archive must not remove the git worktree directory"
    assert Session.load("wtarchive1").archived is True
