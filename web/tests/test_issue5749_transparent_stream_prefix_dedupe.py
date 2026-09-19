"""Regression tests for issue #5749 Transparent Stream prefix dedupe."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")
ISSUE5749_CAPTURED_SESSION = json.loads(
    (ROOT / "tests" / "fixtures" / "issue5749_captured_session_prefix.json").read_text(encoding="utf-8")
)


def _run_node(src, script, tmp_path):
    assert NODE, "node is required for issue #5749 regression tests"
    script_path = tmp_path / "issue5749_node_script.js"
    script_path.write_text(script, encoding="utf-8")
    result = subprocess.run([NODE, str(script_path)], text=True, capture_output=True, check=False)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def _normalized_text(text):
    return " ".join(str(text or "").split()).lower()


def _issue5749_captured_scene():
    scenes = ISSUE5749_CAPTURED_SESSION["anchor_activity_scenes"]
    scene = next(iter(scenes.values()))["scene"]
    rows = scene["activity_rows"]
    assert len(rows) == 1
    row = rows[0]
    assert row["role"] == "prose"
    assert row["kind"] == "process_prose"
    assert row["source_event_type"] == "token"
    assert row["local_id"].startswith("live-prose:")
    assert not any(
        other is not row and other.get("text") == row["text"] and not str(other.get("local_id", "")).startswith("live-prose:")
        for other in rows
    )
    row_key = _normalized_text(row["text"])
    final_key = _normalized_text(scene["final_answer"])
    assert row_key and final_key.startswith(row_key)
    assert 0.40 <= len(row_key) / len(final_key) <= 0.45
    return scene, row


@pytest.mark.reproduction
@pytest.mark.skipif(NODE is None, reason="node not on PATH")
def test_issue5749_reproduction_fixture_matches_lone_live_prefix_shape():
    scene, row = _issue5749_captured_scene()
    final_key = _normalized_text(scene["final_answer"])
    row_key = _normalized_text(row["text"])

    assert row_key != final_key
    assert final_key.startswith(row_key)
    assert scene["final_answer"] == ISSUE5749_CAPTURED_SESSION["messages"][0]["content"]
