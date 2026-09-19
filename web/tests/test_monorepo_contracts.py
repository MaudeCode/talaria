"""Shared synthetic fixtures exercise the real producer and scene boundary."""

from contextlib import contextmanager
import json
from pathlib import Path
from types import SimpleNamespace

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat

FIXTURES = Path(__file__).resolve().parents[2] / "contracts" / "fixtures"


def test_shared_publisher_snapshot(tmp_path, monkeypatch):
    from api import config, models, talaria_relay

    expected = json.loads((FIXTURES / "publisher-snapshot.json").read_text())
    now = expected["states"][0]["updatedAt"]
    key_path = tmp_path / "publisher.pem"
    key = Ed25519PrivateKey.generate()
    key_path.write_bytes(key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()))
    requests = []

    @contextmanager
    def opener(request, timeout):
        requests.append(request)
        assert timeout == 10
        yield SimpleNamespace(status=200)

    monkeypatch.setattr(talaria_relay.time, "time", lambda: now / 1000)
    monkeypatch.setattr(talaria_relay.time, "time_ns", lambda: now * 1_000_000)
    monkeypatch.setattr(talaria_relay.uuid, "uuid4", lambda: SimpleNamespace(hex="0" * 31 + "1"))
    monkeypatch.setattr(talaria_relay, "profile_has_presence", lambda _: True)
    monkeypatch.setattr(models, "get_session", lambda *args, **kwargs: SimpleNamespace(title="Contract fixture", profile="default"))
    monkeypatch.setattr(config, "ACTIVE_RUNS", {"contract-stream": {
        "stream_id": "contract-stream", "session_id": "contract-session", "started_at": 1,
        "phase": "running",
    }})
    publisher = talaria_relay.TalariaRelayPublisher(talaria_relay.RelayConfig(
        "https://relay.example", "https://contract.example", "contract-key", key_path,
    ), opener=opener)
    publisher.publish_snapshot()
    assert len(requests) == 1
    assert json.loads(requests[0].data) == expected
    assert requests[0].full_url.endswith("/profiles/prf_default/snapshot")


def test_shared_activity_scene_is_accepted_without_loss():
    from api.routes import _sanitize_anchor_activity_scene

    fixture = json.loads((FIXTURES / "web-session.json").read_text())
    scene = fixture["session"]["messages"][0]["_anchor_activity_scene"]
    assert _sanitize_anchor_activity_scene(scene) == scene


def test_shared_contract_metadata():
    import jsonschema

    root = FIXTURES.parent
    versions = json.loads((root / "versions.json").read_text())
    jsonschema.validate(versions, json.loads((root / "versions.schema.json").read_text()))
    session = json.loads((FIXTURES / "web-session.json").read_text())
    assert session["session"]["messages"][0]["_anchor_activity_scene"]["version"] == versions["activityScene"]["version"]
    aggregate = json.loads((FIXTURES / "relay-snapshot.json").read_text())["aggregate"]
    assert aggregate["schemaVersion"] == versions["appRelay"]["aggregateSchemaVersion"]
