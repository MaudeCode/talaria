"""Offer projection delegates policy and never provisions an identity."""
import sys
from types import ModuleType, SimpleNamespace

import pytest

from talaria_sidecar.methods import connectors


@pytest.fixture
def native(monkeypatch):
    api = SimpleNamespace(state={"auth_method": "anonymous", "anon_token": "private-guest-token"}, eligible=True, due=0, claims=[])
    package = ModuleType("hermes_cli")
    anon = ModuleType("hermes_cli.anon_auth")
    anon.current_nous_state = lambda: api.state
    anon.is_guest_state = lambda value: value is not None and value.get("auth_method") == "anonymous"
    offer = ModuleType("hermes_cli.free_tier_offer")
    offer.CONNECTOR = "connector"
    offer._eligible = lambda kind: api.eligible
    offer.offer_due_in = lambda kind: api.due
    def claim(kind):
        api.claims.append(kind)
        if api.due != 0:
            return False
        api.due = None
        return True
    offer.claim_offer = claim
    package.anon_auth, package.free_tier_offer = anon, offer
    for name, module in [("hermes_cli", package), ("hermes_cli.anon_auth", anon), ("hermes_cli.free_tier_offer", offer)]:
        monkeypatch.setitem(sys.modules, name, module)
    api.offer = offer
    return api


@pytest.mark.parametrize("eligible,due", [(True, 0), (True, 180), (False, None)])
def test_status_is_pure_and_native_policy_is_authoritative(native, tmp_path, eligible, due):
    native.eligible, native.due = eligible, due
    view = connectors.sign_in_offer(tmp_path)
    assert view["available"] and view["eligible"] == eligible and view["due_in"] == due
    assert view["guest_id"] and "private-guest-token" not in str(view)
    assert native.claims == [] and list(tmp_path.iterdir()) == []


def test_claim_is_identity_bound_and_uses_native_cas(native, tmp_path):
    guest = connectors.sign_in_offer(tmp_path)["guest_id"]
    assert not connectors.sign_in_offer(tmp_path, "another-guest")["claimed"]
    assert native.claims == []
    assert connectors.sign_in_offer(tmp_path, guest)["claimed"]
    assert not connectors.sign_in_offer(tmp_path, guest)["claimed"]
    assert native.claims == ["connector", "connector"]
    assert connectors.sign_in_offer(tmp_path / "another-profile")["guest_id"] != guest


def test_unavailable_is_not_due_and_identity_change_discards_late_result(native, tmp_path):
    def broken(kind):
        raise OSError("private-guest-token")
    native.offer.offer_due_in = broken
    failed = connectors.sign_in_offer(tmp_path)
    assert failed["available"] is False and failed["due_in"] is None and failed["guest_id"]
    def replaced(kind):
        native.state = {"auth_method": "oauth"}
        return 0
    native.offer.offer_due_in = replaced
    assert connectors.sign_in_offer(tmp_path)["guest_id"] is None


def test_older_agent_is_unavailable(native, tmp_path, monkeypatch):
    monkeypatch.delattr(native.offer, "claim_offer")
    assert connectors.sign_in_offer(tmp_path) == {"available": False, "guest_id": None, "eligible": False, "due_in": None, "claimed": False}


def test_accounts_observes_external_connections_without_provisioning(native, monkeypatch):
    rows = [{"connectionId": "one", "connector": "gmail", "status": "active", "label": "Work", "active": True, "createdAt": "now"},
            {"connectionId": "two", "connector": "notion", "status": "inactive", "label": "Old", "active": False, "createdAt": "before"}]
    seen = []
    native.offer.note_connected_apps_seen = lambda value: seen.extend(value)
    monkeypatch.setattr(connectors, "_portal", lambda: SimpleNamespace(list_accounts=lambda: rows))
    monkeypatch.setattr(connectors, "_authenticated", lambda client: True)
    assert len(connectors.accounts()["accounts"]) == 2
    assert seen == [{"connected": True}, {"connected": False}]
