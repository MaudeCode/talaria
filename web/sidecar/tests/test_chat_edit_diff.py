"""TAL-909: a ``write_file`` edit's unified diff, from the Agent's before-snapshot, rides the live ``tool_complete`` frame
and the ``display_metadata`` the Agent persists on the tool-result row; a remote terminal backend yields neither."""

from __future__ import annotations

import json
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent

# Runs on the Agent interpreter: a stand-in AIAgent that calls the turn's callbacks in the Agent's order (start, the
# tool's write, the pre-flush metadata callback, complete) around a real file.
PROBE = """
import json, os, sys
from pathlib import Path
sys.path.append(sys.argv[1])
from talaria_sidecar.home import scoped_home
from talaria_sidecar.methods import chat

target = Path(sys.argv[2])
target.write_text("one\\ntwo\\n", encoding="utf-8")
persisted = {}

class FakeAgent:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

    def run_conversation(self, **kwargs):
        args = {"path": str(target), "content": "one\\nthree\\n"}
        self.kwargs["tool_start_callback"]("call_w", "write_file", args)
        target.write_text(args["content"], encoding="utf-8")
        result = json.dumps({"bytes_written": 10})
        persisted["display_metadata"] = self.kwargs["tool_result_metadata_callback"]("call_w", "write_file", args, result)
        self.kwargs["tool_complete_callback"]("call_w", "write_file", args, result)
        return {"final_response": "ok", "messages": [{"role": "assistant", "content": "ok"}]}

class Ctx:
    cancelled = False

    def __init__(self):
        self.frames = []

    def emit(self, event, data=None):
        self.frames.append((event, data or {}))

chat._resolve_runtime = lambda provider, model: {"model": "m", "provider": "p"}
chat._agent_class = lambda: FakeAgent
home = Path(os.environ["HERMES_HOME"])
ctx = Ctx()
params = {"profile_home": str(home), "session_id": "s1", "stream_id": "st1", "user_message": "hi", "model": "m", "model_provider": "p", "enabled_toolsets": ["memory"]}
with scoped_home(home):
    result = chat.start(ctx, params)
complete = [data for event, data in ctx.frames if event == "tool_complete"]
print(json.dumps({"status": result["status"], "live": complete[0].get("display_metadata"), **persisted}))
"""


def _run(tmp_path, **env: str) -> dict:
    root = tmp_path / ".hermes"
    root.mkdir()
    target = tmp_path / "work" / "notes.txt"
    target.parent.mkdir()
    run = subprocess.run([AGENT_PYTHON, "-c", PROBE, str(AGENT_DIR), str(target)], env=isolated_env(root, **env), capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    out = json.loads(run.stdout.strip().splitlines()[-1])
    assert out["status"] == "completed", out
    return out


@requires_agent
def test_a_write_file_edit_carries_its_diff_live_and_on_the_persisted_row(tmp_path) -> None:
    out = _run(tmp_path)
    diff = out["display_metadata"]["diff"]
    assert diff.startswith("--- a/") and "notes.txt" in diff.splitlines()[0], diff
    assert "-two\n+three\n" in diff, diff
    # The live frame carries the same metadata the Agent persists, so a reload shows what the turn showed.
    assert out["live"] == out["display_metadata"], out


@requires_agent
def test_a_remote_terminal_backend_yields_no_diff(tmp_path) -> None:
    out = _run(tmp_path, TERMINAL_ENV="ssh")
    assert out["display_metadata"] in ({}, None), out
    assert out["live"] is None, out
