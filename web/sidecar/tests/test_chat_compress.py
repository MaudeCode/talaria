"""TAL-255: ``chat.compress`` drives the pinned Agent's manual ``/compress`` core with ``compress_now`` stubbed (no provider)."""

from __future__ import annotations

import ast
import contextlib
import importlib.util
import inspect
import sys
import types

import pytest

from conftest import AGENT_DIR, requires_agent
from talaria_sidecar.errors import RpcError
from talaria_sidecar.methods import chat

pytestmark = requires_agent

HISTORY = [
    {"role": "user", "content": "one"},
    {"role": "assistant", "content": "two"},
    {"role": "user", "content": "three"},
    {"role": "assistant", "content": "four"},
]


class Ctx:
    cancelled = False

    def emit(self, event, data=None):
        pass


class ThrowawayAgent:
    instances: list["ThrowawayAgent"] = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.session_id = kwargs["session_id"]
        self.closed = False
        ThrowawayAgent.instances.append(self)

    def close(self):
        self.closed = True


def _pinned_manual_core(monkeypatch):
    """The pinned Agent's ``conversation_compression_manual`` (stdlib-only at import), so the stub keeps its contract."""
    path = AGENT_DIR / "agent" / "conversation_compression_manual.py"
    spec = importlib.util.spec_from_file_location("agent.conversation_compression_manual", path)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)  # dataclasses resolve annotations through sys.modules
    spec.loader.exec_module(module)
    return module


def _finalize_signature_params() -> set[str]:
    tree = ast.parse((AGENT_DIR / "agent" / "conversation_compression.py").read_text())
    fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "finalize_context_engine_compression_notification")
    return {a.arg for a in [*fn.args.args, *fn.args.kwonlyargs]}


@pytest.fixture
def agent_env(monkeypatch):
    manual = _pinned_manual_core(monkeypatch)
    real_compress_now = manual.compress_now
    calls: dict = {"compress": [], "finalize": []}
    outcome = {"status": "compressed"}

    def compress_now(agent, history, request, **kwargs):
        inspect.signature(real_compress_now).bind(agent, history, request, **kwargs)
        calls["compress"].append({"agent": agent, "history": history, "request": request, **kwargs})
        if outcome["status"] == "lock_skipped":
            return manual.CompressResult("lock_skipped", list(history), list(history), 400, 400, request, lock_holder="cli")
        after = [history[0], {"role": "user", "content": "[CONTEXT COMPACTION — REFERENCE ONLY] summary", "_db_persisted": object()}, history[-1]]
        summary = {"headline": f"Compressed: {len(history)} → 3 messages", "token_line": "Approx request size: ~400 → ~120 tokens", "note": None}
        return manual.CompressResult("compressed", list(history), after, 400, 120, request, summary=summary)

    def finalize(agent, *, committed):
        calls["finalize"].append(committed)
        return committed

    assert "committed" in _finalize_signature_params()
    manual.compress_now = compress_now
    describe = types.ModuleType("agent.manual_compression_feedback")
    describe.describe_compression_lock_skip = lambda holder: f"⏳ Compression already in progress for this session (holder: {holder}). Please wait for it to finish."
    engine = types.ModuleType("agent.conversation_compression")
    engine.finalize_context_engine_compression_notification = finalize
    package = types.ModuleType("agent")
    package.__path__ = []
    for name, module in (("agent", package), ("agent.conversation_compression_manual", manual), ("agent.conversation_compression", engine), ("agent.manual_compression_feedback", describe)):
        monkeypatch.setitem(sys.modules, name, module)
    ThrowawayAgent.instances.clear()
    monkeypatch.setattr(chat, "_resolve_runtime", lambda provider, model: {"model": "m", "provider": provider or "p", "api_key": "k", "base_url": "https://example.invalid/v1", "api_mode": "chat_completions"})
    monkeypatch.setattr(chat, "_agent_class", lambda: ThrowawayAgent)
    monkeypatch.setattr(chat, "_checkpoint_required", lambda: False)
    return calls, outcome


def _params(**extra) -> dict:
    return {"profile_home": "/tmp/unused", "session_id": "s1", "model": "m", "model_provider": "p", "conversation_history": HISTORY, **extra}


def test_compress_runs_the_shared_core_on_a_throwaway_agent_and_commits(agent_env) -> None:
    calls, _ = agent_env
    result = chat.compress(Ctx(), _params(focus_topic="  schema  ", enabled_toolsets=["memory"]))
    assert result["status"] == "compressed"
    assert [m["content"] for m in result["messages"]] == ["one", "[CONTEXT COMPACTION — REFERENCE ONLY] summary", "four"]
    assert isinstance(result["messages"][1]["_db_persisted"], str)  # JSON-safe for the RPC frame
    assert result["summary"]["headline"] == "Compressed: 4 → 3 messages"
    assert (result["before_tokens"], result["after_tokens"], result["message"], result["agent_session_id"]) == (400, 120, None, "s1")
    call = calls["compress"][0]
    assert call["history"] == HISTORY and call["request"].focus_topic == "schema" and call["task_id"] == "s1"
    agent = ThrowawayAgent.instances[0]
    assert agent.kwargs["session_id"] == "s1" and agent.kwargs["platform"] == "webui" and agent.kwargs["enabled_toolsets"] == ["memory"]
    assert agent.closed and agent._end_session_on_close is False
    # The cached turn agent is never used for a manual compression.
    assert "s1" not in chat._AGENT_CACHE
    assert calls["finalize"] == [True]


def test_a_held_lock_is_reported_and_not_committed(agent_env) -> None:
    calls, outcome = agent_env
    outcome["status"] = "lock_skipped"
    result = chat.compress(Ctx(), _params())
    assert result["status"] == "lock_skipped"
    assert result["message"] == "⏳ Compression already in progress for this session (holder: cli). Please wait for it to finish."
    assert result["messages"] == HISTORY
    assert calls["finalize"] == [False]


def test_no_api_key_is_refused_before_an_agent_exists(agent_env, monkeypatch) -> None:
    monkeypatch.setattr(chat, "_resolve_runtime", lambda provider, model: {"provider": "p"})
    with pytest.raises(RpcError) as raised:
        chat.compress(Ctx(), _params())
    assert raised.value.data["condition"] == "credential_missing"
    assert str(raised.value) == "No provider configured -- cannot compress."
    assert ThrowawayAgent.instances == []


def test_registered_method_scopes_the_profile_home(agent_env, monkeypatch) -> None:
    from talaria_sidecar.methods import Registry

    homes = []

    @contextlib.contextmanager
    def scoped(home):
        homes.append(str(home))
        yield home

    monkeypatch.setattr(chat, "scoped_home", scoped)
    registry = Registry(runtime=types.SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
    chat.register(registry)
    assert registry.methods["chat.compress"](Ctx(), _params(profile_home="/tmp/profiles/work"))["status"] == "compressed"
    assert homes == ["/tmp/profiles/work"]
