"""Real native todo hydration and completion publication, without a daemon or model."""
from importlib import import_module
import json
from pathlib import Path
import sys
from types import SimpleNamespace as NS

sys.path.insert(0, sys.argv[1])
progress = import_module('tui_gateway.tool_progress')
if not hasattr(progress, '_todo_state_from_history'):
    print(json.dumps({'supported': False}))
    sys.exit(0)
from gateway.config import Platform
from gateway.run_turn_progress import GatewayTurnProgressMixin
from gateway.session_events import SessionEvents

fixture = json.loads(Path(sys.argv[2]).read_text())
raw = fixture['owner']
history = [
    {'role': 'assistant', 'tool_calls': [{'id': 'todo-call', 'type': 'function', 'function': {'name': 'todo', 'arguments': '{}'}}]},
    {'role': 'tool', 'tool_call_id': 'todo-call', 'content': json.dumps(raw)},
]
assert progress._todo_state_from_history(history) == raw
assert progress._todo_state_from_history([]) is None
stream = SessionEvents()
stream.epoch = 'epoch'
stream.execution = {'authority_epoch': 1, 'execution_generation': 1}
turn = NS(_approval_owner=(NS(sessions={}), 'chat', 1),
          _ctx=NS(source=NS(platform=Platform.LOCAL), _voice_ack_guild=[None], _native_slack_task_cards=False),
          _publish_execution=lambda kind, data: stream.publish('chat', data, event_type=kind),
          _publish_api_tool=lambda *args: None,
          _schedule=lambda coro, name: coro.close())
GatewayTurnProgressMixin.combined_tool_complete_callback(turn, 'todo-call', 'todo', {}, json.dumps(raw))
events = [e for e in stream.since('epoch', 0)['events'] if e['type'] == 'todo.updated']
assert len(events) == 1 and events[0]['payload'] == raw, events
print(json.dumps({'supported': True, 'snapshot': progress._todo_state_from_history(history), 'events': events}))
