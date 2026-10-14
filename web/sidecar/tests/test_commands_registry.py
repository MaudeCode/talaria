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


@requires_agent
def test_prompt_builtins_expand_through_the_agents_own_builders(tmp_path: pathlib.Path) -> None:
    """TAL-817: the turn text for ``/initiate-setup`` is the Agent-built prompt; ``/blueprint`` has no expander."""
    home = tmp_path / "home" / ".hermes"
    home.mkdir(parents=True)
    workspace = tmp_path / "project"
    workspace.mkdir()
    sidecar = SidecarProcess(home)
    try:
        rows = {row["name"]: row["prompt"] for row in sidecar.result("commands.registry", {"profile_home": str(home)})["commands"]}
        assert {name: rows.get(name) for name in ("plan", "learn", "init", "initiate-setup", "blueprint", "new")} == {
            "plan": "expand", "learn": "expand", "init": "expand", "initiate-setup": "expand", "blueprint": "unsupported", "new": None}

        def expand(command: str) -> dict:
            params = {"profile_home": str(home), "command": command, "workspace": str(workspace), "enabled_toolsets": None}
            result = sidecar.result("commands.expand_prompt", params)
            assert validate(result, load_schema("commands.expand_prompt")) == []
            return result

        setup = expand("/initiate_setup")
        assert setup["name"] == "initiate-setup"
        assert setup["message"].startswith("[/initiate-setup]\n\n")
        assert '"surface": "webui"' in setup["message"] and '"primary_profile": "default"' in setup["message"]
        plan = expand("/plan add a dark mode")
        assert plan["name"] == "plan" and plan["message"].startswith("[/plan") and "add a dark mode" in plan["message"]
        assert str(workspace) in expand("/init")["message"]
        assert expand("/blueprint daily digest") == {"name": "blueprint", "message": None}
        assert expand("/etc/hosts looks wrong") == {"name": None, "message": None}
        assert expand("/") == {"name": None, "message": None}
    finally:
        sidecar.close()


def test_an_agent_without_the_builder_takes_the_unsupported_path(monkeypatch) -> None:
    import sys
    import types

    from talaria_sidecar.methods import commands

    monkeypatch.setitem(sys.modules, "hermes_cli", sys.modules.get("hermes_cli") or types.ModuleType("hermes_cli"))
    monkeypatch.setitem(sys.modules, "hermes_cli.commands", types.SimpleNamespace(resolve_command=lambda name: types.SimpleNamespace(name="initiate-setup") if name in {"initiate-setup", "initiate_setup"} else None))
    real = commands.importlib.util.find_spec
    monkeypatch.setattr(commands.importlib.util, "find_spec", lambda name, *a: None if name == "agent.initiate_setup_prompt" else real(name, *a))
    assert commands._prompt_mode("initiate-setup") == "unsupported"
    assert commands.expand_prompt("/initiate_setup", "", None) == {"name": "initiate-setup", "message": None}
