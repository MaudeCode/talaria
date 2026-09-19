"""Regression tests for issue #3820 chat activity display mode."""

import json
import shutil
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")

_EXTRACT_FUNC_JS = """
function extractFunc(name){
  const start = src.indexOf('function ' + name);
  if(start === -1) throw new Error(name + ' not found');
  const params = src.indexOf('(', start);
  let depth = 0, close = -1;
  for(let i=params; i<src.length; i++){
    if(src[i] === '(') depth++;
    else if(src[i] === ')'){
      depth--;
      if(depth === 0){ close = i; break; }
    }
  }
  const brace = src.indexOf('{', close);
  depth = 0;
  for(let i=brace; i<src.length; i++){
    if(src[i] === '{') depth++;
    else if(src[i] === '}'){
      depth--;
      if(depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(name + ' body did not close');
}
""".strip()


def _transparentEventCountLabelBlock(ui_js):
    """Return the body of `_transparentEventCountLabel` as a string slice."""
    start = ui_js.index("function _transparentEventCountLabel")
    end = ui_js.index("\nfunction ", start + 1)
    return ui_js[start:end]


def _run_node_script(script):
    assert NODE, "node is required for chat activity display mode behavior tests"
    result = subprocess.run([NODE, "-e", script], text=True, capture_output=True, check=False)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_chat_activity_display_mode_defaults_to_compact_worklog(monkeypatch, tmp_path):
    import api.config as config

    settings_path = tmp_path / "settings.json"
    monkeypatch.setattr(config, "SETTINGS_FILE", settings_path)

    loaded = config.load_settings()

    assert loaded["chat_activity_display_mode"] == "compact_worklog"


def test_chat_activity_display_mode_persists_transparent_stream_hide_all_activity_and_rejects_invalid(monkeypatch, tmp_path):
    import api.config as config

    settings_path = tmp_path / "settings.json"
    monkeypatch.setattr(config, "SETTINGS_FILE", settings_path)

    saved = config.save_settings({"chat_activity_display_mode": "transparent_stream"})
    assert saved["chat_activity_display_mode"] == "transparent_stream"
    assert json.loads(settings_path.read_text(encoding="utf-8"))["chat_activity_display_mode"] == "transparent_stream"

    saved = config.save_settings({"chat_activity_display_mode": "hide_all_activity"})
    assert saved["chat_activity_display_mode"] == "hide_all_activity"
    assert json.loads(settings_path.read_text(encoding="utf-8"))["chat_activity_display_mode"] == "hide_all_activity"

    saved = config.save_settings({"chat_activity_display_mode": "invalid_mode"})
    assert saved["chat_activity_display_mode"] == "hide_all_activity"
    assert json.loads(settings_path.read_text(encoding="utf-8"))["chat_activity_display_mode"] == "hide_all_activity"


def test_transparent_stream_event_timestamps_default_true_and_persist_boolean(monkeypatch, tmp_path):
    import api.config as config

    settings_path = tmp_path / "settings.json"
    monkeypatch.setattr(config, "SETTINGS_FILE", settings_path)

    loaded = config.load_settings()
    assert loaded["transparent_stream_event_timestamps"] is True

    saved = config.save_settings({"transparent_stream_event_timestamps": False})
    assert saved["transparent_stream_event_timestamps"] is False
    assert json.loads(settings_path.read_text(encoding="utf-8"))["transparent_stream_event_timestamps"] is False


# ── Trifecta review fixes (round 2) ───────────────────────────────────────
