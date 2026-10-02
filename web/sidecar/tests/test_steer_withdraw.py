"""TAL-424: ``chat.steer_withdraw`` and ``chat.steer_now`` take a pending steer back out of the Agent's slot (Edit,
Cancel) or deliver it now with ``redirect`` (Send now), against the pinned Agent's own steer, redirect and drain."""

from __future__ import annotations

import json
import os
import subprocess
import textwrap

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, requires_agent
from talaria_sidecar.errors import InvalidParams
from talaria_sidecar.methods import Registry, chat

# Runs on the pinned Agent's interpreter: a real AIAgent with its steer state installed the way the Agent's own
# tests/agent/test_steer.py builds one, driven through the sidecar helpers.
SCENARIOS = textwrap.dedent(
    """
    import json, threading
    from run_agent import AIAgent
    from talaria_sidecar.methods.chat import steer_now, withdraw_steer

    def bare():
        agent = object.__new__(AIAgent)
        agent._pending_steer = None
        agent._pending_steer_lock = threading.Lock()
        agent._pending_redirect = None
        agent._pending_redirect_lock = threading.Lock()
        agent._model_request_active = threading.Event()
        agent._executing_tools = False
        agent._execution_thread_id = None
        agent._interrupt_thread_signal_pending = False
        agent._interrupt_requested = False
        agent._interrupt_message = None
        agent._active_children = []
        agent._active_children_lock = threading.Lock()
        agent._tool_worker_threads = None
        agent._tool_worker_threads_lock = None
        agent._current_streamed_assistant_text = ""
        agent._stream_needs_break = False
        agent._strip_think_blocks = lambda content: content
        agent.quiet_mode = True
        agent.api_mode = "chat_completions"
        return agent

    def queued(*texts):
        agent = bare()
        for text in texts:
            agent.steer(text)
        return agent

    out = {}
    agent = queued("a", "b", "c")
    out["withdraw_middle"] = [withdraw_steer(agent, ["a", "b", "c"], 1), agent._drain_pending_steer()]
    agent = queued("x", "a", "b")
    out["withdraw_behind_other_surface"] = [withdraw_steer(agent, ["a", "b"], 0), agent._drain_pending_steer()]
    agent = queued("c")
    out["withdraw_consumed"] = [withdraw_steer(agent, ["a", "b", "c"], 0), agent._drain_pending_steer()]
    agent = queued("only")
    out["withdraw_last"] = [withdraw_steer(agent, ["only"], 0), agent._drain_pending_steer()]
    agent = queued("a", "b", "c")
    out["now_idle"] = [steer_now(agent, ["a", "b", "c"], 1), agent._drain_pending_steer()]
    agent = queued("a", "b", "c")
    agent._model_request_active.set()
    out["now_model_request"] = [steer_now(agent, ["a", "b", "c"], 1), agent._drain_pending_steer(), agent._drain_pending_redirect()]
    agent = queued("a", "b", "c")
    agent._executing_tools = True
    out["now_tools"] = [steer_now(agent, ["a", "b", "c"], 0), agent._drain_pending_steer()]
    agent = queued("c")
    agent._model_request_active.set()
    out["now_consumed"] = [steer_now(agent, ["a", "b", "c"], 0), agent._drain_pending_steer(), agent._drain_pending_redirect()]
    print(json.dumps(out))
    """
)


@requires_agent
def test_withdraw_and_send_now_against_the_pinned_agent():
    env = {**os.environ, "PYTHONPATH": f"{SIDECAR_ROOT}{os.pathsep}{AGENT_DIR}"}
    run = subprocess.run([AGENT_PYTHON, "-c", SCENARIOS], cwd=AGENT_DIR, env=env, capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-2000:]
    out = json.loads(run.stdout.strip().splitlines()[-1])
    # The withdrawn steer leaves the slot; the others keep their order and are still delivered.
    assert out["withdraw_middle"] == [True, "a\nc"]
    # Text another surface queued ahead of the server's steers stays.
    assert out["withdraw_behind_other_surface"] == [True, "x\nb"]
    # The Agent already took it: nothing is withdrawn and the slot is restored untouched.
    assert out["withdraw_consumed"] == [False, "c"]
    assert out["withdraw_last"] == [True, None]
    # No live request: the steer stays pending, back in its place.
    assert out["now_idle"] == [{"redirected": False, "withdrawn": True, "requeued": "kept"}, "a\nb\nc"]
    # During a model request it becomes the redirect correction and leaves the slot.
    assert out["now_model_request"] == [{"redirected": True, "withdrawn": True, "delivery": "redirect"}, "a\nc", "b"]
    # During tools the Agent's redirect degrades to a steer: back on the slot, delivered after the tool batch.
    assert out["now_tools"] == [{"redirected": True, "withdrawn": True, "delivery": "steer"}, "b\nc\na"]
    assert out["now_consumed"] == [{"redirected": False, "withdrawn": False}, "c", None]


class _Agent:
    def __init__(self, slot: str | None):
        self._pending_steer = slot

    def steer(self, text: str) -> bool:
        self._pending_steer = f"{self._pending_steer}\n{text}" if self._pending_steer else text
        return True


class _Run:
    def __init__(self, agent):
        self.agent = agent


def _methods(monkeypatch, run):
    monkeypatch.setattr(chat, "_run_for", lambda params: run)
    registry = Registry(runtime=None)  # type: ignore[arg-type]
    chat.register(registry)
    return registry.methods


def test_rpc_methods_validate_and_report_a_finished_run(monkeypatch):
    methods = _methods(monkeypatch, None)
    assert methods["chat.steer_withdraw"](None, {"stream_id": "s", "pending": ["a"], "index": 0}) == {"withdrawn": False}
    assert methods["chat.steer_now"](None, {"stream_id": "s", "pending": ["a"], "index": 0}) == {"redirected": False, "withdrawn": False}
    for bad in ({"pending": [], "index": 0}, {"pending": ["a"], "index": 1}, {"pending": ["a", ""], "index": 0}, {"pending": "a", "index": 0}, {"pending": ["a"], "index": True}):
        with pytest.raises(InvalidParams):
            methods["chat.steer_withdraw"](None, {"stream_id": "s", **bad})


def test_rpc_methods_rewrite_the_running_agents_slot(monkeypatch):
    agent = _Agent("a\nb")
    methods = _methods(monkeypatch, _Run(agent))
    assert methods["chat.steer_withdraw"](None, {"stream_id": "s", "pending": ["a", "b"], "index": 0}) == {"withdrawn": True}
    assert agent._pending_steer == "b"
    # An Agent without `redirect` keeps the steer pending, in its place.
    assert methods["chat.steer_now"](None, {"stream_id": "s", "pending": ["b"], "index": 0}) == {"redirected": False, "withdrawn": True, "requeued": "kept"}
    assert agent._pending_steer == "b"
    assert methods["chat.steer"](None, {"stream_id": "s", "text": "c"})["can_redirect"] is False
