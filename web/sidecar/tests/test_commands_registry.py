"""The command catalog marks what ``commands.exec`` runs (TAL-561), driven against the pinned Agent in a disposable home."""

from __future__ import annotations

import pathlib

from conftest import SidecarProcess, load_schema, requires_agent, validate

RUNTIME = {"reload-mcp", "reload-skills", "codex-runtime", "credits"}


@requires_agent
def test_registry_lists_every_runtime_command_once_as_exec(tmp_path: pathlib.Path) -> None:
    home = tmp_path / "home" / ".hermes"
    home.mkdir(parents=True)
    sidecar = SidecarProcess(home)
    try:
        result = sidecar.result("commands.registry", {"profile_home": str(home)})
        assert validate(result, load_schema("commands.registry")) == []
        names = [row["name"] for row in result["commands"]]
        assert len(names) == len(set(names)), names
        executable = {row["name"] for row in result["commands"] if row["exec"]}
        # Every command exec runs is listed, including one the Agent registry lacks; no other built-in is marked.
        assert executable == RUNTIME, executable
    finally:
        sidecar.close()
