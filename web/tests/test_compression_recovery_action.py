import io
import json
import threading
import time
from pathlib import Path

from api import models, routes
from api.compression_recovery import (
    compression_recovery_payload_for_session,
    is_generic_continuation_intent,
    stamp_compression_exhausted_recovery,
)
from api.models import Session
from api.session_recovery import _state_db_row_to_sidecar
from api.webui_session_db import WebUIJsonSessionDB


ROOT = Path(__file__).resolve().parents[1]


class _JSONHandler:
    headers = {}

    def __init__(self):
        self.status = None
        self.wfile = io.BytesIO()
        self.headers_sent = {}

    def send_response(self, status):
        self.status = status

    def send_header(self, key, value):
        self.headers_sent[key] = value

    def end_headers(self):
        pass


def _payload(handler):
    raw = handler.wfile.getvalue().decode("utf-8")
    return json.loads(raw) if raw else {}


def _isolate_sessions(monkeypatch, tmp_path):
    session_dir = tmp_path / "sessions"
    session_dir.mkdir()
    monkeypatch.setattr(models, "SESSION_DIR", session_dir)
    monkeypatch.setattr(models, "SESSION_INDEX_FILE", session_dir / "_index.json")
    models.SESSIONS.clear()
    routes.SESSIONS.clear()
    return session_dir


def test_generic_continuation_intent_is_scoped_to_empty_continue_words():
    assert is_generic_continuation_intent("continue")
    assert is_generic_continuation_intent("继续吧。")
    assert is_generic_continuation_intent("go on")
    assert not is_generic_continuation_intent("continue by summarizing the workspace changes")
    assert not is_generic_continuation_intent("继续修复 4685 的恢复卡")


def test_chat_start_blocks_generic_continue_after_compression_exhausted(monkeypatch, tmp_path):
    _isolate_sessions(monkeypatch, tmp_path)
    sid = "recoverychat1"
    session = Session(
        session_id=sid,
        title="Recovery",
        workspace=str(tmp_path),
        model="gpt-4o",
        messages=[{"role": "user", "content": "long task"}],
    )
    stamp_compression_exhausted_recovery(session, message="Context length exceeded.")
    models.SESSIONS[sid] = session
    routes.SESSIONS[sid] = session

    handler = _JSONHandler()
    routes._handle_chat_start(handler, {"session_id": sid, "message": "继续"})
    payload = _payload(handler)

    assert handler.status == 409
    assert payload["type"] == "compression_recovery_required"
    assert payload["recommended_recovery_action"] == "start_focused_continuation"
    assert payload["compression_recovery"]["terminal_state"] == "compression_exhausted"


def test_chat_start_keeps_recovery_when_substantive_prompt_fails_validation(monkeypatch, tmp_path):
    session_dir = _isolate_sessions(monkeypatch, tmp_path)
    sid = "recoverychat2"
    session = Session(
        session_id=sid,
        title="Recovery",
        workspace=str(tmp_path),
        model="gpt-4o",
        messages=[{"role": "user", "content": "long task"}],
    )
    stamp_compression_exhausted_recovery(session, message="Context length exceeded.")
    session.save()
    models.SESSIONS[sid] = session
    routes.SESSIONS[sid] = session
    monkeypatch.setattr(
        routes,
        "_resolve_chat_workspace_with_recovery",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(ValueError("bad workspace")),
    )

    handler = _JSONHandler()
    routes._handle_chat_start(handler, {"session_id": sid, "message": "continue by checking the repo"})
    saved = json.loads((session_dir / f"{sid}.json").read_text(encoding="utf-8"))

    assert handler.status == 400
    assert saved["recommended_recovery_action"] == "start_focused_continuation"
    assert saved["compression_recovery"]["terminal_state"] == "compression_exhausted"


def test_chat_start_clears_recovery_when_substantive_prompt_starts(monkeypatch, tmp_path):
    session_dir = _isolate_sessions(monkeypatch, tmp_path)
    sid = "recoverychat3"
    session = Session(
        session_id=sid,
        title="Recovery",
        workspace=str(tmp_path),
        model="gpt-4o",
        messages=[{"role": "user", "content": "long task"}],
    )
    stamp_compression_exhausted_recovery(session, message="Context length exceeded.")
    session.save()
    models.SESSIONS[sid] = session
    routes.SESSIONS[sid] = session
    monkeypatch.setattr(routes, "_resolve_chat_workspace_with_recovery", lambda *_args, **_kwargs: str(tmp_path))
    monkeypatch.setattr(routes, "_read_profile_model_config", lambda *_args, **_kwargs: (None, None, {}))
    monkeypatch.setattr(
        routes,
        "_resolve_compatible_session_model_state",
        lambda requested_model, requested_provider, **_kwargs: (requested_model or "gpt-4o", requested_provider or "openai", False),
    )
    monkeypatch.setattr(routes, "webui_gateway_chat_enabled", lambda _config: False)

    def _fake_start_run(run_session, **_kwargs):
        assert compression_recovery_payload_for_session(run_session) is None
        run_session.save()
        return {"session_id": sid, "stream_id": "stream1", "_status": 200}

    monkeypatch.setattr(routes, "_start_run", _fake_start_run)

    handler = _JSONHandler()
    routes._handle_chat_start(handler, {"session_id": sid, "message": "continue by checking the repo"})
    payload = _payload(handler)
    saved = json.loads((session_dir / f"{sid}.json").read_text(encoding="utf-8"))

    assert handler.status == 200
    assert payload["stream_id"] == "stream1"
    assert saved["compression_recovery"] == {}
    assert saved["recommended_recovery_action"] is None


def test_chat_start_restores_recovery_when_substantive_prompt_start_is_rejected(monkeypatch, tmp_path):
    session_dir = _isolate_sessions(monkeypatch, tmp_path)
    sid = "recoverychat4"
    session = Session(
        session_id=sid,
        title="Recovery",
        workspace=str(tmp_path),
        model="gpt-4o",
        messages=[{"role": "user", "content": "long task"}],
    )
    stamp_compression_exhausted_recovery(session, message="Context length exceeded.")
    session.save()
    models.SESSIONS[sid] = session
    routes.SESSIONS[sid] = session
    monkeypatch.setattr(routes, "_resolve_chat_workspace_with_recovery", lambda *_args, **_kwargs: str(tmp_path))
    monkeypatch.setattr(routes, "_read_profile_model_config", lambda *_args, **_kwargs: (None, None, {}))
    monkeypatch.setattr(
        routes,
        "_resolve_compatible_session_model_state",
        lambda requested_model, requested_provider, **_kwargs: (requested_model or "gpt-4o", requested_provider or "openai", False),
    )
    monkeypatch.setattr(routes, "webui_gateway_chat_enabled", lambda _config: False)

    def _fake_start_run(run_session, **_kwargs):
        assert compression_recovery_payload_for_session(run_session) is None
        run_session.save()
        return {"error": "session already has an active stream", "_status": 409}

    monkeypatch.setattr(routes, "_start_run", _fake_start_run)

    handler = _JSONHandler()
    routes._handle_chat_start(handler, {"session_id": sid, "message": "continue by checking the repo"})
    saved = json.loads((session_dir / f"{sid}.json").read_text(encoding="utf-8"))

    assert handler.status == 409
    assert saved["recommended_recovery_action"] == "start_focused_continuation"
    assert saved["compression_recovery"]["terminal_state"] == "compression_exhausted"


def test_chat_start_timeout_restores_recovery_without_unlocked_save(monkeypatch, tmp_path):
    session_dir = _isolate_sessions(monkeypatch, tmp_path)
    sid = "recoverychat-timeout"
    session = Session(
        session_id=sid,
        title="Recovery",
        workspace=str(tmp_path),
        model="gpt-4o",
        messages=[{"role": "user", "content": "long task"}],
    )
    stamp_compression_exhausted_recovery(session, message="Context length exceeded.")
    session.save()
    models.SESSIONS[sid] = session
    routes.SESSIONS[sid] = session
    monkeypatch.setattr(
        routes,
        "_resolve_chat_workspace_with_recovery",
        lambda *_args, **_kwargs: str(tmp_path),
    )
    monkeypatch.setattr(
        routes, "_read_profile_model_config", lambda *_args, **_kwargs: (None, None, {})
    )
    monkeypatch.setattr(
        routes,
        "_resolve_compatible_session_model_state",
        lambda requested_model, requested_provider, **_kwargs: (
            requested_model or "gpt-4o",
            requested_provider or "openai",
            False,
        ),
    )
    monkeypatch.setattr(routes, "webui_gateway_chat_enabled", lambda _config: False)
    save_calls = []
    monkeypatch.setattr(session, "save", lambda **_kwargs: save_calls.append(True))
    monkeypatch.setattr(
        routes,
        "_start_run",
        lambda *_args, **_kwargs: {
            "error": "session is busy",
            "code": "chat_admission_timeout",
            "_status": 409,
        },
    )

    handler = _JSONHandler()
    routes._handle_chat_start(
        handler, {"session_id": sid, "message": "continue by checking the repo"}
    )
    saved = json.loads((session_dir / f"{sid}.json").read_text(encoding="utf-8"))

    assert handler.status == 409
    assert save_calls == []
    assert session.recommended_recovery_action == "start_focused_continuation"
    assert saved["compression_recovery"]["terminal_state"] == "compression_exhausted"


def test_deferred_recovery_restore_retries_after_lock_timeout(monkeypatch, tmp_path):
    session_dir = _isolate_sessions(monkeypatch, tmp_path)
    session = Session(
        session_id="deferred-recovery",
        workspace=str(tmp_path),
        messages=[{"role": "user", "content": "long task"}],
    )
    recovery = stamp_compression_exhausted_recovery(
        session, message="Context length exceeded."
    )
    clear_recovery = session.compression_recovery
    session.compression_recovery = {}
    session.recommended_recovery_action = None
    session.save()
    models.SESSIONS[session.session_id] = session
    lock = threading.Lock()
    lock.acquire()
    monkeypatch.setattr(routes, "_get_session_agent_lock", lambda _sid: lock)
    monkeypatch.setattr(routes, "_CHAT_LOCK_WAIT_SECONDS", 0.02)

    thread = routes._schedule_deferred_compression_recovery_restore(
        session.session_id, recovery or clear_recovery
    )
    time.sleep(0.05)
    assert thread.is_alive() is True
    lock.release()
    thread.join(timeout=1)

    saved = json.loads(
        (session_dir / f"{session.session_id}.json").read_text(encoding="utf-8")
    )
    assert thread.is_alive() is False
    assert saved["compression_recovery"]["terminal_state"] == "compression_exhausted"


def test_deferred_recovery_restore_stops_after_bounded_lock_retries(monkeypatch):
    lock = threading.Lock()
    lock.acquire()
    monkeypatch.setattr(routes, "_get_session_agent_lock", lambda _sid: lock)
    monkeypatch.setattr(routes, "_CHAT_LOCK_WAIT_SECONDS", 0.01)
    monkeypatch.setattr(routes, "_DEFERRED_SESSION_RETRY_DELAYS", (0.0, 0.0))

    thread = routes._schedule_deferred_compression_recovery_restore(
        "bounded-recovery", {"terminal_state": "compression_exhausted"}
    )
    thread.join(timeout=1)

    assert thread.is_alive() is False
    assert "bounded-recovery" not in routes._DEFERRED_RECOVERY_RESTORE_THREADS
    lock.release()


def test_recovery_start_creates_focused_linked_session(monkeypatch, tmp_path):
    session_dir = _isolate_sessions(monkeypatch, tmp_path)
    sid = "recoverysrc1"
    session = Session(
        session_id=sid,
        title="Long task",
        workspace=str(tmp_path),
        model="gpt-4o",
        model_provider="openai",
        profile="default",
        project_id="proj_1",
        messages=[{"role": "user", "content": "long task"}],
        context_messages=[{"role": "user", "content": "large context"}],
    )
    stamp_compression_exhausted_recovery(session, message="Context length exceeded.")
    session.save()
    models.SESSIONS[sid] = session
    routes.SESSIONS[sid] = session

    handler = _JSONHandler()
    routes._handle_session_compression_recovery_start(handler, {"session_id": sid})
    payload = _payload(handler)

    assert handler.status == 200
    new_session = payload["session"]
    assert new_session["session_id"] != sid
    assert new_session["parent_session_id"] == sid
    assert new_session["workspace"] == str(tmp_path)
    assert new_session["model"] == "gpt-4o"
    assert new_session["model_provider"] == "openai"
    assert new_session["messages"] == []
    assert new_session["session_source"] == "fork"

    saved = json.loads((session_dir / f"{new_session['session_id']}.json").read_text(encoding="utf-8"))
    assert saved["parent_session_id"] == sid
    assert saved["session_source"] == "fork"
    assert saved["context_messages"] == []
    assert saved["compression_recovery_source_session_id"] == sid
    assert saved["compression_recovery_action"] == "start_focused_continuation"
    assert compression_recovery_payload_for_session(session)["recommended_action"] == "start_focused_continuation"


def test_recovery_child_does_not_merge_parent_transcript(monkeypatch, tmp_path):
    _isolate_sessions(monkeypatch, tmp_path)
    sid = "recoverysrcisolate"
    session = Session(
        session_id=sid,
        title="Long task",
        workspace=str(tmp_path),
        model="gpt-4o",
        messages=[
            {"role": "user", "content": "long task"},
            {"role": "assistant", "content": "compression exhausted"},
        ],
    )
    stamp_compression_exhausted_recovery(session, message="Context length exceeded.")
    session.save()
    models.SESSIONS[sid] = session
    routes.SESSIONS[sid] = session

    handler = _JSONHandler()
    routes._handle_session_compression_recovery_start(handler, {"session_id": sid})
    payload = _payload(handler)
    child_id = payload["session"]["session_id"]
    child = models.SESSIONS[child_id]

    assert child.messages == []
    assert routes._merged_webui_lineage_messages_for_display(child) == []


def test_recovery_start_reuses_existing_focused_session(monkeypatch, tmp_path):
    session_dir = _isolate_sessions(monkeypatch, tmp_path)
    sid = "recoverysrc2"
    session = Session(
        session_id=sid,
        title="Long task",
        workspace=str(tmp_path),
        model="gpt-4o",
        messages=[{"role": "user", "content": "long task"}],
    )
    stamp_compression_exhausted_recovery(session, message="Context length exceeded.")
    session.save()
    models.SESSIONS[sid] = session
    routes.SESSIONS[sid] = session

    first_handler = _JSONHandler()
    routes._handle_session_compression_recovery_start(first_handler, {"session_id": sid})
    first_payload = _payload(first_handler)
    first_child_id = first_payload["session"]["session_id"]

    second_handler = _JSONHandler()
    routes._handle_session_compression_recovery_start(second_handler, {"session_id": sid})
    second_payload = _payload(second_handler)

    assert second_handler.status == 200
    assert second_payload["session"]["session_id"] == first_child_id
    assert second_payload["message"].startswith("Opened the existing")

    models.SESSIONS.clear()
    routes.SESSIONS.clear()
    third_handler = _JSONHandler()
    routes._handle_session_compression_recovery_start(third_handler, {"session_id": sid})
    third_payload = _payload(third_handler)

    assert third_handler.status == 200
    assert third_payload["session"]["session_id"] == first_child_id

    recovery_children = []
    for path in session_dir.glob("*.json"):
        if path.name.startswith("_"):
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("compression_recovery_source_session_id") == sid:
            recovery_children.append(data)
    assert len(recovery_children) == 1


def test_recovery_start_ignores_existing_child_from_other_profile(monkeypatch, tmp_path):
    session_dir = _isolate_sessions(monkeypatch, tmp_path)
    sid = "recoverysrcprofile"
    source = Session(
        session_id=sid,
        title="Long task",
        workspace=str(tmp_path),
        model="gpt-4o",
        profile="default",
        messages=[{"role": "user", "content": "long task"}],
    )
    stamp_compression_exhausted_recovery(source, message="Context length exceeded.")
    source.save()
    foreign_child = Session(
        session_id="foreignchild1",
        title="Foreign focused continuation",
        workspace=str(tmp_path),
        model="gpt-4o",
        profile="other-profile",
        messages=[],
        parent_session_id=sid,
        compression_recovery_source_session_id=sid,
        compression_recovery_action="start_focused_continuation",
    )
    foreign_child.save()
    models.SESSIONS.clear()
    routes.SESSIONS.clear()
    models.SESSIONS[sid] = source
    routes.SESSIONS[sid] = source

    handler = _JSONHandler()
    routes._handle_session_compression_recovery_start(handler, {"session_id": sid})
    payload = _payload(handler)

    assert handler.status == 200
    assert payload["session"]["session_id"] != "foreignchild1"
    assert payload["session"]["profile"] == "default"

    recovery_children = []
    for path in session_dir.glob("*.json"):
        if path.name.startswith("_"):
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("compression_recovery_source_session_id") == sid:
            recovery_children.append(data)
    assert {child["profile"] for child in recovery_children} == {"default", "other-profile"}


def test_recovery_metadata_is_persisted_and_exposed_in_compact_session():
    session = Session(session_id="recovermeta1", title="x", messages=[])
    recovery = stamp_compression_exhausted_recovery(session, message="Context length exceeded.")
    compact = session.compact()

    assert recovery["terminal_state"] == "compression_exhausted"
    assert compact["recommended_recovery_action"] == "start_focused_continuation"
    assert compact["compression_recovery"]["recommended_action"] == "start_focused_continuation"


def test_recovery_child_markers_round_trip_through_state_db_sidecar_rebuild(tmp_path):
    db = WebUIJsonSessionDB(tmp_path)
    db.write_session(
        {
            "session_id": "recoverychild1",
            "title": "Focused continuation",
            "model": "gpt-4o",
            "started_at": 1700000000,
            "messages": [],
            "parent_session_id": "recoverysrc3",
            "compression_recovery_source_session_id": "recoverysrc3",
            "compression_recovery_action": "start_focused_continuation",
        }
    )
    row = db.list_sessions()[0]

    assert row["compression_recovery_source_session_id"] == "recoverysrc3"
    assert row["compression_recovery_action"] == "start_focused_continuation"

    sidecar = _state_db_row_to_sidecar({"id": "recoverychild1", **row, "messages": []})

    assert sidecar["compression_recovery_source_session_id"] == "recoverysrc3"
    assert sidecar["compression_recovery_action"] == "start_focused_continuation"


def test_recovery_source_metadata_round_trips_through_state_db_sidecar_rebuild(tmp_path):
    recovery = {
        "type": "compression_recovery_required",
        "terminal_state": "compression_exhausted",
        "recommended_action": "start_focused_continuation",
        "source_session_id": "recoverysrc4",
    }
    db = WebUIJsonSessionDB(tmp_path)
    db.write_session(
        {
            "session_id": "recoverysrc4",
            "title": "Exhausted source",
            "model": "gpt-4o",
            "started_at": 1700000000,
            "messages": [{"role": "user", "content": "long task"}],
            "compression_recovery": recovery,
            "recommended_recovery_action": "start_focused_continuation",
        }
    )
    row = db.list_sessions()[0]

    sidecar = _state_db_row_to_sidecar({"id": "recoverysrc4", **row, "messages": []})

    assert sidecar["compression_recovery"] == recovery
    assert sidecar["recommended_recovery_action"] == "start_focused_continuation"
