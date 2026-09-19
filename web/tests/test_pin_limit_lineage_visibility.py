import sys
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from api.routes import _session_row_lineage_root_id, _visible_pinned_lineage_ids


class _FakeSession:
    def __init__(self, session_id, *, pinned=False, parent_session_id=None):
        self.session_id = session_id
        self.pinned = pinned
        self.archived = False
        self.parent_session_id = parent_session_id
        self.profile = "default"
        self.saved = 0

    def compact(self):
        return {
            "session_id": self.session_id,
            "pinned": self.pinned,
            "archived": self.archived,
            "parent_session_id": self.parent_session_id,
            "profile": self.profile,
        }

    def save(self):
        self.saved += 1


def test_visible_pinned_lineage_ids_dedupes_multiple_pinned_continuations():
    rows = [
        {
            "session_id": "gov-new",
            "title": "Project OS Governor",
            "pinned": True,
            "archived": False,
            "parent_session_id": "gov-mid",
        },
        {
            "session_id": "gov-mid",
            "title": "Project OS Governor",
            "pinned": True,
            "archived": False,
            "parent_session_id": "gov-root",
        },
        {
            "session_id": "gov-root",
            "title": "Project OS Governor",
            "pinned": True,
            "archived": False,
            "parent_session_id": None,
        },
        {
            "session_id": "other-pin",
            "title": "Import Preview",
            "pinned": True,
            "archived": False,
            "parent_session_id": None,
        },
    ]
    roots = _visible_pinned_lineage_ids(rows)
    assert roots == {"gov-root", "other-pin"}


def test_visible_pinned_lineage_ids_ignores_hidden_precompression_snapshots():
    rows = [
        {
            "session_id": "snap-root",
            "title": "Project OS Governor",
            "pinned": True,
            "archived": False,
            "pre_compression_snapshot": True,
            "parent_session_id": None,
        },
        {
            "session_id": "live-root",
            "title": "Project OS Governor",
            "pinned": True,
            "archived": False,
            "parent_session_id": "snap-root",
        },
    ]
    roots = _visible_pinned_lineage_ids(rows)
    assert roots == {"snap-root"}


def test_session_row_lineage_root_uses_explicit_root_when_present():
    row = {
        "session_id": "tip",
        "_lineage_root_id": "root-123",
        "parent_session_id": "older",
    }
    assert _session_row_lineage_root_id(row, {"tip": row}) == "root-123"


def test_pinned_forks_of_same_parent_count_as_separate_lineages():
    """A branch/fork (session_source='fork') is an independent visible session and
    must consume its own pin slot — two pinned forks of the same parent must NOT
    collapse to one quota lineage (would let the user exceed the pin limit). #3288."""
    rows = [
        {
            "session_id": "parent-root",
            "title": "Original",
            "pinned": True,
            "archived": False,
            "parent_session_id": None,
        },
        {
            "session_id": "fork-a",
            "title": "Fork A",
            "pinned": True,
            "archived": False,
            "session_source": "fork",
            "parent_session_id": "parent-root",
        },
        {
            "session_id": "fork-b",
            "title": "Fork B",
            "pinned": True,
            "archived": False,
            "session_source": "fork",
            "parent_session_id": "parent-root",
        },
    ]
    # Each fork is its own lineage root; the parent is its own root too → 3 lineages.
    assert _session_row_lineage_root_id(rows[1], {r["session_id"]: r for r in rows}) == "fork-a"
    assert _session_row_lineage_root_id(rows[2], {r["session_id"]: r for r in rows}) == "fork-b"
    roots = _visible_pinned_lineage_ids(rows)
    assert roots == {"parent-root", "fork-a", "fork-b"}
    # Three distinct pinned lineages → would exceed a limit of 2 (no false collapse).
    assert len(roots) == 3


def test_pin_quota_ignores_stale_pinned_objects_in_session_lru(monkeypatch):
    """Only durable rows plus in-flight reservations own pin quota.

    A cached object may outlive its sidebar/index row. Counting the LRU made an
    invisible ghost pin reject a valid third pin at a configured limit of 3.
    """
    from api import routes

    target = _FakeSession("target")
    ghost = _FakeSession("ghost", pinned=True)
    persisted = [
        _FakeSession("pin-a", pinned=True).compact(),
        _FakeSession("pin-b", pinned=True).compact(),
    ]
    captured = {}

    monkeypatch.setattr(routes, "_check_csrf", lambda _handler: True)
    monkeypatch.setattr(
        routes,
        "read_body",
        lambda _handler: {"session_id": "target", "pinned": True},
    )
    monkeypatch.setattr(routes, "_session_is_subagent_view_only", lambda _sid: False)
    monkeypatch.setattr(routes, "get_session", lambda _sid, **_kwargs: target)
    monkeypatch.setattr(routes, "_ensure_full_session_before_mutation", lambda _sid, s: s)
    monkeypatch.setattr(routes, "all_sessions", lambda: list(persisted))
    monkeypatch.setattr(routes, "load_settings", lambda: {"pinned_sessions_limit": 3})
    monkeypatch.setattr(routes, "SESSIONS", {"ghost": ghost})
    monkeypatch.setattr(routes, "_get_session_agent_lock", lambda _sid: nullcontext())
    monkeypatch.setattr(routes, "publish_session_list_changed", lambda *_a, **_k: None)
    monkeypatch.setattr(
        routes,
        "j",
        lambda _handler, payload, status=200, **_kwargs: captured.update(
            payload=payload,
            status=status,
        )
        or True,
    )
    monkeypatch.setattr(
        routes,
        "bad",
        lambda _handler, error, status=400, **_kwargs: captured.update(
            payload={"error": error},
            status=status,
        )
        or True,
    )
    routes._PIN_QUOTA_RESERVATIONS.clear()

    assert routes.handle_post(object(), SimpleNamespace(path="/api/session/pin")) is True
    assert captured["status"] == 200
    assert target.pinned is True
    assert target.saved == 1
    assert routes._PIN_QUOTA_RESERVATIONS == set()
