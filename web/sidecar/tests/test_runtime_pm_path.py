"""PM tool activation at the sidecar's Agent-import boundary, without a real Agent."""

import json
import os
import subprocess
import sys

import pytest

from conftest import SIDECAR_ROOT


@pytest.mark.parametrize("managed", [True, False])
def test_runtime_resolves_managed_tools_before_agent_import(tmp_path, managed):
    agent = tmp_path / "agent"
    agent.mkdir()
    cli = agent / "hermes_cli"
    cli.mkdir()
    (cli / "__init__.py").write_text("")
    (cli / "auth.py").write_text("")
    bin_dir = tmp_path / "store" / "bin"
    bin_dir.mkdir(parents=True)
    for tool in ("node", "rg", "ffmpeg"):
        binary = bin_dir / tool
        binary.write_text(f"#!/bin/sh\nprintf 'managed-{tool}'\n")
        binary.chmod(0o755)
    if managed:
        pm = agent / "pm"
        pm.mkdir()
        (pm / "__init__.py").write_text(
            "import os\n"
            f"def store_first_path(path):\n    return {str(bin_dir)!r} + os.pathsep + path\n"
        )
    (agent / "run_agent.py").write_text(
        "import shutil, subprocess\n"
        "class AIAgent: pass\n"
        + ("for name in ('node', 'rg', 'ffmpeg'):\n"
           "    assert shutil.which(name), f'missing managed tool: {name}'\n"
           "    assert subprocess.check_output([name], text=True) == f'managed-{name}'\n" if managed else "")
    )
    result = subprocess.run(
        [sys.executable, "-c", (
            "import json, os\nfrom pathlib import Path\n"
            "from talaria_sidecar.runtime import AgentRuntime\n"
            f"runtime = AgentRuntime(Path({str(tmp_path)!r}), Path({str(agent)!r}))\n"
            "runtime.load()\nprint(json.dumps({'loaded': runtime.loaded, 'path': os.environ['PATH']}))\n"
        )],
        env={"HOME": str(tmp_path), "HERMES_HOME": str(tmp_path / "state"), "PATH": "",
             "PYTHONPATH": os.pathsep.join([str(SIDECAR_ROOT), str(agent)]),
             **({"LD_LIBRARY_PATH": os.environ["LD_LIBRARY_PATH"]} if "LD_LIBRARY_PATH" in os.environ else {})},
        capture_output=True, text=True, timeout=15,
    )
    assert result.returncode == 0, result.stderr
    outcome = json.loads(result.stdout)
    assert outcome["loaded"] is True
    assert outcome["path"] == (str(bin_dir) + os.pathsep if managed else "")
