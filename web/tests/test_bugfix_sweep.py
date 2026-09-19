import re
from pathlib import Path
from types import SimpleNamespace

import pytest


ROOT = Path(__file__).resolve().parents[1]


class _Headers(dict):
    def get(self, key, default=None):
        return super().get(key, default)


class _RejectNegativeRead:
    def read(self, n=-1):
        if n < 0:
            raise AssertionError("read_body must reject negative Content-Length before read(-1)")
        return b"{}"


def test_read_body_rejects_negative_content_length_without_unbounded_read():
    from api.helpers import read_body

    handler = SimpleNamespace(headers=_Headers({"Content-Length": "-1"}), rfile=_RejectNegativeRead(), close_connection=False)

    with pytest.raises(ValueError, match="Content-Length"):
        read_body(handler)
    assert handler.close_connection is True


def test_session_save_rejects_unsafe_session_id(tmp_path, monkeypatch):
    import api.models as models

    session_dir = tmp_path / "sessions"
    session_dir.mkdir()
    monkeypatch.setattr(models, "SESSION_DIR", session_dir)

    session = models.Session(session_id="../escape", workspace=str(tmp_path), messages=[])

    with pytest.raises(ValueError, match="session_id"):
        session.save()

    numeric_session = models.Session(session_id=123, workspace=str(tmp_path), messages=[])
    with pytest.raises(ValueError, match="session_id"):
        numeric_session.save()

    assert not (tmp_path / "escape.json").exists()


def test_bespoke_telemetry_body_readers_reject_invalid_lengths_without_unbounded_read():
    import api.routes as routes

    for reader in (routes._read_csp_report_payload, routes._read_client_event_payload):
        handler = SimpleNamespace(headers=_Headers({"Content-Length": "-1"}), rfile=_RejectNegativeRead(), close_connection=False)
        payload = reader(handler)
        assert handler.close_connection is True
        assert payload.get("discarded") == "invalid_content_length" or payload.get("reason") == "invalid_content_length"


def test_bespoke_telemetry_body_readers_close_connection_on_oversize():
    import api.routes as routes

    cases = [
        (routes._read_csp_report_payload, routes._CSP_REPORT_MAX_BODY_BYTES + 1),
        (routes._read_client_event_payload, routes._CLIENT_EVENT_MAX_BODY_BYTES + 1),
    ]
    for reader, size in cases:
        handler = SimpleNamespace(headers=_Headers({"Content-Length": str(size)}), rfile=_RejectNegativeRead(), close_connection=False)
        payload = reader(handler)
        assert handler.close_connection is True
        assert payload.get("discarded") == "body_too_large" or payload.get("reason") == "body_too_large"


def test_auth_sessions_have_lock_and_success_can_clear_login_attempts(monkeypatch, tmp_path):
    import api.auth as auth

    assert hasattr(auth, "_SESSIONS_LOCK"), "auth session dict mutations must be lock-protected"
    assert hasattr(auth, "_clear_login_attempts"), "successful login needs to clear failed attempt bucket"

    monkeypatch.setattr(auth, "_LOGIN_ATTEMPTS_FILE", tmp_path / ".login_attempts.json")
    auth._login_attempts.clear()
    auth._login_attempts["127.0.0.1"] = [1.0, 2.0, 3.0, 4.0]

    auth._clear_login_attempts("127.0.0.1")

    assert "127.0.0.1" not in auth._login_attempts


def _english_i18n_keys():
    text = (ROOT / "static" / "i18n.js").read_text(encoding="utf-8")
    match = re.search(r"en:\s*\{([\s\S]*?)\n\s*\},\n\s*[a-z]{2}:", text)
    assert match, "could not find English locale block"
    return set(re.findall(r"^\s*([A-Za-z0-9_]+):", match.group(1), re.M))


def _literal_i18n_refs():
    refs = set()
    for path in (ROOT / "static").glob("*.js"):
        if path.name == "i18n.js":
            continue
        text = path.read_text(encoding="utf-8")
        refs.update(re.findall(r"\bt\(\s*['\"]([A-Za-z0-9_]+)['\"]", text))
        refs.update(re.findall(r"data-i18n(?:-[a-z]+)?=['\"]([A-Za-z0-9_]+)['\"]", text))
    return {key for key in refs if not key.endswith("_")}
