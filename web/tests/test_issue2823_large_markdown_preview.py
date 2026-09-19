"""Regression coverage for #2823 large Markdown workspace previews."""

from pathlib import Path


CONFIG_PY = Path("api/config.py").read_text(encoding="utf-8")


def test_backend_file_read_limit_allows_plain_text_markdown_fallback():
    assert "MAX_FILE_BYTES = 400_000" in CONFIG_PY
