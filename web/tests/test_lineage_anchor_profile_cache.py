from types import SimpleNamespace

from api import models


def test_verified_lineage_anchor_cache_is_profile_scoped(monkeypatch):
    models._VERIFIED_LINEAGE_ANCHOR_CACHE.clear()
    calls = []

    def state_messages(_sid, *, stitch_continuations, profile):
        assert stitch_continuations is True
        calls.append(profile)
        return [{"timestamp": 1.0 if profile == "default" else 2.0}]

    monkeypatch.setattr(models, "get_state_db_session_messages", state_messages)
    monkeypatch.setattr(models, "_state_db_anchor_index", lambda _rows, _anchor: 0)
    anchor = {"role": "user", "text": "same", "ts": 1.0, "attachments": None}

    default_ts = models._verified_lineage_anchor_timestamp(
        SimpleNamespace(session_id="shared-id", profile="default"),
        anchor,
    )
    work_ts = models._verified_lineage_anchor_timestamp(
        SimpleNamespace(session_id="shared-id", profile="work"),
        anchor,
    )

    assert default_ts == 1.0
    assert work_ts == 2.0
    assert calls == ["default", "work"]
