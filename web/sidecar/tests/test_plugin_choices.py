"""Native plugin choice API through the real commands.exec RPC, without a provider."""
import json
import pathlib

from conftest import AGENT_DIR, SidecarProcess, requires_agent


PLUGIN = '''
def register(ctx):
    def choose(args):
        try:
            from hermes_cli.plugin_choices import ask_choice
        except ImportError:
            return "unsupported"
        choices = ["dev", "prod"] if args == "string" else [
            {"value": "private-dev", "label": "Development", "description": "Safe sandbox"},
            {"value": "private-prod", "label": "Production", "description": "Live environment"}]
        result = ask_choice("Which environment?", choices)
        from pathlib import Path
        from hermes_constants import get_hermes_home
        with (Path(get_hermes_home()) / "choice-results.txt").open("a") as log:
            log.write(repr(result) + "\\n")
        return repr(result)
    ctx.register_command("probe-choice", choose, description="Synthetic choice")
    async def async_choice(args):
        return choose(args)
    ctx.register_command("probe-async-choice", async_choice, description="Unsupported async choice")
'''


@requires_agent
def test_real_plugin_command_choice_round_trip(tmp_path: pathlib.Path) -> None:
    home = tmp_path / "hermes"
    plugin = home / "plugins" / "probe-choice"
    plugin.mkdir(parents=True)
    (plugin / "plugin.yaml").write_text("name: probe-choice\nversion: 0.0.1\ndescription: Synthetic choice\n")
    (plugin / "__init__.py").write_text(PLUGIN)
    (home / "config.yaml").write_text("plugins:\n  enabled: [probe-choice]\nclarify:\n  timeout: 1\n")
    supported = AGENT_DIR is not None and (AGENT_DIR / "hermes_cli/plugin_choices.py").is_file()
    sidecar = SidecarProcess(home)
    try:
        for shape, reply, expected in [("string", "prod", "'prod'"), ("described", "Development — Safe sandbox", "'private-dev'"),
                                       ("described", "not an option", "None"), ("string", None, "None"), ("string", "cancel", "None")]:
            request = sidecar.request("commands.exec", {"profile_home": str(home), "session_id": "choice-session", "command": f"/probe-choice {shape}"})
            prompts, resolved = [], []
            while True:
                message = sidecar.next_message()
                assert message is not None
                if message.get("id") == request:
                    if supported and reply == "cancel":
                        assert message.get("error", {}).get("data", {}).get("condition") == "cancelled", message
                        assert (home / "choice-results.txt").read_text().splitlines()[-1] == "None"
                    else:
                        assert message.get("result") == {"output": expected if supported else "unsupported", "source": "plugin"}, message
                    break
                frame = message.get("params", {})
                if frame.get("id") != request:
                    continue
                if frame.get("event") == "clarify":
                    data = frame["data"]
                    prompts.append(data)
                    assert data["session_id"] == "choice-session"
                    assert data["questions"][0]["question"] == "Which environment?"
                    if reply == "cancel":
                        sidecar.request("rpc.cancel", {"id": request})
                    elif reply is not None:
                        sidecar.request("clarify.respond", {"profile_home": str(home), "session_id": "choice-session", "clarify_id": data["clarify_id"],
                                                           "response": json.dumps({"answers": {"q0": reply}})})
                elif frame.get("event") == "clarify_resolved":
                    resolved.append(frame["data"])
            assert len(prompts) == len(resolved) == (1 if supported else 0)
            if prompts:
                assert resolved[0]["clarify_id"] == prompts[0]["clarify_id"]
                assert sidecar.result("clarify.respond", {"profile_home": str(home), "session_id": "choice-session", "clarify_id": prompts[0]["clarify_id"], "response": "late"}) == {"ok": False}
        assert sidecar.result("commands.exec", {"profile_home": str(home), "command": "/probe-choice string"})["output"] == ("None" if supported else "unsupported")
        assert sidecar.result("commands.exec", {"profile_home": str(home), "session_id": "choice-session", "command": "/probe-async-choice string"})["output"] == ("None" if supported else "unsupported")
    finally:
        sidecar.close()
