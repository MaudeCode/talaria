"""TAL-514: an approval the Agent drops after ``approvals.timeout`` is withdrawn with an ``approval_resolved`` frame."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent

pytestmark = requires_agent


def test_an_approval_the_agent_times_out_is_withdrawn(tmp_path: Path) -> None:
    root = tmp_path / ".hermes"
    root.mkdir()
    # Manual approvals: a smart-mode guardian would call a provider before the prompt parks.
    (root / "config.yaml").write_text("approvals:\n  mode: manual\n  timeout: 1\n")
    env = isolated_env(root)
    probe = Path(__file__).with_name("approval_timeout_probe.py")
    run = subprocess.run([AGENT_PYTHON, str(probe), str(AGENT_DIR)], env=env, capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    assert json.loads(run.stdout.strip().splitlines()[-1]) == {
        "status": "completed",
        "events": ["approval", "approval_resolved"],
        "resolved": [{"same_id": True, "reason": "timeout"}],
        "agent_pending": [],
    }
