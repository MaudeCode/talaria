"""Regenerate compaction-replay.json with the v0.21.6 Agent checkout and its venv.

Usage: <agent-venv>/bin/python generate-compaction-replay.py <agent-checkout>
Uses the real replay and persistence methods with a synthetic summary, no LLM.
"""
from contextlib import closing
import copy
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from unittest.mock import patch

sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
with tempfile.TemporaryDirectory(prefix="tal783-") as home:
    os.environ["HERMES_HOME"] = home
    from hermes_state import SessionDB
    from agent.context_compressor import ContextCompressor, SUMMARY_PREFIX, _SUMMARY_END_MARKER

    path = Path(home) / "state.db"
    with closing(SessionDB(path)) as db:
        sid = "compaction-replay"
        with patch("hermes_state_sessions.time.time", return_value=1000):
            db.create_session(sid, source="webui")
        messages = [
            {"role": "user", "content": "Refactor the parser please"},
            {"role": "assistant", "content": "I will inspect the parser."},
            {"role": "user", "content": "Keep the public interface unchanged."},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "call_read", "type": "function", "function": {"name": "read_file", "arguments": "{}"}}]},
            {"role": "tool", "content": "Synthetic parser source", "tool_call_id": "call_read"},
        ]
        for i, msg in enumerate(messages, 1):
            msg.update(timestamp=999 + i, message_uid=f"fixture-{i}")
        messages[3]["tool_call_uids"] = {"call_read": "fixture-tool-call"}
        db.append_messages_batch(sid, messages)
        before = [{k: v for k, v in msg.items() if k in ("role", "content", "timestamp", "tool_calls", "tool_call_id")} for msg in messages]
        carrier = {"role": "assistant", "content": SUMMARY_PREFIX + "\nParser work in progress.\n" + _SUMMARY_END_MARKER, "message_uid": "fixture-summary"}
        compressor = ContextCompressor.__new__(ContextCompressor)
        compressor.quiet_mode = True
        compacted = compressor._reappend_inflight_user_task([carrier, *copy.deepcopy(messages[-2:])], messages[0])
        assert compacted[-1]["content"].startswith("[STILL IN PROGRESS")
        assert "timestamp" not in compacted[-1]
        with patch("hermes_state_messages.time.time", return_value=2000):
            db.archive_and_compact(sid, compacted, carried_messages=messages[-2:])
    with sqlite3.connect(path) as conn:
        # Preserve the Agent's actual table and index definitions, without unrelated FTS state.
        schema = [row[0] for row in conn.execute("SELECT sql FROM sqlite_master WHERE tbl_name IN ('sessions', 'messages', 'system_prompts') AND type IN ('table', 'index') AND sql IS NOT NULL ORDER BY type DESC, name")]
        dump = list(conn.iterdump())
        inserts = [line for table in ("sessions", "messages") for line in dump if line.startswith(f'INSERT INTO "{table}"')]
        replay = conn.execute("SELECT message_uid, timestamp FROM messages WHERE id = 9").fetchone()
        assert replay[0] == "fixture-1" and replay[1] > 2000
    fixture = {"agentRelease": "v0.21.6", "agentRevision": "818c13be1dc4fd28987e1e881a9408224afd4535", "sessionId": sid, "before": before, "sql": (";\n".join(schema) + ";\n" + "\n".join(inserts)).splitlines()}
    Path(__file__).with_name("compaction-replay.json").write_text(json.dumps(fixture, indent=2) + "\n")
