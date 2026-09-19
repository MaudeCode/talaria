import json
import sys
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def test_session_load_overlays_atomic_draft_sidecar(tmp_path, monkeypatch):
    from api import config, models
    from api.models import Session
    from api.session_drafts import read_session_draft, write_session_draft

    monkeypatch.setattr(config, "SESSION_DIR", tmp_path)
    monkeypatch.setattr(models, "SESSION_DIR", tmp_path)

    session = Session(session_id="draft-overlay", title="Draft overlay")
    session.messages = [{"role": "user", "content": "kept"}]
    session.composer_draft = {"text": "old", "files": []}
    session.save(skip_index=True)
    transcript_before = session.path.read_bytes()

    written = write_session_draft(
        session.session_id,
        {"text": "new text", "files": [{"name": "note.txt"}]},
    )

    assert written == read_session_draft(session.session_id)
    assert session.path.read_bytes() == transcript_before
    loaded = Session.load(session.session_id)
    assert loaded is not None
    assert loaded.messages == [{"role": "user", "content": "kept"}]
    assert loaded.composer_draft == written


def test_existing_session_draft_endpoint_never_rewrites_transcript(tmp_path, monkeypatch):
    from api import config, routes
    from api.session_drafts import read_session_draft

    monkeypatch.setattr(config, "SESSION_DIR", tmp_path)
    monkeypatch.setattr(routes, "SESSION_DIR", tmp_path)
    transcript = tmp_path / "draft-endpoint.json"
    transcript.write_text(json.dumps({"large": "payload"}), encoding="utf-8")
    transcript_before = transcript.read_bytes()

    class FakeSession:
        session_id = "draft-endpoint"
        composer_draft = {"text": "", "files": []}
        path = transcript

        def save(self, **_kwargs):
            raise AssertionError("existing draft update must not save the session transcript")

    fake = FakeSession()
    captured = {}
    get_session_kwargs = {}
    handler = SimpleNamespace(command="POST", headers={}, _safe_webui_print=lambda *_args: None)

    def _get_session(_sid, **kwargs):
        get_session_kwargs.update(kwargs)
        return fake

    monkeypatch.setattr(routes, "_check_csrf", lambda _handler: True)
    monkeypatch.setattr(routes, "_guard_request_session_visibility", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(
        routes,
        "read_body",
        lambda _handler: {"session_id": fake.session_id, "text": "typed", "files": []},
    )
    monkeypatch.setattr(routes, "_session_is_subagent_view_only", lambda _sid: False)
    monkeypatch.setattr(routes, "get_session", _get_session)
    monkeypatch.setattr(routes, "_get_session_agent_lock", lambda _sid: nullcontext())
    monkeypatch.setattr(
        routes,
        "j",
        lambda _handler, payload, status=200, **_kwargs: captured.update(
            payload=payload,
            status=status,
        )
        or True,
    )

    handled = routes.handle_post(handler, SimpleNamespace(path="/api/session/draft", query=""))

    assert handled is True
    assert captured["status"] == 200
    assert get_session_kwargs == {"metadata_only": True}
    assert captured["payload"]["draft"] == {"text": "typed", "files": []}
    assert transcript.read_bytes() == transcript_before
    assert read_session_draft(fake.session_id) == {"text": "typed", "files": []}

    # Once the sidecar exists, frequent autosaves do not even parse transcript
    # metadata or consult the session LRU.
    monkeypatch.setattr(
        routes,
        "read_body",
        lambda _handler: {"session_id": fake.session_id, "text": "typed again", "files": []},
    )

    def _unexpected_get_session(*_args, **_kwargs):
        raise AssertionError("existing sidecar update must not load session metadata")

    monkeypatch.setattr(routes, "get_session", _unexpected_get_session)
    captured.clear()
    handled = routes.handle_post(handler, SimpleNamespace(path="/api/session/draft", query=""))

    assert handled is True
    assert captured["status"] == 200
    assert captured["payload"]["draft"] == {"text": "typed again", "files": []}
    assert transcript.read_bytes() == transcript_before
