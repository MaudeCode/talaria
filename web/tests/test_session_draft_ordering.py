"""Concurrency and ordering contracts for composer-draft persistence."""

from __future__ import annotations

import json
import threading
from types import SimpleNamespace


def _install_draft_route_harness(monkeypatch, routes, *, bodies, responses):
    monkeypatch.setattr(routes, "_check_csrf", lambda _handler: True)
    monkeypatch.setattr(routes, "_guard_request_session_visibility", lambda *_a, **_k: True)
    monkeypatch.setattr(routes, "_session_is_subagent_view_only", lambda _sid: False)
    monkeypatch.setattr(routes, "read_body", lambda _handler: bodies.pop(0))

    def _respond(_handler, payload, status=200, **_kwargs):
        responses.append((status, payload))
        return True

    monkeypatch.setattr(routes, "j", _respond)
    monkeypatch.setattr(routes, "bad", lambda h, msg, status=400: _respond(h, {"error": msg}, status))


def _post_draft(routes):
    handler = SimpleNamespace(command="POST", headers={}, _safe_webui_print=lambda *_a: None)
    return routes.handle_post(handler, SimpleNamespace(path="/api/session/draft", query=""))


def test_delete_winning_session_lock_prevents_delayed_draft_resurrection(tmp_path, monkeypatch):
    """A queued draft request must re-resolve ownership after delete wins."""
    from api import config, routes
    from api.session_drafts import draft_path

    sid = "delete-wins"
    transcript = tmp_path / f"{sid}.json"

    class UnsavedShell:
        session_id = sid
        composer_draft = {"text": "", "files": []}
        path = transcript
        save_calls = 0

        def save(self, **_kwargs):
            self.save_calls += 1
            transcript.write_text("{}", encoding="utf-8")

    shell = UnsavedShell()
    agent_lock = threading.Lock()
    waiting = threading.Event()
    responses = []
    bodies = [{"session_id": sid, "text": "stale", "files": [], "draft_version": "1"}]

    monkeypatch.setattr(config, "SESSION_DIR", tmp_path)
    monkeypatch.setattr(routes, "SESSION_DIR", tmp_path)
    monkeypatch.setattr(routes, "SESSIONS", {sid: shell})
    monkeypatch.setattr(routes, "LOCK", threading.RLock())
    # The pre-fix route called this before waiting on the mutation lock and
    # retained the returned shell; the fixed route never calls it after delete
    # removes both authoritative ownership sources.
    monkeypatch.setattr(routes, "get_session", lambda _sid, **_kwargs: shell)
    _install_draft_route_harness(monkeypatch, routes, bodies=bodies, responses=responses)

    def _lock_for_request(_sid):
        waiting.set()
        return agent_lock

    monkeypatch.setattr(routes, "_get_session_agent_lock", _lock_for_request)

    agent_lock.acquire()
    request = threading.Thread(target=_post_draft, args=(routes,))
    request.start()
    assert waiting.wait(timeout=2)

    # This is the ownership-changing portion of delete, performed while it owns
    # the same per-session lock. The delayed POST captured no durable authority.
    routes.SESSIONS.pop(sid, None)
    transcript.unlink(missing_ok=True)
    draft_path(sid).unlink(missing_ok=True)
    agent_lock.release()
    request.join(timeout=2)

    assert not request.is_alive()
    assert responses == [(404, {"error": "Session not found"})]
    assert shell.save_calls == 0
    assert not transcript.exists()
    assert not draft_path(sid).exists()


def test_newer_clear_rejects_delayed_older_save_and_survives_reload(tmp_path, monkeypatch):
    """Server-side persisted revisions, not response arrival, choose the winner."""
    from api import config, routes
    from api.session_drafts import read_session_draft_state

    sid = "ordered-draft"
    transcript = tmp_path / f"{sid}.json"
    transcript.write_text(json.dumps({"session_id": sid}), encoding="utf-8")

    class ExistingSession:
        session_id = sid
        composer_draft = {"text": "old server text", "files": [{"name": "old.txt"}]}
        path = transcript

        def save(self, **_kwargs):
            raise AssertionError("existing transcript must not be rewritten")

    session = ExistingSession()
    responses = []
    bodies = [
        # The submit-clear was issued second but reaches the server first.
        {"session_id": sid, "text": "", "files": [], "draft_version": "200"},
        {"session_id": sid, "text": "stale autosave", "files": [], "draft_version": "100"},
        # Once versioning is established, an old/unversioned tab fails closed.
        {"session_id": sid, "text": "legacy resurrection", "files": []},
        # A byte-for-byte retry of the winning mutation is idempotent.
        {"session_id": sid, "text": "", "files": [], "draft_version": "200"},
    ]

    monkeypatch.setattr(config, "SESSION_DIR", tmp_path)
    monkeypatch.setattr(routes, "SESSION_DIR", tmp_path)
    monkeypatch.setattr(routes, "SESSIONS", {})
    monkeypatch.setattr(routes, "LOCK", threading.RLock())
    monkeypatch.setattr(routes, "_get_session_agent_lock", lambda _sid: threading.Lock())
    monkeypatch.setattr(routes, "get_session", lambda _sid, **_kwargs: session)
    _install_draft_route_harness(monkeypatch, routes, bodies=bodies, responses=responses)

    for _ in range(4):
        assert _post_draft(routes) is True

    assert [status for status, _payload in responses] == [200, 409, 409, 200]
    assert responses[1][1]["draft"] == {"text": "", "files": []}
    assert responses[1][1]["draft_version"] == "200"
    assert responses[2][1]["draft_version"] == "200"
    assert responses[3][1]["unchanged"] is True

    # Read from disk rather than the route/session object to prove reload safety.
    draft, version = read_session_draft_state(sid, fallback={"text": "wrong", "files": []})
    assert draft == {"text": "", "files": []}
    assert version == "200"


def test_draft_version_future_bound_rejects_poisoning(tmp_path, monkeypatch):
    from api import config, routes

    sid = "future-version"
    (tmp_path / f"{sid}.json").write_text(json.dumps({"session_id": sid}), encoding="utf-8")
    responses = []
    bodies = [{
        "session_id": sid,
        "text": "poison",
        "files": [],
        "draft_version": "99999999999999999999",
    }]
    monkeypatch.setattr(config, "SESSION_DIR", tmp_path)
    monkeypatch.setattr(routes, "SESSION_DIR", tmp_path)
    _install_draft_route_harness(monkeypatch, routes, bodies=bodies, responses=responses)

    assert _post_draft(routes) is True
    assert responses == [(400, {"error": "draft_version is too far in the future"})]
