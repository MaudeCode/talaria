"""Turn-start MCP retries use registered tools while slow discovery stays in the background."""

from __future__ import annotations

import sys
import threading
import types

import pytest

from test_chat_turn import Ctx, FakeAgent, _params, _patch
from talaria_sidecar.errors import RpcError
from talaria_sidecar.methods import Registry, chat, commands, profiles


@pytest.fixture
def discovery(monkeypatch, tmp_path):
    _patch(monkeypatch)
    monkeypatch.setattr(chat, "_MCP_DISCOVERIES", {})
    monkeypatch.setattr(commands, "_MCP_DISCOVERED_HOMES", set())
    monkeypatch.setattr(chat, "_DRAINING", threading.Event())
    home = tmp_path / "profiles" / "alpha"
    home.mkdir(parents=True)
    monkeypatch.setattr(chat, "refresh_profile_agents_mcp_tools", lambda home: None)
    monkeypatch.setattr(commands, "retire_unscoped_launch_mcp_servers", lambda: set())
    # The Agent boundary only. Real Talaria discovery orchestration and chat.start run below.
    release = threading.Event()
    entered = threading.Event()
    calls = []
    def discover():
        calls.append(1)
        entered.set()
        release.wait()
        return ["mcp_stub_ping"]
    monkeypatch.setitem(sys.modules, "hermes_constants", types.SimpleNamespace(get_hermes_home=lambda: home))
    monkeypatch.setitem(sys.modules, "tools.mcp_tool_discovery", types.SimpleNamespace(discover_mcp_tools=discover))
    try:
        yield home, release, entered, calls
    finally:
        release.set()
        with chat._MCP_DISCOVERY_LOCK:
            done = chat._MCP_DISCOVERIES.get(str(home.resolve()))
        if done is not None:
            assert done.wait(5)


def start(home, stream, session="s1"):
    ctx = Ctx()
    result = {}
    returned = threading.Event()
    ctx.pending = threading.Event()
    ctx.cleared = threading.Event()
    original_emit = ctx.emit
    def emit(event, data=None):
        original_emit(event, data)
        if (data or {}).get("key") == "mcp_discovery_pending":
            if event == "notice":
                ctx.pending.set()
            elif event == "notice_clear":
                ctx.cleared.set()
    ctx.emit = emit
    def turn():
        result.update(chat.start(ctx, {**_params(stream, session), "profile_home": str(home)}))
        returned.set()
    worker = threading.Thread(target=turn)
    worker.start()
    return ctx, result, returned, worker


def test_repeat_discovery_starts_turn_with_pending_notice_within_three_seconds(discovery):
    home, release, entered, calls = discovery
    # A completed catalog discovery warms this profile before its first chat.
    release.set()
    commands.discover_profile_mcp_tools()
    release.clear()
    entered.clear()
    ctx, result, returned, worker = start(home, "retry")
    try:
        assert entered.wait(1)
        assert returned.wait(3), "chat.start stayed blocked on a previously discovered profile"
        assert result["status"] == "completed"
        assert any(event == "notice" and data.get("key") == "mcp_discovery_pending" for event, data in ctx.frames)
        assert len(FakeAgent.instances) == 1
        assert ctx.cleared.is_set(), "a finished turn must not retain its pending notice"
        frames = list(ctx.frames)
        release.set()
        assert chat._MCP_DISCOVERIES[str(home.resolve())].wait(1)
        assert ctx.frames == frames, "background completion must not emit into a finished stream"
    finally:
        release.set()
        worker.join(5)


def test_fresh_home_waits_and_stop_releases_it(discovery):
    home, release, entered, calls = discovery
    ctx, result, returned, worker = start(home, "fresh")
    try:
        assert entered.wait(1)
        assert not returned.wait(2.2), "first discovery must finish before the first Agent snapshots tools"
        assert not FakeAgent.instances
        ctx.cancelled = True
        assert returned.wait(1), "Stop must release the first discovery wait"
        assert result["status"] == "cancelled"
    finally:
        release.set()
        worker.join(5)


@pytest.mark.parametrize("outcome", ["empty", "error"])
def test_only_a_completed_discovery_warms_the_profile(discovery, monkeypatch, outcome):
    home, release, entered, calls = discovery
    def discover():
        if outcome == "error":
            raise RuntimeError("connection failed")
        return []
    monkeypatch.setattr(sys.modules["tools.mcp_tool_discovery"], "discover_mcp_tools", discover)
    if outcome == "error":
        with pytest.raises(RuntimeError):
            commands.discover_profile_mcp_tools()
    else:
        assert commands.discover_profile_mcp_tools() == []
    assert commands.profile_mcp_tools_discovered(home) is (outcome == "empty")
    assert not commands.profile_mcp_tools_discovered(home.parent / "other-profile")


def test_concurrent_turns_share_retry_and_clear_notice_when_tools_arrive(discovery, monkeypatch):
    home, release, entered, calls = discovery
    release.set()
    commands.discover_profile_mcp_tools()
    release.clear()
    entered.clear()
    turn_release = threading.Event()
    refreshed = threading.Event()
    class RunningAgent(FakeAgent):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            self.block = turn_release
    monkeypatch.setattr(chat, "_agent_class", lambda: RunningAgent)
    def refresh(target):
        assert target == home
        with chat._AGENT_CACHE_LOCK:
            if len(chat._AGENT_CACHE) == 2:
                refreshed.set()
    monkeypatch.setattr(chat, "refresh_profile_agents_mcp_tools", refresh)
    turns = [start(home, "shared-" + str(i), "session-" + str(i)) for i in range(2)]
    try:
        assert entered.wait(1)
        # Observe the real two-second timeout without releasing discovery or the Agent.
        for ctx, result, returned, worker in turns:
            assert ctx.pending.wait(3)
            assert any(e == "notice" and d.get("key") == "mcp_discovery_pending" for e, d in ctx.frames)
        assert len(calls) == 2, "a completed catalog scan plus one shared chat retry"
        release.set()
        assert refreshed.wait(1)
        for ctx, result, returned, worker in turns:
            assert ctx.cleared.wait(1)
            assert any(e == "notice_clear" and d.get("key") == "mcp_discovery_pending" for e, d in ctx.frames)
    finally:
        release.set()
        turn_release.set()
        for ctx, result, returned, worker in turns:
            worker.join(5)
    assert all(result["status"] == "completed" for _, result, _, _ in turns)


@pytest.fixture
def profile_delete(discovery, monkeypatch):
    home, release, entered, calls = discovery
    # No Agent memory or review work in these discovery-only lifecycle cases.
    monkeypatch.setattr(chat, "_cancel_background_reviews", lambda *args: [])
    monkeypatch.setattr(chat, "_release_agents_locked", lambda *args: [])
    deleted = []
    monkeypatch.setattr(profiles, "delete_profile", lambda base, name: deleted.append(name))
    registry = Registry(runtime=types.SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
    profiles.register(registry)
    def delete():
        return registry.methods["profiles.delete"](Ctx(), {"base_home": str(home.parent.parent), "name": home.name})
    return delete, deleted


def test_profile_deletion_refuses_until_background_discovery_finishes(discovery, profile_delete, monkeypatch):
    home, release, entered, calls = discovery
    delete, deleted = profile_delete
    release.set()
    commands.discover_profile_mcp_tools()
    release.clear()
    ctx, result, returned, worker = start(home, "delete-pending")
    try:
        assert returned.wait(3)
        monkeypatch.setattr(chat, "_PROFILE_RELEASE_TIMEOUT", 0.02)
        with pytest.raises(RpcError, match="MCP|discovery"):
            delete()
        assert deleted == [], "profile home was removed while discovery could still publish"
        assert commands.profile_mcp_tools_discovered(home), "refused deletion must preserve the live profile baseline"
        release.set()
        assert chat._MCP_DISCOVERIES[str(home.resolve())].wait(1)
        assert delete() == {"ok": True}
        assert deleted == ["alpha"]
    finally:
        release.set()
        worker.join(5)


def test_profile_deletion_forgets_readiness_for_recreated_home(discovery, profile_delete):
    home, release, entered, calls = discovery
    delete, deleted = profile_delete
    release.set()
    commands.discover_profile_mcp_tools()
    assert commands.profile_mcp_tools_discovered(home)
    assert delete() == {"ok": True}
    assert not commands.profile_mcp_tools_discovered(home), "recreated profile inherited deleted profile's readiness"
    release.clear()
    ctx, result, returned, worker = start(home, "recreated")
    try:
        assert entered.wait(1)
        assert not returned.wait(2.2), "recreated profile skipped its first tool snapshot"
        ctx.cancelled = True
        assert returned.wait(1)
    finally:
        release.set()
        worker.join(5)


def test_shutdown_joins_background_discovery_after_turn_finishes(discovery, monkeypatch):
    home, release, entered, calls = discovery
    monkeypatch.setattr(chat, "_cancel_background_reviews", lambda *args: [])
    monkeypatch.setattr(chat, "_release_agents_locked", lambda *args: [])
    release.set()
    commands.discover_profile_mcp_tools()
    release.clear()
    ctx, result, returned, worker = start(home, "shutdown-pending")
    stopped = threading.Event()
    shutdown = threading.Thread(target=lambda: (chat.drain_agents(timeout=1), stopped.set()))
    try:
        assert returned.wait(3)
        shutdown.start()
        assert not stopped.wait(0.1), "shutdown abandoned an active discovery worker"
        release.set()
        assert stopped.wait(1)
    finally:
        release.set()
        worker.join(5)
        if shutdown.ident is not None:
            shutdown.join(5)


def test_profile_delete_fences_new_discovery_until_home_is_removed(discovery, profile_delete, monkeypatch):
    home, release, entered, calls = discovery
    delete, deleted = profile_delete
    release.set()
    commands.discover_profile_mcp_tools()
    def remove(base, name):
        with pytest.raises(RpcError, match="profile|Profile"):
            chat.start(Ctx(), {**_params("during-delete"), "profile_home": str(home)})
    monkeypatch.setattr(profiles, "delete_profile", remove)
    assert delete() == {"ok": True}


def test_fast_turn_refreshes_tools_when_discovery_finishes_during_agent_build(discovery, monkeypatch):
    home, release, entered, calls = discovery
    release.set()
    commands.discover_profile_mcp_tools()
    release.clear()

    class BuildingAgent(FakeAgent):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            self.tools = ["old-tool"]
            # Discovery's first cache refresh runs after this snapshot, before the Agent enters the cache.
            release.set()
            assert chat._MCP_DISCOVERIES[str(home.resolve())].wait(1)

    def refresh(target):
        with chat._AGENT_CACHE_LOCK:
            for agent, _, cached_home in chat._AGENT_CACHE.values():
                if cached_home == target:
                    agent.tools = ["old-tool", "connected-tool"]

    monkeypatch.setattr(chat, "_agent_class", lambda: BuildingAgent)
    monkeypatch.setattr(chat, "refresh_profile_agents_mcp_tools", refresh)
    result = chat.start(Ctx(), {**_params("fast-build"), "profile_home": str(home)})
    assert result["status"] == "completed"
    assert chat._AGENT_CACHE["s1"][0].tools == ["old-tool", "connected-tool"], "fast completed turn cached an Agent without the newly connected tools"
