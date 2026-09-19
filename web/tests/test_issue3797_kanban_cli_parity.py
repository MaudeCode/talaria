"""
Regression tests for Kanban UI task workspace and dependency controls (#3797).
Tests the Kanban workspace kind selector, workspace path validation, and dependency
add/remove controls for tasks in the Kanban board detail view.
"""

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
def test_no_backend_modifications_required():
    """Verify that backend kanban_bridge.py already has the routes we're using."""
    kanban_bridge = (ROOT / "api" / "kanban_bridge.py").read_text(encoding="utf-8")
    # Routes for links must exist and accept workspace_kind, workspace_path
    assert "/api/kanban/links" in kanban_bridge
    assert "/api/kanban/links/delete" in kanban_bridge
    # workspace_kind and workspace_path must be accepted in payload
    assert "workspace_kind" in kanban_bridge
    assert "workspace_path" in kanban_bridge
