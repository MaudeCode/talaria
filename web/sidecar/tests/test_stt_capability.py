"""``stt.capability`` reports the provider the Agent's own ``_get_provider`` picks (TAL-786)."""

from __future__ import annotations

import subprocess

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SidecarProcess, isolated_env, requires_agent

# Synthetic credentials and a local command: every built-in the old hand-rolled resolver knew,
# plus deepinfra, which it did not.
STT_ENV = {
    "HERMES_LOCAL_STT_COMMAND": "echo hi > {output_dir}/out.txt",
    "OPENAI_API_KEY": "sk-synthetic-openai",
    "DEEPINFRA_API_KEY": "synthetic-deepinfra",
}


def agent_provider(hermes_home) -> str:
    """The provider the Agent itself resolves for ``hermes_home``."""
    script = "from tools.transcription_tools import _get_provider, _load_stt_config; print(_get_provider(_load_stt_config()))"
    env = isolated_env(hermes_home, PYTHONPATH=str(AGENT_DIR), **STT_ENV)
    done = subprocess.run([AGENT_PYTHON, "-c", script], cwd=str(AGENT_DIR), env=env, capture_output=True, text=True, timeout=60, check=True)
    return done.stdout.strip().splitlines()[-1]


COMMAND_PROVIDER = "stt:\n  provider: mycmd\n  providers:\n    mycmd:\n      type: command\n      command: echo hi > {output_dir}/out.txt\n"


@requires_agent
@pytest.mark.parametrize(
    ("config", "expected"),
    [
        ("stt:\n  provider: local_command\n", {"available": True, "provider": "local_command", "streaming": False, "warm_supported": False}),
        ("stt:\n  provider: deepinfra\n", {"available": True, "provider": "deepinfra", "streaming": False, "warm_supported": False}),
        (COMMAND_PROVIDER, {"available": True, "provider": "mycmd", "streaming": False, "warm_supported": False}),
        # The Agent passes an unknown name through; stt.transcribe fails it as not registered.
        ("stt:\n  provider: not-registered\n", {"available": False, "provider": "not-registered", "streaming": False, "warm_supported": False}),
        ("", None),  # auto-detect: whatever the Agent picks
    ],
)
def test_capability_matches_agent_provider(hermes_home, config, expected):
    (hermes_home / "config.yaml").write_text(config)
    if expected is None:
        provider = agent_provider(hermes_home)
        expected = {"available": True, "provider": provider, "streaming": False, "warm_supported": provider == "local"}
    sidecar = SidecarProcess(hermes_home, env=STT_ENV)
    try:
        result = sidecar.result("stt.capability", {"profile_home": str(hermes_home)})
    finally:
        sidecar.close()
    assert result == expected
