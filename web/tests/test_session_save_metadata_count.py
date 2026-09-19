import json
from pathlib import Path

from api import models


def test_growing_modern_session_save_does_not_parse_old_transcript(tmp_path, monkeypatch):
    monkeypatch.setattr(models, "SESSION_DIR", tmp_path)
    monkeypatch.setattr(models, "SESSION_INDEX_FILE", tmp_path / "_index.json")
    session = models.Session(
        session_id="save_count_fast_path",
        messages=[{"role": "user", "content": "first"}],
    )
    session.save(skip_index=True)
    session.messages.append({"role": "assistant", "content": "second"})

    real_read_text = Path.read_text

    def fail_session_read_text(path, *args, **kwargs):
        if path == session.path:
            raise AssertionError("modern growing save parsed the old transcript")
        return real_read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", fail_session_read_text)
    session.save(skip_index=True)

    payload = json.loads(real_read_text(session.path, encoding="utf-8"))
    assert payload["message_count"] == 2
    assert len(payload["messages"]) == 2


def test_shrinking_modern_session_still_writes_full_backup(tmp_path, monkeypatch):
    monkeypatch.setattr(models, "SESSION_DIR", tmp_path)
    monkeypatch.setattr(models, "SESSION_INDEX_FILE", tmp_path / "_index.json")
    session = models.Session(
        session_id="save_count_backup",
        messages=[
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "second"},
        ],
    )
    session.save(skip_index=True)
    session.messages = session.messages[:1]

    session.save(skip_index=True)

    backup = json.loads(session.path.with_suffix(".json.bak").read_text(encoding="utf-8"))
    current = json.loads(session.path.read_text(encoding="utf-8"))
    assert len(backup["messages"]) == 2
    assert len(current["messages"]) == 1
