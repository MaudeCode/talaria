import json
import shutil
import subprocess
from pathlib import Path

import pytest

import api.config as config


ROOT = Path(__file__).parent.parent
def test_full_width_chat_is_opt_in_and_round_trips_as_boolean(tmp_path, monkeypatch):
    settings_file = tmp_path / "settings.json"
    monkeypatch.setattr(config, "SETTINGS_FILE", settings_file)

    assert config.load_settings()["full_width_chat"] is False
    saved = config.save_settings({"full_width_chat": True})

    assert saved["full_width_chat"] is True
    assert json.loads(settings_file.read_text(encoding="utf-8"))["full_width_chat"] is True
    assert config.load_settings()["full_width_chat"] is True
    assert "full_width_chat" in config._SETTINGS_BOOL_KEYS
