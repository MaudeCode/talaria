"""TAL-526: a cache-only agent eviction keeps the session's approval grants and parked approvals; delete/clear ends them."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, requires_agent

pytestmark = requires_agent


def test_cache_only_eviction_keeps_approval_state_and_a_live_runs_agent(tmp_path: Path) -> None:
    root = tmp_path / ".hermes"
    root.mkdir()
    (root / "config.yaml").write_text("approvals:\n  mode: manual\n")
    env = {"PATH": os.environ.get("PATH", ""), "HOME": str(tmp_path), "HERMES_HOME": str(root), "PYTHONPATH": str(SIDECAR_ROOT), "HERMES_STATE_DB_GUARD_BYPASS": "1",
           # Pattern detection parks the prompt; no tirith download writes into the synthetic home past the test.
           "TIRITH_ENABLED": "0"}
    if os.environ.get("LD_LIBRARY_PATH"):  # relocated actions/setup-python interpreter
        env["LD_LIBRARY_PATH"] = os.environ["LD_LIBRARY_PATH"]
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
