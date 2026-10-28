"""The installed Agent's private TTS registration and profile credential scope must remain compatible."""
from pathlib import Path
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent


@requires_agent
def test_native_tts_providers_and_profile_credentials(tmp_path):
    probe = Path(__file__).with_name('probe_tts.py')
    result = subprocess.run([AGENT_PYTHON, str(probe), str(AGENT_DIR)],
                            env=isolated_env(tmp_path / 'agent'), capture_output=True, text=True, timeout=90)
    assert result.returncode == 0, result.stdout + result.stderr
