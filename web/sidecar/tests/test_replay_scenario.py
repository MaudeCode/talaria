"""The replay sidecar plays scenario turns for the phone test server (TAL-2622) and keeps the contract turn otherwise."""
import importlib.util
import json
import threading
from pathlib import Path

import pytest

REPLAY = Path(__file__).resolve().parents[1] / "scripts" / "replay_sidecar.py"
CEILING = 10  # seconds: the one bound on every wait for a frame from the turn thread

SCENARIO = {"chats": [
    {"title": "Tools", "turns": [{"user": "read the notes", "tools": [
        {"name": "read_file", "args": {"path": "notes/todo.md"}, "result": {"content": "- ship it", "total_lines": 1}},
        {"name": "terminal", "args": {"command": "ls"}, "result": "notes"},
    ], "reply": "| a | b |\n|---|---|\n| 1 | 2 |"}]},
    {"title": "Waiting", "turns": [{"user": "clean up", "approval": {"command": "rm -rf build", "tool": "terminal"},
                                    "clarify": {"question": "Which build?", "choices": ["debug", "release"], "multi_select": False},
                                    "reply": "Cleaned."}]},
]}


class Ctx:
    cancelled = False

    def __init__(self):
        self.frames, self._changed = [], threading.Condition()

    def emit(self, event, data=None):
        with self._changed:
            self.frames.append((event, data))
            self._changed.notify_all()

    def wait_for(self, event):
        with self._changed:
            assert self._changed.wait_for(lambda: any(name == event for name, _ in self.frames), CEILING), f"no {event} frame"
        return next(data for name, data in self.frames if name == event)


@pytest.fixture
def methods(tmp_path, monkeypatch):
    scenario = tmp_path / "scenario.json"
    scenario.write_text(json.dumps(SCENARIO))
    monkeypatch.setenv("TALARIA_SIDECAR_REPLAY_SCENARIO", str(scenario))
    spec = importlib.util.spec_from_file_location("replay_under_test", REPLAY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.build_methods()


def start(methods, ctx, session_id, message):
    """Runs chat.start on its own thread, as the RPC server does, and returns a getter for its result."""
    out = {}
    turn = threading.Thread(target=lambda: out.update(result=methods["chat.start"](ctx, {"session_id": session_id, "user_message": message})))
    turn.start()

    def result():
        turn.join(CEILING)
        assert not turn.is_alive(), "the turn did not settle"
        return out["result"]
    return turn, result


def test_a_scripted_turn_streams_its_tools_and_reply_and_returns_them_as_transcript_rows(methods):
    ctx = Ctx()
    result = methods["chat.start"](ctx, {"session_id": "s1", "user_message": "read the notes"})
    events = [name for name, _ in ctx.frames]
    assert events == ["tool", "tool_complete", "tool", "tool_complete", "token"]
    started, completed = ctx.frames[0][1], ctx.frames[1][1]
    assert started == {"event_type": "tool.started", "name": "read_file", "preview": None, "args": {"path": "notes/todo.md"}, "tid": started["tid"]}
    assert completed["event_type"] == "tool.completed" and completed["tid"] == started["tid"]
    assert completed["raw_result"] == {"content": "- ship it", "total_lines": 1}
    assert completed["raw_args"] == {"path": "notes/todo.md"}
    assert ctx.frames[3][1]["preview"] == "notes"
    assert ctx.frames[4][1] == {"text": "| a | b |\n|---|---|\n| 1 | 2 |"}

    user, calls, read, ls, reply = result["messages"]
    assert user == {"role": "user", "content": "read the notes"}
    assert [(c["id"], c["function"]["name"], json.loads(c["function"]["arguments"])) for c in calls["tool_calls"]] == [
        (started["tid"], "read_file", {"path": "notes/todo.md"}), (ctx.frames[2][1]["tid"], "terminal", {"command": "ls"})]
    assert (read["role"], read["tool_call_id"], json.loads(read["content"])) == ("tool", started["tid"], {"content": "- ship it", "total_lines": 1})
    assert (ls["tool_call_id"], ls["content"]) == (ctx.frames[2][1]["tid"], "notes")
    assert reply == {"role": "assistant", "content": "| a | b |\n|---|---|\n| 1 | 2 |"}
    assert result["status"] == "completed" and result["final_response"] == reply["content"]


def test_a_scripted_approval_and_clarification_hold_the_turn_until_its_own_session_answers(methods):
    ctx = Ctx()
    turn, result = start(methods, ctx, "waiting", "clean up")
    approval = ctx.wait_for("approval")
    assert (approval["command"], approval["tool_name"]) == ("rm -rf build", "terminal")
    # Another chat's answer never releases this one.
    methods["approval.respond"](Ctx(), {"session_id": "other", "choice": "once"})
    methods["clarify.respond"](Ctx(), {"session_id": "other", "clarify_id": "x", "response": "debug"})
    # A whole scripted turn on another chat gives a wrongly released turn time to move on.
    methods["chat.start"](Ctx(), {"session_id": "s1", "user_message": "read the notes"})
    assert turn.is_alive() and [name for name, _ in ctx.frames] == ["approval"]

    methods["approval.respond"](Ctx(), {"session_id": "waiting", "choice": "once"})
    clarify = ctx.wait_for("clarify")
    assert (clarify["question"], clarify["choices_offered"], clarify["multi_select"]) == ("Which build?", ["debug", "release"], False)
    assert turn.is_alive()

    methods["clarify.respond"](Ctx(), {"session_id": "waiting", "clarify_id": clarify["clarify_id"], "response": "debug"})
    assert result()["messages"][-1] == {"role": "assistant", "content": "Cleaned."}
    assert ctx.frames[-1] == ("token", {"text": "Cleaned."})


def test_an_unmatched_message_keeps_the_contract_turn(methods):
    ctx = Ctx()
    _, result = start(methods, ctx, "contract", "contract fixture")
    assert ctx.wait_for("approval")["pattern_key"] == "talaria_contract_fixture"
    methods["approval.respond"](Ctx(), {"session_id": "contract", "choice": "once"})
    assert result()["final_response"] == "talaria-contract"
