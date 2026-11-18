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
        # /autoprune runs through the registry's own executor.
        assert executable == RUNTIME | {"autoprune"}, executable
    finally:
        sidecar.close()


@requires_agent
def test_prompt_builtins_expand_through_the_agents_own_builders(tmp_path: pathlib.Path) -> None:
    """TAL-817: the turn text for ``/plan`` and ``/init`` is the Agent-built prompt; ``/blueprint`` has no expander."""
    home = tmp_path / "home" / ".hermes"
    home.mkdir(parents=True)
    workspace = tmp_path / "project"
    workspace.mkdir()
    sidecar = SidecarProcess(home)
    try:
        rows = {row["name"]: row["prompt"] for row in sidecar.result("commands.registry", {"profile_home": str(home)})["commands"]}
        assert {name: rows.get(name) for name in ("plan", "learn", "init", "blueprint", "new")} == {
            "plan": "expand", "learn": "expand", "init": "expand", "blueprint": "unsupported", "new": None}

        def expand(command: str) -> dict:
            params = {"profile_home": str(home), "command": command, "workspace": str(workspace), "enabled_toolsets": None}
            result = sidecar.result("commands.expand_prompt", params)
            assert validate(result, load_schema("commands.expand_prompt")) == []
            return result

        plan = expand("/plan add a dark mode")
        assert plan["name"] == "plan" and plan["message"].startswith("[/plan") and "add a dark mode" in plan["message"]
        assert str(workspace) in expand("/init")["message"]
        assert expand("/blueprint daily digest") == {"name": "blueprint", "message": None}
        assert expand("/etc/hosts looks wrong") == {"name": None, "message": None}
        assert expand("/") == {"name": None, "message": None}
    finally:
        sidecar.close()
