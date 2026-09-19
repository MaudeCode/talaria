"""Regression checks for #5435 TTS and voice preference persistence."""

import json
import importlib
import pathlib
import urllib.error
import urllib.request

from tests._pytest_port import BASE

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONFIG_PY = (ROOT / "api" / "config.py").read_text(encoding="utf-8")
SPEECH_DEFAULTS = {
    "tts_enabled": False,
    "tts_auto_read": False,
    "tts_engine": "browser",
    "tts_voice": "",
    "tts_rate": 1.0,
    "tts_pitch": 1.0,
    "voice_mode_button": False,
    "voice_continuous": False,
    "voice_silence_ms": 1800,
    "raw_audio_mode": False,
}
PERSISTED_SPEECH_KEYS_FIELD = "persisted_speech_keys"


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as response:
        return json.loads(response.read()), response.status


def post(path, body=None):
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(
        BASE + path,
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.loads(response.read()), response.status
    except urllib.error.HTTPError as exc:
        return json.loads(exc.read()), exc.code


def _extract_balanced_block(src, marker):
    start = src.index(marker)
    brace = src.index("{", start)
    depth = 0
    end = None
    for idx in range(brace, len(src)):
        ch = src[idx]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = idx + 1
                break
    assert end is not None, f"Unbalanced block for {marker!r}"
    return src[start:end]


def _settings_file_snapshot():
    cfg = importlib.import_module("api.config")
    path = cfg.SETTINGS_FILE
    original = path.read_text(encoding="utf-8") if path.exists() else None
    return path, original


def _restore_settings_file(path, original):
    if original is None:
        if path.exists():
            path.unlink()
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(original, encoding="utf-8")


def test_settings_api_exposes_tts_voice_and_raw_audio_defaults():
    data, status = get("/api/settings")

    assert status == 200
    assert data[PERSISTED_SPEECH_KEYS_FIELD] == []
    for key, value in SPEECH_DEFAULTS.items():
        assert data[key] == value


def test_settings_api_round_trips_speech_preferences():
    path, original = _settings_file_snapshot()
    payload = {
        "tts_enabled": True,
        "tts_auto_read": True,
        "tts_engine": "voicevox_local",
        "tts_voice": "en-US-AriaNeural",
        "tts_rate": "1.4",
        "tts_pitch": "0",
        "voice_mode_button": True,
        "voice_continuous": True,
        "voice_silence_ms": "2400",
        "raw_audio_mode": True,
    }
    try:
        saved, status = post("/api/settings", payload)
        reloaded, reload_status = get("/api/settings")

        assert status == 200
        assert reload_status == 200
        assert saved["tts_enabled"] is True
        assert saved["tts_auto_read"] is True
        assert saved["tts_engine"] == "voicevox_local"
        assert saved["tts_voice"] == "en-US-AriaNeural"
        assert saved["tts_rate"] == 1.4
        assert saved["tts_pitch"] == 0.0
        assert saved["voice_mode_button"] is True
        assert saved["voice_continuous"] is True
        assert saved["voice_silence_ms"] == 2400
        assert saved["raw_audio_mode"] is True
        assert saved[PERSISTED_SPEECH_KEYS_FIELD] == sorted(payload)
        for key in payload:
            expected = saved[key]
            assert reloaded[key] == expected
        assert reloaded[PERSISTED_SPEECH_KEYS_FIELD] == sorted(payload)
    finally:
        _restore_settings_file(path, original)


def test_settings_api_reports_only_raw_persisted_speech_keys():
    path, original = _settings_file_snapshot()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "show_tps": True,
                    "tts_pitch": 0.0,
                    "voice_mode_button": False,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        data, status = get("/api/settings")

        assert status == 200
        assert data[PERSISTED_SPEECH_KEYS_FIELD] == [
            "tts_pitch",
            "voice_mode_button",
        ]
        assert data["tts_pitch"] == 0.0
        assert data["voice_mode_button"] is False
        assert data["tts_enabled"] is False
    finally:
        _restore_settings_file(path, original)


def test_unrelated_settings_save_does_not_materialize_absent_speech_defaults():
    path, original = _settings_file_snapshot()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"show_tps": False}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        saved, status = post("/api/settings", {"show_tps": True})

        assert status == 200
        assert saved["show_tps"] is True
        assert saved[PERSISTED_SPEECH_KEYS_FIELD] == []

        raw = json.loads(path.read_text(encoding="utf-8"))
        assert raw["show_tps"] is True
        for key in SPEECH_DEFAULTS:
            assert key not in raw
    finally:
        _restore_settings_file(path, original)


def test_startup_workspace_repair_write_drops_merged_speech_defaults():
    path, original = _settings_file_snapshot()
    cfg = importlib.import_module("api.config")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "show_tps": False,
                    "tts_pitch": 0.0,
                    "default_workspace": "C:/stale/workspace",
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        merged = cfg.load_settings()
        merged["default_workspace"] = "C:/fixed/workspace"
        persisted = cfg._settings_payload_for_write(
            merged, cfg._extract_persisted_speech_keys(cfg._read_raw_settings_file())
        )

        assert persisted["show_tps"] is False
        assert persisted["tts_pitch"] == 0.0
        assert persisted["default_workspace"] == "C:/fixed/workspace"
        assert PERSISTED_SPEECH_KEYS_FIELD not in persisted
        for key in SPEECH_DEFAULTS:
            if key != "tts_pitch":
                assert key not in persisted
    finally:
        _restore_settings_file(path, original)


def test_invalid_speech_settings_preserve_previous_values_and_unrelated_settings():
    path, original = _settings_file_snapshot()
    data, status = get("/api/settings")
    original_show_tps = bool(data.get("show_tps"))
    valid = {
        "tts_engine": "edge",
        "tts_voice": "zh-CN-XiaoxiaoNeural",
        "tts_rate": 1.2,
        "tts_pitch": 1.1,
        "voice_silence_ms": 2200,
    }
    try:
        saved, status = post("/api/settings", valid)
        assert status == 200
        assert saved["tts_engine"] == "edge"

        invalid, status = post(
            "/api/settings",
            {
                "tts_engine": "",
                "tts_voice": "x" * 201,
                "tts_rate": "nan",
                "tts_pitch": 3,
                "voice_silence_ms": 199,
                "show_tps": not original_show_tps,
            },
        )

        assert status == 200
        for key, value in valid.items():
            assert invalid[key] == value
        assert invalid["show_tps"] is (not original_show_tps)
    finally:
        _restore_settings_file(path, original)


def test_backend_schema_contains_typed_speech_validation():
    for key in SPEECH_DEFAULTS:
        assert f'"{key}"' in CONFIG_PY
    assert '"voice_silence_ms": (200, 60000)' in CONFIG_PY
    assert '"tts_rate": (0.5, 2.0)' in CONFIG_PY
    assert '"tts_pitch": (0.0, 2.0)' in CONFIG_PY
    assert "_SETTINGS_TTS_ENGINE_RE" in CONFIG_PY
    assert 'k == "tts_voice"' in CONFIG_PY
