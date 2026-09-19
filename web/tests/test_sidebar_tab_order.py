"""Regression tests for configurable sidebar tab ordering."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PY = (ROOT / "api" / "config.py").read_text(encoding="utf-8")
def _function_body(source: str, name: str, limit: int = 5000) -> str:
    start = source.find(f"function {name}(")
    assert start >= 0, f"{name} not found"
    end = source.find("\nfunction ", start + 1)
    if end < 0:
        end = start + limit
    return source[start:end]


def test_backend_round_trip_and_validation_for_tab_order(monkeypatch, tmp_path):
    """tab_order is persisted as a sanitized list and never includes fixed tabs."""
    import api.config as config

    settings_path = tmp_path / "settings.json"
    monkeypatch.setattr(config, "SETTINGS_FILE", settings_path)

    loaded = config.load_settings()
    assert loaded["tab_order"] == [], "default tab_order must be empty list"

    saved = config.save_settings({"tab_order": ["logs", "tasks", "kanban"]})
    assert saved["tab_order"] == ["logs", "tasks", "kanban"]
    assert config.load_settings()["tab_order"] == ["logs", "tasks", "kanban"]

    bad = config.save_settings({"tab_order": "logs,tasks"})
    assert bad["tab_order"] == ["logs", "tasks", "kanban"], "non-list payload is ignored"

    saved = config.save_settings({"tab_order": ["chat", "logs", "", "logs", "settings", "  ", "tasks"]})
    assert saved["tab_order"] == ["logs", "tasks"], \
        "tab_order must strip fixed tabs, blanks, and duplicates while preserving order"

    assert "tab_order" in config._SETTINGS_ALLOWED_KEYS
    assert "tab_order" not in config._SETTINGS_BOOL_KEYS
