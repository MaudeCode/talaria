"""Message-level media snapshots: freeze file bytes at settle time.

PR #6922 made /api/media revalidate on every use (no-cache + ETag), so an
in-place overwrite of a file (same filename) also rewrites every historical
chat preview that referenced it — the old/new comparison is lost. This suite
covers the fix: at settle time the WebUI snapshots each local-file MEDIA:
reference into a content-addressed store and stamps the message with
``_media_snapshots``; the frontend appends ``&snap=<digest>`` to historical
preview URLs and /api/media serves the frozen bytes instead of the live file.

Key property under test: a snapshot survives the original file being
overwritten AND deleted, while a request WITHOUT a snap keeps serving the live
(possibly new) bytes.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]


class _FakeHandler:
    def __init__(self, headers=None):
        self.status = None
        self.sent_headers: list[tuple[str, str]] = []
        self.body = bytearray()
        self.wfile = self
        self.headers = dict(headers or {})

    def send_response(self, code):
        self.status = code

    def send_header(self, key, value):
        self.sent_headers.append((key, value))

    def end_headers(self):
        pass

    def write(self, data):
        self.body.extend(data)

    def header(self, key):
        return next((v for k, v in self.sent_headers if k == key), "") or ""


@pytest.fixture
def routes():
    from api import routes

    return routes


@pytest.fixture(autouse=True)
def media_allowed_root(tmp_path, monkeypatch):
    # tmp_path is under /tmp only on Linux; register it and make Path.home()
    # resolve to the same fixture root on Windows so deny tests reach #3234.
    monkeypatch.setenv("MEDIA_ALLOWED_ROOTS", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))


@pytest.fixture
def snap_dir(tmp_path, monkeypatch):
    """Isolate the snapshot store per test and point it at tmp_path."""
    store = tmp_path / "media_snapshots"
    monkeypatch.setenv("HERMES_WEBUI_MEDIA_SNAPSHOT_DIR", str(store))
    return store


def _media_get(routes, monkeypatch, target, headers=None, query_extra=""):
    monkeypatch.setattr("api.auth.is_auth_enabled", lambda: False)
    handler = _FakeHandler(headers)
    parsed = SimpleNamespace(path="/api/media", query=f"path={target}{query_extra}")
    routes._handle_media(handler, parsed)
    return handler


def test_platform_temp_root_accepts_private_disjoint_root(tmp_path, monkeypatch):
    from api import media_snapshots

    home = tmp_path / "home"
    home.mkdir()
    private_temp = tmp_path / "private-temp"
    private_temp.mkdir(mode=0o700)
    private_temp.chmod(0o700)
    monkeypatch.setattr(media_snapshots.tempfile, "gettempdir", lambda: str(private_temp))

    assert media_snapshots.safe_platform_temp_root(home) == private_temp.resolve()


def test_platform_temp_root_rejects_protected_home_override(tmp_path, monkeypatch):
    from api import media_snapshots

    home = tmp_path / "home"
    home.mkdir()
    hermes_home = home / ".hermes"
    secret = home / "secret.txt"
    secret.write_text("private")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    monkeypatch.delenv("MEDIA_ALLOWED_ROOTS", raising=False)
    monkeypatch.setattr(media_snapshots.tempfile, "gettempdir", lambda: str(home))

    assert media_snapshots.safe_platform_temp_root(home, hermes_home) is None
    assert media_snapshots.media_capture_allowed(secret) is False


def test_handle_media_rejects_protected_home_tmpdir(routes, tmp_path, monkeypatch):
    from api import media_snapshots

    home = tmp_path / "home"
    home.mkdir()
    secret = home / "secret.txt"
    secret.write_text("private")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("HERMES_HOME", str(home / ".hermes"))
    monkeypatch.delenv("MEDIA_ALLOWED_ROOTS", raising=False)
    monkeypatch.setattr(media_snapshots.tempfile, "gettempdir", lambda: str(home))

    denied = _media_get(routes, monkeypatch, secret)
    assert denied.status == 403


# ── capture_snapshot ───────────────────────────────────────────────────────


def test_capture_snapshot_stores_content_addressed_bytes(snap_dir, tmp_path):
    from api.media_snapshots import capture_snapshot, snapshot_path_for_digest

    source = tmp_path / "report.html"
    source.write_bytes(b"<html>v1</html>")

    digest = capture_snapshot(source)
    assert digest and len(digest) == 64

    stored = snapshot_path_for_digest(digest)
    assert stored is not None
    assert stored.read_bytes() == b"<html>v1</html>"


def test_anchored_snapshot_read_preserves_windows_ctrl_z(tmp_path):
    """Anchored binary reads must not treat DOS Ctrl-Z as text EOF on Windows."""
    from api.routes import _etag_and_snapshot, _open_file_read_fd

    payload = b"a" * 568 + b"\x1a" + b"b" * 4096
    source = tmp_path / "clip.mp4"
    source.write_bytes(payload)

    fd = _open_file_read_fd(source, tmp_path)
    try:
        _etag, snapshot, actual_size = _etag_and_snapshot(fd, file_size=len(payload))
    finally:
        os.close(fd)

    assert actual_size == len(payload)
    assert snapshot == payload


def test_anchored_file_leaf_uses_binary_open_flag(monkeypatch, tmp_path):
    """The platform-independent flag contract keeps Windows binary-safe in CI."""
    from api import workspace

    source = tmp_path / "clip.mp4"
    source.write_bytes(b"payload")
    seen = {}

    def fake_open(path, flags, *args, **kwargs):
        seen["path"] = path
        seen["flags"] = flags
        return 123

    monkeypatch.setattr(workspace, "_DIR_FD_OK", False)
    monkeypatch.setattr(workspace, "_O_BINARY", 0x40000000)
    monkeypatch.setattr(workspace.os, "open", fake_open)

    fd = workspace.open_anchored_fd(tmp_path, source, want_dir=False)

    assert fd == 123
    assert seen["path"] == str(source)
    assert seen["flags"] & workspace._O_BINARY


def test_anchored_directory_does_not_use_binary_open_flag(monkeypatch, tmp_path):
    """Directory opens keep their directory-only flag contract."""
    from api import workspace

    target = tmp_path / "folder"
    target.mkdir()
    seen = {}

    def fake_open(path, flags, *args, **kwargs):
        seen["flags"] = flags
        return 124

    monkeypatch.setattr(workspace, "_DIR_FD_OK", False)
    monkeypatch.setattr(workspace, "_O_BINARY", 0x40000000)
    monkeypatch.setattr(workspace, "_O_DIRECTORY", 0x20000000)
    monkeypatch.setattr(workspace.os, "open", fake_open)

    fd = workspace.open_anchored_fd(tmp_path, target, want_dir=True)

    assert fd == 124
    assert seen["flags"] & workspace._O_DIRECTORY
    assert not seen["flags"] & workspace._O_BINARY


def test_capture_snapshot_dedupes_identical_content(snap_dir, tmp_path):
    from api.media_snapshots import capture_snapshot

    a = tmp_path / "a.png"
    b = tmp_path / "b.png"
    a.write_bytes(b"same-bytes")
    b.write_bytes(b"same-bytes")

    d1 = capture_snapshot(a)
    d2 = capture_snapshot(b)
    assert d1 == d2
    # One .snap blob only (the dedup contract); the source-binding sidecar
    # (.src.json) is a separate small file and does not count as a blob.
    assert len(list(snap_dir.glob("*.snap"))) == 1


def test_record_source_binding_does_not_reresolve_authorized_path(
    snap_dir, tmp_path, monkeypatch
):
    import json

    from api.media_snapshots import _binding_path_for_digest, _record_source_binding

    source = tmp_path / "already-canonical.png"
    digest = "a" * 64
    snap_dir.mkdir()

    def reject_late_resolve(_self, *args, **kwargs):
        raise AssertionError("authorized source path must not be resolved again")

    monkeypatch.setattr(Path, "resolve", reject_late_resolve)
    _record_source_binding(digest, source)

    binding = json.loads(_binding_path_for_digest(digest).read_text(encoding="utf-8"))
    assert binding["sources"] == [str(source)]


def test_capture_snapshot_skips_missing_and_over_cap(snap_dir, tmp_path):
    from api.media_snapshots import capture_snapshot

    assert capture_snapshot(tmp_path / "missing.png") is None

    big = tmp_path / "big.mp4"
    big.write_bytes(b"x" * 1024)
    assert capture_snapshot(big, max_file_bytes=512) is None


def test_capture_snapshot_rejects_hard_link_alias_of_denied_file(
    routes, snap_dir, tmp_path, monkeypatch
):
    from api.media_snapshots import capture_snapshot, media_capture_allowed

    state_dir = tmp_path / "state"
    state_dir.mkdir()
    secret = state_dir / "auth.json"
    secret.write_text('{"secret": true}')
    alias = tmp_path / "report.png"
    os.link(secret, alias)
    monkeypatch.setattr("api.config.STATE_DIR", str(state_dir))

    assert media_capture_allowed(secret) is False
    assert alias.stat().st_nlink > 1
    assert media_capture_allowed(alias) is False
    assert capture_snapshot(alias) is None
    assert list(snap_dir.glob("*.snap")) == []
    assert _media_get(routes, monkeypatch, alias).status == 403


def test_capture_snapshot_enforces_cap_during_copy(snap_dir, tmp_path, monkeypatch):
    from api.media_snapshots import capture_snapshot

    source = tmp_path / "growing.log"
    source.write_bytes(b"0123456789")
    real_stat = Path.stat

    def stale_small_stat(path, *args, **kwargs):
        result = real_stat(path, *args, **kwargs)
        if path == source:
            return SimpleNamespace(st_mode=result.st_mode, st_size=1)
        return result

    monkeypatch.setattr(Path, "stat", stale_small_stat)

    assert capture_snapshot(source, max_file_bytes=4) is None
    assert list(snap_dir.glob("*.snap")) == []
    assert list(snap_dir.glob(".tmp.*")) == []


def test_capture_snapshot_skips_directories(snap_dir, tmp_path):
    from api.media_snapshots import capture_snapshot

    assert capture_snapshot(tmp_path) is None


# ── resolve_media_ref / media_capture_allowed ──────────────────────────────


def test_resolve_media_ref_handles_file_url_and_expands_home(tmp_path, monkeypatch):
    from api.media_snapshots import resolve_media_ref

    target = tmp_path / "x.html"
    target.write_text("hi")

    assert resolve_media_ref(str(target)) == target.resolve()
    assert resolve_media_ref("file://" + str(target)) == target.resolve()
    assert resolve_media_ref("https://example.com/a.png") is None
    assert resolve_media_ref("data:image/png;base64,AAAA") is None
    assert resolve_media_ref("") is None


def test_media_capture_allowed_denies_hermes_state(tmp_path, monkeypatch):
    from api.media_snapshots import media_capture_allowed

    # Files under an allowed root (tmp) are fine...
    allowed = tmp_path / "ok.html"
    allowed.write_text("x")
    assert media_capture_allowed(allowed) is True

    # ...but a deny-listed filename under a Hermes root is never snapshotted.
    # Point HOME at the fake tree so <fake-home>/.hermes counts as a root.
    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir()
    secret = hermes_home / "settings.json"
    secret.write_text("{}")
    monkeypatch.setenv("HOME", str(tmp_path))
    assert media_capture_allowed(secret) is False


# ── annotate_media_snapshots ───────────────────────────────────────────────


def test_settle_snapshot_scope_excludes_older_and_following_turns():
    from api.streaming import _current_turn_messages_for_media_snapshots

    token = "stream:current"
    messages = [
        {"role": "assistant", "content": "old MEDIA:/tmp/report.html"},
        {"role": "user", "content": "current", "_active_turn_token": token},
        {"role": "assistant", "content": "new MEDIA:/tmp/report.html"},
        {"role": "user", "content": "following"},
        {"role": "assistant", "content": "later MEDIA:/tmp/report.html"},
    ]

    selected = _current_turn_messages_for_media_snapshots(messages, {"token": token})
    assert selected == messages[1:3]


def test_annotate_stamps_assistant_messages_with_snapshots(snap_dir, tmp_path):
    from api.media_snapshots import annotate_media_snapshots

    target = tmp_path / "report.html"
    target.write_text("<html>v1</html>")

    messages = [
        {"role": "user", "content": "please build it"},
        {"role": "assistant", "content": f"done: MEDIA:{target}"},
        {"role": "assistant", "content": "no media here"},
    ]
    captured = annotate_media_snapshots(messages)
    assert captured == 1

    stamped = messages[1]["_media_snapshots"]
    assert str(target) in stamped
    assert len(stamped[str(target)]) == 64


def test_annotate_is_idempotent_across_settles(snap_dir, tmp_path):
    from api.media_snapshots import annotate_media_snapshots

    target = tmp_path / "report.html"
    target.write_text("<html>v1</html>")
    messages = [{"role": "assistant", "content": f"MEDIA:{target}"}]

    assert annotate_media_snapshots(messages) == 1
    assert annotate_media_snapshots(messages) == 0  # fast-path skip
    assert len(list(snap_dir.glob("*.snap"))) == 1


def test_annotate_skips_remote_and_data_refs(snap_dir, tmp_path):
    from api.media_snapshots import annotate_media_snapshots

    messages = [
        {"role": "assistant", "content": "MEDIA:https://example.com/a.png"},
        {"role": "assistant", "content": "MEDIA:data:image/png;base64,AAAA"},
    ]
    assert annotate_media_snapshots(messages) == 0
    assert "_media_snapshots" not in messages[0]
    assert "_media_snapshots" not in messages[1]


# ── /api/media?snap= serving ───────────────────────────────────────────────


def test_handle_media_serves_snapshot_after_inplace_overwrite(routes, monkeypatch, snap_dir, tmp_path):
    """THE regression test: same filename overwritten must not rewrite old
    previews when the message pins a snapshot digest."""
    from api.media_snapshots import capture_snapshot

    target = tmp_path / "report.html"
    target.write_text("<html>v1</html>")
    digest = capture_snapshot(target)

    # Overwrite the file in place (the scenario that used to break history).
    time.sleep(0.01)
    target.write_text("<html>v2 - completely different</html>")

    # Without snap: live file (new bytes).
    live = _media_get(routes, monkeypatch, target)
    assert live.status == 200
    assert bytes(live.body) == b"<html>v2 - completely different</html>"

    # With snap: frozen v1 bytes, immutable caching.
    pinned = _media_get(routes, monkeypatch, target, query_extra=f"&snap={digest}")
    assert pinned.status == 200
    assert bytes(pinned.body) == b"<html>v1</html>"
    assert pinned.header("Cache-Control") == "private, max-age=31536000, immutable"


def test_handle_media_snapshot_survives_file_deletion(routes, monkeypatch, snap_dir, tmp_path):
    from api.media_snapshots import capture_snapshot

    target = tmp_path / "pic.png"
    target.write_bytes(b"png-bytes-v1")
    digest = capture_snapshot(target)

    target.unlink()

    pinned = _media_get(routes, monkeypatch, target, query_extra=f"&snap={digest}")
    assert pinned.status == 200
    assert bytes(pinned.body) == b"png-bytes-v1"


def test_handle_media_invalid_snap_falls_back_to_live(routes, monkeypatch, snap_dir, tmp_path):
    target = tmp_path / "pic.png"
    target.write_bytes(b"live-bytes")
    replayed = _media_get(routes, monkeypatch, target, query_extra="&snap=not-a-digest")
    assert replayed.status == 200
    assert bytes(replayed.body) == b"live-bytes"


def test_handle_media_missing_valid_snap_fails_closed(routes, monkeypatch, snap_dir, tmp_path):
    target = tmp_path / "pic.png"
    target.write_bytes(b"live-bytes")
    missing = _media_get(
        routes, monkeypatch, target, query_extra="&snap=" + "0" * 64
    )
    assert missing.status == 410
    assert b"snapshot unavailable" in bytes(missing.body)


def test_handle_media_snap_does_not_bypass_deny(routes, monkeypatch, snap_dir, tmp_path):
    """snap= must never widen the path allow-list: a denied path stays denied
    even when a valid snapshot digest is supplied."""
    from api.media_snapshots import capture_snapshot

    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir()
    secret = hermes_home / "settings.json"
    secret.write_text("{}")
    monkeypatch.setenv("HOME", str(tmp_path))
    digest = capture_snapshot(secret)  # capture itself may be blocked; if not...

    denied = _media_get(routes, monkeypatch, secret, query_extra=f"&snap={digest or '0'*64}")
    # settings.json under a hermes root is denied by the #3234 deny list.
    assert denied.status == 403


def test_handle_media_denies_direct_store_path(routes, monkeypatch, tmp_path):
    """The snapshot STORE directory itself is not a servable media path.

    The store lives under STATE_DIR (a Hermes root) in production; the #3234
    deny list must reject a bare path= fetch of a snapshot blob there, so the
    store is only reachable through the validated snap= parameter.
    """
    from api.media_snapshots import capture_snapshot

    # Simulate the production layout: the store lives under a Hermes root, with
    # HOME pointing at tmp_path so that directory counts as a Hermes root. The
    # #3234 deny list denies <hermes_root>/media_snapshots.
    hermes_home = tmp_path / ".hermes"
    store = hermes_home / "media_snapshots"
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_WEBUI_MEDIA_SNAPSHOT_DIR", str(store))

    target = tmp_path / "a.png"
    target.write_bytes(b"bytes")
    digest = capture_snapshot(target)
    store_file = store / f"{digest}.snap"
    assert store_file.exists()

    denied = _media_get(routes, monkeypatch, store_file)
    assert denied.status == 403


def test_handle_media_snapshot_range_request(routes, monkeypatch, snap_dir, tmp_path):
    from api.media_snapshots import capture_snapshot

    target = tmp_path / "clip.mp4"
    target.write_bytes(b"0123456789")
    digest = capture_snapshot(target)

    handler = _media_get(
        routes,
        monkeypatch,
        target,
        headers={"Range": "bytes=2-4"},
        query_extra=f"&snap={digest}",
    )
    assert handler.status == 206
    assert bytes(handler.body) == b"234"
    assert handler.header("Content-Range") == "bytes 2-4/10"


def test_handle_media_snapshot_download_name_uses_original(routes, monkeypatch, snap_dir, tmp_path):
    from api.media_snapshots import capture_snapshot

    target = tmp_path / "report.html"
    target.write_bytes(b"<html>v1</html>")
    digest = capture_snapshot(target)
    target.unlink()

    handler = _media_get(routes, monkeypatch, target, query_extra=f"&snap={digest}")
    disposition = handler.header("Content-Disposition")
    assert "report.html" in disposition
    assert f"{digest}.snap" not in disposition


# ── Round 2: capture/serve deny parity + source-path binding (#6979) ────────


def test_media_capture_allowed_denies_default_webui_state_layout(tmp_path, monkeypatch):
    """MUST-FIX 1 repro: default-layout <HERMES_HOME>/webui/sessions/victim.json
    (== STATE_DIR/sessions) must NEVER be captured.

    Round 1 capture omitted STATE_DIR from its deny roots; the serve path
    denies it. Capture now shares the serve predicate, so this returns False.
    """
    from api.media_snapshots import media_capture_allowed

    hermes_home = tmp_path / ".hermes"
    state_dir = hermes_home / "webui"
    (state_dir / "sessions").mkdir(parents=True)
    victim = state_dir / "sessions" / "victim.json"
    victim.write_text("{}")

    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    monkeypatch.setattr("api.config.STATE_DIR", str(state_dir))

    assert media_capture_allowed(victim) is False


def test_annotate_never_captures_denied_state_file(snap_dir, tmp_path, monkeypatch):
    """MUST-FIX 1 end-to-end: annotating a message whose MEDIA: ref points at a
    denied state file must capture NOTHING (Round 1 captured it and the digest
    then acted as a bearer capability)."""
    from api.media_snapshots import annotate_media_snapshots

    hermes_home = tmp_path / ".hermes"
    state_dir = hermes_home / "webui"
    (state_dir / "sessions").mkdir(parents=True)
    victim = state_dir / "sessions" / "victim.json"
    victim.write_text('{"secret": 1}')

    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    monkeypatch.setattr("api.config.STATE_DIR", str(state_dir))

    messages = [{"role": "assistant", "content": f"here it is: MEDIA:{victim}"}]
    captured = annotate_media_snapshots(messages)
    assert captured == 0
    assert "_media_snapshots" not in messages[0]
    assert len(list(snap_dir.glob("*.snap"))) == 0


def test_handle_media_snap_requires_source_path_binding(routes, monkeypatch, snap_dir, tmp_path):
    """MUST-FIX 1 serve-side repro: a digest captured from path A must not be
    servable through path B, even when B is an allowed path.

    Round 1 served stored bytes for ANY allowed path carrying the digest.
    With the binding, B fails closed and never receives A's or B's live bytes.
    """
    from api.media_snapshots import capture_snapshot

    source = tmp_path / "a.png"
    source.write_bytes(b"frozen-bytes-from-a")
    digest = capture_snapshot(source)

    # Bound path: snapshot bytes served.
    bound = _media_get(routes, monkeypatch, source, query_extra=f"&snap={digest}")
    assert bound.status == 200
    assert bytes(bound.body) == b"frozen-bytes-from-a"

    # A valid but unbound snapshot request fails closed regardless of whether
    # the mutable live path exists.
    other_missing = tmp_path / "b.png"
    unbound = _media_get(routes, monkeypatch, other_missing, query_extra=f"&snap={digest}")
    assert unbound.status == 410

    # Unbound + present path must not silently serve mutable live bytes.
    other_live = tmp_path / "b.png"
    other_live.write_bytes(b"live-bytes-of-b")
    unbound_live = _media_get(routes, monkeypatch, other_live, query_extra=f"&snap={digest}")
    assert unbound_live.status == 410
    assert b"snapshot unavailable" in bytes(unbound_live.body)


def test_handle_media_snap_dedup_binds_every_source_path(routes, monkeypatch, snap_dir, tmp_path):
    """Dedup must not break source binding: identical bytes captured from two
    different paths share one digest, and BOTH paths may serve it (each was a
    legitimate capture source); a third path may not."""
    from api.media_snapshots import capture_snapshot

    a = tmp_path / "a.png"
    b = tmp_path / "b.png"
    a.write_bytes(b"same-bytes")
    b.write_bytes(b"same-bytes")
    d1 = capture_snapshot(a)
    d2 = capture_snapshot(b)
    assert d1 == d2

    sa = _media_get(routes, monkeypatch, a, query_extra=f"&snap={d1}")
    sb = _media_get(routes, monkeypatch, b, query_extra=f"&snap={d2}")
    assert sa.status == 200 and bytes(sa.body) == b"same-bytes"
    assert sb.status == 200 and bytes(sb.body) == b"same-bytes"

    c = tmp_path / "c.png"
    c.write_bytes(b"live-different-bytes")
    sc = _media_get(routes, monkeypatch, c, query_extra=f"&snap={d1}")
    assert sc.status == 410


def test_handle_media_denies_custom_named_store_via_bare_path(routes, monkeypatch, tmp_path):
    """MUST-FIX 2 repro: a custom-named snapshot store (HERMES_WEBUI_MEDIA_SNAPSHOT_DIR
    pointing anywhere, e.g. /tmp/custom-store-name) must not be readable through
    a bare path= request. Round 1 only deny-listed the literal name
    'media_snapshots', so the blobs leaked with no snap= needed."""
    from api.media_snapshots import capture_snapshot

    store = tmp_path / "custom-store-name"
    monkeypatch.setenv("HERMES_WEBUI_MEDIA_SNAPSHOT_DIR", str(store))

    target = tmp_path / "a.png"
    target.write_bytes(b"stored-bytes")
    digest = capture_snapshot(target)
    store_file = store / f"{digest}.snap"
    assert store_file.exists()

    denied = _media_get(routes, monkeypatch, store_file)
    assert denied.status == 403


def test_is_valid_digest_rejects_trailing_newline():
    """SHOULD-FIX: `$` matched before a terminal newline; fullmatch must not."""
    from api.media_snapshots import is_valid_digest

    good = "a" * 64
    assert is_valid_digest(good) is True
    assert is_valid_digest(good + "\n") is False
    assert is_valid_digest("a" * 63) is False
    assert is_valid_digest("A" * 64) is False  # lowercase hex only
    assert is_valid_digest("") is False
    assert is_valid_digest(None) is False  # type: ignore[arg-type]


def test_annotate_evicted_snapshot_is_final(snap_dir, tmp_path):
    """SHOULD-FIX: a recorded digest is FINAL — after its blob is evicted, a
    re-settle must not re-capture the CURRENT live bytes and rebind the
    historical message (Round 1 did, silently following overwrites again)."""
    from api.media_snapshots import annotate_media_snapshots

    target = tmp_path / "report.html"
    target.write_text("<html>v1</html>")
    messages: list = [{"role": "assistant", "content": f"MEDIA:{target}"}]

    assert annotate_media_snapshots(messages) == 1
    snaps0: dict = messages[0].get("_media_snapshots") or {}
    digest = snaps0[str(target)]

    # Simulate quota eviction: blob gone.
    blob = snap_dir / f"{digest}.snap"
    assert blob.exists()
    blob.unlink()

    # Overwrite the live file, then re-settle the SAME message.
    target.write_text("<html>v2 - overwritten</html>")
    assert annotate_media_snapshots(messages) == 0
    snaps1: dict = messages[0].get("_media_snapshots") or {}
    assert snaps1[str(target)] == digest
    assert not blob.exists()  # no re-capture


def test_handle_media_evicted_snapshot_never_serves_overwritten_live_bytes(
    routes, monkeypatch, snap_dir, tmp_path
):
    from api.media_snapshots import capture_snapshot

    target = tmp_path / "report.html"
    target.write_text("<html>v1</html>")
    digest = capture_snapshot(target)
    assert digest
    (snap_dir / f"{digest}.snap").unlink()
    target.write_text("<html>v2 overwritten</html>")

    response = _media_get(routes, monkeypatch, target, query_extra=f"&snap={digest}")
    assert response.status == 410
    assert b"v2 overwritten" not in bytes(response.body)


def test_annotate_revalidates_the_opened_source_after_symlink_replacement(
    snap_dir, tmp_path, monkeypatch
):
    from api import media_snapshots

    hermes_home = tmp_path / ".hermes"
    state_dir = hermes_home / "webui"
    state_dir.mkdir(parents=True)
    secret = state_dir / "secret.json"
    secret.write_text('{"secret": true}')
    source = tmp_path / "safe.txt"
    source.write_text("safe")
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    monkeypatch.setattr("api.config.STATE_DIR", str(state_dir))

    calls = 0

    def replace_after_first_authorization(path):
        nonlocal calls
        calls += 1
        allowed = media_snapshots.media_capture_allowed(path)
        if calls == 1 and allowed:
            source.unlink()
            source.symlink_to(secret)
        return allowed

    messages = [{"role": "assistant", "content": f"MEDIA:{source}"}]
    captured = media_snapshots.annotate_media_snapshots(
        messages,
        allowed_predicate=replace_after_first_authorization,
    )

    assert captured == 0
    assert "_media_snapshots" not in messages[0]
    assert list(snap_dir.glob("*.snap")) == []


def test_capture_revalidates_after_open_before_copy(snap_dir, tmp_path, monkeypatch):
    from api import media_snapshots

    state_dir = tmp_path / "state"
    state_dir.mkdir()
    secret = state_dir / "auth.json"
    secret.write_text('{"secret": true}')
    source = tmp_path / "safe.txt"
    source.write_text("safe")
    monkeypatch.setattr("api.config.STATE_DIR", str(state_dir))

    real_open = media_snapshots.os.open
    replaced = False

    def open_then_replace(path, flags, *args, **kwargs):
        nonlocal replaced
        fd = real_open(path, flags, *args, **kwargs)
        if Path(path) == source and not replaced:
            replaced = True
            source.unlink()
            source.symlink_to(secret)
        return fd

    monkeypatch.setattr(media_snapshots.os, "open", open_then_replace)
    # Exercise the portability path where final-component no-follow is not
    # available; post-open identity and authorization must still fail closed.
    monkeypatch.delattr(media_snapshots.os, "O_NOFOLLOW", raising=False)

    assert media_snapshots.capture_snapshot(source) is None
    assert replaced is True
    assert list(snap_dir.glob("*.snap")) == []


def test_quota_eviction_drops_source_binding_sidecar(snap_dir, tmp_path, monkeypatch):
    """Evicting a snapshot blob must also drop its source-binding sidecar."""
    from api.media_snapshots import _binding_path_for_digest, capture_snapshot

    monkeypatch.setenv("HERMES_WEBUI_MEDIA_SNAPSHOT_CAP_BYTES", "64")
    old = tmp_path / "old.png"
    new = tmp_path / "new.png"
    old.write_bytes(b"x" * 64)
    new.write_bytes(b"y" * 64)
    d_old = capture_snapshot(old)
    d_new = capture_snapshot(new)
    assert d_old and d_new

    if not _binding_path_for_digest(d_old).exists():
        # Oldest was evicted (its binding sidecar must be gone too).
        assert not (snap_dir / f"{d_old}.snap").exists()
    else:
        assert not _binding_path_for_digest(d_new).exists()
        assert not (snap_dir / f"{d_new}.snap").exists()


# ── display-metadata persistence (state.db ↔ sidecar merge) ────────────────


def test_media_snapshots_registered_in_display_metadata_keys():
    from api.models import _SESSION_MESSAGE_DISPLAY_METADATA_KEYS

    assert "_media_snapshots" in _SESSION_MESSAGE_DISPLAY_METADATA_KEYS


def test_merge_session_display_metadata_preserves_snapshots():
    from api.models import _merge_session_display_metadata

    target = {"role": "assistant", "content": "x"}
    source = {"role": "assistant", "content": "x", "_media_snapshots": {"/a": "a" * 64}}
    _merge_session_display_metadata(target, source)
    assert target["_media_snapshots"] == {"/a": "a" * 64}


# ── frontend stamping helper (behavioral, node-executed) ───────────────────


def _extract_stamp_helper():
    """Extract esc() and _stampMediaSnapshots() verbatim from static/ui.js."""
    src = open(ROOT / "static" / "ui.js", encoding="utf-8").read()

    def extract_function(name):
        start = src.find(f"function {name}(")
        if start < 0:
            raise AssertionError(f"{name} not found in ui.js")
        i = src.find("{", start)
        depth = 1
        i += 1
        while i < len(src) and depth:
            if src[i] == "{":
                depth += 1
            elif src[i] == "}":
                depth -= 1
            i += 1
        return src[start:i]

    esc_line = next(line for line in src.split("\n") if line.startswith("const esc="))
    return esc_line, extract_function("_stampMediaSnapshots")


def _run_stamp(html, snaps):
    """Run the real _stampMediaSnapshots under node with mocked collaborators."""
    import json
    import subprocess
    import tempfile

    esc_def, fn_def = _extract_stamp_helper()
    js_code = esc_def + "\n" + fn_def + "\n"
    js_code += "var html=process.argv[2];\n"
    js_code += "var snaps=JSON.parse(process.argv[3]);\n"
    js_code += "process.stdout.write(_stampMediaSnapshots(html,snaps));\n"
    with tempfile.NamedTemporaryFile(mode="w", suffix=".js", delete=False, encoding="utf-8") as tf:
        tf.write(js_code)
        tfname = tf.name
    try:
        result = subprocess.run(
            ["node", tfname, html, json.dumps(snaps)],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            raise RuntimeError(f"node error: {result.stderr}")
        return result.stdout
    finally:
        os.unlink(tfname)
