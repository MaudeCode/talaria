from pathlib import Path

CHANGELOG = Path("CHANGELOG.md").read_text(encoding="utf-8")


def test_changelog_mentions_workspace_artifacts_tab():
    unreleased = CHANGELOG.split("## [v0.51.103]", 1)[0]
    assert "Artifacts tab" in unreleased
