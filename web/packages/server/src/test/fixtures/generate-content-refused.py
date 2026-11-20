"""Generate a state.db snapshot of two safety-refused chats as the released, unmodified Agent v0.23.2 stores them (TAL-2057).

Usage: <agent-python> generate-content-refused.py <agent-checkout>
No model calls, account data or live store; fixed IDs and clock make the fixture reproducible. Both refusals are written by the
Agent's own code: `retained` by the owner retention a current build runs after a refused turn
(`hermes_state_rewind.retain_refused_turn_for_display`), `repaired` by the repair a writable `SessionDB` open runs on a chat an
older build locked (`hermes_state_legacy_refusal`, keyed on the `failed_turn` boundary that build wrote).
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
with tempfile.TemporaryDirectory(prefix="tal2057-content-refused-") as home:
    os.environ["HERMES_HOME"] = home
    from hermes_state import SessionDB
    from hermes_state_rewind import retain_refused_turn_for_display
    from agent.turn_failure_copy import CONTENT_REFUSED_NOTICE, FAILED_TURN_DISPLAY_KIND

    path = Path(home) / "state.db"
    answered = [{"role": "user", "content": "Plan the trip"}, {"role": "assistant", "content": "Here is the plan."}]

    def stamped(messages, prefix):
        for i, msg in enumerate(messages, 1):
            msg.update(timestamp=999 + i, message_uid=f"{prefix}-{i}")
        return messages

    with closing(SessionDB(path)) as db:
        with patch("hermes_state_sessions.time.time", return_value=1000):
            db.create_session("retained", source="cli")
            db.create_session("repaired", source="cli")
        # A current build flushed the refused ask at turn start, then its owner retains it for display only.
        db.append_messages_batch("retained", stamped([*answered, {"role": "user", "content": "The refused ask"}], "retained"))
        boundary = db.get_messages("retained")[-1]["id"]
        assert retain_refused_turn_for_display(db, "retained", notice=CONTENT_REFUSED_NOTICE, boundary_row_id=boundary)
        # An older build closed the refused turn with a failed-turn boundary naming the refusal, and left it in the context.
        legacy = {"role": "assistant", "content": "Your request was not processed. Send it again if you still want me to carry it out.",
                  "display_kind": FAILED_TURN_DISPLAY_KIND, "display_metadata": {"error_surface": {"code": "content_policy_blocked"}}}
        db.append_messages_batch("repaired", stamped([*answered, {"role": "user", "content": "The refused ask"}, legacy], "repaired"))
    # The repair runs when a writable store opens; this store marked itself repaired when it was created, so let it look again.
    with sqlite3.connect(path) as conn:
        conn.execute("DELETE FROM state_meta WHERE key LIKE 'legacy_refusal_repair%'")
    with closing(SessionDB(path)) as db:
        # A surface showing either chat reads its display rows, which indexes the refused ask for read-only readers.
        for sid in ("retained", "repaired"):
            assert [m["content"] for m in db.get_messages(sid, include_compacted=True)][-1] == "The refused ask"

    def sql_value(value):
        if value is None:
            return "NULL"
        if isinstance(value, bytes):
            return f"X'{value.hex()}'"
        if isinstance(value, str):
            return "'" + value.replace("'", "''") + "'"
        return repr(value)

    with sqlite3.connect(path) as conn:
        repaired = conn.execute("SELECT display_kind FROM messages WHERE session_id = 'repaired' AND content = 'The refused ask'").fetchone()
        assert repaired == ("content_refused",), repaired
        tables = ("sessions", "messages", "system_prompts")
        definitions = [row[0] for row in conn.execute("SELECT sql FROM sqlite_master WHERE tbl_name IN (?, ?, ?) AND type IN ('table', 'index') AND sql IS NOT NULL ORDER BY type DESC, name", tables)]
        inserts = [f'INSERT INTO "{table}" VALUES({",".join(sql_value(v) for v in row)});' for table in tables for row in conn.execute(f'SELECT * FROM "{table}" ORDER BY rowid')]
    fixture = {"agentRevision": "ae2a81ccc00e9b7c06301523e5bb09608397149c", "agentRelease": "v0.23.2", "notice": CONTENT_REFUSED_NOTICE,
               "schema": (";\n".join(definitions) + ";").splitlines(), "inserts": inserts}
    Path(__file__).with_name("content-refused.json").write_text(json.dumps(fixture, indent=2) + "\n")
