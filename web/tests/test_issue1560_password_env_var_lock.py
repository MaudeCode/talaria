"""Tests for issue #1560 — Settings password silently no-ops when HERMES_WEBUI_PASSWORD env var is set.

Root cause: HERMES_WEBUI_PASSWORD takes precedence in api.auth.get_password_hash(),
but the UI had no way to know — POST /api/settings happily wrote password_hash to
settings.json, returned 200 + "Saved" toast, while every subsequent login still
required the env-var password.

Fix: surface env-var precedence in GET /api/settings (`password_env_var: bool`),
refuse the write loudly (409) when shadowed, disable the field + show help-text
banner in the UI, with i18n keys in all 9 locales.
"""

import json
import os
import pathlib
import urllib.error
import urllib.request

REPO = pathlib.Path(__file__).parent.parent


def _read(rel_path):
    return (REPO / rel_path).read_text(encoding='utf-8')


# ── Backend (api/routes.py) ───────────────────────────────────────────────


def test_get_settings_surfaces_password_env_var_flag():
    """GET /api/settings handler must include `password_env_var: bool(env)`."""
    src = _read('api/routes.py')
    # Locate the GET /api/settings block (by handler comment + path string)
    start = src.index('if parsed.path == "/api/settings":')
    # Block ends at next top-level `if parsed.path == ...` or `if parsed.path.startswith`
    end = src.index('if parsed.path', start + 50)
    block = src[start:end]

    assert 'password_env_var' in block, \
        'GET /api/settings must expose password_env_var so UI can disable the field'
    assert 'HERMES_WEBUI_PASSWORD' in block, \
        'GET /api/settings must read HERMES_WEBUI_PASSWORD env var'


def test_post_settings_refuses_set_password_when_env_var_shadowed():
    """POST /api/settings with _set_password must return 409 when env var is set."""
    src = _read('api/routes.py')
    # The guard lives near the POST /api/settings handler; locate it via the
    # canonical error-message substring (defense-in-depth comment + bad() call).
    assert 'HERMES_WEBUI_PASSWORD env var is set' in src, \
        'POST /api/settings must refuse with a clear message naming the env var'
    assert '409' in src, 'POST /api/settings must use HTTP 409 for env-var conflict'


def test_post_settings_refuses_clear_password_when_env_var_shadowed():
    """POST /api/settings with _clear_password=true must also be refused."""
    src = _read('api/routes.py')
    # Same guard must cover both paths
    assert '_clear_password' in src
    # Find the guard and verify it tests both flags
    guard_idx = src.index('HERMES_WEBUI_PASSWORD env var is set')
    # Look back ~2KB for the conditional that triggers the guard
    window = src[max(0, guard_idx - 2000):guard_idx]
    assert 'requested_password' in window or '_set_password' in window
    assert 'requested_clear_password' in window or '_clear_password' in window, \
        'guard must cover both _set_password and _clear_password'


# ── Frontend: lock UI elements (static/index.html) ────────────────────────


# ── Frontend: env-locked logic (static/panels.js) ─────────────────────────


# ── i18n: keys present in all 10 locales (static/i18n.js) ──────────────────


LOCALES = ['en', 'it', 'ja', 'ru', 'es', 'de', 'zh', 'zh-Hant', 'pt', 'ko']


def _split_locales(i18n_src):
    """Split i18n.js into per-locale source slices.

    Locale block headers look like `  en: {` or `  'zh-Hant': {`. We slice each
    block from its header to the next sibling header at the same indentation.
    """
    import re
    pattern = re.compile(r"^  ['\"]?([\w\-]+)['\"]?: \{$", re.MULTILINE)
    matches = list(pattern.finditer(i18n_src))
    blocks = {}
    for i, m in enumerate(matches):
        name = m.group(1)
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(i18n_src)
        blocks[name] = i18n_src[start:end]
    return blocks


# ── Live HTTP smoke test (env var NOT set in pytest) ──────────────────────


def test_get_settings_returns_password_env_var_false_when_unset(monkeypatch):
    """When HERMES_WEBUI_PASSWORD is not set in the test process,
    GET /api/settings must include `password_env_var: False`."""
    # Test the unset branch explicitly. Some suite neighbors intentionally set
    # HERMES_WEBUI_PASSWORD while exercising the locked-password path.
    monkeypatch.delenv('HERMES_WEBUI_PASSWORD', raising=False)
    # The conftest server inherits a sanitized env; verify this process is clean.
    assert not os.getenv('HERMES_WEBUI_PASSWORD', '').strip(), \
        'this test requires HERMES_WEBUI_PASSWORD to be unset'

    from tests._pytest_port import BASE
    req = urllib.request.Request(BASE + '/api/settings')
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            payload = json.loads(r.read())
    except urllib.error.HTTPError as e:
        payload = json.loads(e.read())

    assert 'password_env_var' in payload, \
        'GET /api/settings must always include password_env_var key'
    assert payload['password_env_var'] is False, \
        'env var unset => password_env_var must be False'
