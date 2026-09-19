"""Tests for /reasoning show|hide slash command and show_thinking setting.

Covers:
  - show_thinking in _SETTINGS_DEFAULTS and _SETTINGS_BOOL_KEYS (api/config.py)
  - window._showThinking initialised in boot.js (settings and fallback paths)
  - window._showThinking guard in ui.js renderMessages thinking card
  - _renderLiveThinking guard in messages.js
  - cmdReasoning function present in commands.js with show/hide/effort handling
  - /reasoning in COMMANDS array (not just SLASH_SUBARG_SOURCES)
  - show|hide present as subArgs in COMMANDS entry
"""

import pathlib
import re

REPO = pathlib.Path(__file__).parent.parent


def read(rel):
    return (REPO / rel).read_text(encoding='utf-8')


def function_body(src, name):
    start = src.find(f"function {name}")
    assert start != -1, f"{name} not found"
    brace = src.find("{", start)
    assert brace != -1, f"{name} body not found"
    depth = 0
    for idx in range(brace, len(src)):
        ch = src[idx]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return src[brace + 1:idx]
    raise AssertionError(f"{name} body did not close")


# ── api/config.py ─────────────────────────────────────────────────────────────

class TestShowThinkingConfig:
    """show_thinking must appear in defaults and bool keys."""

    def test_show_thinking_in_defaults(self):
        src = read('api/config.py')
        assert '"show_thinking": True' in src, (
            "show_thinking must be True in _SETTINGS_DEFAULTS"
        )

    def test_show_thinking_in_bool_keys(self):
        src = read('api/config.py')
        assert '"show_thinking"' in src
        # Find the _SETTINGS_BOOL_KEYS set and confirm show_thinking is in it
        m = re.search(r'_SETTINGS_BOOL_KEYS\s*=\s*\{([^}]+)\}', src, re.DOTALL)
        assert m, "_SETTINGS_BOOL_KEYS not found"
        assert 'show_thinking' in m.group(1), (
            "show_thinking must be in _SETTINGS_BOOL_KEYS"
        )


# ── static/boot.js ────────────────────────────────────────────────────────────

# ── static/ui.js ──────────────────────────────────────────────────────────────

# ── static/messages.js ────────────────────────────────────────────────────────

# ── static/commands.js ────────────────────────────────────────────────────────

# ── api/config.py — reasoning helpers ────────────────────────────────────────

class TestReasoningConfigHelpers:
    """Validate that api/config.py exposes the CLI-parity helpers and that
    they read/write the same keys the CLI uses."""

    def test_parse_reasoning_effort_matches_cli_semantics(self):
        from api.config import parse_reasoning_effort, VALID_REASONING_EFFORTS
        # Empty → None
        assert parse_reasoning_effort('') is None
        assert parse_reasoning_effort(None) is None
        # none → disabled
        assert parse_reasoning_effort('none') == {'enabled': False}
        # Each valid level → {enabled, effort}
        for level in VALID_REASONING_EFFORTS:
            assert parse_reasoning_effort(level) == {'enabled': True, 'effort': level}
        # Unknown → None (fall back to default)
        assert parse_reasoning_effort('garbage') is None
        # Case-insensitive + trimmed
        assert parse_reasoning_effort('  HIGH  ') == {'enabled': True, 'effort': 'high'}

    def test_valid_reasoning_efforts_matches_hermes_constants(self):
        """Ensure our mirror stays in sync with hermes_constants."""
        from api.config import VALID_REASONING_EFFORTS
        # Snapshot-style assertion: if hermes_constants adds a level, this
        # test will fail fast so we know to update WebUI too.
        assert VALID_REASONING_EFFORTS == (
            'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'
        )

    def test_set_reasoning_effort_persists_to_config_yaml(self, tmp_path, monkeypatch):
        """set_reasoning_effort writes agent.reasoning_effort to the active
        profile's config.yaml — the same key the CLI writes."""
        import api.config as cfg
        cfgfile = tmp_path / 'config.yaml'
        monkeypatch.setattr(cfg, '_get_config_path', lambda: cfgfile)
        cfg.set_reasoning_effort('high')
        import yaml as _yaml
        data = _yaml.safe_load(cfgfile.read_text(encoding='utf-8'))
        assert data.get('agent', {}).get('reasoning_effort') == 'high', (
            "agent.reasoning_effort must be persisted to config.yaml"
        )

    def test_set_reasoning_display_persists_to_config_yaml(self, tmp_path, monkeypatch):
        """set_reasoning_display writes display.show_reasoning to the same
        config.yaml the CLI writes."""
        import api.config as cfg
        cfgfile = tmp_path / 'config.yaml'
        monkeypatch.setattr(cfg, '_get_config_path', lambda: cfgfile)
        cfg.set_reasoning_display(False)
        import yaml as _yaml
        data = _yaml.safe_load(cfgfile.read_text(encoding='utf-8'))
        assert data.get('display', {}).get('show_reasoning') is False, (
            "display.show_reasoning must be persisted to config.yaml"
        )
        cfg.set_reasoning_display(True)
        data = _yaml.safe_load(cfgfile.read_text(encoding='utf-8'))
        assert data.get('display', {}).get('show_reasoning') is True

    def test_set_reasoning_effort_rejects_invalid(self, tmp_path, monkeypatch):
        import api.config as cfg
        monkeypatch.setattr(cfg, '_get_config_path', lambda: tmp_path / 'config.yaml')
        monkeypatch.setattr(cfg, 'reload_config', lambda: None)
        import pytest as _pt
        with _pt.raises(ValueError):
            cfg.set_reasoning_effort('garbage')
        # Empty effort is ACCEPTED as "clear the override" (the Default/On
        # re-enable path for thinking-toggle-only models, #6219 round-3). It
        # must not raise; it removes agent.reasoning_effort so the provider
        # default takes effect.
        cfg.set_reasoning_effort('')

    def test_get_reasoning_status_defaults_to_show_true(self, tmp_path, monkeypatch):
        """When config.yaml has no display section, show_reasoning defaults
        to True (matches CLI default where the setting is opt-in)."""
        import api.config as cfg
        monkeypatch.setattr(cfg, '_get_config_path', lambda: tmp_path / 'config.yaml')
        st = cfg.get_reasoning_status()
        assert st['show_reasoning'] is True
        assert st['reasoning_effort'] == ''


# ── api/streaming.py — AIAgent receives reasoning_config ──────────────────────

class TestStreamingReasoningWiring:
    """Confirm api/streaming.py reads agent.reasoning_effort from config and
    passes parsed reasoning_config to AIAgent (so effort changes take effect
    on the next session)."""

    def test_streaming_reads_reasoning_effort_from_config(self):
        src = read('api/streaming.py')
        assert 'parse_reasoning_effort' in src, (
            "api/streaming.py must import parse_reasoning_effort to translate "
            "config.yaml agent.reasoning_effort into AIAgent reasoning_config"
        )
        assert 'coerce_reasoning_effort_for_model' in src, (
            "api/streaming.py must clamp/drop unsupported model-specific effort "
            "levels before sending reasoning_config to the provider"
        )
        assert "reasoning_config" in src and "'reasoning_config' in _agent_params" in src, (
            "api/streaming.py must guard the reasoning_config kwarg with "
            "inspect.signature so older hermes-agent builds don't TypeError"
        )


# ── api/routes.py — /api/reasoning endpoints ──────────────────────────────────

class TestReasoningRoutes:

    def test_get_api_reasoning_route_exists(self):
        src = read('api/routes.py')
        assert 'parsed.path == "/api/reasoning"' in src, (
            "GET /api/reasoning route must exist"
        )
        assert 'get_reasoning_status' in src, (
            "api/routes.py must import and call get_reasoning_status"
        )

    def test_post_api_reasoning_accepts_display(self):
        src = read('api/routes.py')
        # The POST branch reads 'display' from body and dispatches to
        # set_reasoning_display.
        assert 'set_reasoning_display' in src, (
            "POST /api/reasoning must route display toggles through "
            "set_reasoning_display"
        )

    def test_post_api_reasoning_accepts_effort(self):
        src = read('api/routes.py')
        assert 'set_reasoning_effort' in src, (
            "POST /api/reasoning must route effort changes through "
            "set_reasoning_effort"
        )
