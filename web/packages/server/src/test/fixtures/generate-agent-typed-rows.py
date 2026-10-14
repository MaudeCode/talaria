"""Generate a state.db snapshot of the rows the released, unmodified Agent v0.21.6 types for display (TAL-815).

Usage: <agent-python> generate-agent-typed-rows.py <agent-checkout>
No model calls, account data or live store; fixed IDs and clock make the fixture reproducible. Every typed row is built
by the Agent's own code: its failed-turn boundary copy and kind, its hidden interrupt placeholder, and its stream-cut
continuation nudge (an untyped `[System:` user row).
"""
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from unittest.mock import patch

agent = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(agent))
with tempfile.TemporaryDirectory(prefix="tal815-typed-rows-") as home:
    os.environ["HERMES_HOME"] = home
    from hermes_state import SessionDB
    from hermes_state_common import SCHEMA_VERSION
    assert SCHEMA_VERSION == 31, "Use the pinned v0.21.6 checkout, without Agent modifications"
    from agent.agent_runtime_helpers_placeholders import hidden_interrupt_placeholder_row
    from agent.conversation_loop import _LENGTH_CONTINUATION_NETWORK_STUB
    from agent.turn_failure_copy import FAILED_TURN_DISPLAY_KIND, failed_turn_notice

    path = Path(home) / "state.db"
    sid = "agent-typed-rows"

    def call(call_id):
        return {"role": "assistant", "content": "", "tool_calls": [{"id": call_id, "type": "function", "function": {"name": "terminal", "arguments": "{}"}}]}

    def failed(turn):
        return {"role": "assistant", "content": failed_turn_notice(turn), "display_kind": FAILED_TURN_DISPLAY_KIND, "display_metadata": {"error": "Synthetic provider error"}}

    # Turn 1 fails after a tool ran (a stream cut, its nudge, then the partial boundary); turn 2 is interrupted after a
    # tool and closed by the hidden placeholder; turn 3 fails before any output (the not-processed boundary).
    first = [{"role": "user", "content": "Run the migration"}, call("call_migrate"), {"role": "tool", "content": "migrated", "tool_call_id": "call_migrate"}, {"role": "user", "content": _LENGTH_CONTINUATION_NETWORK_STUB}]
    second = [{"role": "user", "content": "Deploy it"}, call("call_deploy"), {"role": "tool", "content": "deploying", "tool_call_id": "call_deploy"}, hidden_interrupt_placeholder_row()]
    third = [{"role": "user", "content": "Try once more"}]
    messages = [*first, failed(first), *second, *third, failed(third)]
    for i, msg in enumerate(messages, 1):
        msg.update(timestamp=999 + i, message_uid=f"fixture-{i}")

    with closing(SessionDB(path)) as db:
        with patch("hermes_state_sessions.time.time", return_value=1000):
            db.create_session(sid, source="cli")
        db.append_messages_batch(sid, messages)

    def sql_value(value):
        if value is None:
            return "NULL"
        if isinstance(value, bytes):
            return f"X'{value.hex()}'"
        if isinstance(value, str):
            return "'" + value.replace("'", "''") + "'"
        return repr(value)

    with sqlite3.connect(path) as conn:
        tables = ("sessions", "messages", "system_prompts")
        definitions = [row[0] for row in conn.execute("SELECT sql FROM sqlite_master WHERE tbl_name IN (?, ?, ?) AND type IN ('table', 'index') AND sql IS NOT NULL ORDER BY type DESC, name", tables)]
        inserts = [f'INSERT INTO "{table}" VALUES({",".join(sql_value(v) for v in row)});' for table in tables for row in conn.execute(f'SELECT * FROM "{table}"')]
    fixture = {"agentRevision": "818c13be1dc4fd28987e1e881a9408224afd4535", "agentRelease": "v0.21.6", "sessionId": sid, "schema": (";\n".join(definitions) + ";").splitlines(), "inserts": inserts}
    Path(__file__).with_name("agent-typed-rows.json").write_text(json.dumps(fixture, indent=2) + "\n")
