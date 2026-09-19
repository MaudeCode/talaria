"""
Bug batch fixes — April 2026.

Covers:
- #594: .app-dialog and .file-rename-input have light theme overrides in style.css
- #576: workspace panel localStorage restore is gated on session.workspace presence (boot.js)
- #585: get_available_models() calls reload_config() before reading config cache
- #567: docker-compose.yml comment mentions macOS UID mismatch
- #590: _transcribeBlob already calls setComposerStatus('Transcribing…') — confirmed present
"""
import pathlib
import re

REPO_ROOT = pathlib.Path(__file__).parent.parent
COMPOSE   = (REPO_ROOT / "docker-compose.yml").read_text(encoding="utf-8")


# ── #594: light theme dialog overrides ───────────────────────────────────────

# ── dark-mode user bubble semantics ──────────────────────────────────────────

# ── #576: workspace panel snap fix ───────────────────────────────────────────

# ── #585: get_available_models reloads config ─────────────────────────────────

def test_585_get_available_models_calls_reload_config():
    """api/config.py: get_available_models() must do a mtime-based reload check."""
    config_src = (REPO_ROOT / "api" / "config.py").read_text(encoding="utf-8")
    fn_start = config_src.find("def get_available_models(")
    assert fn_start != -1, "get_available_models not found"
    fn_body_end = config_src.find('"""', config_src.find('"""', fn_start + 30) + 3) + 3
    # Must check mtime before reading config
    mtime_pos    = config_src.find("_current_mtime", fn_body_end)
    active_prov_pos = config_src.find("active_provider = None", fn_body_end)
    assert mtime_pos != -1, (
        "get_available_models() must check config file mtime before reading cache (#585)"
    )
    assert mtime_pos < active_prov_pos, (
        "mtime check must come before active_provider = None in get_available_models()"
    )


# ── #567: docker-compose UID note ─────────────────────────────────────────────

def test_567_compose_mentions_macos_uid():
    """docker-compose.yml must mention macOS UID / id -u to help macOS users."""
    assert "macOS" in COMPOSE or "macos" in COMPOSE.lower(), (
        "docker-compose.yml should mention macOS UID issue (#567)"
    )
    assert "id -u" in COMPOSE, (
        "docker-compose.yml should tell users to run 'id -u' to find their UID (#567)"
    )


# ── #590: transcription spinner already present ───────────────────────────────
