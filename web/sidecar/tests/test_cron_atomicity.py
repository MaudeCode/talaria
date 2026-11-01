"""TAL-1623: scheduled-task creation and resumption are atomic to concurrent readers and Agent store writers."""

from __future__ import annotations

import pathlib
import subprocess

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent


@requires_agent
@pytest.mark.parametrize("boundary", ["create", "resume"])
def test_store_transaction_publishes_one_complete_job_state(tmp_path: pathlib.Path, boundary: str) -> None:
    probe = pathlib.Path(__file__).with_name("probe_cron_atomicity.py")
    result = subprocess.run([AGENT_PYTHON, str(probe), str(AGENT_DIR), boundary],
                            env=isolated_env(tmp_path / "agent"), capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
    assert f"{boundary}: ok" in result.stdout
