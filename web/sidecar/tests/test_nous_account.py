"""Safe projection and account fences, with native APIs replaced at the boundary."""
import sys
from types import ModuleType, SimpleNamespace

import pytest

from talaria_sidecar.methods import nous_account


@pytest.fixture
def native(monkeypatch, tmp_path):
    api = SimpleNamespace()
    api.status = {"state": "claimed", "account_email": "unmasked@example.test", "connectors_kind": "moved",
                  "moved_toolkits": ["calendar"], "dropped_toolkits": ["gmail"]}
    api.record = {"profiles": [str(tmp_path)], "destination": "user-1"}
    api.subject = "user-1"
    api.broken = False
    package = ModuleType("hermes_cli")
    handoff = ModuleType("hermes_cli.guest_handoff")
    def status():
        if api.broken:
            raise OSError("secret exception")
        return api.status.copy()
    handoff.handoff_status = status
    handoff._status_of = lambda record: status()
    handoff._load = lambda path: {"records": {"record": api.record}}
    handoff._records_path = lambda: tmp_path / "native-records"
    handoff._home_key = lambda: str(tmp_path)
    handoff._account_bound_to = lambda record: None if record["destination"] != api.subject else {"access_token": "secret"}
    # Native generates its own copy from the safe fields we give it; arbitrary raw lines are ignored.
    handoff.wire_status = lambda safe: {**safe, "lines": [f"{safe['state']} {safe['account_email']} {','.join(safe['moved_toolkits'])}"]}
    auth = ModuleType("hermes_cli.auth")
    auth.get_provider_auth_state = lambda provider: {"access_token": "secret"}
    anon = ModuleType("hermes_cli.anon_auth")
    anon.is_guest_state = lambda state: False
    constants = ModuleType("hermes_cli.auth_constants")
    constants._decode_jwt_claims = lambda token: {"sub": api.subject, "email": "unmasked@example.test"}
    package.guest_handoff = handoff
    for name, module in [("hermes_cli", package), ("hermes_cli.guest_handoff", handoff), ("hermes_cli.auth", auth),
                         ("hermes_cli.anon_auth", anon), ("hermes_cli.auth_constants", constants)]:
        monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.setattr(nous_account, "_LAST", nous_account.OrderedDict())
    api.handoff = handoff
    return api


@pytest.mark.parametrize("state", ["claimed", "idle", "retrying", "pending", "paused", "failed", "gone", "future"])
def test_projection_is_allowlisted_and_auth_success_does_not_imply_handoff_success(native, tmp_path, state):
    native.status.update(state=state, anon_token="secret", access_token="secret", lines=["secret"], error="secret")
    native.status["moved_toolkits"] += ["https://evil.test", "SECRET=secret", "calendar"]
    result = nous_account.read(tmp_path)
    assert result["email"] == "u***@example.test"
    assert result["state"] == (state if state != "future" else "unknown")
    assert result["moved"] == (["calendar"] if state == "claimed" else [])
    assert result["reconnect"] == (["gmail"] if state == "claimed" else [])
    assert result["poll_after"] == (5 if state in {"pending", "retrying"} else None)
    assert "secret" not in str(result) and "unmasked" not in str(result)


def test_failed_read_keeps_only_the_current_accounts_confirmed_view(native, tmp_path):
    confirmed = nous_account.read(tmp_path)
    native.broken = True
    unavailable = nous_account.read(tmp_path)
    assert unavailable["state"] == "unavailable" and unavailable["moved"] == ["calendar"]
    assert unavailable["lines"][:-1] == confirmed["lines"] and unavailable["reconnect"] == []
    native.subject = "other-user"
    other = nous_account.read(tmp_path)
    assert other["account_id"] != confirmed["account_id"] and other["moved"] == []
    assert confirmed["lines"][0] not in other["lines"]


def test_old_terminal_result_never_exposes_another_accounts_apps(native, tmp_path):
    native.subject = "another-user"
    result = nous_account.read(tmp_path)
    assert result["state"] == "paused" and result["moved"] == [] and result["reconnect"] == []


def test_account_change_during_read_discards_the_response(native, tmp_path):
    def replaced():
        native.subject = "another-user"
        return native.status
    native.handoff.handoff_status = replaced
    assert nous_account.read(tmp_path) is None


def test_no_apps_and_unknown_connector_outcomes_do_not_invent_apps(native, tmp_path):
    native.status.update(connectors_kind="none", moved_toolkits=[], dropped_toolkits=[])
    assert nous_account.read(tmp_path)["reconnect"] == []
    native.status.update(state="future", moved_toolkits=["calendar"])
    assert nous_account.read(tmp_path)["moved"] == []


def test_profile_identity_is_part_of_the_display_fence(native, tmp_path):
    assert nous_account.read(tmp_path)["account_id"] != nous_account.read(tmp_path / "other")["account_id"]


def test_reconnect_checks_the_current_profile_account_and_live_catalog_before_connect(native, tmp_path, monkeypatch):
    import contextlib
    from talaria_sidecar.methods import Registry, connectors
    from talaria_sidecar.errors import RpcError
    registry = Registry(runtime=SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
    connectors.register(registry)
    monkeypatch.setattr(connectors, "scoped_home", lambda home: contextlib.nullcontext())
    monkeypatch.setattr(connectors, "_slug", lambda params: params["connector"])
    openings, writes = [], []
    monkeypatch.setattr(connectors, "_open", lambda **options: openings.append(options))
    monkeypatch.setattr(connectors, "catalog", lambda: {"connectors": [{"slug": "gmail"}]})
    monkeypatch.setattr(connectors, "connect", lambda home, slug, **kwargs: writes.append((home, slug)) or {})
    account_id = nous_account.read(tmp_path)["account_id"]
    params = {"profile_home": str(tmp_path), "connector": "gmail", "nous_account_id": account_id}
    call = registry.methods["connectors.connect"]
    assert call(None, params) == {}
    assert writes == [(tmp_path, "gmail")] and openings == [{"creates_guest": False}]
    for changed in ({"nous_account_id": "stale"}, {"profile_home": str(tmp_path / "other")}, {"connector": "calendar"}):
        with pytest.raises(RpcError):
            call(None, {**params, **changed})
    native.subject = "another-user"
    with pytest.raises(RpcError):
        call(None, params)
    assert writes == [(tmp_path, "gmail")]


def test_connector_headers_recheck_both_profile_and_bearer_identity(native, tmp_path, monkeypatch):
    tools = ModuleType("tools")
    auth = ModuleType("tools.managed_gateway_auth")
    tokens = ModuleType("tools.managed_tool_gateway")
    tokens.peek_nous_access_token = lambda: "secret"
    auth.managed_gateway_auth_headers = lambda url, token_reader: {"Authorization": token_reader()} if url == "https://trusted.test" else {}
    monkeypatch.setitem(sys.modules, "tools", tools)
    monkeypatch.setitem(sys.modules, "tools.managed_gateway_auth", auth)
    monkeypatch.setitem(sys.modules, "tools.managed_tool_gateway", tokens)
    expected = nous_account.read(tmp_path)["account_id"]
    assert nous_account.connector_headers(tmp_path, expected, "https://trusted.test")["Authorization"] == "secret"
    assert nous_account.connector_headers(tmp_path, expected, "https://untrusted.test") == {}
    native.subject = "replacement-account"
    assert nous_account.connector_headers(tmp_path, expected, "https://trusted.test")["Authorization"] is None
    native.subject = "user-1"
    tokens.peek_nous_access_token = lambda: "foreign-token"
    constants = sys.modules["hermes_cli.auth_constants"]
    constants._decode_jwt_claims = lambda token: {"sub": "another-account" if token == "foreign-token" else "user-1"}
    assert nous_account.connector_headers(tmp_path, expected, "https://trusted.test")["Authorization"] is None
