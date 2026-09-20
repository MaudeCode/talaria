"""Agent installation defaults use the same immutable identity as releases."""

import json
from pathlib import Path

import bootstrap


def test_bootstrap_installer_pins_script_and_checkout(monkeypatch):
    pin = json.loads((Path(__file__).parents[1] / "sidecar/agent_dependency.json").read_text())
    sha = pin["x-talaria"]["sourceRevision"]
    calls = []
    monkeypatch.setattr(bootstrap.platform, "system", lambda: "Linux")
    monkeypatch.setattr(bootstrap.subprocess, "run", lambda *a, **kw: calls.append((a, kw)))
    bootstrap.install_hermes_agent()
    assert len(calls) == 1
    args, kwargs = calls[0]
    command = args[0]
    assert f"/{sha}/scripts/install.sh" in command[-1]
    assert f"--commit {sha}" in command[-1]
    assert "pipefail" in command
    assert kwargs["check"] is True
    assert "--force-commit" not in command[-1]
