"""Record SessionDB's multimodal backfill for TAL-888.

Run with PYTHONPATH pointing at Hermes Agent 818c13be1dc4fd28987e1e881a9408224afd4535.
Only a disposable database is written; the fixture preserves its encoded content.
"""
import json
import sqlite3
import tempfile
from pathlib import Path

from hermes_state import SessionDB

with tempfile.TemporaryDirectory(prefix="talaria-memory-context-") as directory:
    path = Path(directory) / "state.db"
    db = SessionDB(path)
    db.create_session("memory-image", "cli")
    content = [
        {"type": "text", "text": "What is in this picture?"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1sAAAAASUVORK5CYII="}},
    ]
    row_id = db.append_message("memory-image", "user", content, timestamp=100)
    content.append({"type": "text", "text": "<memory-context>\nRecalled memory: prefers metric units.\n</memory-context>"})
    assert db.set_user_message_content("memory-image", row_id, content) == 1
    db.close()
    with sqlite3.connect(path) as connection:
        connection.row_factory = sqlite3.Row
        row = dict(connection.execute("SELECT id, session_id, role, content, timestamp FROM messages WHERE id = ?", (row_id,)).fetchone())
    Path(__file__).with_name("memory-context.json").write_text(json.dumps(row, indent=2) + "\n")
