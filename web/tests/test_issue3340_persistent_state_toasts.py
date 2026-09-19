from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STREAMING_PY = (ROOT / "api" / "streaming.py").read_text(encoding="utf-8")
CHANGELOG = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")


def test_backend_emits_state_saved_sse_from_file_snapshots():
    assert "def _persistent_state_snapshot" in STREAMING_PY
    assert "def _persistent_state_changes" in STREAMING_PY
    assert '_persistent_state_before = _persistent_state_snapshot(_profile_home)' in STREAMING_PY
    assert 'put("state_saved", {' in STREAMING_PY
    assert '"kind": "memory"' in STREAMING_PY
    assert '"kind": "skill"' in STREAMING_PY


def test_issue_3340_changelog_entry_present():
    assert "#3340" in CHANGELOG
    assert "saved memory" in CHANGELOG
    assert "created/updated a skill" in CHANGELOG
