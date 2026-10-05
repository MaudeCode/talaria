"""TAL-528: leaving a session commits the cached Agent's transcript to memory under the session's profile."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, requires_agent

pytestmark = requires_agent


def test_commit_memory_hands_the_transcript_to_providers_in_the_session_profile(tmp_path: Path) -> None:
    root = tmp_path / ".hermes"
    alpha = root / "profiles" / "alpha"
    alpha.mkdir(parents=True)
    (alpha / ".env").write_text("ALPHA_ONLY=alpha\n")
    env = {"PATH": os.environ.get("PATH", ""), "HOME": str(tmp_path), "HERMES_HOME": str(root), "PYTHONPATH": str(SIDECAR_ROOT), "HERMES_STATE_DB_GUARD_BYPASS": "1"}
    if os.environ.get("LD_LIBRARY_PATH"):  # relocated actions/setup-python interpreter
        env["LD_LIBRARY_PATH"] = os.environ["LD_LIBRARY_PATH"]
    probe = Path(__file__).with_name("commit_memory_probe.py")
    run = subprocess.run([AGENT_PYTHON, str(probe), str(AGENT_DIR)], env=env, capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    assert json.loads(run.stdout.strip().splitlines()[-1]) == {
        "result": {"committed": True},
        "seen": [{
            "messages": [{"role": "user", "content": "remember the blue door"}, {"role": "assistant", "content": "noted"}],
            "home": str(alpha),
            "secret": "alpha",
        }],
    }
