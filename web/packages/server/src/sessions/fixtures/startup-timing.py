"""Synthetic stdio integration: real RPC and chat handler, fake Agent; no network or account."""
import json
import logging
import sys
from pathlib import Path

from talaria_sidecar.rpc import RpcServer
from talaria_sidecar.methods import chat

logging.basicConfig(level=logging.INFO, format="%(message)s")
fixtures = {}
for file in Path(sys.argv[1]).glob("*.json"):
    fixtures.update(json.loads(file.read_text()))


class Agent:
    def __init__(self, **kwargs):
        self.model = "test-model"
        self.stream_delta_callback = kwargs["stream_delta_callback"]

    def run_conversation(self, **kwargs):
        self.stream_delta_callback("synthetic answer")
        return {"messages": [{"role": "assistant", "content": "synthetic answer"}], "final_response": "synthetic answer"}


chat._discover_mcp_tools = lambda run: None
chat._resolve_runtime = lambda provider, model: {"model": "test-model", "provider": "test"}
chat._agent_class = lambda: Agent
chat._agent_kwargs = lambda *args: {}
chat._build_agent = lambda cls, kwargs, *args, **kw: cls(**kwargs)
chat._set_vault_prompts = lambda *args: None


def reply(ctx, params):
    return fixtures[ctx.method][0]["result"]


methods = {method: reply for method in fixtures}
methods["chat.start"] = chat.start
methods["goals.get"] = lambda ctx, params: {"goal": None}
RpcServer(methods).serve_forever()
