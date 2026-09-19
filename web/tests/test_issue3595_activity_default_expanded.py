"""Pin the full behavioral contract for the Worklog expanded-default setting."""
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent


def _function_body(src, name):
    marker = f"function {name}"
    start = src.index(marker)
    brace = src.index("{", start)
    depth = 0
    for idx in range(brace, len(src)):
        ch = src[idx]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return src[brace + 1:idx]
    raise AssertionError(f"function {name} body not found")


def test_setting_in_defaults():
    src = (ROOT / "api" / "config.py").read_text(encoding="utf-8")
    assert '"worklog_details_expanded_default"' in src or "'worklog_details_expanded_default'" in src, \
        "worklog_details_expanded_default must exist in _SETTINGS_DEFAULTS"
    # Verify default is False
    assert re.search(r'["\']worklog_details_expanded_default["\']:\s*False', src), \
        "worklog_details_expanded_default default must be False (collapsed)"


def test_setting_in_bool_keys():
    src = (ROOT / "api" / "config.py").read_text(encoding="utf-8")
    assert re.search(r'_SETTINGS_BOOL_KEYS\b.*?worklog_details_expanded_default', src, re.DOTALL), \
        "worklog_details_expanded_default must appear inside _SETTINGS_BOOL_KEYS (not just anywhere in config.py)"


def test_legacy_activity_feed_setting_migrates_without_remaining_primary_semantics():
    src = (ROOT / "api" / "config.py").read_text(encoding="utf-8")
    assert '"activity_feed_expanded_default"' in src, \
        "config.py should still accept the legacy key as a migration alias"
    assert re.search(r'_SETTINGS_LEGACY_DROP_KEYS\b.*?activity_feed_expanded_default', src, re.DOTALL), \
        "The legacy Activity Feed key should be dropped from primary settings after migration"
    assert 'settings["worklog_details_expanded_default"] = bool(' in src, \
        "load_settings should migrate legacy Activity Feed values into the Worklog details key"
    assert 'settings.pop("activity_feed_expanded_default", None)' in src, \
        "save_settings should not persist the legacy Activity Feed key"


def test_legacy_activity_feed_setting_migrates_on_load_and_save(monkeypatch, tmp_path):
    from api import config

    settings_file = tmp_path / "settings.json"
    settings_file.write_text(
        json.dumps({"activity_feed_expanded_default": True}),
        encoding="utf-8",
    )
    monkeypatch.setattr(config, "SETTINGS_FILE", settings_file)

    loaded = config.load_settings()
    assert loaded["worklog_details_expanded_default"] is True
    assert "activity_feed_expanded_default" not in loaded

    saved = config.save_settings({"activity_feed_expanded_default": False})
    assert saved["worklog_details_expanded_default"] is False
    on_disk = json.loads(settings_file.read_text(encoding="utf-8"))
    assert on_disk["worklog_details_expanded_default"] is False
    assert "activity_feed_expanded_default" not in on_disk
