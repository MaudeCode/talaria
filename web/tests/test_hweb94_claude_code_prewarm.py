"""HWEB-94: the startup prewarm parses Claude Code transcripts only when the
sidebar would show them, and never raises."""

import pytest

from api import config, models, startup


def _spy(monkeypatch, settings, raise_exc=None):
    calls = []

    def fake_get_claude_code_sessions():
        calls.append(1)
        if raise_exc:
            raise raise_exc
        return []

    monkeypatch.setattr(config, "load_settings", lambda: dict(settings))
    monkeypatch.setattr(models, "get_claude_code_sessions", fake_get_claude_code_sessions)
    return calls


def test_prewarm_runs_once_when_claude_code_rows_are_visible(monkeypatch):
    calls = _spy(monkeypatch, {"show_cli_sessions": True, "show_claude_code_sessions": True})
    startup._prewarm_claude_code_parse_cache()
    assert calls == [1]


@pytest.mark.parametrize(
    "settings",
    [
        {"show_cli_sessions": False, "show_claude_code_sessions": True},
        {"show_cli_sessions": True, "show_claude_code_sessions": False},
        {},
    ],
)
def test_prewarm_skips_when_rows_are_hidden(monkeypatch, settings):
    calls = _spy(monkeypatch, settings)
    startup._prewarm_claude_code_parse_cache()
    assert calls == []


def test_prewarm_step_runs_before_session_recovery(monkeypatch):
    calls = []
    monkeypatch.setattr(startup, "_prewarm_claude_code_parse_cache_step", lambda: calls.append("prewarm"))
    monkeypatch.setattr(startup, "_recover_sessions_step", lambda: calls.append("recover"))
    for name in ("_repair_agent_deps_step", "_start_background_workers_step", "_load_plugins_step", "_start_talaria_relay_step"):
        monkeypatch.setattr(startup, name, lambda: None)
    startup.run_deferred_startup()
    assert calls == ["prewarm", "recover"]


def test_prewarm_swallows_parse_errors(monkeypatch, capsys):
    _spy(
        monkeypatch,
        {"show_cli_sessions": True, "show_claude_code_sessions": True},
        raise_exc=RuntimeError("boom"),
    )
    startup._prewarm_claude_code_parse_cache()
    assert "prewarm failed: boom" in capsys.readouterr().out
