import io
import json
import pathlib
import sys
from types import SimpleNamespace
from urllib.parse import urlparse

REPO_ROOT = pathlib.Path(__file__).parent.parent.resolve()
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import api.profiles as profiles
import api.routes as routes


class _FakeHandler:
    def __init__(self):
        self.status = None
        self.headers = {}
        self.wfile = io.BytesIO()

    def send_response(self, status):
        self.status = status

    def send_header(self, key, value):
        self.headers[key] = value

    def end_headers(self):
        pass

    def json_body(self):
        return json.loads(self.wfile.getvalue().decode("utf-8"))


def _clear_attention_state(*session_ids):
    from api import clarify

    with routes._lock:
        for sid in session_ids:
            routes._pending.pop(sid, None)
            routes._gateway_queues.pop(sid, None)
    for sid in session_ids:
        clarify.clear_pending(sid)


def test_attention_summary_purges_stale_gateway_mirror():
    sid = "attention-stale-gateway-session"
    _clear_attention_state(sid)
    try:
        approval = {
            "approval_id": "stale-gateway-approval",
            "command": "rm -rf /tmp/nope",
            "description": "Danger",
        }
        with routes._lock:
            routes._gateway_queues[sid] = [SimpleNamespace(data=dict(approval))]
        routes.submit_gateway_pending_mirror(sid, approval)

        with routes._lock:
            assert routes._pending[sid]
            routes._gateway_queues[sid].pop(0)
            assert routes._pending[sid]

        assert routes._session_attention_summary(sid) is None
        with routes._lock:
            assert sid not in routes._pending
    finally:
        _clear_attention_state(sid)


def test_attention_summary_keeps_live_gateway_mirror():
    sid = "attention-live-gateway-session"
    _clear_attention_state(sid)
    try:
        approval = {
            "approval_id": "live-gateway-approval",
            "command": "touch /tmp/nope",
            "description": "Also danger",
        }
        with routes._lock:
            routes._gateway_queues[sid] = [SimpleNamespace(data=dict(approval))]
        routes.submit_gateway_pending_mirror(sid, approval)

        assert routes._session_attention_summary(sid) == {
            "kind": "approval",
            "count": 1,
            "severity": "critical",
        }
        with routes._lock:
            assert len(routes._pending[sid]) == 1
            assert routes._pending[sid][0]["approval_id"] == approval["approval_id"]
    finally:
        _clear_attention_state(sid)


def test_attention_summary_prefers_pending_approvals_over_clarify_questions():
    sid = "attention-both-session"
    _clear_attention_state(sid)
    try:
        routes.submit_pending(sid, {"command": "rm -rf /tmp/nope", "description": "Danger"})
        routes.submit_pending(sid, {"command": "touch /tmp/nope", "description": "Also danger"})
        routes.submit_clarify_pending(sid, {
            "question": "Which option?",
            "choices_offered": ["A", "B", "C"],
        })

        summary = routes._session_attention_summary(sid)

        assert summary == {
            "kind": "approval",
            "count": 2,
            "severity": "critical",
        }
    finally:
        _clear_attention_state(sid)


def test_attention_summary_keeps_direct_runs_mirror_after_stream_pointer_clears():
    from types import SimpleNamespace
    from unittest.mock import MagicMock, patch

    import api.route_approvals as approvals

    sid = "attention-retained-gateway-session"
    _clear_attention_state(sid)
    try:
        approvals.submit_gateway_pending_mirror(sid, {
            "_gateway_mirror": True,
            "approval_id": "approval-retained",
            "run_id": "run-retained",
            "command": "rm -rf /tmp/retained",
            "description": "Retained approval",
        })
        handler = MagicMock()
        handler.wfile = io.BytesIO()

        with patch("api.routes.get_session", return_value=SimpleNamespace(active_stream_id=None)), \
             patch("api.runner_client.HttpRunnerClient.respond_approval") as respond_approval:
            assert routes._session_attention_summary(sid) == {
                "kind": "approval",
                "count": 1,
                "severity": "critical",
            }
            routes._handle_approval_respond(handler, {
                "session_id": sid,
                "choice": "deny",
                "approval_id": "approval-retained",
            })

        handler.send_response.assert_called_with(200)
        respond_approval.assert_called_once_with("run-retained", "", "deny")
        assert json.loads(handler.wfile.getvalue().decode("utf-8"))["ok"] is True
    finally:
        approvals._pending.pop(sid, None)
        _clear_attention_state(sid)


def test_attention_summary_hides_retired_direct_runs_mirror():
    import api.route_approvals as approvals

    sid = "attention-retired-gateway-session"
    _clear_attention_state(sid)
    try:
        approvals.submit_gateway_pending_mirror(sid, {
            "_gateway_mirror": True,
            "approval_id": "approval-retired",
            "run_id": "run-retired",
            "command": "rm -rf /tmp/retired",
            "description": "Retired approval",
        })

        assert approvals.retire_gateway_pending_mirror(sid, run_id="run-retired") is True
        assert routes._session_attention_summary(sid) is None
        assert approvals.gateway_pending_mirror(sid, run_id="run-retired") is None
    finally:
        approvals._pending.pop(sid, None)
        _clear_attention_state(sid)


def test_attention_summary_reports_clarify_when_no_approval_is_pending():
    sid = "attention-clarify-session"
    _clear_attention_state(sid)
    try:
        routes.submit_clarify_pending(sid, {
            "question": "Pick deploy target",
            "choices_offered": ["staging", "prod", "cancel"],
        })
        routes.submit_clarify_pending(sid, {
            "question": "Pick rollout speed",
            "choices_offered": ["slow", "fast"],
        })

        summary = routes._session_attention_summary(sid)

        assert summary == {
            "kind": "clarify",
            "count": 2,
            "severity": "question",
        }
    finally:
        _clear_attention_state(sid)


def test_sessions_api_includes_attention_summary_for_sidebar_rows(monkeypatch):
    sid = "attention-api-session"
    _clear_attention_state(sid)
    try:
        routes.submit_pending(sid, {"command": "sudo service restart", "description": "Restart"})

        monkeypatch.setattr(routes, "all_sessions", lambda diag=None, **_kwargs: [{
            "session_id": sid,
            "title": "Needs approval",
            "profile": "default",
            "updated_at": 1,
            "last_message_at": 1,
        }])
        monkeypatch.setattr(routes, "_reconcile_stale_stream_state_for_session_rows", lambda rows: False)
        monkeypatch.setattr(routes, "load_settings", lambda: {"show_cli_sessions": False})
        monkeypatch.setattr(profiles, "get_active_profile_name", lambda: "default")

        handler = _FakeHandler()
        routes.handle_get(handler, urlparse("http://example.com/api/sessions"))

        assert handler.status == 200
        sessions = handler.json_body()["sessions"]
        assert sessions[0]["attention"] == {
            "kind": "approval",
            "count": 1,
            "severity": "critical",
        }
    finally:
        _clear_attention_state(sid)
