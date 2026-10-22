"""Exercise chat.start with the installed Agent's real clarify tool, without a provider."""

import json
import subprocess

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent


PROBE = r'''
import inspect, json, os, sys
sys.path.append(sys.argv[1])
from tools.clarify_tool import clarify_tool
from talaria_sidecar.methods import Registry, chat

shape, outcome = sys.argv[2:]
modern = "question" not in inspect.signature(clarify_tool).parameters
questions = [{"question": "Which env?", "choices": ["dev", "prod"], "multi_select": shape == "multi"}]
answers = {"q0": ["dev (Recommended)", "prod"] if shape == "multi" else "dev (Recommended)"}
if shape == "open":
    questions = [{"question": "What next?"}]
    answers = {"q0": "Run the tests"}
if shape == "batch":
    questions.append({"question": "Which checks?", "choices": ["unit", "integration"], "multi_select": True})
    answers["q1"] = ["unit (Recommended)", "integration"]
registry = Registry(runtime=None)
chat.register(registry)
tool_results, frames, acknowledgements = [], [], []

class Agent:
    def __init__(self, **kwargs):
        self.callback = kwargs["clarify_callback"]
    def interrupt(self, *args, **kwargs):
        pass
    def run_conversation(self, **kwargs):
        if modern:
            result = clarify_tool(questions, callback=self.callback)
        elif shape == "batch":
            result = clarify_tool("", questions=questions, callback=self.callback)
        else:
            result = clarify_tool(**questions[0], callback=self.callback)
        tool_results.append(json.loads(result))
        return {"final_response": "ok", "messages": []}

class Ctx:
    cancelled = False
    def emit(self, event, data=None):
        frames.append([event, data])
        if event != "clarify":
            return
        if outcome == "cancelled":
            registry.methods["chat.interrupt"](self, {"stream_id": "st-clarify"})
        elif outcome == "submitted":
            # Exactly the reply clarifyReply emits for the advertised frame shape.
            response = json.dumps({"answers": answers}) if data.get("questions") else (
                json.dumps(answers["q0"]) if isinstance(answers["q0"], list) else answers["q0"])
            acknowledgements.append(registry.methods["clarify.respond"](self, {
                "stream_id": "st-clarify", "clarify_id": data["clarify_id"], "response": response}))

chat._agent_class = lambda: Agent
chat._resolve_runtime = lambda provider, model: {"model": "m", "provider": "p"}
chat._discover_mcp_tools = lambda run: None
chat._profile_toolsets = lambda cfg=None: ["clarify"]
chat._profile_fallback_chain = lambda cfg=None: None
chat._main_model_request_overrides = lambda model, provider, base_url="", cfg=None: None
chat.checkpoint_kwargs = lambda cfg=None: {}
result = chat.start(Ctx(), {
    "profile_home": os.environ["HERMES_HOME"], "session_id": "s-clarify", "stream_id": "st-clarify",
    "user_message": "Ask me", "model": "m", "model_provider": "p", "clarify_timeout_seconds": 1 if outcome == "timed_out" else 0,
})
late = registry.methods["clarify.respond"](Ctx(), {"stream_id": "st-clarify", "response": "late"})
print(json.dumps({"modern": modern, "tool": tool_results, "frames": frames, "acks": acknowledgements,
                  "status": result["status"], "late": late, "run_released": chat._run_for({"stream_id": "st-clarify"}) is None}))
'''


@requires_agent
@pytest.mark.parametrize("shape", ["single", "multi", "open", "batch"])
@pytest.mark.parametrize("outcome", ["submitted", "timed_out", "cancelled"])
def test_real_agent_clarify_through_chat_start(tmp_path, shape, outcome):
    home = tmp_path / "hermes"
    home.mkdir()
    run = subprocess.run([AGENT_PYTHON, "-c", PROBE, str(AGENT_DIR), shape, outcome],
                         env=isolated_env(home), capture_output=True, text=True, timeout=60)
    assert run.returncode == 0, run.stderr[-4000:]
    observed = json.loads(run.stdout.strip().splitlines()[-1])
    tool = observed["tool"][0]
    assert "error" not in tool, tool
    prompts = [data for event, data in observed["frames"] if event == "clarify"]
    resolved = [data for event, data in observed["frames"] if event == "clarify_resolved"]
    assert len(prompts) == len(resolved) == 1
    assert resolved[0]["clarify_id"] == prompts[0]["clarify_id"]
    assert prompts[0]["timeout_seconds"] == (1 if outcome == "timed_out" else 0)
    assert observed["run_released"] and observed["late"] == {"ok": False}
    assert observed["status"] == ("cancelled" if outcome == "cancelled" else "completed")
    responses = tool.get("responses", [tool])
    if observed["modern"]:
        assert tool["outcome"] == outcome
        assert len(prompts[0]["questions"]) == len(responses)
    if outcome == "submitted":
        assert observed["acks"] == [{"ok": True, "clarify_id": prompts[0]["clarify_id"]}]
        expected = {"single": ["dev"], "multi": [["dev", "prod"]], "open": ["Run the tests"],
                    "batch": ["dev", ["unit", "integration"]]}[shape]
        assert [r["user_response"] for r in responses] == expected
    else:
        assert all(r["user_response"] in (None, "", []) for r in responses), tool
        if observed["modern"]:
            assert all(r["status"] == "unanswered" for r in responses)
            assert tool["notice"]
        elif shape == "batch":
            assert bool(tool.get("timed_out")) == (outcome == "timed_out")
