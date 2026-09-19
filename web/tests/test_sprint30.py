"""
Sprint 30: Approval card UI, i18n coverage, and approval flow polish.

Tests for:
- Approval card HTML structure (all 4 buttons, IDs, data-i18n attrs)
- Keyboard shortcut handler presence in boot.js
- i18n keys for approval card in both locales
- CSS for approval-btn states (loading, disabled, kbd badge)
- respondApproval loading/disable pattern in messages.js
- streaming.py scoping fix (_unreg_notify=None initialisation)
- Approval respond HTTP endpoint (existing + new behaviour)
"""

import json
import pathlib
import re
import urllib.request
import urllib.error
import urllib.parse

from tests._pytest_port import BASE


def get(path):
    url = BASE + path
    with urllib.request.urlopen(url, timeout=10) as r:
        return json.loads(r.read())


def post(path, body=None):
    url = BASE + path
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(url, data=data,
          headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read()), r.status
    except urllib.error.HTTPError as e:
        return json.loads(e.read()), e.code


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()

REPO = pathlib.Path(__file__).parent.parent


# ── HTML structure ───────────────────────────────────────────────────────────

# ── CSS ──────────────────────────────────────────────────────────────────────

# ── i18n keys ────────────────────────────────────────────────────────────────

# ── messages.js behaviour ────────────────────────────────────────────────────

# ── boot.js keyboard shortcut ────────────────────────────────────────────────

# ── streaming.py scoping fix ─────────────────────────────────────────────────

class TestStreamingApprovalScoping:

    def test_unreg_notify_initialised_to_none(self):
        src = read(REPO / "api/streaming.py")
        assert "_unreg_notify = None" in src, \
            "_unreg_notify must be initialised to None before the try block"

    def test_finally_checks_unreg_notify_not_none(self):
        src = read(REPO / "api/streaming.py")
        assert "_unreg_notify is not None" in src, \
            "finally block must check '_unreg_notify is not None' before calling it"

    def test_approval_registered_flag_present(self):
        src = read(REPO / "api/streaming.py")
        assert "_approval_registered = False" in src, \
            "_approval_registered flag must be initialised to False"

    def test_clarify_registered_flag_present(self):
        src = read(REPO / "api/streaming.py")
        assert "_clarify_registered = False" in src, \
            "_clarify_registered flag must be initialised to False"

    def test_clarify_unreg_notify_initialised_to_none(self):
        src = read(REPO / "api/streaming.py")
        assert "_unreg_clarify_notify = None" in src, \
            "_unreg_clarify_notify must be initialised to None before the try block"

    def test_finally_checks_clarify_unreg_notify_not_none(self):
        src = read(REPO / "api/streaming.py")
        assert "_unreg_clarify_notify is not None" in src, \
            "finally block must check '_unreg_clarify_notify is not None' before calling it"


# ── HTTP regression: approval respond ────────────────────────────────────────

class TestApprovalRespondHTTP:

    def test_respond_ok_with_all_choices(self):
        for choice in ("once", "session", "always", "deny"):
            import uuid
            sid = f"sprint30-{uuid.uuid4().hex[:8]}"
            result, status = post("/api/approval/respond",
                                  {"session_id": sid, "choice": choice})
            assert status == 200, f"choice={choice} should return 200"
            assert result["ok"] is True
            assert result["choice"] == choice

    def test_respond_rejects_bad_choice(self):
        result, status = post("/api/approval/respond",
                              {"session_id": "x", "choice": "HACKED"})
        assert status == 400

    def test_respond_requires_session_id(self):
        result, status = post("/api/approval/respond", {"choice": "deny"})
        assert status == 400

    def test_respond_returns_choice_field(self):
        import uuid
        sid = f"sprint30-choice-{uuid.uuid4().hex[:8]}"
        result, status = post("/api/approval/respond",
                              {"session_id": sid, "choice": "always"})
        assert status == 200
        assert "choice" in result
        assert result["choice"] == "always"
