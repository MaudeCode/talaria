import base64
import hashlib
import json
import logging
import os
import stat
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from threading import Event, Lock, Thread

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat

from api.talaria_relay import RelayConfig, RelayPairingError, TalariaRelayPublisher, pair_talaria_relay


def test_pairing_persists_private_key_and_starts_publisher(tmp_path, monkeypatch):
    from api import config, talaria_relay

    monkeypatch.setattr(config, "STATE_DIR", tmp_path)
    monkeypatch.setenv("HERMES_WEBUI_TALARIA_RELAY_URL", "https://relay.example.com")
    configured = []
    monkeypatch.setattr(
        talaria_relay,
        "configure_talaria_relay_publisher",
        lambda config, **_kwargs: configured.append(config),
    )
    captured = {}

    @contextmanager
    def opener(request, timeout):
        captured["request"] = request
        captured["timeout"] = timeout
        yield type(
            "Response",
            (),
            {
                "status": 201,
                "read": lambda self: json.dumps({
                    "protocolVersion": 2,
                    "keyId": "key-created",
                    "publisherId": "https://hermes.example.com",
                    "profileId": json.loads(request.data)["profileId"],
                    "profileIdPreserved": False,
                }).encode(),
            },
        )()

    result = pair_talaria_relay(
        {
            "relay_url": "https://relay.example.com/",
            "publisher_id": "https://hermes.example.com",
            "publisher_invitation": "invite-once",
            "label": "Home Hermes",
        },
        opener=opener,
    )

    request_body = json.loads(captured["request"].data)
    saved = json.loads((tmp_path / "talaria-relay.json").read_text())
    key_path = Path(saved["private_key_path"])
    assert result == {"ok": True, "publisher_id": "https://hermes.example.com"}
    assert captured["request"].full_url == "https://relay.example.com/v1/pairings/publisher/redeem"
    assert captured["timeout"] == 10
    assert request_body["invitation"] == "invite-once"
    assert request_body["profileId"].startswith("prf_")
    assert len(base64.urlsafe_b64decode(request_body["publicKey"] + "==")) == 32
    assert saved["key_id"] == "key-created"
    assert stat.S_IMODE(key_path.stat().st_mode) == 0o600
    assert saved["version"] == 2
    assert saved["profiles"]["default"]["profile_id"] == request_body["profileId"]
    assert saved["profiles"]["default"]["identity"]
    assert configured == [RelayConfig(
        "https://relay.example.com",
        "https://hermes.example.com",
        "key-created",
        key_path,
        saved["profiles"],
    )]


def test_pairing_private_key_is_0600_before_any_post_write_failure(tmp_path, monkeypatch):
    from api import config, talaria_relay

    monkeypatch.setattr(config, "STATE_DIR", tmp_path)
    monkeypatch.setenv("HERMES_WEBUI_TALARIA_RELAY_URL", "https://relay.example.com")
    monkeypatch.setattr(
        talaria_relay,
        "configure_talaria_relay_publisher",
        lambda _config, **_kwargs: (_ for _ in ()).throw(RuntimeError("startup failed")),
    )
    monkeypatch.setattr(
        type(tmp_path),
        "chmod",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("late chmod")),
    )

    @contextmanager
    def opener(request, timeout):
        assert timeout == 10
        yield type(
            "Response",
            (),
            {
                "status": 201,
                "read": lambda self: json.dumps({
                    "protocolVersion": 2,
                    "keyId": "key-created",
                    "publisherId": "https://hermes.example.com",
                    "profileId": json.loads(request.data)["profileId"],
                    "profileIdPreserved": False,
                }).encode(),
            },
        )()

    previous_umask = os.umask(0)
    try:
        with pytest.raises(RuntimeError, match="startup failed"):
            pair_talaria_relay(
                {
                    "relay_url": "https://relay.example.com",
                    "publisher_id": "https://hermes.example.com",
                    "publisher_invitation": "invite-once",
                },
                opener=opener,
            )
    finally:
        os.umask(previous_umask)

    saved = json.loads((tmp_path / "talaria-relay.json").read_text())
    assert stat.S_IMODE(Path(saved["private_key_path"]).stat().st_mode) == 0o600


def test_server_registration_rejects_v1_relay_response_without_persisting(tmp_path, monkeypatch):
    from api import config

    monkeypatch.setattr(config, "STATE_DIR", tmp_path)
    monkeypatch.setenv("HERMES_WEBUI_TALARIA_RELAY_URL", "https://relay.example.com")

    @contextmanager
    def opener(_request, timeout):
        assert timeout == 10
        yield type("Response", (), {
            "status": 201,
            "read": lambda self: b'{"keyId":"legacy-key","publisherId":"https://hermes.example.com"}',
        })()

    with pytest.raises(RelayPairingError, match="invalid response"):
        pair_talaria_relay({
            "relay_url": "https://relay.example.com",
            "publisher_id": "https://hermes.example.com",
            "publisher_invitation": "invite-once",
        }, opener=opener)
    assert not (tmp_path / "talaria-relay.json").exists()


def test_server_registration_rejects_unmarked_profile_scope_mismatch(tmp_path, monkeypatch):
    from api import config

    monkeypatch.setattr(config, "STATE_DIR", tmp_path)
    monkeypatch.setenv("HERMES_WEBUI_TALARIA_RELAY_URL", "https://relay.example.com")

    @contextmanager
    def opener(_request, timeout):
        assert timeout == 10
        yield type("Response", (), {
            "status": 201,
            "read": lambda self: json.dumps({
                "protocolVersion": 2,
                "keyId": "key-created",
                "publisherId": "https://hermes.example.com",
                "profileId": "prf_mismatched",
                "profileIdPreserved": False,
            }).encode(),
        })()

    with pytest.raises(RelayPairingError, match="invalid response"):
        pair_talaria_relay({
            "relay_url": "https://relay.example.com",
            "publisher_id": "https://hermes.example.com",
            "publisher_invitation": "invite-once",
        }, opener=opener)
    assert not (tmp_path / "talaria-relay.json").exists()


def test_pairing_rejects_an_untrusted_relay_origin():
    with pytest.raises(RelayPairingError, match="Untrusted"):
        pair_talaria_relay({
            "relay_url": "https://internal.example.com",
            "publisher_id": "https://hermes.example.com",
            "publisher_invitation": "invite-once",
        })


def test_v1_relay_state_requires_registration_again(tmp_path, monkeypatch):
    from api import config

    monkeypatch.setattr(config, "STATE_DIR", tmp_path)
    (tmp_path / "talaria-relay.json").write_text(json.dumps({
        "url": "https://relay.example.com",
        "publisher_id": "https://hermes.example.com",
        "key_id": "legacy-key",
        "private_key_path": str(tmp_path / "legacy.pem"),
    }))

    assert RelayConfig.from_state() is None


def test_profile_identity_is_persistent_and_changes_after_recreation(tmp_path, monkeypatch):
    from api import profiles, talaria_relay

    profile_home = tmp_path / "profiles" / "work"
    profile_home.mkdir(parents=True)
    monkeypatch.setattr(profiles, "get_hermes_home_for_profile", lambda _profile: profile_home)

    first = talaria_relay._profile_identity("work")
    assert stat.S_IMODE((profile_home / ".talaria-relay-profile-id").stat().st_mode) == 0o600
    assert talaria_relay._profile_identity("work") == first

    (profile_home / ".talaria-relay-profile-id").unlink()
    profile_home.rmdir()
    profile_home.mkdir()
    assert talaria_relay._profile_identity("work") != first


def test_enrollment_snapshot_revalidates_captured_profile_identity(tmp_path, monkeypatch):
    from api import talaria_relay

    key = Ed25519PrivateKey.generate()
    key_path = tmp_path / "publisher.pem"
    key_path.write_bytes(key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()))
    monkeypatch.setattr(talaria_relay, "_profile_identity", lambda _profile: "new-identity")
    publisher = TalariaRelayPublisher(
        RelayConfig(
            "https://relay.example",
            "https://hermes.example",
            "key-1",
            key_path,
            {"work": {"identity": "old-identity", "profile_id": "prf_work"}},
        ),
    )

    with pytest.raises(RelayPairingError, match="changed during relay enrollment") as raised:
        publisher.publish_profile("prf_work", "old-identity")
    assert raised.value.status == 409


def test_pairing_confirms_initial_snapshot_before_switching_publishers(monkeypatch):
    from api import session_events, talaria_relay

    events = []

    class Candidate:
        changed = object()

        def __init__(self, config):
            events.append(("create", config.key_id))

        def publish_snapshot(self):
            events.append(("publish", None))

        def start(self, *, publish_initial):
            events.append(("start", publish_initial))

    monkeypatch.setattr(talaria_relay, "TalariaRelayPublisher", Candidate)
    monkeypatch.setattr(talaria_relay, "stop_talaria_relay_publisher", lambda: events.append(("stop", None)))
    monkeypatch.setattr(session_events, "add_session_list_changed_listener", lambda _listener: events.append(("listen", None)))
    monkeypatch.setattr(talaria_relay.atexit, "register", lambda _callback: None)

    talaria_relay.configure_talaria_relay_publisher(
        RelayConfig("https://relay.example", "https://hermes.example", "key-1", Path("key.pem"))
    )

    assert events == [
        ("create", "key-1"),
        ("publish", None),
        ("listen", None),
        ("start", False),
    ]


@pytest.mark.parametrize("has_previous", [True, False])
def test_blocked_candidate_publish_does_not_hold_publisher_registry_lock(
    monkeypatch, has_previous
):
    from api import session_events, talaria_relay

    publish_started = Event()
    release_publish = Event()
    terminal_noted = Event()

    class Publisher:
        def __init__(self, config):
            self.config = config
            self.changed = object()
            self._terminal_lock = Lock()
            self._revision_lock = Lock()
            self._terminal = {}
            self._last_revision = 0

        def publish_snapshot(self):
            publish_started.set()
            assert release_publish.wait(2)

        def note_terminal(self, _stream_id, _phase):
            with self._terminal_lock:
                self._terminal[_stream_id] = {"relay_phase": _phase}
            terminal_noted.set()

        def start(self, *, publish_initial):
            assert publish_initial is False

        def stop(self):
            pass

    old = Publisher(
        RelayConfig("https://relay.example", "https://old.example", "old", Path("old.pem"))
    )
    monkeypatch.setattr(talaria_relay, "_publisher", old if has_previous else None)
    monkeypatch.setattr(talaria_relay, "_publisher_candidate", None)
    monkeypatch.setattr(talaria_relay, "TalariaRelayPublisher", Publisher)
    monkeypatch.setattr(session_events, "add_session_list_changed_listener", lambda _listener: None)
    monkeypatch.setattr(session_events, "remove_session_list_changed_listener", lambda _listener: None)
    monkeypatch.setattr(talaria_relay.atexit, "register", lambda _callback: None)

    configuring = Thread(
        target=lambda: talaria_relay.configure_talaria_relay_publisher(
            RelayConfig("https://relay.example", "https://new.example", "new", Path("new.pem"))
        )
    )
    configuring.start()
    assert publish_started.wait(1)
    noting = Thread(
        target=lambda: talaria_relay.note_talaria_terminal("stream", "completed")
    )
    noting.start()
    progressed_while_publish_blocked = terminal_noted.wait(0.2)
    release_publish.set()
    configuring.join(1)
    noting.join(1)

    assert progressed_while_publish_blocked is True
    assert talaria_relay._publisher._terminal["stream"]["relay_phase"] == "completed"


def test_publisher_reconfiguration_preserves_unpublished_terminal_state(monkeypatch):
    from api import session_events, talaria_relay

    published = []

    class Candidate:
        def __init__(self, config):
            self.config = config
            self.changed = object()
            self._terminal_lock = Lock()
            self._revision_lock = Lock()
            self._terminal = {}
            self._last_revision = 0

        def publish_snapshot(self):
            published.append(dict(self._terminal))

        def start(self, *, publish_initial):
            assert publish_initial is False

        def stop(self):
            pass

    old = Candidate(RelayConfig("https://relay.example", "https://hermes.example", "key", Path("key.pem")))
    old._terminal["session-1"] = {"phase": "completed"}
    monkeypatch.setattr(talaria_relay, "TalariaRelayPublisher", Candidate)
    monkeypatch.setattr(talaria_relay, "_publisher", old)
    monkeypatch.setattr(session_events, "add_session_list_changed_listener", lambda _listener: None)
    monkeypatch.setattr(session_events, "remove_session_list_changed_listener", lambda _listener: None)
    monkeypatch.setattr(talaria_relay.atexit, "register", lambda _callback: None)

    talaria_relay.configure_talaria_relay_publisher(
        RelayConfig("https://relay.example", "https://hermes.example", "key", Path("key.pem")),
    )

    assert published == [{"session-1": {"phase": "completed"}}]


def test_publisher_reconfiguration_validates_only_new_profile(monkeypatch):
    from api import session_events, talaria_relay

    validated = []

    class Candidate:
        def __init__(self, _config):
            self.changed = object()

        def publish_snapshot(self):
            raise AssertionError("full snapshot must not gate one profile enrollment")

        def publish_profile(self, profile_id, expected_identity):
            validated.append((profile_id, expected_identity))

        def start(self, *, publish_initial):
            assert publish_initial is False

    monkeypatch.setattr(talaria_relay, "TalariaRelayPublisher", Candidate)
    monkeypatch.setattr(talaria_relay, "_publisher", None)
    monkeypatch.setattr(session_events, "add_session_list_changed_listener", lambda _listener: None)
    monkeypatch.setattr(talaria_relay.atexit, "register", lambda _callback: None)

    talaria_relay.configure_talaria_relay_publisher(
        RelayConfig("https://relay.example", "https://hermes.example", "key", Path("key.pem")),
        validate_profile_id="prf_new",
        validate_profile_identity="identity-new",
    )

    assert validated == [("prf_new", "identity-new")]


def test_profile_bound_session_can_enroll_without_operator_access(monkeypatch):
    from api import auth, routes
    from api import talaria_relay

    monkeypatch.setattr(auth, "is_auth_enabled", lambda: True)
    monkeypatch.setattr(auth, "ensure_trusted_auth_session", lambda _handler: {"bound_profile": "work"})
    handler = type("Handler", (), {"headers": {}})()
    responses = []
    monkeypatch.setattr(routes, "j", lambda _handler, payload: responses.append((200, payload)) or True)
    monkeypatch.setattr(
        talaria_relay,
        "pair_talaria_relay",
        lambda body, *, profile, operator: {"profile": profile, "operator": operator, "body": body},
    )
    monkeypatch.setattr(routes, "_check_csrf", lambda _handler: True)
    monkeypatch.setattr(routes, "_handle_extension_sidecar_proxy", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(routes, "read_body", lambda _handler: {})
    monkeypatch.setattr(routes, "_guard_request_session_visibility", lambda *_args, **_kwargs: True)

    assert routes.handle_post(handler, type("Parsed", (), {"path": "/api/talaria/relay/pair"})()) is True
    assert responses == [(200, {"profile": "work", "operator": False, "body": {}})]


def test_profile_enrollment_requires_an_existing_owner_registration(tmp_path, monkeypatch):
    from api import config, talaria_relay

    monkeypatch.setattr(config, "STATE_DIR", tmp_path)
    monkeypatch.setenv("HERMES_WEBUI_TALARIA_RELAY_URL", "https://relay.example.com")
    monkeypatch.setattr(talaria_relay, "_profile_identity", lambda _profile: "profile-identity")
    with pytest.raises(RelayPairingError, match="owner must register") as raised:
        pair_talaria_relay(
            {
                "relay_url": "https://relay.example.com",
                "publisher_id": "https://hermes.example.com",
                "publisher_invitation": "invite-once",
            },
            profile="work",
            operator=False,
        )
    assert raised.value.status == 409


def test_profile_enrollment_reuses_the_registered_publisher_key(tmp_path, monkeypatch):
    from api import config, talaria_relay

    monkeypatch.setattr(config, "STATE_DIR", tmp_path)
    monkeypatch.setenv("HERMES_WEBUI_TALARIA_RELAY_URL", "https://relay.example.com")
    monkeypatch.setattr(talaria_relay, "configure_talaria_relay_publisher", lambda _config, **_kwargs: None)
    monkeypatch.setattr(talaria_relay, "_profile_identity", lambda _profile: "profile-identity")
    key = Ed25519PrivateKey.generate()
    key_path = tmp_path / "publisher.pem"
    key_path.write_bytes(key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()))
    (tmp_path / "talaria-relay.json").write_text(json.dumps({
        "version": 2,
        "url": "https://relay.example.com",
        "publisher_id": "https://hermes.example.com",
        "key_id": "key-1",
        "private_key_path": str(key_path),
        "profiles": {"default": {"identity": "default-identity", "profile_id": "prf_default"}},
    }))
    captured = {}

    @contextmanager
    def opener(request, timeout):
        captured["request"] = request
        captured["timeout"] = timeout
        body = json.loads(request.data)
        yield type("Response", (), {
            "status": 201,
            "read": lambda self: json.dumps({
                "protocolVersion": 2,
                "publisherId": body["publisherId"],
                "profileId": body["profileId"],
            }).encode(),
        })()

    assert pair_talaria_relay(
        {
            "relay_url": "https://relay.example.com",
            "publisher_id": "https://hermes.example.com",
            "publisher_invitation": "invite-work",
        },
        profile="work",
        operator=False,
        opener=opener,
    ) == {"ok": True, "publisher_id": "https://hermes.example.com"}

    request = captured["request"]
    body = json.loads(request.data)
    saved = json.loads((tmp_path / "talaria-relay.json").read_text())
    assert request.full_url == "https://relay.example.com/v1/pairings/profile/redeem"
    assert request.headers["X-talaria-key-id"] == "key-1"
    assert body["invitation"] == "invite-work"
    assert "publicKey" not in body
    assert saved["profiles"] == {
        "default": {"identity": "default-identity", "profile_id": "prf_default"},
        "work": {"identity": "profile-identity", "profile_id": body["profileId"]},
    }


def test_concurrent_profile_enrollments_preserve_both_mappings(tmp_path, monkeypatch):
    from api import config, talaria_relay

    monkeypatch.setattr(config, "STATE_DIR", tmp_path)
    monkeypatch.setenv("HERMES_WEBUI_TALARIA_RELAY_URL", "https://relay.example.com")
    monkeypatch.setattr(talaria_relay, "configure_talaria_relay_publisher", lambda _config, **_kwargs: None)
    monkeypatch.setattr(talaria_relay, "_profile_identity", lambda profile: f"identity-{profile}")
    key = Ed25519PrivateKey.generate()
    key_path = tmp_path / "publisher.pem"
    key_path.write_bytes(key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()))
    (tmp_path / "talaria-relay.json").write_text(json.dumps({
        "version": 2,
        "url": "https://relay.example.com",
        "publisher_id": "https://hermes.example.com",
        "key_id": "key-1",
        "private_key_path": str(key_path),
        "profiles": {"default": {"identity": "identity-default", "profile_id": "prf_default"}},
    }))
    alice_opened = Event()
    bob_opened = Event()

    @contextmanager
    def opener(request, timeout):
        assert timeout == 10
        body = json.loads(request.data)
        if body["invitation"] == "invite-alice":
            alice_opened.set()
            bob_opened.wait(0.1)
        else:
            bob_opened.set()
        yield type("Response", (), {
            "status": 201,
            "read": lambda self: json.dumps({
                "protocolVersion": 2,
                "publisherId": body["publisherId"],
                "profileId": body["profileId"],
            }).encode(),
        })()

    def enroll(profile):
        return pair_talaria_relay({
            "relay_url": "https://relay.example.com",
            "publisher_id": "https://hermes.example.com",
            "publisher_invitation": f"invite-{profile}",
        }, profile=profile, operator=False, opener=opener)

    with ThreadPoolExecutor(max_workers=2) as executor:
        alice = executor.submit(enroll, "alice")
        assert alice_opened.wait(1)
        bob = executor.submit(enroll, "bob")
        assert alice.result()["ok"] is True
        assert bob.result()["ok"] is True

    saved = json.loads((tmp_path / "talaria-relay.json").read_text())
    assert set(saved["profiles"]) == {"default", "alice", "bob"}


def test_recreated_profile_receives_a_new_relay_scope(tmp_path, monkeypatch):
    from api import config, talaria_relay

    monkeypatch.setattr(config, "STATE_DIR", tmp_path)
    monkeypatch.setenv("HERMES_WEBUI_TALARIA_RELAY_URL", "https://relay.example.com")
    monkeypatch.setattr(talaria_relay, "configure_talaria_relay_publisher", lambda _config, **_kwargs: None)
    monkeypatch.setattr(talaria_relay, "_profile_identity", lambda _profile: "new-identity")
    key = Ed25519PrivateKey.generate()
    key_path = tmp_path / "publisher.pem"
    key_path.write_bytes(key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()))
    (tmp_path / "talaria-relay.json").write_text(json.dumps({
        "version": 2,
        "url": "https://relay.example.com",
        "publisher_id": "https://hermes.example.com",
        "key_id": "key-1",
        "private_key_path": str(key_path),
        "profiles": {"work": {"identity": "old-identity", "profile_id": "prf_old"}},
    }))
    captured = {}

    @contextmanager
    def opener(request, timeout):
        assert timeout == 10
        captured.update(json.loads(request.data))
        yield type("Response", (), {
            "status": 201,
            "read": lambda self: json.dumps({
                "protocolVersion": 2,
                "publisherId": captured["publisherId"],
                "profileId": captured["profileId"],
            }).encode(),
        })()

    TalariaRelayPublisher(
        RelayConfig(
            "https://relay.example.com",
            "https://hermes.example.com",
            "key-1",
            key_path,
            {"work": {"identity": "old-identity", "profile_id": "prf_old"}},
        ),
        opener=opener,
    ).publish_snapshot()
    assert captured == {}

    pair_talaria_relay({
        "relay_url": "https://relay.example.com",
        "publisher_id": "https://hermes.example.com",
        "publisher_invitation": "invite-new",
    }, profile="work", operator=False, opener=opener)

    assert captured["profileId"] != "prf_old"
    saved = json.loads((tmp_path / "talaria-relay.json").read_text())
    assert saved["profiles"]["work"] == {
        "identity": "new-identity",
        "profile_id": captured["profileId"],
    }


def test_profile_enrollment_http_rejection_is_not_reported_as_reachability(tmp_path, monkeypatch):
    from api import config, talaria_relay

    monkeypatch.setattr(config, "STATE_DIR", tmp_path)
    monkeypatch.setenv("HERMES_WEBUI_TALARIA_RELAY_URL", "https://relay.example.com")
    monkeypatch.setattr(talaria_relay, "_profile_identity", lambda _profile: "profile-identity")
    key = Ed25519PrivateKey.generate()
    key_path = tmp_path / "publisher.pem"
    key_path.write_bytes(key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()))
    (tmp_path / "talaria-relay.json").write_text(json.dumps({
        "version": 2,
        "url": "https://relay.example.com",
        "publisher_id": "https://hermes.example.com",
        "key_id": "key-1",
        "private_key_path": str(key_path),
        "profiles": {"work": {"identity": "profile-identity", "profile_id": "prf_work"}},
    }))

    def opener(request, timeout):
        raise urllib.error.HTTPError(request.full_url, 401, "Unauthorized", {}, None)

    with pytest.raises(RelayPairingError, match="rejected.*HTTP 401") as raised:
        pair_talaria_relay({
            "relay_url": "https://relay.example.com",
            "publisher_id": "https://hermes.example.com",
            "publisher_invitation": "invite-work",
        }, profile="work", operator=False, opener=opener)
    assert raised.value.status == 409


def test_signed_snapshot_contains_all_active_sessions(tmp_path, monkeypatch):
    key = Ed25519PrivateKey.generate()
    key_path = tmp_path / "publisher.pem"
    key_path.write_bytes(key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()))
    captured = {}

    @contextmanager
    def opener(request, timeout):
        captured["request"] = request
        captured["timeout"] = timeout
        yield type("Response", (), {"status": 200})()

    from api import config
    from api import models

    monkeypatch.setattr(models, "get_session", lambda sid, metadata_only: type("S", (), {"title": f"Title {sid}"})())
    with config.ACTIVE_RUNS_LOCK:
        previous = dict(config.ACTIVE_RUNS)
        config.ACTIVE_RUNS.clear()
        config.ACTIVE_RUNS.update({
            "stream-a": {"stream_id": "stream-a", "session_id": "a", "started_at": 1, "phase": "running"},
            "stream-b": {"stream_id": "stream-b", "session_id": "b", "started_at": 2, "phase": "starting"},
        })
    try:
        publisher = TalariaRelayPublisher(
            RelayConfig("https://relay.example", "publisher/id", "key-1", key_path),
            opener=opener,
        )
        publisher.publish_snapshot()
    finally:
        with config.ACTIVE_RUNS_LOCK:
            config.ACTIVE_RUNS.clear()
            config.ACTIVE_RUNS.update(previous)

    request = captured["request"]
    body = json.loads(request.data)
    expected_path = "/v1/publishers/publisher%2Fid/profiles/prf_default/snapshot"
    assert request.full_url == f"https://relay.example{expected_path}"
    assert captured["timeout"] == 10
    assert {state["sessionId"] for state in body["states"]} == {"a", "b"}
    assert next(state for state in body["states"] if state["sessionId"] == "b")["phase"] == "starting"
    timestamp = request.headers["X-talaria-timestamp"]
    nonce = request.headers["X-talaria-nonce"]
    body_hash = base64.urlsafe_b64encode(hashlib.sha256(request.data).digest()).rstrip(b"=").decode()
    signature = request.headers["X-talaria-signature"]
    signature += "=" * (-len(signature) % 4)
    key.public_key().verify(
        base64.urlsafe_b64decode(signature),
        f"PUT\n{expected_path}\n{timestamp}\n{nonce}\n{body_hash}".encode(),
    )


def test_signed_snapshot_contains_only_the_enrolled_profile(tmp_path, monkeypatch):
    key = Ed25519PrivateKey.generate()
    key_path = tmp_path / "publisher.pem"
    key_path.write_bytes(key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()))
    captured = []

    @contextmanager
    def opener(request, timeout):
        assert timeout == 10
        captured.append((request.full_url, json.loads(request.data)))
        yield type("Response", (), {"status": 200})()

    from api import config, models

    sessions = {
        "a": type("S", (), {"title": "A", "profile": "alice"})(),
        "b": type("S", (), {"title": "B", "profile": "bob"})(),
    }
    monkeypatch.setattr(models, "get_session", lambda sid, metadata_only: sessions[sid])
    with config.ACTIVE_RUNS_LOCK:
        previous = dict(config.ACTIVE_RUNS)
        config.ACTIVE_RUNS.clear()
        config.ACTIVE_RUNS.update({
            "stream-a": {"stream_id": "stream-a", "session_id": "a", "started_at": 1},
            "stream-b": {"stream_id": "stream-b", "session_id": "b", "started_at": 2},
        })
    try:
        TalariaRelayPublisher(
            RelayConfig(
                "https://relay.example",
                "https://hermes.example",
                "key-1",
                key_path,
                {
                    "alice": {"identity": "", "profile_id": "prf_alice"},
                    "bob": {"identity": "", "profile_id": "prf_bob"},
                },
            ),
            opener=opener,
        ).publish_snapshot()
    finally:
        with config.ACTIVE_RUNS_LOCK:
            config.ACTIVE_RUNS.clear()
            config.ACTIVE_RUNS.update(previous)

    assert [body["states"][0]["sessionId"] for _, body in captured] == ["a", "b"]
    assert captured[0][0].endswith("/profiles/prf_alice/snapshot")
    assert captured[1][0].endswith("/profiles/prf_bob/snapshot")


def test_terminal_state_survives_active_run_teardown(tmp_path, monkeypatch):
    key = Ed25519PrivateKey.generate()
    key_path = tmp_path / "publisher.pem"
    key_path.write_bytes(key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()))
    from api import config, models
    monkeypatch.setattr(models, "get_session", lambda sid, metadata_only: type("S", (), {"title": "Done"})())
    publisher = TalariaRelayPublisher(RelayConfig("https://relay.example", "publisher", "key", key_path))
    with config.ACTIVE_RUNS_LOCK:
        previous = dict(config.ACTIVE_RUNS)
        config.ACTIVE_RUNS.clear()
        config.ACTIVE_RUNS["stream"] = {"stream_id": "stream", "session_id": "session", "started_at": 1}
    try:
        publisher.note_terminal("stream", "completed")
        with config.ACTIVE_RUNS_LOCK:
            config.ACTIVE_RUNS.clear()
        states = publisher.build_states("default")
    finally:
        with config.ACTIVE_RUNS_LOCK:
            config.ACTIVE_RUNS.clear()
            config.ACTIVE_RUNS.update(previous)
    assert [(state["sessionId"], state["phase"]) for state in states] == [("session", "completed")]
    restarted = TalariaRelayPublisher(RelayConfig("https://relay.example", "publisher", "key", key_path))
    assert restarted._next_revision() > states[0]["revision"]


def test_health_only_waiter_is_not_published(tmp_path, monkeypatch):
    key = Ed25519PrivateKey.generate()
    key_path = tmp_path / "publisher.pem"
    key_path.write_bytes(key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()))
    from api import config, models

    monkeypatch.setattr(
        models,
        "get_session",
        lambda sid, metadata_only: type("S", (), {"title": sid, "profile": "default"})(),
    )
    publisher = TalariaRelayPublisher(
        RelayConfig("https://relay.example", "publisher", "key", key_path)
    )
    with config.ACTIVE_RUNS_LOCK:
        previous = dict(config.ACTIVE_RUNS)
        config.ACTIVE_RUNS.clear()
        config.ACTIVE_RUNS.update(
            {
                "real": {"stream_id": "real", "session_id": "session", "started_at": 1},
                "admission": {
                    "stream_id": "admission",
                    "session_id": "waiting",
                    "started_at": 2,
                    "health_only": True,
                },
            }
        )
    try:
        states = publisher.build_states("default")
    finally:
        with config.ACTIVE_RUNS_LOCK:
            config.ACTIVE_RUNS.clear()
            config.ACTIVE_RUNS.update(previous)

    assert [state["sessionId"] for state in states] == ["session"]


def test_publisher_isolates_permanent_failure_to_one_profile(tmp_path, caplog):
    key = Ed25519PrivateKey.generate()
    key_path = tmp_path / "publisher.pem"
    key_path.write_bytes(key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()))
    attempts = []

    @contextmanager
    def opener(request, timeout):
        assert timeout == 10
        attempts.append(request.full_url)
        if "/profiles/prf_bad/" in request.full_url:
            raise urllib.error.HTTPError(request.full_url, 401, "Unauthorized", {}, None)
        yield type("Response", (), {"status": 200})()

    publisher = TalariaRelayPublisher(
        RelayConfig(
            "https://relay.example",
            "publisher",
            "key",
            key_path,
            {
                "bad": {"identity": "", "profile_id": "prf_bad"},
                "good": {"identity": "", "profile_id": "prf_good"},
            },
        ),
        opener=opener,
    )
    with caplog.at_level(logging.WARNING, logger="api.talaria_relay"):
        publisher.publish_snapshot(isolate_permanent=True)
        publisher.publish_snapshot(isolate_permanent=True)

    assert sum("/profiles/prf_bad/" in url for url in attempts) == 1
    assert sum("/profiles/prf_good/" in url for url in attempts) == 2
    assert "disabled profile after permanent HTTP 401" in caplog.text
    assert all(record.exc_info is None for record in caplog.records)


def test_publisher_attempts_every_profile_before_retryable_backoff(tmp_path):
    from api import talaria_relay

    key = Ed25519PrivateKey.generate()
    key_path = tmp_path / "publisher.pem"
    key_path.write_bytes(key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()))
    attempts = []

    @contextmanager
    def opener(request, timeout):
        assert timeout == 10
        attempts.append(request.full_url)
        if "/profiles/prf_retry/" in request.full_url:
            raise urllib.error.HTTPError(request.full_url, 429, "Rate limited", {}, None)
        yield type("Response", (), {"status": 200})()

    publisher = TalariaRelayPublisher(
        RelayConfig(
            "https://relay.example",
            "publisher",
            "key",
            key_path,
            {
                "retry": {"identity": "", "profile_id": "prf_retry"},
                "healthy": {"identity": "", "profile_id": "prf_healthy"},
            },
        ),
        opener=opener,
    )

    with pytest.raises(talaria_relay._RelayHTTPError) as raised:
        publisher.publish_snapshot(isolate_permanent=True)
    assert raised.value.status == 429
    assert any("/profiles/prf_retry/" in url for url in attempts)
    assert any("/profiles/prf_healthy/" in url for url in attempts)


def test_publisher_retries_transient_failures_with_capped_backoff(tmp_path, monkeypatch, caplog):
    key = Ed25519PrivateKey.generate()
    key_path = tmp_path / "publisher.pem"
    key_path.write_bytes(key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()))
    attempts = 0

    class Stop:
        stopped = False

        def __init__(self):
            self.waits = []

        def is_set(self):
            return self.stopped

        def wait(self, delay):
            self.waits.append(delay)
            return False

        def set(self):
            self.stopped = True

    stop = Stop()

    @contextmanager
    def opener(request, timeout):
        nonlocal attempts
        attempts += 1
        if attempts < 9:
            raise urllib.error.HTTPError(request.full_url, 503, "Unavailable", {}, None)
        stop.set()
        yield type("Response", (), {"status": 200})()

    publisher = TalariaRelayPublisher(
        RelayConfig("https://relay.example", "publisher", "key", key_path),
        opener=opener,
    )
    publisher._stop = stop
    monkeypatch.setattr("api.talaria_relay.random.uniform", lambda _low, _high: 1.2)
    publisher.changed()
    with caplog.at_level(logging.DEBUG, logger="api.talaria_relay"):
        publisher._run()

    assert attempts == 9
    assert stop.waits == [6, 12, 24, 48, 96, 192, 300, 300]
    assert caplog.text.count("Talaria relay snapshot failed") == 1
    assert "Talaria relay snapshot recovered" in caplog.text
