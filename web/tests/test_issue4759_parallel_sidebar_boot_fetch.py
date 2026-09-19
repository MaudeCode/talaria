"""Regression tests for #4759: parallelize first-load sidebar boot fetches."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")


def _extract_function(source_text: str, function_name: str) -> str:
    marker = f"async function {function_name}("
    start = source_text.find(marker)
    if start < 0:
        marker = f"function {function_name}("
        start = source_text.find(marker)
    assert start >= 0, f"{function_name}() not found"
    brace_start = source_text.find("{", start)
    assert brace_start >= 0, f"{function_name} body not found"

    depth = 0
    in_string = None
    escaped = False
    in_line_comment = False
    in_block_comment = False

    for index in range(brace_start, len(source_text)):
        char = source_text[index]
        nxt = source_text[index + 1] if index + 1 < len(source_text) else ""

        if in_line_comment:
            if char == "\n":
                in_line_comment = False
            continue
        if in_block_comment:
            if char == "*" and nxt == "/":
                in_block_comment = False
            continue
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == in_string:
                in_string = None
            continue
        if char == "/" and nxt == "/":
            in_line_comment = True
            continue
        if char == "/" and nxt == "*":
            in_block_comment = True
            continue
        if char in ("'", '"', "`"):
            in_string = char
            continue

        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source_text[start : index + 1]

    raise AssertionError(f"could not extract {function_name}()")


def _run_node(script: str):
    completed = subprocess.run(
        [NODE, "-e", script],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr or completed.stdout
    return json.loads(completed.stdout.strip())


def test_project_crud_publishes_profile_scoped_sidebar_invalidations():
    routes_source = (ROOT / "api" / "routes.py").read_text(encoding="utf-8")
    assert '_publish_session_list_changed("project_create", profile=proj.get("profile"))' in routes_source
    assert '_publish_session_list_changed("project_rename", profile=active_profile)' in routes_source
    assert '_publish_session_list_changed("project_delete", profile=active_profile)' in routes_source
