"""TAL-500: turning YOLO on releases parked approvals with the caller's choice, so nothing outlives YOLO."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent

pytestmark = requires_agent


def test_enabling_yolo_releases_parked_approvals_once_and_they_prompt_after_it_turns_off(tmp_path: Path) -> None:
    root = tmp_path / ".hermes"
    root.mkdir()
    # Manual approvals: a smart-mode guardian would call a provider before the prompt parks.
    (root / "config.yaml").write_text("approvals:\n  mode: manual\n")
    env = isolated_env(root)
    probe = Path(__file__).with_name("yolo_release_probe.py")
    run = subprocess.run([AGENT_PYTHON, str(probe), str(AGENT_DIR)], env=env, capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    assert json.loads(run.stdout.strip().splitlines()[-1]) == {
        "released": 2,
        "choices": ["once", "once"],
        "approved": [True, True],
        "still_approved": [False, False],
        "prompts_again": True,
    }
