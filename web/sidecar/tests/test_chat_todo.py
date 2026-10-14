"""TAL-889: a real turn's todo tool call carries its whole result as ``todo_result``, so the server's live ``todo_state``
follows it. The Agent defers ``todo_list`` behind the ``tool_call`` bridge by default. Real sidecar, pinned Agent, disposable home."""

from __future__ import annotations

import json
import pathlib

import pytest

from conftest import OneToolCallModel, SidecarProcess, requires_agent, serve_model

pytestmark = requires_agent

TODOS = [{"id": "1", "content": "write repro", "status": "in_progress"}]


class _Todo(OneToolCallModel):
    """Calls the todo tool through whichever surface the turn offers: the ``tool_call`` bridge, else ``todo_list``."""

    offered: list[list[str]] = []

    def first_call(self, body: dict) -> dict:
        names = [t["function"]["name"] for t in body.get("tools", [])]
        type(self).offered.append(names)
        if "tool_call" in names:
            return {"name": "tool_call", "arguments": json.dumps({"calls": [{"name": "todo_list", "arguments": {"todos": TODOS}}]})}
        return {"name": "todo_list", "arguments": json.dumps({"todos": TODOS})}


@pytest.mark.parametrize("tool_search, bridged", [("", True), ("tools:\n  tool_search:\n    defer: []\n", False)], ids=["bridged", "direct"])
def test_a_todo_tool_call_carries_its_whole_result(hermes_home: pathlib.Path, tool_search: str, bridged: bool) -> None:
    model = type("Stub", (_Todo,), {"offered": []})
    with serve_model(model) as url:
        (hermes_home / "config.yaml").write_text(f"model:\n  provider: custom\n  default: stub-model\n  base_url: {url}\n  api_key: sk-stub\n{tool_search}")
        proc = SidecarProcess(hermes_home)
        try:
            params = {"profile_home": str(hermes_home), "session_id": "web-todo", "stream_id": "st-todo", "user_message": "plan it", "conversation_history": [],
                      "model": "stub-model", "model_provider": "custom", "workspace": str(hermes_home.parent), "enabled_toolsets": ["todo"]}
            message, frames = proc.call("chat.start", params, timeout=120)
            assert message.get("result", {}).get("status") == "completed", (message, proc.stderr_lines[-20:])
        finally:
            proc.close()
    turn_tools = [names for names in model.offered if names]  # auxiliary requests offer no tools
    assert turn_tools and ("tool_call" in turn_tools[0]) is bridged, model.offered
    completes = [f["data"] for f in frames if f.get("event") == "tool_complete"]
    assert [c["name"] for c in completes] == ["todo_list"], completes
    assert json.loads(completes[0]["todo_result"])["todos"] == TODOS
