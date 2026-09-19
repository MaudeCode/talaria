"""Source-inspection and behavioral tests for Kanban modal fields added in #4470."""
from __future__ import annotations
import json
import re
import shutil
import subprocess
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parents[1]
KANBAN_BRIDGE = (ROOT / "api" / "kanban_bridge.py").read_text(encoding="utf-8")

NODE = shutil.which("node")


def test_backend_already_accepts_new_fields():
    assert "skills=body.get(" in KANBAN_BRIDGE
    assert "max_runtime_seconds=body.get(" in KANBAN_BRIDGE
    assert "parents=body.get(" in KANBAN_BRIDGE
