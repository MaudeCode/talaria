from pathlib import Path

CHANGELOG = Path("CHANGELOG.md").read_text(encoding="utf-8")


def test_changelog_mentions_session_and_cron_polish():
    unreleased = CHANGELOG.split("## [v0.51.103]", 1)[0]
    assert "bounded jitter/backoff" in unreleased
    assert "Expanded cron run rows" in unreleased
    assert "no longer drops content when Markdown rendering is unavailable" in unreleased
