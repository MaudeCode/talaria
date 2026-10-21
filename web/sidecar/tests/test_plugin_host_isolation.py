"""Plugin listing and plugin slash commands under ``plugins.isolation`` (TAL-820), driven against the pinned Agent.

Each profile ships a synthetic third-party plugin whose command reports the process and home it ran in. Nothing touches
``~/.hermes`` or a real account.
"""

from __future__ import annotations

import json
import pathlib

import pytest

from conftest import AGENT_DIR, SidecarProcess, load_schema, requires_agent, validate

PLUGIN = """
import os


def register(ctx):
    ctx.register_command({command!r}, lambda args: f"{{os.getpid()}}|{{os.environ.get('HERMES_HOME')}}|{{args}}", description="Probe")
"""


def _seed(home: pathlib.Path, plugin: str, isolation: str) -> None:
    path = home / "plugins" / plugin
    path.mkdir(parents=True)
    (path / "plugin.yaml").write_text(f"name: {plugin}\nversion: 0.0.1\ndescription: Synthetic probe\n")
    (path / "__init__.py").write_text(PLUGIN.format(command=f"{plugin}-where"))
    (home / "config.yaml").write_text(f"plugins:\n  isolation: {isolation}\n  enabled: [{plugin}]\n")


@requires_agent
@pytest.mark.skipif(AGENT_DIR is None or not (AGENT_DIR / "hermes_cli/plugin_host.py").is_file(), reason="Agent has no plugin host")
@pytest.mark.parametrize("isolation", ["in_process", "host"])
def test_each_profiles_plugin_lists_and_runs_its_command_in_its_own_scope(tmp_path: pathlib.Path, isolation: str) -> None:
    home = tmp_path / "home" / ".hermes"
    other = home / "profiles" / "other"
    other.mkdir(parents=True)
    profiles = {home: "probe-root", other: "probe-other"}
    for profile, plugin in profiles.items():
        _seed(profile, plugin, isolation)
    sidecar = SidecarProcess(home)
    try:
        for profile, plugin in profiles.items():
            params = {"profile_home": str(profile)}
            listed = sidecar.result("plugins.list", {**params, "selected_providers": {}})
            assert validate(listed, load_schema("plugins.list")) == []
            assert [(row["name"], row["enabled"]) for row in listed["plugins"] if row["name"].startswith("probe-")] == [(plugin, True)]

            commands = sidecar.result("commands.registry", params)["commands"]
            assert [row["name"] for row in commands if row["name"].startswith("probe-")] == [f"{plugin}-where"]

            result = sidecar.result("commands.exec", {**params, "command": f"/{plugin}-where hi"})
            assert validate(result, load_schema("commands.exec")) == []
            assert result["source"] == "plugin"
            pid, plugin_home, args = result["output"].split("|")
            assert args == "hi"
            if isolation == "host":
                # The plugin runs in its profile's host process with only that profile's environment.
                assert int(pid) != sidecar.proc.pid
                assert pathlib.Path(plugin_home).resolve() == profile.resolve()
            else:
                assert int(pid) == sidecar.proc.pid

            # Another profile's command is unknown here.
            stranger = next(p for p in profiles.values() if p != plugin)
            error, _ = sidecar.call("commands.exec", {**params, "command": f"/{stranger}-where"})
            assert error.get("error", {}).get("data", {}).get("condition") == "command_not_found", error
    finally:
        sidecar.close()


@requires_agent
def test_isolation_survey_reports_each_profiles_mode_and_installed_plugins_without_loading_them(tmp_path: pathlib.Path) -> None:
    home = tmp_path / "home" / ".hermes"
    work, empty = home / "profiles" / "work", home / "profiles" / "empty"
    for profile in (work, empty):
        profile.mkdir(parents=True)
    _seed(home, "probe-root", "in_process")
    _seed(work, "probe-work", "host")
    # A manifest-less category provider and an installed-but-disabled plugin still count as installed.
    (work / "plugins" / "model-providers" / "probe-provider").mkdir(parents=True)
    (work / "plugins" / "model-providers" / "probe-provider" / "plugin.yaml").write_text("name: probe-provider\nkind: model-provider\n")
    (work / "plugins" / "probe-off").mkdir()
    (work / "plugins" / "probe-off" / "plugin.yaml").write_text("name: probe-off\n")
    (empty / "config.yaml").write_text("plugins:\n  isolation: bogus\n")
    sidecar = SidecarProcess(home)
    try:
        result = sidecar.result("plugins.isolation", {"base_home": str(home)})
        assert validate(result, load_schema("plugins.isolation")) == []
        assert result["profiles"] == [
            {"name": "default", "isolation": "in_process", "third_party_plugins": 1},
            {"name": "empty", "isolation": "in_process", "third_party_plugins": 0},
            {"name": "work", "isolation": "host", "third_party_plugins": 3},
        ]
        # Surveying loads no named profile's plugins (the launch profile's load at sidecar start).
        assert not any("probe-work" in line and "Loading plugin" in line for line in sidecar.stderr_lines)
    finally:
        sidecar.close()


SESSION_PLUGIN = """
from agent.runtime_cwd import scoped_session_cwd
from gateway.session_context import get_session_env


def register(ctx):
    ctx.register_command("probe-session", lambda args: f"{get_session_env('HERMES_SESSION_ID')}|{scoped_session_cwd()}", description="Probe")
"""


@requires_agent
def test_plugin_command_runs_under_the_invoking_chats_session_binding(tmp_path: pathlib.Path) -> None:
    """TAL-904: like the Agent's gateway and TUI, a chat's plugin command sees that chat's session and workspace."""
    home = tmp_path / "home" / ".hermes"
    path = home / "plugins" / "probe-session"
    path.mkdir(parents=True)
    (path / "plugin.yaml").write_text("name: probe-session\nversion: 0.0.1\ndescription: Synthetic probe\n")
    (path / "__init__.py").write_text(SESSION_PLUGIN)
    (home / "config.yaml").write_text("plugins:\n  enabled: [probe-session]\n")
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    sidecar = SidecarProcess(home)
    try:
        params = {"profile_home": str(home), "command": "/probe-session"}
        bound = sidecar.result("commands.exec", {**params, "session_id": "chat-904", "workspace": str(workspace)})
        assert bound["output"] == f"chat-904|{workspace}"
        # Without a chat (Settings) nothing is bound.
        assert sidecar.result("commands.exec", params)["output"] == "|"
    finally:
        sidecar.close()


CONTEXT_PLUGIN = """
import json


def _observe(**kwargs):
    with open({log!r}, "a") as handle:
        handle.write(json.dumps(kwargs) + "\\n")


def register(ctx):
    ctx.register_command("probe-context", lambda args, *, session_id="", platform="": f"{{args}}|{{session_id}}|{{platform}}",
                         description="Probe")
    ctx.register_command("probe-legacy", lambda args: f"legacy|{{args}}", description="Probe")
    ctx.register_hook("pre_command", _observe)
"""


@requires_agent
def test_web_commands_pass_session_context_to_plugins_and_fire_pre_command(tmp_path: pathlib.Path) -> None:
    """TAL-1267: like the Agent's CLI, TUI and gateway, a Web command passes its session to a plugin handler that declares
    it (v0.22.3+ ``invoke_plugin_command``) and fires ``pre_command`` once per recognised command, prompt built-ins included."""
    home = tmp_path / "home" / ".hermes"
    log = tmp_path / "pre_command.jsonl"
    path = home / "plugins" / "probe-context"
    path.mkdir(parents=True)
    (path / "plugin.yaml").write_text("name: probe-context\nversion: 0.0.1\ndescription: Synthetic probe\n")
    (path / "__init__.py").write_text(CONTEXT_PLUGIN.format(log=str(log)))
    (home / "config.yaml").write_text("plugins:\n  enabled: [probe-context]\n")
    sidecar = SidecarProcess(home)
    try:
        params = {"profile_home": str(home)}
        context = sidecar.result("commands.exec", {**params, "command": "/probe-context hi", "session_id": "chat-1267"})
        # Agents before v0.22.3 have no context-aware dispatch: the handler keeps its one-argument call.
        dispatch = AGENT_DIR is not None and (AGENT_DIR / "hermes_cli/plugin_command_dispatch.py").is_file()
        assert context["output"] == ("hi|chat-1267|webui" if dispatch else "hi||")
        assert sidecar.result("commands.exec", {**params, "command": "/probe-legacy there"})["output"] == "legacy|there"
        assert sidecar.result("commands.exec", {**params, "command": "/reload_skills", "session_id": "chat-1267"})["source"] == "agent"
        error, _ = sidecar.call("commands.exec", {**params, "command": "/definitely-not-a-command"})
        assert error.get("error", {}).get("data", {}).get("condition") == "command_not_found", error
        # TAL-1279: a prompt built-in fires it too, by canonical name, even one this Agent cannot expand; other text does not.
        expand = {**params, "workspace": "", "enabled_toolsets": None}
        assert sidecar.result("commands.expand_prompt", {**expand, "command": "/plan x", "session_id": "chat-1279"})["message"]
        assert sidecar.result("commands.expand_prompt", {**expand, "command": "/bp daily"}) == {"name": "blueprint", "message": None}
        for text in ("/probe-context hi", "/etc/hosts looks wrong"):
            assert sidecar.result("commands.expand_prompt", {**expand, "command": text, "session_id": "chat-1279"})["name"] is None

        # The Agent stamps its own telemetry fields beside the hook arguments.
        arguments = ("surface", "command", "alias_used", "args_raw", "session_key", "platform")
        observed = [{key: row[key] for key in arguments} for row in map(json.loads, log.read_text().splitlines())] if log.exists() else []
        webui = {"surface": "webui", "platform": "webui"}
        assert observed == [
            {**webui, "command": "probe-context", "alias_used": "probe-context", "args_raw": "hi", "session_key": "chat-1267"},
            {**webui, "command": "probe-legacy", "alias_used": "probe-legacy", "args_raw": "there", "session_key": None},
            {**webui, "command": "reload-skills", "alias_used": "reload_skills", "args_raw": "", "session_key": "chat-1267"},
            {**webui, "command": "plan", "alias_used": "plan", "args_raw": "x", "session_key": "chat-1279"},
            {**webui, "command": "blueprint", "alias_used": "bp", "args_raw": "daily", "session_key": None},
        ]
    finally:
        sidecar.close()
