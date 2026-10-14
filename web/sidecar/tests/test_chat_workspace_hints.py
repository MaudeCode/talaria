"""TAL-903: a Web turn anchors the Agent's subdirectory-hint discovery at the session workspace when the server marks it
a host path, so a tool call under a project subdirectory loads that directory's AGENTS.md. Real sidecar, pinned Agent, disposable homes, stub model."""

from __future__ import annotations

import io
import json
import pathlib
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, OneToolCallModel, SidecarProcess, isolated_env, requires_agent, serve_model


class _ReadFile(OneToolCallModel):
    """Answers with one ``read_file`` of ``target``; records every request body."""

    target = ""
    bodies: list = []

    def first_call(self, body: dict) -> dict:
        return {"name": "read_file", "arguments": json.dumps({"path": self.target})}

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        type(self).bodies.append(json.loads(raw or b"{}"))
        self.rfile = io.BytesIO(raw)
        super().do_POST()


def _project(root: pathlib.Path, name: str, marker: str) -> pathlib.Path:
    path = root / name
    (path / "sub").mkdir(parents=True)
    (path / "sub" / "AGENTS.md").write_text(f"# Area rules\n\n{marker}\n")
    (path / "sub" / "notes.txt").write_text("plain notes\n")
    return path.resolve()


def _tool_results(bodies: list) -> list[str]:
    return [str(m.get("content")) for body in bodies for m in body.get("messages", []) if m.get("role") == "tool"]


@requires_agent
def test_a_turn_loads_the_local_workspace_subdirectory_hint_and_a_workspace_change_rebuilds_the_agent(hermes_home: pathlib.Path) -> None:
    first = _project(hermes_home.parent, "alpha", "ALPHA-AREA-RULE")
    second = _project(hermes_home.parent, "beta", "BETA-AREA-RULE")
    stub = type("Stub", (_ReadFile,), {"target": "", "bodies": []})
    with serve_model(stub) as url:
        (hermes_home / "config.yaml").write_text(f"model:\n  provider: custom\n  default: stub-model\n  base_url: {url}\n  api_key: sk-stub\n")
        proc = SidecarProcess(hermes_home)
        try:
            # The third turn's workspace is a remote backend's target-side path that happens to exist on the host too.
            turns = ((first, True, "ALPHA-AREA-RULE"), (second, True, "BETA-AREA-RULE"), (first, False, "ALPHA-AREA-RULE"))
            for turn, (workspace, local, marker) in enumerate(turns):
                stub.target = str(workspace / "sub" / "notes.txt")
                stub.bodies.clear()
                params = {"profile_home": str(hermes_home), "session_id": "web-hints", "stream_id": f"st-hints-{turn}", "user_message": "read the notes",
                          "conversation_history": [], "model": "stub-model", "model_provider": "custom", "workspace": str(workspace), "workspace_local": local,
                          "enabled_toolsets": ["file"]}
                result = proc.result("chat.start", params, timeout=120)
                assert result["status"] == "completed", (result, proc.stderr_lines[-20:])
                results = _tool_results(stub.bodies)
                assert results and "plain notes" in results[0], results
                assert (marker in results[0]) is local, (turn, results[0])
        finally:
            proc.close()


# Runs on the Agent interpreter: a stand-in AIAgent from before the ``cwd`` kwarg; passing it would raise TypeError.
NO_CWD_PROBE = """
import os, sys
from pathlib import Path
sys.path.append(sys.argv[1])
from talaria_sidecar.home import scoped_home
from talaria_sidecar.methods import chat

class OlderAgent:
    def __init__(self, model=None, provider=None, base_url=None, api_key=None, platform=None, quiet_mode=None, enabled_toolsets=None,
                 disabled_toolsets=None, session_id=None, stream_delta_callback=None, reasoning_callback=None, tool_progress_callback=None,
                 clarify_callback=None):
        pass

    def run_conversation(self, **kwargs):
        return {"final_response": "ok", "messages": []}

class Ctx:
    cancelled = False

    def emit(self, event, data=None):
        pass

chat._agent_class = lambda: OlderAgent
chat._resolve_runtime = lambda provider, model: {"model": "m", "provider": "p"}
home = Path(os.environ["HERMES_HOME"])
params = {"profile_home": str(home), "session_id": "s", "stream_id": "st", "user_message": "hi", "model": "m", "model_provider": "p", "enabled_toolsets": ["file"], "workspace": sys.argv[2], "workspace_local": True}
with scoped_home(home):
    result = chat.start(Ctx(), params)
assert result["status"] == "completed", result
"""


@requires_agent
def test_an_agent_without_the_cwd_kwarg_is_built_as_before(hermes_home: pathlib.Path) -> None:
    workspace = _project(hermes_home.parent, "alpha", "ALPHA-AREA-RULE")
    run = subprocess.run([AGENT_PYTHON, "-c", NO_CWD_PROBE, str(AGENT_DIR), str(workspace)], env=isolated_env(hermes_home), capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
