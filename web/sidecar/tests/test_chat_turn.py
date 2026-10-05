"""``chat.start`` turn lifecycle with a stand-in Agent: no interrupt on a normal finish, interrupt on cancel, stale interrupts cleared."""

from __future__ import annotations

import contextlib
import json
import threading
import time

from talaria_sidecar.methods import chat


class FakeAgent:
    instances: list["FakeAgent"] = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.interrupts: list[tuple] = []
        self.cleared = 0
        self.block: threading.Event | None = None
        FakeAgent.instances.append(self)

    def clear_interrupt(self):
        self.cleared += 1

    def interrupt(self, message, hard_cancel=False):
        self.interrupts.append((message, hard_cancel))
        if self.block is not None:
            self.block.set()

    def run_conversation(self, **kwargs):
        if self.block is not None:
            self.block.wait(5)
        return {"final_response": "ok", "messages": [{"role": "assistant", "content": "ok"}]}


class Ctx:
    cancelled = False

    def __init__(self):
        self.frames: list[tuple[str, dict]] = []

    def emit(self, event, data=None):
        self.frames.append((event, data or {}))


def _params(stream_id: str, session_id: str = "s1") -> dict:
    return {"profile_home": "/tmp/unused", "session_id": session_id, "stream_id": stream_id, "user_message": "hi", "conversation_history": [], "model": "m", "model_provider": "p"}


def _patch(monkeypatch):
    FakeAgent.instances.clear()
    chat._AGENT_CACHE.clear()
    monkeypatch.setattr(chat, "_resolve_runtime", lambda provider, model: {"model": "m", "provider": "p"})
    monkeypatch.setattr(chat, "_agent_class", lambda: FakeAgent)
    monkeypatch.setattr(chat, "_profile_toolsets", lambda: ["file", "web"])
    monkeypatch.setattr(chat, "_profile_fallback_chain", lambda: None)
    monkeypatch.setattr(chat, "_main_model_request_overrides", lambda model, provider: None)
    monkeypatch.setattr(chat, "scoped_home", lambda home: contextlib.nullcontext(home))


def test_a_finished_turn_never_interrupts_the_cached_agent(monkeypatch) -> None:
    _patch(monkeypatch)
    first = chat.start(Ctx(), _params("st-1"))
    assert first["status"] == "completed", first
    agent = FakeAgent.instances[0]
    assert agent.interrupts == []
    # The second turn reuses the cached agent and is not aborted by anything the first turn left behind.
    second = chat.start(Ctx(), _params("st-2"))
    assert second["status"] == "completed", second
    assert FakeAgent.instances == [agent]
    assert agent.interrupts == []
    assert agent.cleared == 2


def test_cancel_interrupts_the_running_turn_and_the_next_turn_starts_clean(monkeypatch) -> None:
    _patch(monkeypatch)
    ctx = Ctx()
    result: dict = {}
    gate = threading.Event()
    original = chat._agent_class

    def blocking_agent_class():
        cls = original()
        instance_hook = cls
        return instance_hook

    monkeypatch.setattr(chat, "_agent_class", blocking_agent_class)
    started = threading.Event()

    def run():
        # Block the fake turn until it is interrupted.
        FakeAgent.instances.clear()
        orig_init = FakeAgent.__init__

        def init(self, **kwargs):
            orig_init(self, **kwargs)
            self.block = gate
            started.set()

        monkeypatch.setattr(FakeAgent, "__init__", init)
        result.update(chat.start(ctx, _params("st-3", "s2")))

    worker = threading.Thread(target=run)
    worker.start()
    assert started.wait(5)
    assert chat.register.__module__  # module import sanity
    run_obj = chat._run_for({"stream_id": "st-3"})
    assert run_obj is not None
    # `chat.interrupt` drains the Agent's unapplied steer text (predecessor `_finalize_webui_steers`) so the server can
    # settle queued steers before its terminal cancel row.
    run_obj.agent._pending_steer = "prefer tests"
    run_obj.agent._drain_pending_steer = lambda: run_obj.agent.__dict__.pop("_pending_steer", "")
    from talaria_sidecar.methods import Registry

    registry = Registry(runtime=None)  # type: ignore[arg-type]
    chat.register(registry)
    reply = registry.methods["chat.interrupt"](Ctx(), {"stream_id": "st-3"})
    assert reply == {"ok": True, "pending_steer": "prefer tests"}
    assert getattr(run_obj.agent, "_pending_steer", "") == ""
    worker.join(5)
    assert not worker.is_alive()
    agent = FakeAgent.instances[0]
    assert agent.interrupts == [("Cancelled by user", True)]
    assert result["status"] == "cancelled", result
    # The next turn on the same session clears the interrupt the cancel left on the cached agent.
    agent.block = None
    follow = chat.start(Ctx(), _params("st-4", "s2"))
    assert follow["status"] == "completed", follow
    assert agent.cleared >= 2


def test_interrupt_returns_the_agents_checkpoint_only_once_this_turn_published_one(monkeypatch) -> None:
    """TAL-364: Stop hands the server the Agent's canonical transcript for the stopped turn, taken before the interrupt."""
    _patch(monkeypatch)
    from talaria_sidecar.methods import Registry

    registry = Registry(runtime=None)  # type: ignore[arg-type]
    chat.register(registry)
    previous = [{"role": "user", "content": "earlier"}, {"role": "assistant", "content": "earlier answer"}]
    tool_call = {"role": "assistant", "content": "", "tool_calls": [{"id": "call-1", "type": "function", "function": {"name": "terminal", "arguments": "{}"}}]}
    tool_result = {"role": "tool", "tool_call_id": "call-1", "content": "worker-2 CrashLoopBackOff"}
    published = threading.Event()
    publish = threading.Event()
    gate = threading.Event()

    class CheckpointingAgent(FakeAgent):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            # The list a cached Agent kept from its previous turn.
            self._session_messages = list(previous)

        def run_conversation(self, **kwargs):
            publish.wait(5)
            # What the Agent's tool round republishes after a completed call.
            self._session_messages = [*kwargs["conversation_history"], {"role": "user", "content": kwargs["user_message"]}, tool_call, tool_result]
            published.set()
            gate.wait(5)
            self._session_messages.append({"role": "assistant", "content": "Operation interrupted."})
            return {"final_response": "", "messages": self._session_messages}

        def interrupt(self, message, hard_cancel=False):
            super().interrupt(message, hard_cancel)
            gate.set()

    monkeypatch.setattr(chat, "_agent_class", lambda: CheckpointingAgent)
    result: dict = {}
    worker = threading.Thread(target=lambda: result.update(chat.start(Ctx(), {**_params("st-ck", "s-ck"), "conversation_history": previous, "user_message": "check the rollout"})))
    worker.start()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and chat._run_for({"stream_id": "st-ck"}) is None:
        time.sleep(0.01)
    run = chat._run_for({"stream_id": "st-ck"})
    assert run is not None
    while time.monotonic() < deadline and run.agent is None:
        time.sleep(0.01)
    # Before the Agent republishes, it still holds the previous turn's list: no checkpoint, never a stale one.
    assert chat._cancel_checkpoint(run) is None
    publish.set()
    assert published.wait(5)
    reply = registry.methods["chat.interrupt"](Ctx(), {"stream_id": "st-ck"})
    assert reply["ok"] is True
    assert reply["checkpoint"] == [*previous, {"role": "user", "content": "check the rollout"}, tool_call, tool_result]
    # The reply matches the result schema exported from the contracts package (RPC v2).
    from conftest import assert_matches

    assert_matches("chat.interrupt", reply)
    worker.join(5)
    assert not worker.is_alive()
    assert result["status"] == "cancelled"
    # The snapshot is a copy: the Agent's own unwind (its closing row) does not change what the server received.
    assert reply["checkpoint"][-1] == tool_result
    assert registry.methods["chat.interrupt"](Ctx(), {"stream_id": "st-ck"}) == {"ok": False, "reason": "not_running"}


def test_a_rotated_credential_never_reuses_the_cached_agent(monkeypatch) -> None:
    _patch(monkeypatch)
    runtime = {"model": "m", "provider": "p", "api_key": "sk-old"}
    monkeypatch.setattr(chat, "_resolve_runtime", lambda provider, model: dict(runtime))
    assert chat.start(Ctx(), _params("st-5", "s3"))["status"] == "completed"
    assert chat.start(Ctx(), _params("st-6", "s3"))["status"] == "completed"
    assert len(FakeAgent.instances) == 1
    runtime["api_key"] = "sk-rotated"
    assert chat.start(Ctx(), _params("st-7", "s3"))["status"] == "completed"
    assert len(FakeAgent.instances) == 2
    assert FakeAgent.instances[-1].kwargs["api_key"] == "sk-rotated"
    # runtime.env drops every cached agent as well.
    assert chat.evict_all_agents() == 1
    assert chat.start(Ctx(), _params("st-8", "s3"))["status"] == "completed"
    assert len(FakeAgent.instances) == 3
    # A reasoning-effort change from the composer is bound at construction: it never reuses the cached agent.
    assert chat.start(Ctx(), {**_params("st-9", "s3"), "reasoning_config": {"effort": "high"}})["status"] == "completed"
    assert len(FakeAgent.instances) == 4
    assert FakeAgent.instances[-1].kwargs["reasoning_config"] == {"effort": "high"}
    assert chat.start(Ctx(), {**_params("st-10", "s3"), "reasoning_config": {"effort": "high"}})["status"] == "completed"
    assert len(FakeAgent.instances) == 4
    assert chat.start(Ctx(), {**_params("st-11", "s3"), "reasoning_config": {"effort": "low"}})["status"] == "completed"
    assert len(FakeAgent.instances) == 5


def test_the_turn_binds_its_session_identity_and_workspace(monkeypatch, tmp_path) -> None:
    """The approval key, gateway session vars (with the profile), and session cwd are bound for the turn and reset afterwards."""
    import contextvars
    import sys
    import types

    seen: dict = {}
    approval_ctx = types.ModuleType("tools.approval_context")
    key_var: contextvars.ContextVar = contextvars.ContextVar("key", default="default")
    approval_ctx.set_current_session_key = lambda k: key_var.set(k)
    approval_ctx.reset_current_session_key = lambda t: key_var.reset(t)
    tools_pkg = types.ModuleType("tools")
    tools_pkg.approval_context = approval_ctx
    sc = types.ModuleType("gateway.session_context")
    for name in ("_SESSION_KEY", "_SESSION_UI_SESSION_ID", "_SESSION_PLATFORM", "_SESSION_CHAT_ID", "_SESSION_ID", "_SESSION_PROFILE"):
        setattr(sc, name, contextvars.ContextVar(name, default=""))
    gateway_pkg = types.ModuleType("gateway")
    gateway_pkg.session_context = sc
    cwd_mod = types.ModuleType("agent.runtime_cwd")
    cwd_mod._SESSION_CWD = contextvars.ContextVar("cwd", default="")
    agent_pkg = types.ModuleType("agent")
    agent_pkg.runtime_cwd = cwd_mod
    constants = types.ModuleType("hermes_constants")
    constants.get_hermes_home = lambda: tmp_path / "profiles" / "work"
    constants.profile_name_for_home = lambda home: home.name
    profiles = types.ModuleType("hermes_cli.profiles")
    profiles.get_active_profile_name = lambda: "custom"
    stubs = {"tools": tools_pkg, "tools.approval_context": approval_ctx, "gateway": gateway_pkg, "gateway.session_context": sc, "agent": agent_pkg, "agent.runtime_cwd": cwd_mod,
             "hermes_constants": constants, "hermes_cli.profiles": profiles}
    for name, mod in stubs.items():
        monkeypatch.setitem(sys.modules, name, mod)

    class ObservingAgent(FakeAgent):
        def run_conversation(self, **kwargs):
            seen.update(key=key_var.get(), platform=sc._SESSION_PLATFORM.get(), chat_id=sc._SESSION_CHAT_ID.get(), ui=sc._SESSION_UI_SESSION_ID.get(), profile=sc._SESSION_PROFILE.get(), cwd=cwd_mod._SESSION_CWD.get())
            return super().run_conversation(**kwargs)

    _patch(monkeypatch)
    monkeypatch.setattr(chat, "_agent_class", lambda: ObservingAgent)
    workspace = str(tmp_path / "ws")
    with chat._turn_identity("s-ident", workspace):
        assert chat.start(Ctx(), {**_params("st-9", "s-ident"), "workspace": workspace})["status"] == "completed"
    assert seen == {"key": "s-ident", "platform": "webui", "chat_id": "s-ident", "ui": "s-ident", "profile": "work", "cwd": workspace}
    # Everything is reset once the turn is over.
    assert key_var.get() == "default" and sc._SESSION_PLATFORM.get() == "" and sc._SESSION_PROFILE.get() == "" and cwd_mod._SESSION_CWD.get() == ""


def test_a_turn_on_a_busy_session_never_shares_the_live_agent(monkeypatch) -> None:
    _patch(monkeypatch)
    gate = threading.Event()
    started = threading.Event()
    orig_init = FakeAgent.__init__

    def init(self, **kwargs):
        orig_init(self, **kwargs)
        if len(FakeAgent.instances) == 1:
            self.block = gate
            started.set()

    monkeypatch.setattr(FakeAgent, "__init__", init)
    # A stand-in for the Agent's gateway approval registry: the successor's callback must survive the old run's unwind.
    import sys, types
    registry: dict[str, object] = {}
    approval_mod = types.ModuleType("tools.approval")
    approval_mod.register_gateway_notify = lambda key, cb: registry.__setitem__(key, cb)
    approval_mod.unregister_gateway_notify = lambda key: registry.pop(key, None)
    tools_pkg = types.ModuleType("tools")
    tools_pkg.approval = approval_mod
    monkeypatch.setitem(sys.modules, "tools", tools_pkg)
    monkeypatch.setitem(sys.modules, "tools.approval", approval_mod)
    first: dict = {}
    worker = threading.Thread(target=lambda: first.update(chat.start(Ctx(), _params("st-10", "s-busy"))))
    worker.start()
    assert started.wait(5)
    first_cb = registry.get("s-busy")
    assert first_cb is not None
    # The first turn is still inside run_conversation; the second gets its own agent and does not clear its interrupt.
    second_ctx = Ctx()
    blocker = threading.Event()
    second_started = threading.Event()

    class SuccessorAgent(FakeAgent):
        def run_conversation(self, **kwargs):
            second_started.set()
            blocker.wait(5)
            return super().run_conversation(**kwargs)

    monkeypatch.setattr(chat, "_agent_class", lambda: SuccessorAgent)
    second: dict = {}
    successor = threading.Thread(target=lambda: second.update(chat.start(second_ctx, _params("st-11", "s-busy"))))
    successor.start()
    assert second_started.wait(5)
    assert registry.get("s-busy") is not first_cb
    successor_cb = registry.get("s-busy")
    # The stale first run unwinds now: it no longer owns the session registration, so it leaves it alone.
    gate.set()
    worker.join(5)
    assert first["status"] == "completed"
    assert registry.get("s-busy") is successor_cb
    blocker.set()
    successor.join(5)
    assert second["status"] == "completed"
    assert "s-busy" not in registry
    assert len(FakeAgent.instances) == 2
    assert FakeAgent.instances[0].cleared == 1  # only its own start cleared it


def test_clarify_prompts_advertise_the_agent_timeout(monkeypatch) -> None:
    """The clarify frame carries the timeout the sidecar actually waits (predecessor ``_clarify_timeout_seconds``)."""
    _patch(monkeypatch)
    import types, sys
    gateway = types.ModuleType("tools.clarify_gateway")
    gateway.get_clarify_timeout = lambda: 42
    tools_pkg = types.ModuleType("tools")
    tools_pkg.clarify_gateway = gateway
    monkeypatch.setitem(sys.modules, "tools", tools_pkg)
    monkeypatch.setitem(sys.modules, "tools.clarify_gateway", gateway)
    assert chat._clarify_timeout({}) == 42
    assert chat._clarify_timeout({"clarify_timeout_seconds": 7}) == 7
    assert chat._clarify_timeout({"clarify_timeout_seconds": 0}) == 0

    class ClarifyingAgent(FakeAgent):
        def run_conversation(self, **kwargs):
            answer = self.kwargs["clarify_callback"]("Which env?", ["dev", "prod"])
            return {"final_response": answer, "messages": []}

    monkeypatch.setattr(chat, "_agent_class", lambda: ClarifyingAgent)
    ctx = Ctx()
    threading.Thread(target=lambda: chat.start(ctx, _params("st-clarify")), daemon=True).start()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and not any(e == "clarify" for e, _ in ctx.frames):
        time.sleep(0.02)
    frame = next(data for e, data in ctx.frames if e == "clarify")
    assert frame["timeout_seconds"] == 42
    run = chat._run_for({"stream_id": "st-clarify"})
    assert run is not None
    with run.lock:
        entry = run.clarify_entries[frame["clarify_id"]]
    entry.result = "dev"
    entry.event.set()


def test_batch_clarify_relays_questions_and_returns_the_answers_envelope(monkeypatch) -> None:
    """TAL-362: the Agent's batch callback frame has no top-level question; the keyed envelope reply reaches it unchanged."""
    _patch(monkeypatch)
    questions = [
        {"qid": "q0", "id": None, "question": "What sounds best for a quiet evening?", "choices": ["A book (Recommended)", "A movie"], "choices_offered": ["A book", "A movie"], "multi_select": False},
        {"qid": "q1", "id": "snacks", "question": "Which snacks?", "choices": ["Popcorn (Recommended)", "Tea"], "choices_offered": ["Popcorn", "Tea"], "multi_select": True},
    ]
    replies: list = []

    class BatchAgent(FakeAgent):
        def run_conversation(self, **kwargs):
            # Mirrors ``clarify_tool._run_batch`` then a single multi-select question.
            replies.append(self.kwargs["clarify_callback"]("", None, questions=questions))
            replies.append(self.kwargs["clarify_callback"]("Which env?", ["dev", "prod"], multi_select=True))
            return {"final_response": "ok", "messages": []}

    monkeypatch.setattr(chat, "_agent_class", lambda: BatchAgent)
    ctx = Ctx()
    threading.Thread(target=lambda: chat.start(ctx, _params("st-batch")), daemon=True).start()

    def answer(n: int, response: str) -> dict:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and sum(e == "clarify" for e, _ in ctx.frames) < n:
            time.sleep(0.02)
        frame = [data for e, data in ctx.frames if e == "clarify"][n - 1]
        run = chat._run_for({"stream_id": "st-batch"})
        assert run is not None
        with run.lock:
            entry = run.clarify_entries[frame["clarify_id"]]
        entry.result = response
        entry.event.set()
        return frame

    envelope = '{"answers": {"q0": "A movie", "q1": ["Popcorn (Recommended)", "Tea"]}}'
    batch = answer(1, envelope)
    assert batch["question"] == "" and batch["questions"] == questions and "multi_select" not in batch
    single = answer(2, '["prod"]')
    assert single["multi_select"] is True and single["choices_offered"] == ["dev", "prod"]
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and len(replies) < 2:
        time.sleep(0.02)
    assert replies == [envelope, '["prod"]']


def test_tool_frames_keep_content_args_long_and_extract_result_previews(monkeypatch) -> None:
    """Predecessor caps: content/diff args keep 4000 chars, incidental args 120; previews come from output/result/error."""
    snap = chat._args_snapshot({"path": "/very/long/" + "x" * 300, "note": "n" * 300, "old_string": "o" * 5000})
    assert len(snap["path"]) == 311 and not snap["path"].endswith("...")
    assert snap["note"].endswith("...") and len(snap["note"]) == 123
    assert len(snap["old_string"]) == 4003
    # A non-string argument is rendered by the server's rule for the parsed JSON a persisted call carries (Python
    # str() shapes, JavaScript number text), so a call shows one target live and after reload. The same cases are
    # pinned in the server's tool-display.test.ts.
    cases = [
        (1.0, "1"), (3, "3"), (1.5, "1.5"), (-0.0, "0"), (1e21, "1e+21"), (1e20, "100000000000000000000"), (1e-7, "1e-7"),
        (0.000001, "0.000001"), (2**60, "1152921504606847000"), (1.5e-10, "1.5e-10"), (True, "True"), (None, "None"),
        ([1.0, "it's", None, {"a": 1.5, "b": True}], "[1, \"it's\", None, {'a': 1.5, 'b': True}]"),
        (["tab\there", 'q"uote'], "['tab\\there', 'q\"uote']"),
    ]
    for value, shown in cases:
        assert chat._args_snapshot({"task": value}) == {"task": shown}, value
    assert chat._snippet('{"output": "hello", "extra": "x"}') == "hello"
    assert chat._snippet({"error": "boom"}) == "boom"
    assert chat._snippet("a" * 5000) == "a" * 4000
    assert chat._delegation_cost_usd("delegate_task", {"results": [{"cost_usd": 0.5}, {"cost_usd": 0.25}]}) == 0.75
    assert chat._delegation_cost_usd("delegate_task", {"results": [{"cost_usd": 0.5}, {"cost_status": "unknown"}]}) is None
    assert chat._delegation_cost_usd("read_file", {"results": [{"cost_usd": 1}]}) is None


def test_tool_complete_ships_the_raw_result_and_no_error_decision(monkeypatch) -> None:
    """The server decides failure from ``raw_result``: a parsed dict (strings capped), else the capped text."""
    _patch(monkeypatch)
    results = [
        {"exit_code": 2, "output": "o" * 5000, "items": list(range(10_000)), "empty": {}},
        '{"error": "boom", "nested": {"text": "' + "n" * 5000 + '"}}',
        "plain " + "p" * 5000,
        None,
        {**{f"k{i}": i for i in range(100)}, "exit_code": 7},
    ]

    class ToolAgent(FakeAgent):
        def run_conversation(self, **kwargs):
            for i, result in enumerate(results):
                self.kwargs["tool_start_callback"](f"t{i}", "terminal", {"command": "x"})
                self.kwargs["tool_complete_callback"](f"t{i}", "terminal", {"command": "x"}, result)
            return super().run_conversation(**kwargs)

    monkeypatch.setattr(chat, "_agent_class", lambda: ToolAgent)
    ctx = Ctx()
    assert chat.start(ctx, _params("st-raw"))["status"] == "completed"
    frames = [data for event, data in ctx.frames if event == "tool_complete"]
    assert [frame["tid"] for frame in frames] == ["t0", "t1", "t2", "t3", "t4"]
    assert all("is_error" not in frame for frame in frames)
    # Bounded: top-level fields only, nested values as capped JSON text, at most 64 fields.
    assert frames[0]["raw_result"] == {"exit_code": 2, "output": "o" * 4000, "items": json.dumps(list(range(10_000)))[:4000], "empty": {}}
    assert frames[1]["raw_result"] == {"error": "boom", "nested": json.dumps({"text": "n" * 5000})[:4000]}
    assert len(frames[4]["raw_result"]) == 65 and frames[4]["raw_result"]["exit_code"] == 7
    assert frames[2]["raw_result"] == ("plain " + "p" * 5000)[:4000]
    assert frames[3]["raw_result"] == ""


def test_a_result_diff_reaches_the_server_whole(monkeypatch) -> None:
    """TAL-448: a result's string ``diff`` travels whole as ``result_diff``; other results carry none."""
    _patch(monkeypatch)
    diff = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+" + "b" * 5000 + "\n"
    results = [json.dumps({"success": True, "diff": diff}), {"diff": diff}, json.dumps({"bytes_written": 3}), "plain", {"diff": 3}]

    class EditAgent(FakeAgent):
        def run_conversation(self, **kwargs):
            for i, result in enumerate(results):
                self.kwargs["tool_start_callback"](f"t{i}", "patch", {"path": "x"})
                self.kwargs["tool_complete_callback"](f"t{i}", "patch", {"path": "x"}, result)
            return super().run_conversation(**kwargs)

    monkeypatch.setattr(chat, "_agent_class", lambda: EditAgent)
    ctx = Ctx()
    assert chat.start(ctx, _params("st-diff"))["status"] == "completed"
    frames = [data for event, data in ctx.frames if event == "tool_complete"]
    assert [frame.get("result_diff") for frame in frames] == [diff, diff, None, None, None]
    assert len(frames[0]["raw_result"]["diff"]) == 4000


def test_usage_changes_and_the_full_todo_result_reach_the_server(monkeypatch) -> None:
    """TAL-397: a counter change is reported before the next content frame; the todo tool's result travels whole."""
    _patch(monkeypatch)
    todo = json.dumps({"todos": [{"id": str(i), "content": "c" * 200, "status": "pending"} for i in range(40)], "summary": {"total": 40}})

    class MeteredAgent(FakeAgent):
        session_prompt_tokens = 0
        session_completion_tokens = 0
        session_estimated_cost_usd = None

        def run_conversation(self, **kwargs):
            self.kwargs["stream_delta_callback"]("a")
            self.session_prompt_tokens, self.session_completion_tokens, self.session_estimated_cost_usd = 100, 10, 0.5
            self.kwargs["tool_start_callback"]("t1", "todo", {})
            self.kwargs["tool_complete_callback"]("t1", "todo", {}, todo)
            self.kwargs["stream_delta_callback"]("b")
            return super().run_conversation(**kwargs)

    monkeypatch.setattr(chat, "_agent_class", lambda: MeteredAgent)
    ctx = Ctx()
    assert chat.start(ctx, _params("st-meter"))["status"] == "completed"
    events = [event for event, _ in ctx.frames if event != "steer_pending"]
    assert events == ["token", "usage", "tool", "tool_complete", "token"]
    assert dict(ctx.frames)["usage"] == {"prompt_tokens": 100, "completion_tokens": 10, "cache_read_tokens": 0, "cache_write_tokens": 0, "estimated_cost_usd": 0.5}
    complete = dict(ctx.frames)["tool_complete"]
    assert complete["todo_result"] == todo
    assert len(complete["raw_result"]["todos"]) == 4000


def test_a_profile_toolset_change_builds_a_fresh_agent(monkeypatch) -> None:
    _patch(monkeypatch)
    chat.start(Ctx(), _params("st-1", "toolsets"))
    assert FakeAgent.instances[0].kwargs["enabled_toolsets"] == ["file", "web"]
    monkeypatch.setattr(chat, "_profile_toolsets", lambda: ["file"])
    chat.start(Ctx(), _params("st-2", "toolsets"))
    assert len(FakeAgent.instances) == 2 and FakeAgent.instances[1].kwargs["enabled_toolsets"] == ["file"]
    chat._AGENT_CACHE.clear()


def test_the_agents_failed_and_partial_results_reach_the_server(monkeypatch) -> None:
    """TAL-506: the pinned Agent reports a failed turn with ``failed``/``partial``/``compression_exhausted`` (never
    ``status``), after text already streamed and with the turn's messages; the sidecar forwards them and fails the turn."""
    _patch(monkeypatch)
    from conftest import assert_matches

    history = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "terminal", "arguments": "{}"}}]}]
    outcomes = {
        # `_billing_failure_result`: failed, with the provider's summary as `error`.
        "billing": {"final_response": "Out of credits.", "messages": history, "completed": False, "failed": True, "error": "HTTP 402: insufficient credits"},
        # `OverflowVerdict.fail_turn`: failed and partial, compression exhausted, `error` mirrors the site copy.
        "overflow": {"final_response": "The conversation no longer fits.", "messages": history, "completed": False, "failed": True, "partial": True, "compression_exhausted": True, "error": "The conversation no longer fits."},
        # `turn_tool_validation._partial_exit`: partial but not failed.
        "truncated": {"final_response": "Stopped after invalid tool calls.", "messages": history, "completed": False, "partial": True, "error": "Stopped after invalid tool calls."},
    }

    class FailingAgent(FakeAgent):
        outcome: dict = {}

        def run_conversation(self, **kwargs):
            self.kwargs["stream_delta_callback"]("Partial answer")
            return dict(FailingAgent.outcome)

    monkeypatch.setattr(chat, "_agent_class", lambda: FailingAgent)
    results = {}
    for name, outcome in outcomes.items():
        FailingAgent.outcome = outcome
        ctx = Ctx()
        results[name] = chat.start(ctx, _params(f"st-{name}", f"s-{name}"))
        assert ("token", {"text": "Partial answer"}) in ctx.frames
        assert_matches("chat.start", results[name])
    assert {k: (r["status"], r.get("failed"), r.get("partial"), r.get("compression_exhausted"), r["error"]) for k, r in results.items()} == {
        "billing": ("error", True, False, False, "HTTP 402: insufficient credits"),
        "overflow": ("error", True, True, True, "The conversation no longer fits."),
        "truncated": ("completed", False, True, False, "Stopped after invalid tool calls."),
    }
    assert all(r["token_sent"] and r["messages"] == history for r in results.values())
