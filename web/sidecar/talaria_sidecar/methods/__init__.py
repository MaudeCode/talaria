"""Method registry: one module per RPC namespace (docs/architecture/sidecar-rpc.md)."""

from __future__ import annotations

from typing import Callable

from ..rpc import CallContext, Handler
from ..runtime import AgentRuntime


class Registry:
    def __init__(self, runtime: AgentRuntime):
        self.runtime = runtime
        self.methods: dict[str, Handler] = {}

    def method(self, name: str, *, requires_agent: bool = True) -> Callable[[Callable], Callable]:
        def register(func: Callable) -> Callable:
            def handler(ctx: CallContext, params: dict):
                if requires_agent:
                    self.runtime.load()
                    self.runtime.ensure_current()
                return func(ctx, params)

            self.methods[name] = handler
            return func

        return register


def build_methods(runtime: AgentRuntime) -> dict[str, Handler]:
    registry = Registry(runtime)
    from . import agent_imports, aux, chat, checkpoints, commands, config, connectors, cron, dashboard_plugins, delegation, gateway, goals, kanban, mcp, managed_buffers, memory, meshy, oauth, outbound_drafts, plugin_oauth, process, profiles, providers, skills, state_db, stt, tts, text, toolsets, usage, worktree, write_approval  # noqa: WPS433
    from . import runtime as runtime_methods

    for module in (agent_imports, runtime_methods, goals, commands, kanban, state_db, profiles, skills, mcp, stt, tts, cron, providers, oauth, plugin_oauth, aux, delegation, text, process, usage, gateway, worktree, checkpoints, memory, chat, config, toolsets, write_approval, connectors, dashboard_plugins, outbound_drafts, managed_buffers, meshy):
        module.register(registry)
    return registry.methods
