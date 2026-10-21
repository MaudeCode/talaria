"""Real Agent cached-check and scan transaction compatibility, with disposable local Git state."""
from __future__ import annotations

import pathlib
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent


@requires_agent
def test_plugin_cached_update_and_scan_consent(tmp_path: pathlib.Path) -> None:
    probe = pathlib.Path(__file__).with_name("probe_plugin_update.py")
    result = subprocess.run([AGENT_PYTHON, str(probe), str(AGENT_DIR)], env=isolated_env(tmp_path),
                            capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
