"""HWEB-70: owner-only update controls are explained before non-owners try them.

Server: ``/api/auth/status`` exposes ``can_manage_server`` from the same helper
that guards ``OPERATOR_ONLY_PATHS``. Frontend: apply / force / clear-lock stay
disabled unless that capability is exactly ``true``.
"""
from __future__ import annotations

import io
import json
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlparse

import pytest

import api.auth as auth
import api.passkeys as passkeys
import api.routes as routes
ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")


class _Handler:
    def __init__(self, cookie=None):
        self.headers = {"Host": "localhost:8787"}
        if cookie:
            self.headers["Cookie"] = f"hermes_session={cookie}"
        self.request = SimpleNamespace()
        self.wfile = io.BytesIO()
        self.status = None
        self.sent_headers = []

    def send_response(self, status):
        self.status = status

    def send_header(self, key, value):
        self.sent_headers.append((key, value))

    def end_headers(self):
        pass

    def json_body(self):
        return json.loads(self.wfile.getvalue().decode("utf-8"))


def _auth_enabled(monkeypatch, session_info):
    monkeypatch.setattr(auth, "is_auth_enabled", lambda: True)
    monkeypatch.setattr(auth, "is_oidc_auth_enabled", lambda: True)
    monkeypatch.setattr(auth, "is_trusted_auth_enabled", lambda: False)
    monkeypatch.setattr(auth, "_passkey_feature_flag_enabled", lambda: False)
    monkeypatch.setattr(auth, "get_password_hash", lambda: None)
    monkeypatch.setattr(auth, "parse_cookie", lambda _h: "cookie" if session_info else None)
    monkeypatch.setattr(auth, "verify_session", lambda _c: bool(session_info))
    monkeypatch.setattr(auth, "ensure_trusted_auth_session", lambda _h: session_info)
    monkeypatch.setattr(passkeys, "registered_credentials", lambda: [])


def _status(handler):
    routes.handle_get(handler, urlparse("http://example.com/api/auth/status"))
    assert handler.status == 200
    return handler.json_body()


# ── shared helper ────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "session_info, expected",
    [
        (None, False),
        ({"auth_type": None, "username": None, "bound_profile": None}, True),
        ({"auth_type": "oidc", "username": "alice", "bound_profile": "alice"}, False),
        ({"auth_type": "oidc", "username": "d", "bound_profile": "default"}, False),
        ({"auth_type": "trusted", "username": "ops", "bound_profile": "ops"}, False),
    ],
)
def test_helper_with_auth_enabled(monkeypatch, session_info, expected):
    monkeypatch.setattr(auth, "is_auth_enabled", lambda: True)
    assert auth.session_can_manage_server(session_info) is expected


def test_helper_with_auth_disabled_is_owner_for_everyone(monkeypatch):
    monkeypatch.setattr(auth, "is_auth_enabled", lambda: False)
    assert auth.session_can_manage_server(None) is True
    assert auth.session_can_manage_server({"bound_profile": "alice"}) is True


# ── /api/auth/status and the route guard agree ───────────────────────────────


@pytest.mark.parametrize("bound", ["alice", "default"])
def test_bound_session_reports_false_and_is_still_denied_directly(monkeypatch, bound):
    info = {"auth_type": "oidc", "username": "user@example.com", "bound_profile": bound}
    _auth_enabled(monkeypatch, info)

    assert _status(_Handler("cookie"))["can_manage_server"] is False

    for path in ("/api/updates/apply", "/api/updates/force", "/api/updates/clear_lock"):
        handler = _Handler("cookie")
        assert auth.check_auth(handler, SimpleNamespace(path=path, query="")) is False
        assert handler.status == 403
        assert handler.json_body() == {"error": "Owner session required"}


def test_unbound_owner_session_reports_true_and_passes_guard(monkeypatch):
    info = {"auth_type": None, "username": None, "bound_profile": None}
    _auth_enabled(monkeypatch, info)
    monkeypatch.setattr(auth, "trusted_session_allows_active_profile", lambda _i: True)

    assert _status(_Handler("cookie"))["can_manage_server"] is True
    handler = _Handler("cookie")
    assert auth.check_auth(handler, SimpleNamespace(path="/api/updates/apply", query="")) is True
    assert handler.status is None


def test_unauthenticated_with_auth_enabled_reports_false(monkeypatch):
    _auth_enabled(monkeypatch, None)
    payload = _status(_Handler())
    assert payload["logged_in"] is False
    assert payload["can_manage_server"] is False


def test_auth_disabled_reports_true(monkeypatch):
    monkeypatch.setattr(auth, "is_auth_enabled", lambda: False)
    monkeypatch.setattr(auth, "is_oidc_auth_enabled", lambda: False)
    monkeypatch.setattr(auth, "is_trusted_auth_enabled", lambda: False)
    monkeypatch.setattr(auth, "_passkey_feature_flag_enabled", lambda: False)
    monkeypatch.setattr(auth, "get_password_hash", lambda: None)
    monkeypatch.setattr(passkeys, "registered_credentials", lambda: [])
    monkeypatch.setattr(routes, "load_settings", lambda: {})

    payload = _status(_Handler())
    assert payload["auth_enabled"] is False
    assert payload["can_manage_server"] is True


# ── frontend harness ─────────────────────────────────────────────────────────

_FUNCTIONS = [
    ("_showUpdateBanner", "function"),
    ("_updateMutationAllowed", "function"),
    ("_renderUpdateCapability", "function"),
    ("_syncUpdateCapability", "async function"),
    ("_noteUpdateForbidden", "async function"),
    ("_i18nUpdateText", "function"),
    ("_isUpdateApplyNetworkError", "function"),
    ("_formatUpdateApplyExceptionMessage", "function"),
    ("applyUpdates", "async function"),
    ("_showUpdateError", "function"),
    ("applyClearUpdateLock", "async function"),
    ("forceUpdate", "async function"),
]

_HARNESS = r"""
const scenario = JSON.parse(process.argv[1]);
const authResponses = scenario.auth.slice();
const updateResponses = scenario.updates.slice();

function el(extra) { return Object.assign({ disabled: false, textContent: '', style: { display: '' }, dataset: {} }, extra || {}); }
const dom = {
  updateBanner: { classList: { classes: new Set(), add(c) { this.classes.add(c); }, remove(c) { this.classes.delete(c); } } },
  updateMsg: el(),
  updateError: el({ style: { display: 'none' } }),
  updateOwnerNote: el({ style: { display: 'none' } }),
  btnApplyUpdate: el({ textContent: 'Update Now' }),
  btnForceUpdate: el({ style: { display: 'none' }, textContent: 'Force update', dataset: { target: 'webui' } }),
  btnClearUpdateLock: el({ style: { display: 'none' }, textContent: 'Clear lock', dataset: { target: 'webui' } }),
  btnUpdatePermissionRetry: el({ style: { display: 'none' } }),
};
const apiCalls = [];
const waitCalls = [];
const toasts = [];

global.window = { _updateApplyInFlight: false, _clearLockInFlight: false, _updateData: scenario.updateData };
global.sessionStorage = { removeItem() {}, setItem() {} };
global.$ = (id) => dom[id] || null;
global.api = async (path, opts) => {
  if (path === '/api/auth/status') {
    const res = authResponses.length > 1 ? authResponses.shift() : authResponses[0];
    if (res && res.throwMessage) throw new Error(res.throwMessage);
    return res;
  }
  apiCalls.push({ path, body: JSON.parse(opts.body), applyDisabled: dom.btnApplyUpdate.disabled, clearLockDisabled: dom.btnClearUpdateLock.disabled });
  const res = updateResponses.shift() || { ok: true };
  if (res.httpStatus) { const e = new Error(res.message || 'HTTP ' + res.httpStatus); e.status = res.httpStatus; throw e; }
  return res;
};
global._readHealthServerIdentity = async () => 'baseline';
global._waitForServerThenReload = (opts) => waitCalls.push(opts);
global.showToast = (message) => toasts.push(message);
global.showConfirmDialog = async () => true;
global._renderLockManualInstruction = () => {};
global._formatUpdateTargetStatus = (label, t) => (t && t.behind > 0 ? label : '');
global._formatManualUpdateInstruction = () => '';
global._renderUpdateWhatsNewLinks = () => {};
global._hideUpdateSummaryPanel = () => {};
global.setTimeout = (cb) => { cb(); return 1; };
global.clearTimeout = () => {};

__FUNCTIONS__

(async () => {
  for (const action of scenario.actions) {
    if (action === 'banner') _showUpdateBanner(scenario.updateData);
    else if (action === 'settle') await new Promise((r) => setImmediate(r));
    else if (action === 'apply') await applyUpdates();
    else if (action === 'force') await forceUpdate(dom.btnForceUpdate);
    else if (action === 'clearLock') await applyClearUpdateLock(dom.btnClearUpdateLock);
    else if (action === 'retry') await _syncUpdateCapability();
    else throw new Error('unknown action ' + action);
  }
  console.log(JSON.stringify({
    apiCalls,
    waitCalls: waitCalls.length,
    canManage: window._updateCanManage === undefined ? 'undefined' : window._updateCanManage,
    applyDisabled: dom.btnApplyUpdate.disabled,
    applyText: dom.btnApplyUpdate.textContent,
    forceDisabled: dom.btnForceUpdate.disabled,
    clearLockDisabled: dom.btnClearUpdateLock.disabled,
    retryDisplay: dom.btnUpdatePermissionRetry.style.display,
    noteDisplay: dom.updateOwnerNote.style.display,
    noteText: dom.updateOwnerNote.textContent,
    errorText: dom.updateError.textContent,
    inFlight: window._updateApplyInFlight,
    lockInFlight: window._clearLockInFlight,
  }));
})().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
"""


def _mutations(out):
    return [c["path"] for c in out["apiCalls"] if c["path"].startswith("/api/updates/")]


def _assert_locked_out(out):
    assert out["applyDisabled"] is True
    assert out["forceDisabled"] is True
    assert out["clearLockDisabled"] is True
    assert out["noteDisplay"] == "block"
