import json
from types import SimpleNamespace

from api import models


def _session(sid, updated_at):
    entry = {
        "session_id": sid,
        "title": sid,
        "updated_at": updated_at,
        "message_count": 1,
    }
    return SimpleNamespace(session_id=sid, compact=lambda: dict(entry))


def test_large_index_updates_reuse_signature_guarded_parsed_cache(tmp_path, monkeypatch):
    index_path = tmp_path / "_index.json"
    entries = [
        {"session_id": f"sid-{i}", "title": f"sid-{i}", "updated_at": i, "message_count": 1}
        for i in range(3000)
    ]
    index_path.write_text(json.dumps(entries), encoding="utf-8")
    all_ids = frozenset(entry["session_id"] for entry in entries)
    monkeypatch.setattr(models, "SESSION_DIR", tmp_path)
    monkeypatch.setattr(models, "SESSION_INDEX_FILE", index_path)
    monkeypatch.setattr(models, "SESSIONS", {})
    monkeypatch.setattr(models, "_persisted_session_ids_snapshot", lambda: all_ids)

    models._write_session_index(updates=[_session("sid-1500", 4000)])

    real_read_bytes = type(index_path).read_bytes

    def reject_second_parse(path):
        if path == index_path:
            raise AssertionError("warm targeted update reread and reparsed the full index")
        return real_read_bytes(path)

    monkeypatch.setattr(type(index_path), "read_bytes", reject_second_parse)
    models._write_session_index(updates=[_session("sid-1500", 5000)])

    persisted = json.loads(index_path.read_text(encoding="utf-8"))
    assert persisted[0]["session_id"] == "sid-1500"
    assert persisted[0]["updated_at"] == 5000


def test_identical_targeted_index_update_is_a_noop(tmp_path, monkeypatch):
    index_path = tmp_path / "_index.json"
    entry = {"session_id": "sid-same", "title": "sid-same", "updated_at": 10, "message_count": 1}
    index_path.write_text(json.dumps([entry]), encoding="utf-8")
    monkeypatch.setattr(models, "SESSION_DIR", tmp_path)
    monkeypatch.setattr(models, "SESSION_INDEX_FILE", index_path)
    monkeypatch.setattr(models, "SESSIONS", {})
    monkeypatch.setattr(models, "_persisted_session_ids_snapshot", lambda: frozenset({"sid-same"}))
    monkeypatch.setattr(
        models,
        "_safe_replace",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("identical row rewrote index")),
    )

    models._write_session_index(updates=[_session("sid-same", 10)])

    assert json.loads(index_path.read_text(encoding="utf-8")) == [entry]
