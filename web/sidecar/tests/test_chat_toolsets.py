"""``chat.start`` without a session override builds the Agent with the profile's ``platform_toolsets.cli``, resolved by
the pinned Agent's own ``_get_platform_tools`` under the turn's profile home; an override still replaces it."""

from __future__ import annotations

import json
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent

# Runs on the Agent interpreter: real config loading and toolset resolution, a stand-in AIAgent that records its kwargs.
PROBE = """
import json, os, sys
from pathlib import Path
sys.path.append(sys.argv[1])
from talaria_sidecar.home import scoped_home
from talaria_sidecar.methods import chat

seen = []

class FakeAgent:
    def __init__(self, **kwargs):
        seen.append(kwargs.get("enabled_toolsets"))

    def run_conversation(self, **kwargs):
        return {"final_response": "ok", "messages": []}

class Ctx:
    cancelled = False

    def emit(self, event, data=None):
        pass

chat._agent_class = lambda: FakeAgent
chat._resolve_runtime = lambda provider, model: {"model": "m", "provider": "p"}
root = Path(os.environ["HERMES_HOME"])
cases = [("custom", None), ("plain", None), ("legacy", None), ("custom", ["memory"])]
for i, (profile, override) in enumerate(cases):
    home = root if profile == "custom" else root / "profiles" / profile
    params = {"profile_home": str(home), "session_id": f"s{i}", "stream_id": f"st{i}", "user_message": "hi", "model": "m", "model_provider": "p", "enabled_toolsets": override}
    with scoped_home(home):
        result = chat.start(Ctx(), params)
    assert result["status"] == "completed", result
print(json.dumps(seen))
"""


@requires_agent
def test_turn_toolsets_follow_the_profile_config_unless_overridden(tmp_path) -> None:
    root = tmp_path / ".hermes"
    root.mkdir()
    (root / "config.yaml").write_text("platform_toolsets:\n  cli: [web, file, memory]\n")
    (root / "profiles" / "plain").mkdir(parents=True)
    (root / "profiles" / "legacy").mkdir(parents=True)
    (root / "profiles" / "legacy" / "config.yaml").write_text("platform_toolsets:\n  cli: [hermes]\n")
    env = isolated_env(root)
    run = subprocess.run([AGENT_PYTHON, "-c", PROBE, str(AGENT_DIR)], env=env, capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    custom, plain, legacy, override = json.loads(run.stdout.strip().splitlines()[-1])
    # The profile's saved CLI list, nothing it omitted.
    assert isinstance(custom, list) and {"web", "file", "memory"} <= set(custom), custom
    assert "terminal" not in custom and "browser" not in custom, custom
    # No saved list: the CLI default, with the Agent's default-off toolsets still off.
    assert isinstance(plain, list) and {"terminal", "file", "web"} <= set(plain), plain
    assert not {"homeassistant", "discord_admin", "kanban", "spotify"} & set(plain), plain
    # The legacy ``hermes`` composite name expands to the composites the Agent registers today.
    assert isinstance(legacy, list) and {"hermes-cli", "hermes-api-server"} <= set(legacy) and "hermes" not in legacy, legacy
    # A session-level override replaces the profile default.
    assert override == ["memory"]
