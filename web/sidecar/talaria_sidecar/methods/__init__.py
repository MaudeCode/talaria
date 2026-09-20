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
    from . import runtime as runtime_methods  # noqa: WPS433 - namespaces register on import

    for module in (runtime_methods,):
        module.register(registry)
    return registry.methods
