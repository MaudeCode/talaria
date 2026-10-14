"""TAL-897: deleting or clearing a session, and sidecar shutdown, cancel its agent's post-turn background review fork;
a model switch or truncate leaves it running."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent

pytestmark = requires_agent

ENDED = ["session deleted or cleared", "session ended"]


def test_delete_clear_and_shutdown_cancel_the_admitted_background_review(tmp_path: Path) -> None:
    root = tmp_path / ".hermes"
    root.mkdir()
    probe = Path(__file__).with_name("review_cancel_probe.py")
    run = subprocess.run([AGENT_PYTHON, str(probe), str(AGENT_DIR)], env=isolated_env(root), capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    out = json.loads(run.stdout.strip().splitlines()[-1])
    # The Agent waits 2 s for an acknowledgement, then lets the eviction proceed.
    assert out.pop("wedged_seconds") <= 3
    assert out == {
        "switch": [],
        "switch_review_live": True,
        "deleted": [ENDED],
        "running": [ENDED],
        "wedged_evicted": True,
        "wedged": [ENDED],
        "drained": [["sidecar shutting down", "session ended"]],
    }
