"""TAL-1274: the Agent's low-disk session auto-prune question (v0.22.3 ``hermes_cli.prune_advisor``), asked and answered from Web."""

from __future__ import annotations

import os
import pathlib
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, SidecarProcess, isolated_env, load_schema, requires_agent, validate

HAS_ADVISOR = AGENT_DIR is not None and (AGENT_DIR / "hermes_cli" / "prune_advisor.py").is_file()
# Every filesystem reports 1 GiB free of 100 GiB, under the Agent's 2 GiB low-disk floor.
LOW_DISK = """
import collections, shutil
shutil.disk_usage = lambda path: collections.namedtuple("usage", "total used free")(100 * 1024 ** 3, 99 * 1024 ** 3, 1024 ** 3)
"""
COMMANDS = "/autoprune on to enable, /autoprune off to keep everything (never asked again), /autoprune later to be reminded in a week."


def _seed(home: pathlib.Path) -> None:
    code = "import sys, pathlib; from hermes_state import SessionDB; db = SessionDB(db_path=pathlib.Path(sys.argv[1]) / 'state.db'); db.create_session('cli-1', source='cli'); db.close()"
    subprocess.run([AGENT_PYTHON, "-c", code, str(home)], env=isolated_env(home, PYTHONPATH=str(AGENT_DIR)), check=True, timeout=60)


def _advice(proc: SidecarProcess, home: pathlib.Path):
    result = proc.result("state_db.prune_advice", {"profile_home": str(home)})
    assert validate(result, load_schema("state_db.prune_advice")) == []
    return result["advice"]


def _exec(proc: SidecarProcess, home: pathlib.Path, command: str) -> dict:
    return proc.call("commands.exec", {"profile_home": str(home), "command": command})[0]


@requires_agent
def test_a_low_disk_asks_the_agents_question_until_web_answers_it(tmp_path: pathlib.Path, hermes_home: pathlib.Path) -> None:
    decided = hermes_home / "profiles" / "decided"
    decided.mkdir(parents=True)
    (decided / "config.yaml").write_text("sessions:\n  auto_prune: true\n", encoding="utf-8")
    for home in (hermes_home, decided):
        _seed(home)
    patch = tmp_path / "low-disk"
    patch.mkdir()
    (patch / "sitecustomize.py").write_text(LOW_DISK, encoding="utf-8")
    proc = SidecarProcess(hermes_home, env={"PYTHONPATH": os.pathsep.join([str(patch), str(SIDECAR_ROOT)])})
    try:
        advice = _advice(proc, hermes_home)
        if not HAS_ADVISOR:
            # Agents before v0.22.3 have no advisor: nothing to ask, and no /autoprune to run.
            assert advice is None
            assert _exec(proc, hermes_home, "/autoprune off")["error"]["data"]["condition"] == "command_not_found"
            return
        lines = advice["lines"]
        assert lines[0].startswith("Low disk space: 1.0 GB free of 100.0 GB. Your session history (state.db) uses "), lines
        assert lines[1].startswith("Auto-prune is off."), lines
        assert lines[-1] == COMMANDS
        # A profile whose config already sets the key is never asked.
        assert _advice(proc, decided) is None

        assert _exec(proc, hermes_home, "/autoprune later")["result"] == {"output": "OK, I'll ask again in a week if the disk is still low.", "source": "agent"}
        assert _advice(proc, hermes_home) is None

        off = _exec(proc, hermes_home, "/autoprune off")["result"]
        assert off["output"].startswith("Auto-prune is off and you will not be asked again."), off
        assert "auto_prune: false" in (hermes_home / "config.yaml").read_text(encoding="utf-8")
        # The answer clears the snooze, so only the saved key keeps the question away now.
        assert not (hermes_home / ".auto_prune_prompt.json").exists()
        assert _advice(proc, hermes_home) is None
    finally:
        proc.close()
