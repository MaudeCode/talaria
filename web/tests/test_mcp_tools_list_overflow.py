"""Regression coverage for large MCP tool inventories in Settings → System."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CHANGELOG = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
def test_changelog_mentions_large_mcp_tool_inventory_fix():
    assert "large MCP tool inventories" in CHANGELOG
    assert "5-item default pages" in CHANGELOG
    assert "per-page selector up to 40 tools" in CHANGELOG
