"""Regression tests for WebUI handling of Hermes CLI-only slash commands."""

import json
from pathlib import Path
import subprocess
import tempfile
import textwrap
from types import SimpleNamespace

from api.commands import list_commands


REPO_ROOT = Path(__file__).resolve().parents[1]
def test_api_commands_exposes_cli_only_metadata_for_webui_intercept():
    """CLI-only commands must remain visible so the frontend can explain them."""
    registry = [
        SimpleNamespace(
            name="browser",
            description="Attach browser tools",
            category="tools",
            aliases=["browse"],
            args_hint="connect",
            subcommands=["connect"],
            cli_only=True,
            gateway_only=False,
        )
    ]

    body = list_commands(registry)

    assert body == [
        {
            "name": "browser",
            "description": "Attach browser tools",
            "category": "tools",
            "aliases": ["browse"],
            "args_hint": "connect",
            "subcommands": ["connect"],
            "cli_only": True,
            "gateway_only": False,
        }
    ]
