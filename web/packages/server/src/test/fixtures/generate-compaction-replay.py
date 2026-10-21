"""Generate synthetic lifecycle snapshots using the released, unmodified Agent v0.21.6 or v0.22.3.

Usage: <agent-python> generate-compaction-replay.py <agent-checkout> [--carrier]
Use --carrier with v0.22.3 for the kept-message summary fixture.
No model calls, account data or live store; fixed IDs and clock make the fixture reproducible.
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

agent = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(agent))
with tempfile.TemporaryDirectory(prefix="tal783-versions-") as home:
    os.environ["HERMES_HOME"] = home
    from hermes_state import SessionDB
    from hermes_state_common import SCHEMA_VERSION
    carrier_mode = "--carrier" in sys.argv[2:]
    assert SCHEMA_VERSION == (32 if carrier_mode else 31), "Use unmodified v0.22.3 for --carrier, otherwise v0.21.6"
    from agent.context_compressor import ContextCompressor, SUMMARY_PREFIX, _SUMMARY_END_MARKER

    path = Path(home) / "state.db"
    sid = "compaction-replay"
    snapshots = {}
    schema = []

    def sql_value(value):
        if value is None:
            return "NULL"
        if isinstance(value, bytes):
            return f"X'{value.hex()}'"
        if isinstance(value, str):
            # sqlite3.iterdump uses quote(), which truncates the Agent's NUL-prefixed structured content.
            if "\0" in value:
                return f"CAST(X'{value.encode().hex()}' AS TEXT)"
            return "'" + value.replace("'", "''") + "'"
        return repr(value)

    def snapshot(name):
        with sqlite3.connect(path) as conn:
            tables = ("sessions", "messages", "system_prompts")
            definitions = [row[0] for row in conn.execute("SELECT sql FROM sqlite_master WHERE tbl_name IN (?, ?, ?) AND type IN ('table', 'index') AND sql IS NOT NULL ORDER BY type DESC, name", tables)]
            inserts = [f'INSERT INTO "{table}" VALUES({",".join(sql_value(v) for v in row)});' for table in tables for row in conn.execute(f'SELECT * FROM "{table}"')]
            if not schema:
                schema.extend((";\n".join(definitions) + ";").splitlines())
            snapshots[name] = inserts

    def unaddressed(msg):
        return {k: copy.deepcopy(v) for k, v in msg.items() if k not in ("_row_id", "_db_row_snapshot", "_canonical_row", "_db_persisted")}

    if carrier_mode:
        from agent.context_compressor import _MERGED_PRIOR_CONTEXT_HEADER, _MERGED_SUMMARY_DELIMITER
        import subprocess
        revision = subprocess.check_output(["git", "-C", str(agent), "rev-parse", "HEAD"], text=True).strip()
        assert revision == "5b147ab036d6d19131bff8d20701b5001eab844a", "Use the v0.22.3 release"
        sid = "compaction-carrier"
        messages = [
            {"role": "user", "content": "Inspect the parser."},
            {"role": "assistant", "content": "I will inspect the parser."},
            {"role": "user", "content": "Keep the public interface unchanged."},
            {"role": "assistant", "content": "The parser interface is preserved."},
        ]
        for i, msg in enumerate(messages, 1):
            msg.update(timestamp=999 + i, message_uid=f"carrier-{i}")
        before = [{k: v for k, v in msg.items() if k != "message_uid"} for msg in messages]
        summary = SUMMARY_PREFIX + "\nParser inspected; the public interface must stay unchanged."
        compressor = ContextCompressor.__new__(ContextCompressor)
        compressor._summary_has_user_turn = True
        with closing(SessionDB(path)) as db:
            with patch("hermes_state_sessions.time.time", return_value=1000):
                db.create_session(sid, source="webui")
            db.append_messages_batch(sid, messages)
            snapshot("initial")
            carrier = copy.deepcopy(messages[1])
            compressor._merge_summary_into_tail_row(carrier, summary, "assistant", False)
            assert carrier["content"].startswith(_MERGED_PRIOR_CONTEXT_HEADER)
            assert _MERGED_SUMMARY_DELIMITER in carrier["content"]
            with patch("hermes_state_messages.time.time", return_value=2000):
                db.archive_and_compact(sid, [carrier, *copy.deepcopy(messages[2:])])
            snapshot("compacted")
            with patch("hermes_state_messages.time.time", return_value=2500):
                db.archive_and_compact(sid, [copy.deepcopy(carrier), *copy.deepcopy(messages[2:])])
            snapshot("replayed")
        fixture = {"agentRevision": revision, "agentRelease": "v0.22.3", "sessionId": sid,
                   "before": before, "summary": summary + "\n\n" + _SUMMARY_END_MARKER,
                   "schema": schema, "snapshots": snapshots}
        Path(__file__).with_name("compaction-carrier.json").write_text(json.dumps(fixture, indent=2) + "\n")
        sys.exit(0)

    with closing(SessionDB(path)) as db:
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

        replay = compact(messages[0], 2000)
        snapshot("compacted")
        replay = compact(replay, 2500)
        snapshot("twiceCompacted")
        edited = {**unaddressed(messages[0]), "content": "Only fix the parser error", "timestamp": 3000}
        db.append_messages_batch(sid, [edited])
        snapshot("editedActive")
        replay = compact(edited, 4000)
        snapshot("editedThenCompacted")
        replay = compact(replay, 5000)
        snapshot("editedTwiceCompacted")
        # Returning to an older request with its old timestamp is still a later authored edit.
        reverted = unaddressed(messages[0])
        db.append_messages_batch(sid, [reverted])
        snapshot("reverted")
        with patch("hermes_state_sessions.time.time", return_value=6000):
            db.create_session("media", source="webui")
        media = {"role": "user", "content": [{"type": "text", "text": "Inspect this image"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}}], "message_uid": "media-user", "timestamp": 6000}
        db.append_messages_batch("media", [media])
        for clock in (7000, 8000):
            carrier = {"role": "assistant", "content": SUMMARY_PREFIX + "\nImage work.\n" + _SUMMARY_END_MARKER, "message_uid": f"media-summary-{clock}"}
            compacted = compressor._reappend_inflight_user_task([carrier], media)
            with patch("hermes_state_messages.time.time", return_value=clock):
                db.archive_and_compact("media", compacted)
            media = compacted[-1]
        snapshot("multimodal")
    fixture = {"agentRevision": "818c13be1dc4fd28987e1e881a9408224afd4535", "agentRelease": "v0.21.6", "sessionId": sid, "before": before, "schema": schema, "snapshots": snapshots}
    Path(__file__).with_name("compaction-replay.json").write_text(json.dumps(fixture, indent=2) + "\n")
