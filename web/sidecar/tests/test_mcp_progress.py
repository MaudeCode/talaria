"""Real MCP stdio progress reaches the callback installed by chat.start; older Agents stay quiet."""
from __future__ import annotations

import json
import subprocess

from conftest import AGENT_PYTHON, isolated_env, requires_agent

SERVER = """
from mcp.server.mcpserver import MCPServer, Context
server = MCPServer("progress")
@server.tool()
async def index(ctx: Context) -> str:
    await ctx.report_progress(42, 100, "indexing files")
    await ctx.report_progress(100, 100, "finished")
    return "indexed"
server.run()
"""

PROBE = r'''
import contextlib, importlib.util, json, os
from pathlib import Path
from talaria_sidecar.home import scoped_home
from talaria_sidecar.methods import chat
from tools.registry import registry
has_progress = importlib.util.find_spec('agent.tool_progress_relay') is not None
class Agent:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
    def run_conversation(self, **kwargs):
        name, tid = 'mcp__progress__index', 'call-index'
        self.kwargs['tool_start_callback'](tid, name, {})
        if has_progress:
            from agent.tool_progress_relay import bound_tool_progress
            binding = bound_tool_progress(self.kwargs['tool_progress_callback'], name, tid)
        else:
            binding = contextlib.nullcontext()
        with binding:
            result = registry.dispatch(name, {})
        assert 'indexed' in result, result
        self.kwargs['tool_complete_callback'](tid, name, {}, result)
        return {'final_response': 'ok', 'messages': []}
class Ctx:
    cancelled = False
    def __init__(self): self.frames = []
    def emit(self, event, data=None): self.frames.append([event, data])
chat._agent_class = lambda: Agent
chat._resolve_runtime = lambda *a: {'model': 'm', 'provider': 'p'}
ctx = Ctx()
home = Path(os.environ['HERMES_HOME'])
try:
    with scoped_home(home):
        result = chat.start(ctx, {'profile_home': str(home), 'session_id': 's', 'stream_id': 'st', 'user_message': 'index', 'model': 'm', 'model_provider': 'p'})
    assert result['status'] == 'completed', result
finally:
    from tools.mcp_tool_lifecycle import shutdown_mcp_servers
    from tools.mcp_tool_loop import _stop_mcp_loop
    shutdown_mcp_servers()
    _stop_mcp_loop()
print(json.dumps({'native_progress': has_progress, 'frames': ctx.frames}))
'''

@requires_agent
def test_mcp_stdio_progress_reaches_the_sidecar_tool_row(tmp_path):
    home = tmp_path / 'home'
    home.mkdir()
    server = home / 'server.py'
    server.write_text(SERVER)
    (home / 'config.yaml').write_text('mcp_servers:\n  progress:\n    command: ' + json.dumps(AGENT_PYTHON) + '\n    args: [' + json.dumps(str(server)) + ']\n')
    run = subprocess.run([AGENT_PYTHON, '-c', PROBE], env=isolated_env(home), capture_output=True, text=True, timeout=90)
    assert run.returncode == 0, run.stderr[-5000:] + run.stdout[-2000:]
    result = json.loads(run.stdout.strip().splitlines()[-1])
    progress = [data for event, data in result['frames'] if event == 'tool_progress']
    if not result['native_progress']:
        assert progress == []
        return
    assert progress == [
        {'tool_call_id': 'call-index', 'message': 'indexing files', 'progress': 42.0, 'total': 100.0, 'percent': 42},
        {'tool_call_id': 'call-index', 'message': 'finished', 'progress': 100.0, 'total': 100.0, 'percent': 100},
    ]
