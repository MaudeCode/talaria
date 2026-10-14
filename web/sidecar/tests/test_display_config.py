"""The display section Web's reasoning toggle writes stays on Web under the pinned Agent's resolver (TAL-895)."""

from __future__ import annotations

import json
import pathlib
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent

PLATFORMS = ("telegram", "discord", "slack", "signal", "email", "webui")


def resolved_show_reasoning(home: pathlib.Path, config: dict) -> dict[str, bool]:
    code = (
        "import json, sys; sys.path.insert(0, sys.argv[1])\n"
        "from gateway.display_config import resolve_display_setting\n"
        "config = json.loads(sys.argv[2])\n"
        "print(json.dumps({p: resolve_display_setting(config, p, 'show_reasoning') for p in json.loads(sys.argv[3])}))"
    )
    out = subprocess.check_output([AGENT_PYTHON, "-c", code, str(AGENT_DIR), json.dumps(config), json.dumps(PLATFORMS)], env=isolated_env(home), text=True)
    return json.loads(out)


@requires_agent
def test_web_reasoning_toggle_section_leaves_gateway_platforms_alone(hermes_home: pathlib.Path) -> None:
    # The exact section settings.test.ts asserts after `reasoning.set display=show`.
    shown = resolved_show_reasoning(hermes_home, {"display": {"platforms": {"webui": {"show_reasoning": True}}}})
    assert shown == {"telegram": False, "discord": False, "slack": False, "signal": False, "email": False, "webui": True}
    hidden = resolved_show_reasoning(hermes_home, {"display": {"platforms": {"webui": {"show_reasoning": False}}, "show_reasoning": True}})
    assert hidden["webui"] is False and hidden["telegram"] is True
