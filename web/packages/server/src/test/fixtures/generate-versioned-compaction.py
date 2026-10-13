"""Generate synthetic lifecycle snapshots using the real unreleased Agent contract.

Usage: <agent-python> generate-versioned-compaction.py <agent-checkout>
No model calls, account data or live store; fixed IDs and clock make the fixture reproducible.
"""
from contextlib import closing
import copy
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from unittest.mock import patch

agent = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(agent))
with tempfile.TemporaryDirectory(prefix="tal783-versions-") as home:
    os.environ["HERMES_HOME"] = home
    from hermes_state import SessionDB
    from agent.context_compressor import ContextCompressor, SUMMARY_PREFIX, _SUMMARY_END_MARKER

    path = Path(home) / "state.db"
    sid = "compaction-replay"
    snapshots = {}
    schema = []

    def snapshot(name):
        with sqlite3.connect(path) as conn:
            tables = ("sessions", "messages", "system_prompts", "message_versions")
            definitions = [row[0] for row in conn.execute("SELECT sql FROM sqlite_master WHERE tbl_name IN (?, ?, ?, ?) AND type IN ('table', 'index') AND sql IS NOT NULL ORDER BY type DESC, name", tables)]
            inserts = [line for line in conn.iterdump() if any(line.startswith(f'INSERT INTO "{table}"') for table in tables)]
            if not schema:
                schema.extend((";\n".join(definitions) + ";").splitlines())
            snapshots[name] = inserts

    def unaddressed(msg):
        return {k: copy.deepcopy(v) for k, v in msg.items() if k not in ("_row_id", "_db_row_snapshot", "_canonical_row", "_db_persisted")}

    with closing(SessionDB(path)) as db:
        counter = iter(range(1, 1000))
        db._conn.create_function("randomblob", 1, lambda size: next(counter).to_bytes(size, "big"))
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
        snapshot("initial")
        compressor = ContextCompressor.__new__(ContextCompressor)
        compressor.quiet_mode = True

        def compact(request, clock):
            carrier = {"role": "assistant", "content": SUMMARY_PREFIX + "\nParser work in progress.\n" + _SUMMARY_END_MARKER, "message_uid": f"summary-{clock}"}
            compacted = compressor._reappend_inflight_user_task([carrier, *copy.deepcopy(messages[-2:])], request)
            with patch("hermes_state_messages.time.time", return_value=clock):
                db.archive_and_compact(sid, compacted, carried_messages=messages[-2:])
            return compacted[-1]

        compact(messages[0], 2000)
        snapshot("compacted")
        edited = {**unaddressed(messages[0]), "content": "Only fix the parser error", "timestamp": 3000}
        db.append_messages_batch(sid, [edited])
        replay = compact(edited, 4000)
        snapshot("editedThenCompacted")
        db.set_user_message_content(sid, replay["_row_id"], "Only fix the parser error and add tests")
        snapshot("rewritten")
        db.replace_messages(sid, db.get_messages_as_conversation(sid, include_row_ids=True))
        snapshot("replaced")
    fixture = {"agentRevision": subprocess.check_output(["git", "-C", str(agent), "rev-parse", "HEAD"], text=True).strip(), "agentRelease": None, "sessionId": sid, "before": before, "schema": schema, "snapshots": snapshots}
    Path(__file__).with_name("versioned-compaction.json").write_text(json.dumps(fixture, indent=2) + "\n")
