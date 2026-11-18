"""TAL-903: a Web turn anchors the Agent's subdirectory-hint discovery at the session workspace when the server marks it
a host path, so a tool call under a project subdirectory loads that directory's AGENTS.md. Real sidecar, pinned Agent, disposable homes, stub model."""

from __future__ import annotations

import io
import json
import pathlib

from conftest import OneToolCallModel, SidecarProcess, requires_agent, serve_model
from talaria_sidecar.methods import chat
from test_chat_turn import Ctx, FakeAgent, _params, _patch


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


def test_an_agent_without_the_cwd_kwarg_is_built_as_before(monkeypatch, tmp_path: pathlib.Path) -> None:
    """``_supported`` passes a constructor only the kwargs it declares: ``cwd`` would raise TypeError here."""
    _patch(monkeypatch)

    class NamedParameterAgent(FakeAgent):
        def __init__(self, model=None, provider=None, base_url=None, api_key=None, platform=None, quiet_mode=None, enabled_toolsets=None,
                     disabled_toolsets=None, session_id=None, stream_delta_callback=None, reasoning_callback=None, tool_progress_callback=None,
                     clarify_callback=None):
            super().__init__(model=model, session_id=session_id)

    monkeypatch.setattr(chat, "_agent_class", lambda: NamedParameterAgent)
    workspace = _project(tmp_path, "alpha", "ALPHA-AREA-RULE")
    params = {**_params("st-no-cwd"), "profile_home": str(tmp_path), "workspace": str(workspace), "workspace_local": True}
    assert chat.start(Ctx(), params)["status"] == "completed"
    assert FakeAgent.instances[0].kwargs == {"model": "m", "session_id": "s1"}
