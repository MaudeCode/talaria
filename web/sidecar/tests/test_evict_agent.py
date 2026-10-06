"""TAL-526: a cache-only agent eviction keeps the session's approval grants and parked approvals; delete/clear ends them."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent

pytestmark = requires_agent


def test_cache_only_eviction_keeps_approval_state_and_a_live_runs_agent(tmp_path: Path) -> None:
    root = tmp_path / ".hermes"
    root.mkdir()
    (root / "config.yaml").write_text("approvals:\n  mode: manual\n")
    env = isolated_env(root)
    probe = Path(__file__).with_name("evict_grants_probe.py")
    run = subprocess.run([AGENT_PYTHON, str(probe), str(AGENT_DIR)], env=env, capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    assert json.loads(run.stdout.strip().splitlines()[-1]) == {
        "idle_evicted": True,
        "grant_after_switch": True,
        "live_evicted": False,
        "live_agent_cached": True,
        "pending_after_switch": 1,
        "clear_evicted": True,
        "grant_after_clear": False,
        "parked_released": False,
    }
