"""Regression coverage for issue #2211 workspace panel reopen affordance."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHANGELOG = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")


def test_changelog_mentions_workspace_panel_reopen_affordance():
    assert "#2211" in CHANGELOG
    assert "workspace panel" in CHANGELOG.lower()
    assert "reopen" in CHANGELOG.lower()
