"""HWEB-71: opt-in OIDC owner mapping.

Owner permission for an OIDC identity comes from an explicit operator
allowlist (``webui_oidc.owner_claim`` / ``owner_values``), never from an empty
``bound_profile``. These tests cover the configuration contract, exact claim
matching, the route/``/api/auth/status`` agreement, and owner permission for
the session lifetime. IdP group removal takes effect at the next login.

Everything here is synthetic: locally generated keys, locally signed tokens,
and locally patched provider transport. No IdP, credential, or network is used.
"""

import io
import json
import os
import time
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, utils

import api.auth_oidc as _auth_oidc

# Captured before the autouse fixture stubs it, for the cases that need the
# real operator-config read against a temporary config.yaml.
_REAL_LOAD_OPERATOR_CONFIG = _auth_oidc._load_operator_config

ISSUER = "https://issuer.example"
CLIENT_ID = "webui-client"
OWNER_GROUP = "webui-owners"


class FakeHeaders(dict):
    def get(self, key, default=None):
        return super().get(key, default)


class RouteFakeHandler:
    def __init__(self, cookie=None, headers=None):
        self.headers = FakeHeaders({"Host": "server.example", "Content-Length": "0"})
        if cookie:
            self.headers["Cookie"] = f"hermes_session={cookie}"
        self.headers.update(headers or {})
        self.rfile = io.BytesIO()
        self.wfile = io.BytesIO()
        self.request = SimpleNamespace()
        self.status = None
        self.sent_headers = []
        self.client_address = ("127.0.0.1", 12345)

    def send_response(self, status):
        self.status = status

    def send_header(self, key, value):
        self.sent_headers.append((key, value))

    def end_headers(self):
        pass

    def json_body(self):
        return json.loads(self.wfile.getvalue())

    def header_values(self, name):
        return [value for key, value in self.sent_headers if key.lower() == name.lower()]


@pytest.fixture(autouse=True)
def _isolated_oidc_env(monkeypatch):
    """Strip inherited OIDC configuration and pending flow state."""
    import api.auth_oidc as auth_oidc

    for name in (
        "ISSUER", "CLIENT_ID", "CLIENT_SECRET", "REDIRECT_URI", "SCOPES",
        "ALLOW_CLAIM", "ALLOW_VALUES", "PROFILE_CLAIM", "PROFILE_MAP",
        "OWNER_CLAIM", "OWNER_VALUES", "TRUSTED_PRIVATE_HOSTS",
    ):
        monkeypatch.delenv(f"HERMES_WEBUI_OIDC_{name}", raising=False)
    monkeypatch.setattr(auth_oidc, "_load_operator_config", lambda: {})
    monkeypatch.setattr(auth_oidc, "_warned_owner_policy", False, raising=False)
    auth_oidc._pending_flows.clear()
    auth_oidc._native_flows.clear()
    auth_oidc._native_exchange_codes.clear()
    yield
    auth_oidc._pending_flows.clear()
    auth_oidc._native_flows.clear()
    auth_oidc._native_exchange_codes.clear()


# ── synthetic provider ───────────────────────────────────────────────────────


def _ec_jwk(auth_oidc, private_key, *, kid="test-key"):
    numbers = private_key.public_key().public_numbers()
    return {
        "kid": kid,
        "kty": "EC",
        "alg": "ES256",
        "crv": "P-256",
        "x": auth_oidc._b64u(numbers.x.to_bytes(32, "big")),
        "y": auth_oidc._b64u(numbers.y.to_bytes(32, "big")),
    }


def _sign(auth_oidc, private_key, claims, *, kid="test-key", tamper=False):
    header = auth_oidc._b64u(
        json.dumps({"alg": "ES256", "kid": kid}, separators=(",", ":")).encode()
    )
    payload = auth_oidc._b64u(json.dumps(claims, separators=(",", ":")).encode())
    der = private_key.sign(f"{header}.{payload}".encode("ascii"), ec.ECDSA(hashes.SHA256()))
    r, s = utils.decode_dss_signature(der)
    if tamper:
        r ^= 1
    signature = auth_oidc._b64u(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
    return f"{header}.{payload}.{signature}"


def _configure(monkeypatch, *, owner_claim="groups", owner_values=OWNER_GROUP, profile_map=None):
    """Point the WebUI at a synthetic provider and return (key, token slot)."""
    import api.auth_oidc as auth_oidc

    monkeypatch.setenv("HERMES_WEBUI_OIDC_ISSUER", ISSUER)
    monkeypatch.setenv("HERMES_WEBUI_OIDC_CLIENT_ID", CLIENT_ID)
    monkeypatch.setenv("HERMES_WEBUI_OIDC_ALLOW_CLAIM", "email")
    monkeypatch.setenv("HERMES_WEBUI_OIDC_ALLOW_VALUES", "owner@example.com,user@example.com")
    if owner_claim is not None:
        monkeypatch.setenv("HERMES_WEBUI_OIDC_OWNER_CLAIM", owner_claim)
    if owner_values is not None:
        monkeypatch.setenv("HERMES_WEBUI_OIDC_OWNER_VALUES", owner_values)
    if profile_map is not None:
        monkeypatch.setenv("HERMES_WEBUI_OIDC_PROFILE_CLAIM", "email")
        monkeypatch.setenv("HERMES_WEBUI_OIDC_PROFILE_MAP", json.dumps(profile_map))

    private_key = ec.generate_private_key(ec.SECP256R1())
    token = {"value": ""}
    monkeypatch.setattr(auth_oidc, "_get_discovery_document", lambda _issuer: {
        "issuer": ISSUER,
        "authorization_endpoint": f"{ISSUER}/authorize",
        "token_endpoint": f"{ISSUER}/token",
        "jwks_uri": f"{ISSUER}/jwks",
    })
    monkeypatch.setattr(
        auth_oidc, "_post_form_json", lambda *_a, **_kw: {"id_token": token["value"]}
    )
    monkeypatch.setattr(
        auth_oidc, "_get_jwks_document",
        lambda *_a, **_kw: {"keys": [_ec_jwk(auth_oidc, private_key)]},
    )
    return private_key, token


def _login(monkeypatch, private_key, token, claims, *, sign_key=None, tamper=False):
    """Drive one full authorization-code login and return its result."""
    import api.auth_oidc as auth_oidc

    location = auth_oidc.build_authorization_redirect("https://server.example")
    params = parse_qs(urlparse(location).query)
    payload = {
        "iss": ISSUER,
        "aud": CLIENT_ID,
        "iat": time.time(),
        "exp": time.time() + 300,
        "nonce": params["nonce"][0],
        "sub": "synthetic-user",
        **claims,
    }
    token["value"] = _sign(auth_oidc, sign_key or private_key, payload, tamper=tamper)
    return auth_oidc.complete_authorization_code_flow(
        "https://server.example", params["state"][0], "synthetic-code"
    )


# ── configuration contract ───────────────────────────────────────────────────


def test_absent_owner_policy_is_disabled(monkeypatch):
    import api.auth_oidc as auth_oidc

    _configure(monkeypatch, owner_claim=None, owner_values=None)
    cfg = auth_oidc._resolve_oidc_config()

    assert cfg["owner_policy_configured"] is False
    assert cfg["owner_policy_error"] is None
    assert cfg["owner_values"] == []


@pytest.mark.parametrize(
    "raw_claim, raw_values",
    [
        ("groups", None),          # claim without values
        (None, OWNER_GROUP),       # values without a claim
        ("groups", ""),            # present-but-blank values
        ("", ""),                  # both explicitly blank, e.g. templated env vars
        ("", OWNER_GROUP),
        ("   ", OWNER_GROUP),      # whitespace-only claim
        ("groups", []),            # empty list
        ("groups", [OWNER_GROUP, 7]),      # a number is not a group name
        ("groups", [OWNER_GROUP, True]),   # nor is a boolean
        ("groups", [OWNER_GROUP, ""]),     # a blank entry is malformed, not droppable
        ("groups", [OWNER_GROUP, "   "]),
        ("groups", [OWNER_GROUP, "${UNRESOLVED}"]),  # never expanded
        ("${UNRESOLVED}", OWNER_GROUP),
        ("groups", {"a": OWNER_GROUP}),    # nor is an object
        ("groups", 42),
    ],
)
def test_partial_or_malformed_owner_policy_matches_nothing(raw_claim, raw_values):
    import api.auth_oidc as auth_oidc

    claim, values, error, configured = auth_oidc._normalize_owner_policy(raw_claim, raw_values)

    assert configured is True, "a present setting must never fall back to legacy owner access"
    assert values == []
    assert error == auth_oidc._OWNER_POLICY_ERROR
    assert auth_oidc._resolve_owner_permission(
        {"owner_policy_configured": True, "owner_claim": claim, "owner_values": values},
        {"groups": [OWNER_GROUP]},
    ) is False


@pytest.mark.parametrize(
    "raw_values, expected",
    [
        (OWNER_GROUP, [OWNER_GROUP]),
        (f"{OWNER_GROUP}, other ", [OWNER_GROUP, "other"]),
        ([OWNER_GROUP, "Hermes Owners"], [OWNER_GROUP, "Hermes Owners"]),
        ("a\nb", ["a", "b"]),
    ],
)
def test_owner_values_accept_supported_string_shapes(raw_values, expected):
    import api.auth_oidc as auth_oidc

    _, values, error, configured = auth_oidc._normalize_owner_policy("groups", raw_values)

    assert (values, error, configured) == (expected, None, True)


def test_explicitly_blank_env_settings_activate_the_match_nobody_path(monkeypatch):
    """Blank templated env vars are supplied configuration, not absence."""
    import api.auth as auth
    import api.auth_oidc as auth_oidc

    _configure(monkeypatch, owner_claim="", owner_values="")
    cfg = auth_oidc._resolve_oidc_config()
    assert cfg["owner_policy_configured"] is True
    assert cfg["owner_values"] == []

    monkeypatch.setattr(auth, "is_auth_enabled", lambda: True)
    cookie = auth.create_session(auth_type="oidc", username="legacy@example.com")
    try:
        assert _status(monkeypatch, cookie)["can_manage_server"] is False
    finally:
        auth.invalidate_session(cookie)


def test_unreadable_operator_config_does_not_restore_legacy_owner_access(monkeypatch):
    """An unreadable policy is unknown, and unknown must not grant ownership."""
    import api.auth as auth
    import api.auth_oidc as auth_oidc

    _configure(monkeypatch, owner_claim=None, owner_values=None)
    monkeypatch.setattr(auth, "is_auth_enabled", lambda: True)
    legacy = auth.create_session()

    try:
        assert _status(monkeypatch, legacy)["can_manage_server"] is True

        def _broken():
            raise OSError("config.yaml is unreadable")

        monkeypatch.setattr(auth_oidc, "_load_operator_config", _broken)
        assert auth_oidc._resolve_oidc_config()["config_read_failed"] is True
        assert auth.oidc_owner_policy_is_configured() is True
        assert _status(monkeypatch, legacy)["can_manage_server"] is False
    finally:
        auth.invalidate_session(legacy)


@pytest.mark.parametrize("mode", ["malformed", "unreadable"])
def test_malformed_operator_config_does_not_restore_legacy_owner_access(monkeypatch, tmp_path, mode):
    """api.config flattens a broken config to {}; that must not read as "no policy"."""
    import api.auth as auth
    import api.auth_oidc as auth_oidc
    import api.profiles as profiles

    _configure(monkeypatch, owner_claim=None, owner_values=None)
    monkeypatch.setattr(auth_oidc, "_load_operator_config", _REAL_LOAD_OPERATOR_CONFIG)
    config_path = tmp_path / "config.yaml"
    config_path.write_text("webui_oidc: [this is: not, a mapping\n", encoding="utf-8")
    if mode == "unreadable":
        if os.geteuid() == 0:
            pytest.skip("root bypasses file permissions")
        config_path.chmod(0o000)
    monkeypatch.setattr(profiles, "_INITIAL_HERMES_CONFIG_PATH", str(config_path))
    monkeypatch.setattr(auth, "is_auth_enabled", lambda: True)
    legacy = auth.create_session()

    try:
        assert auth_oidc._resolve_oidc_config()["config_read_failed"] is True
        assert auth.oidc_owner_policy_is_configured() is True
        assert auth.session_can_manage_server(auth.get_session_info(legacy)) is False
    finally:
        config_path.chmod(0o600)
        auth.invalidate_session(legacy)


def test_unreadable_config_denies_ownership_to_a_typed_oidc_session(monkeypatch, tmp_path):
    """Base settings from the environment do not make a missing policy "disabled"."""
    import api.auth as auth
    import api.auth_oidc as auth_oidc
    import api.profiles as profiles

    _configure(monkeypatch, owner_claim=None, owner_values=None)
    monkeypatch.setattr(auth_oidc, "_load_operator_config", _REAL_LOAD_OPERATOR_CONFIG)
    monkeypatch.setattr(auth, "is_auth_enabled", lambda: True)
    cookie = auth.create_session(auth_type="oidc", username="user@example.com")

    try:
        assert auth.session_can_manage_server(auth.get_session_info(cookie)) is True

        config_path = tmp_path / "config.yaml"
        config_path.write_text("webui_oidc: [this is: not, a mapping\n", encoding="utf-8")
        monkeypatch.setattr(profiles, "_INITIAL_HERMES_CONFIG_PATH", str(config_path))

        assert auth.session_can_manage_server(auth.get_session_info(cookie)) is False
    finally:
        auth.invalidate_session(cookie)


@pytest.mark.parametrize(
    "content",
    ["# nothing configured yet\n\n", "", "{}\n", "---\n", "# lead\n{}\n"],
)
def test_legitimately_empty_operator_config_is_not_a_read_failure(monkeypatch, tmp_path, content):
    """An empty document, an explicit {}, and comments are all "nothing set"."""
    import api.auth_oidc as auth_oidc
    import api.profiles as profiles

    monkeypatch.setattr(auth_oidc, "_load_operator_config", _REAL_LOAD_OPERATOR_CONFIG)
    config_path = tmp_path / "config.yaml"
    config_path.write_text(content, encoding="utf-8")
    monkeypatch.setattr(profiles, "_INITIAL_HERMES_CONFIG_PATH", str(config_path))

    assert auth_oidc._resolve_oidc_config()["config_read_failed"] is False


def test_non_mapping_operator_config_is_a_read_failure(monkeypatch, tmp_path):
    import api.auth_oidc as auth_oidc
    import api.profiles as profiles

    monkeypatch.setattr(auth_oidc, "_load_operator_config", _REAL_LOAD_OPERATOR_CONFIG)
    config_path = tmp_path / "config.yaml"
    config_path.write_text("- just\n- a list\n", encoding="utf-8")
    monkeypatch.setattr(profiles, "_INITIAL_HERMES_CONFIG_PATH", str(config_path))

    assert auth_oidc._resolve_oidc_config()["config_read_failed"] is True


def test_a_repaired_config_is_returned_rather_than_the_stale_empty_read(monkeypatch, tmp_path):
    """The dict returned and the failure verdict come from the same read."""
    import api.auth_oidc as auth_oidc
    import api.profiles as profiles

    _configure(monkeypatch, owner_claim=None, owner_values=None)
    monkeypatch.setattr(auth_oidc, "_load_operator_config", _REAL_LOAD_OPERATOR_CONFIG)
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        f"webui_oidc:\n  owner_claim: groups\n  owner_values: [{OWNER_GROUP}]\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(profiles, "_INITIAL_HERMES_CONFIG_PATH", str(config_path))
    # Model a transient first-read failure: the shared loader reports empty
    # while the file on disk is intact.
    monkeypatch.setattr(auth_oidc, "_load_yaml_config_file", lambda _path: {}, raising=False)
    monkeypatch.setattr("api.config._load_yaml_config_file", lambda _path: {})

    cfg = auth_oidc._resolve_oidc_config()

    assert cfg["config_read_failed"] is False
    assert cfg["owner_policy_configured"] is True
    assert cfg["owner_values"] == [OWNER_GROUP]


def test_owner_check_reconciles_against_the_snapshot_that_chose_the_branch(monkeypatch):
    """A policy removed and restored between two reads must not pass the check."""
    import api.auth_oidc as auth_oidc

    private_key, token = _configure(monkeypatch)
    result = _login(monkeypatch, private_key, token, {
        "email": "user@example.com", "groups": ["users"],
    })
    session_info = {
        "auth_type": "oidc",
        "bound_profile": None,
        "oidc_mapping_fingerprint": result["oidc_binding"]["mapping_fingerprint"],
        "oidc_profile_identity": result["oidc_binding"]["profile_identity"],
    }

    # The snapshot that selects the legacy branch is the one validated against,
    # so a concurrent restore cannot make the policy-era fingerprint match.
    reads = []
    real_resolve = auth_oidc._resolve_oidc_config

    def _flapping():
        reads.append(len(reads))
        cfg = real_resolve()
        if len(reads) == 1:
            cfg = {**cfg, "owner_claim": "", "owner_values": [], "owner_policy_configured": False}
        return cfg

    monkeypatch.setattr(auth_oidc, "_resolve_oidc_config", _flapping)

    assert auth_oidc.oidc_session_can_manage_server(session_info) is False


@pytest.mark.parametrize("section", ["[]", '"owner_claim: groups"', "42"])
def test_non_mapping_webui_oidc_section_is_unresolved_not_absent(monkeypatch, tmp_path, section):
    """A section the operator did write must not present as one they did not."""
    import api.auth as auth
    import api.auth_oidc as auth_oidc
    import api.profiles as profiles

    _configure(monkeypatch, owner_claim=None, owner_values=None)
    monkeypatch.setattr(auth_oidc, "_load_operator_config", _REAL_LOAD_OPERATOR_CONFIG)
    config_path = tmp_path / "config.yaml"
    config_path.write_text(f"webui_oidc: {section}\n", encoding="utf-8")
    monkeypatch.setattr(profiles, "_INITIAL_HERMES_CONFIG_PATH", str(config_path))
    monkeypatch.setattr(auth, "is_auth_enabled", lambda: True)
    cookie = auth.create_session(auth_type="oidc", username="user@example.com")

    try:
        assert auth_oidc._resolve_oidc_config()["config_read_failed"] is True
        assert auth.session_can_manage_server(auth.get_session_info(cookie)) is False
    finally:
        auth.invalidate_session(cookie)


@pytest.mark.parametrize(
    "section",
    [
        "webui_oidc:\n  owner_claim:\n  owner_values:\n",
        "webui_oidc:\n  owner_claim:\n",
        "webui_oidc:\n  owner_values:\n",
    ],
)
def test_null_yaml_owner_keys_activate_the_match_nobody_path(monkeypatch, tmp_path, section):
    """A key written with no value was still written."""
    import api.auth as auth
    import api.auth_oidc as auth_oidc
    import api.profiles as profiles

    _configure(monkeypatch, owner_claim=None, owner_values=None)
    monkeypatch.setattr(auth_oidc, "_load_operator_config", _REAL_LOAD_OPERATOR_CONFIG)
    config_path = tmp_path / "config.yaml"
    config_path.write_text(section, encoding="utf-8")
    monkeypatch.setattr(profiles, "_INITIAL_HERMES_CONFIG_PATH", str(config_path))
    monkeypatch.setattr(auth, "is_auth_enabled", lambda: True)
    cookie = auth.create_session(auth_type="oidc", username="user@example.com")

    try:
        cfg = auth_oidc._resolve_oidc_config()
        assert cfg["owner_policy_configured"] is True
        assert cfg["owner_values"] == []
        assert auth.session_can_manage_server(auth.get_session_info(cookie)) is False
        assert auth_oidc._OWNER_POLICY_ERROR in (auth.get_oidc_startup_warning() or "")
    finally:
        auth.invalidate_session(cookie)


def test_an_absent_owner_section_still_means_legacy(monkeypatch, tmp_path):
    import api.auth as auth
    import api.auth_oidc as auth_oidc
    import api.profiles as profiles

    _configure(monkeypatch, owner_claim=None, owner_values=None)
    monkeypatch.setattr(auth_oidc, "_load_operator_config", _REAL_LOAD_OPERATOR_CONFIG)
    config_path = tmp_path / "config.yaml"
    config_path.write_text("webui_oidc:\n  profile_claim: sub\n", encoding="utf-8")
    monkeypatch.setattr(profiles, "_INITIAL_HERMES_CONFIG_PATH", str(config_path))
    monkeypatch.setattr(auth, "is_auth_enabled", lambda: True)
    cookie = auth.create_session(auth_type="oidc", username="user@example.com")

    try:
        assert auth_oidc._resolve_oidc_config()["owner_policy_configured"] is False
        assert auth.session_can_manage_server(auth.get_session_info(cookie)) is True
    finally:
        auth.invalidate_session(cookie)


def test_activating_an_empty_profile_map_revokes_existing_unbound_sessions(monkeypatch):
    """An empty map admits nobody, which is not the same policy as no map."""
    import api.auth as auth

    private_key, token = _configure(monkeypatch)
    cookie = _session(monkeypatch, _login(monkeypatch, private_key, token, {
        "email": "owner@example.com", "groups": [OWNER_GROUP],
    }))

    try:
        assert auth.session_can_manage_server(auth.get_session_info(cookie)) is True
        monkeypatch.setenv("HERMES_WEBUI_OIDC_PROFILE_CLAIM", "email")
        monkeypatch.setenv("HERMES_WEBUI_OIDC_PROFILE_MAP", "{}")

        assert auth.session_can_manage_server(auth.get_session_info(cookie)) is False
        assert auth.ensure_trusted_auth_session(RouteFakeHandler(cookie)) is None
    finally:
        auth.invalidate_session(cookie)


def _operator_config_with_interpolated_owner(monkeypatch, tmp_path):
    import api.auth_oidc as auth_oidc
    import api.profiles as profiles

    monkeypatch.setattr(auth_oidc, "_load_operator_config", _REAL_LOAD_OPERATOR_CONFIG)
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        "webui_oidc:\n"
        "  owner_claim: groups\n"
        '  owner_values: ["${OIDC_OWNER_GROUP}"]\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(profiles, "_INITIAL_HERMES_CONFIG_PATH", str(config_path))
    return config_path


def test_a_profile_dotenv_cannot_supply_an_interpolated_owner_group(monkeypatch, tmp_path):
    """Protecting the two setting names is not enough: the indirection can name
    any variable, so a profile .env must not resolve one either."""
    import api.auth_oidc as auth_oidc
    import api.profiles as profiles

    _configure(monkeypatch, owner_claim=None, owner_values=None)
    _operator_config_with_interpolated_owner(monkeypatch, tmp_path)
    monkeypatch.delenv("OIDC_OWNER_GROUP", raising=False)

    profile_home = tmp_path / "profile"
    profile_home.mkdir()
    (profile_home / ".env").write_text("OIDC_OWNER_GROUP=attackers\n", encoding="utf-8")
    profiles._reload_dotenv(profile_home)
    try:
        assert os.environ["OIDC_OWNER_GROUP"] == "attackers"

        cfg = auth_oidc._resolve_oidc_config()
        # The unresolved reference is a configuration error, not a group name:
        # the policy is configured and matches nobody, including an identity
        # whose claim is literally the placeholder.
        assert cfg["owner_policy_configured"] is True
        assert cfg["owner_values"] == []
        assert cfg["owner_policy_error"] == auth_oidc._OWNER_POLICY_ERROR
        assert auth_oidc._resolve_owner_permission(cfg, {"groups": ["attackers"]}) is False
        assert auth_oidc._resolve_owner_permission(cfg, {"groups": ["${OIDC_OWNER_GROUP}"]}) is False
    finally:
        profiles._reload_dotenv(tmp_path)


def test_a_shadowed_placeholder_falls_back_to_the_startup_value(monkeypatch, tmp_path):
    """Rejecting the profile value must not discard the operator's own."""
    import api.auth_oidc as auth_oidc
    import api.profiles as profiles

    _configure(monkeypatch, owner_claim=None, owner_values=None)
    _operator_config_with_interpolated_owner(monkeypatch, tmp_path)
    monkeypatch.setitem(profiles._INITIAL_PROCESS_ENV, "OIDC_OWNER_GROUP", OWNER_GROUP)
    monkeypatch.setenv("OIDC_OWNER_GROUP", OWNER_GROUP)

    profile_home = tmp_path / "profile"
    profile_home.mkdir()
    (profile_home / ".env").write_text("OIDC_OWNER_GROUP=attackers\n", encoding="utf-8")
    profiles._reload_dotenv(profile_home)
    try:
        assert os.environ["OIDC_OWNER_GROUP"] == "attackers"

        cfg = auth_oidc._resolve_oidc_config()
        assert cfg["owner_values"] == [OWNER_GROUP]
        assert auth_oidc._resolve_owner_permission(cfg, {"groups": [OWNER_GROUP]}) is True
        assert auth_oidc._resolve_owner_permission(cfg, {"groups": ["attackers"]}) is False
    finally:
        profiles._reload_dotenv(tmp_path)


def test_the_operator_environment_still_resolves_an_interpolated_owner_group(monkeypatch, tmp_path):
    import api.auth_oidc as auth_oidc

    _configure(monkeypatch, owner_claim=None, owner_values=None)
    _operator_config_with_interpolated_owner(monkeypatch, tmp_path)
    monkeypatch.setenv("OIDC_OWNER_GROUP", OWNER_GROUP)

    cfg = auth_oidc._resolve_oidc_config()

    assert cfg["owner_values"] == [OWNER_GROUP]
    assert auth_oidc._resolve_owner_permission(cfg, {"groups": [OWNER_GROUP]}) is True


def test_an_unset_placeholder_stays_literal_and_matches_nothing(monkeypatch, tmp_path):
    import api.auth_oidc as auth_oidc

    _configure(monkeypatch, owner_claim=None, owner_values=None)
    _operator_config_with_interpolated_owner(monkeypatch, tmp_path)
    monkeypatch.delenv("OIDC_OWNER_GROUP", raising=False)

    cfg = auth_oidc._resolve_oidc_config()

    assert cfg["owner_policy_configured"] is True
    assert cfg["owner_values"] == []
    assert auth_oidc._resolve_owner_permission(cfg, {"groups": ["${OIDC_OWNER_GROUP}"]}) is False
    assert auth_oidc._resolve_owner_permission(cfg, {"groups": [""]}) is False


def test_an_unresolved_login_allowlist_admits_nobody(monkeypatch, tmp_path):
    """An unresolvable admission policy disables login, it does not admit the
    identity that can present the literal placeholder."""
    import api.auth_oidc as auth_oidc
    import api.profiles as profiles

    _configure(monkeypatch, owner_claim=None, owner_values=None)
    monkeypatch.delenv("HERMES_WEBUI_OIDC_ALLOW_VALUES", raising=False)
    monkeypatch.delenv("HERMES_WEBUI_OIDC_ALLOW_CLAIM", raising=False)
    monkeypatch.setattr(auth_oidc, "_load_operator_config", _REAL_LOAD_OPERATOR_CONFIG)
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        "webui_oidc:\n"
        "  issuer: https://issuer.example\n"
        "  client_id: webui-client\n"
        "  allow_claim: email\n"
        '  allow_values: ["${OIDC_ALLOWED}"]\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(profiles, "_INITIAL_HERMES_CONFIG_PATH", str(config_path))
    monkeypatch.delenv("OIDC_ALLOWED", raising=False)

    cfg = auth_oidc._resolve_oidc_config()

    assert cfg["allow_values"] == []
    assert auth_oidc.is_oidc_enabled() is False
    with pytest.raises(auth_oidc.OIDCConfigError):
        auth_oidc._require_oidc_config()


def test_an_unresolved_config_blocks_oidc_login_not_just_ownership(monkeypatch, tmp_path):
    """The profile map lives in that file; an unbound session is not a safe guess."""
    import api.auth as auth
    import api.auth_oidc as auth_oidc
    import api.profiles as profiles

    private_key, token = _configure(monkeypatch, owner_claim=None, owner_values=None)
    monkeypatch.setattr(auth_oidc, "_load_operator_config", _REAL_LOAD_OPERATOR_CONFIG)
    config_path = tmp_path / "config.yaml"
    config_path.write_text("webui_oidc: [not, a, mapping\n", encoding="utf-8")
    monkeypatch.setattr(profiles, "_INITIAL_HERMES_CONFIG_PATH", str(config_path))

    # Login is refused, but the deployment must not fall out of auth entirely:
    # is_auth_enabled() is the OR of the configured methods.
    assert auth_oidc.is_oidc_enabled() is True
    assert auth.is_auth_enabled() is True
    for name in ("ISSUER", "CLIENT_ID", "ALLOW_CLAIM", "ALLOW_VALUES"):
        monkeypatch.delenv(f"HERMES_WEBUI_OIDC_{name}", raising=False)
    # ... including when every base setting lived in the unreadable file.
    assert auth_oidc.is_oidc_enabled() is True
    assert auth.is_auth_enabled() is True
    with pytest.raises(auth_oidc.OIDCConfigError, match="could not be resolved"):
        auth_oidc._require_oidc_config()
    with pytest.raises(auth_oidc.OIDCConfigError):
        _login(monkeypatch, private_key, token, {"email": "user@example.com"})


def test_an_unresolved_profile_claim_does_not_fall_back_to_sub(monkeypatch):
    """Binding through a claim path the operator did not configure is not a default."""
    import api.auth_oidc as auth_oidc

    _configure(
        monkeypatch, owner_claim=None, owner_values=None,
        profile_map={"synthetic-user": "default"},
    )
    monkeypatch.setenv("HERMES_WEBUI_OIDC_PROFILE_CLAIM", "${OIDC_PROFILE_CLAIM}")

    cfg = auth_oidc._resolve_oidc_config()
    assert cfg["profile_claim"] == ""
    assert "profile_claim could not be resolved" in (cfg["profile_map_error"] or "")
    with pytest.raises(auth_oidc.OIDCConfigError, match="profile_claim"):
        auth_oidc._require_oidc_config()


def test_startup_values_survive_leaving_a_shadowing_profile(monkeypatch, tmp_path):
    """_reload_dotenv pops the shadowed name on the next switch."""
    import api.auth_oidc as auth_oidc
    import api.profiles as profiles

    _configure(monkeypatch, owner_claim=None, owner_values=None)
    _operator_config_with_interpolated_owner(monkeypatch, tmp_path)
    monkeypatch.setitem(profiles._INITIAL_PROCESS_ENV, "OIDC_OWNER_GROUP", OWNER_GROUP)
    monkeypatch.setenv("OIDC_OWNER_GROUP", OWNER_GROUP)

    shadowing = tmp_path / "profile-a"
    shadowing.mkdir()
    (shadowing / ".env").write_text("OIDC_OWNER_GROUP=attackers\n", encoding="utf-8")
    plain = tmp_path / "profile-b"
    plain.mkdir()

    try:
        profiles._reload_dotenv(shadowing)
        assert auth_oidc._resolve_oidc_config()["owner_values"] == [OWNER_GROUP]

        # Switching away pops the name from os.environ entirely.
        profiles._reload_dotenv(plain)
        assert "OIDC_OWNER_GROUP" not in os.environ
        assert auth_oidc._resolve_oidc_config()["owner_values"] == [OWNER_GROUP]
    finally:
        profiles._reload_dotenv(tmp_path)


def test_an_unresolved_claim_path_is_blanked(monkeypatch):
    import api.auth_oidc as auth_oidc

    _configure(monkeypatch, owner_claim=None, owner_values=None)
    monkeypatch.setenv("HERMES_WEBUI_OIDC_ALLOW_CLAIM", "${OIDC_CLAIM}")
    monkeypatch.setenv("HERMES_WEBUI_OIDC_PROFILE_CLAIM", "${OIDC_CLAIM}")

    cfg = auth_oidc._resolve_oidc_config()

    assert cfg["allow_claim"] == ""
    assert cfg["profile_claim"] == ""
    # No usable allow_claim means OIDC is genuinely not configured, which is a
    # different state from a config we could not read.
    assert auth_oidc.is_oidc_enabled() is False


def test_a_cached_config_snapshot_is_not_trusted_once_unreadable(monkeypatch, tmp_path):
    """api.config memoizes on (mtime, size), so a chmod alone keeps the cache warm."""
    import api.auth as auth
    import api.auth_oidc as auth_oidc
    import api.profiles as profiles

    if os.geteuid() == 0:
        pytest.skip("root bypasses file permissions")

    _configure(monkeypatch, owner_claim=None, owner_values=None)
    monkeypatch.setattr(auth_oidc, "_load_operator_config", _REAL_LOAD_OPERATOR_CONFIG)
    config_path = tmp_path / "config.yaml"
    config_path.write_text("webui_oidc:\n  profile_claim: sub\n", encoding="utf-8")
    monkeypatch.setattr(profiles, "_INITIAL_HERMES_CONFIG_PATH", str(config_path))
    monkeypatch.setattr(auth, "is_auth_enabled", lambda: True)
    legacy = auth.create_session()

    try:
        # Warm the shared parse cache, then revoke read without touching
        # mtime or size.
        assert auth_oidc._resolve_oidc_config()["config_read_failed"] is False
        assert auth.session_can_manage_server(auth.get_session_info(legacy)) is True

        config_path.chmod(0o000)
        assert auth_oidc._resolve_oidc_config()["config_read_failed"] is True
        assert auth.session_can_manage_server(auth.get_session_info(legacy)) is False
    finally:
        config_path.chmod(0o600)
        auth.invalidate_session(legacy)


def test_a_preserved_mtime_owner_policy_replace_revokes_existing_sessions(monkeypatch, tmp_path):
    """HWEB-81: editing owner_values to another same-length value while the
    replace restores mtime kept the previous policy authoritative, so the
    sessions the operator meant to revoke stayed owners. The parse cache now
    keys on file identity too, so the next authorization check sees the change.
    """
    import api.auth as auth
    import api.auth_oidc as auth_oidc
    import api.config as config
    import api.profiles as profiles

    _configure(monkeypatch, owner_claim=None, owner_values=None)
    monkeypatch.setattr(auth_oidc, "_load_operator_config", _REAL_LOAD_OPERATOR_CONFIG)
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        "webui_oidc:\n  owner_claim: groups\n  owner_values: [group-aaa]\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(profiles, "_INITIAL_HERMES_CONFIG_PATH", str(config_path))
    monkeypatch.setattr(auth, "is_auth_enabled", lambda: True)
    with config._yaml_file_cache_lock:
        config._yaml_file_cache.clear()

    cfg = auth_oidc._resolve_oidc_config()
    assert cfg["owner_values"] == ["group-aaa"]
    cookie = auth.create_session(
        auth_type="oidc",
        username="owner",
        oidc_binding=auth_oidc._oidc_profile_binding(cfg, None, owner=True),
    )

    try:
        assert auth.session_can_manage_server(auth.get_session_info(cookie)) is True

        original = config_path.stat()
        replacement = tmp_path / "config.yaml.new"
        replacement.write_text(
            "webui_oidc:\n  owner_claim: groups\n  owner_values: [group-bbb]\n",
            encoding="utf-8",
        )
        assert replacement.stat().st_size == original.st_size, "test setup: sizes must match"
        os.replace(replacement, config_path)
        os.utime(config_path, ns=(original.st_atime_ns, original.st_mtime_ns))
        assert config_path.stat().st_mtime_ns == original.st_mtime_ns, (
            "test setup: the replace must be invisible to a (mtime_ns, size) key"
        )

        assert auth_oidc._resolve_oidc_config()["owner_values"] == ["group-bbb"], (
            "the replaced owner policy was served from the stale parse cache"
        )
        assert auth.session_can_manage_server(auth.get_session_info(cookie)) is False, (
            "a session minted under the old owner group kept owner authority"
        )
    finally:
        auth.invalidate_session(cookie)


def test_profile_dotenv_cannot_supply_an_interpolated_login_allowlist(monkeypatch, tmp_path):
    """The same protection covers the settings that predate the owner policy."""
    import api.auth_oidc as auth_oidc
    import api.profiles as profiles

    _configure(monkeypatch, owner_claim=None, owner_values=None)
    monkeypatch.delenv("HERMES_WEBUI_OIDC_ALLOW_VALUES", raising=False)
    monkeypatch.delenv("HERMES_WEBUI_OIDC_ALLOW_CLAIM", raising=False)
    monkeypatch.setattr(auth_oidc, "_load_operator_config", _REAL_LOAD_OPERATOR_CONFIG)
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        "webui_oidc:\n"
        "  allow_claim: email\n"
        '  allow_values: ["${OIDC_ALLOWED}"]\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(profiles, "_INITIAL_HERMES_CONFIG_PATH", str(config_path))
    monkeypatch.delenv("OIDC_ALLOWED", raising=False)

    profile_home = tmp_path / "profile"
    profile_home.mkdir()
    (profile_home / ".env").write_text("OIDC_ALLOWED=attacker@example.com\n", encoding="utf-8")
    profiles._reload_dotenv(profile_home)
    try:
        # The profile value is ignored and the unresolved reference is not a
        # value either, so the allowlist admits nobody.
        assert auth_oidc._resolve_oidc_config()["allow_values"] == []
    finally:
        profiles._reload_dotenv(tmp_path)


def test_startup_warning_explains_a_non_mapping_oidc_section(monkeypatch, tmp_path):
    import api.auth as auth
    import api.auth_oidc as auth_oidc
    import api.profiles as profiles

    _configure(monkeypatch, owner_claim=None, owner_values=None)
    monkeypatch.setattr(auth_oidc, "_load_operator_config", _REAL_LOAD_OPERATOR_CONFIG)
    config_path = tmp_path / "config.yaml"
    config_path.write_text("webui_oidc: []\n", encoding="utf-8")
    monkeypatch.setattr(profiles, "_INITIAL_HERMES_CONFIG_PATH", str(config_path))

    warning = auth.get_oidc_startup_warning() or ""

    assert "must be a mapping" in warning
    assert "owner operations are denied" in warning


def test_profile_dotenv_cannot_grant_itself_the_owner_policy(monkeypatch, tmp_path):
    """A contained profile must not be able to name itself the owner group."""
    import api.profiles as profiles

    monkeypatch.setenv("HERMES_WEBUI_OIDC_OWNER_CLAIM", "groups")
    monkeypatch.setenv("HERMES_WEBUI_OIDC_OWNER_VALUES", OWNER_GROUP)
    (tmp_path / ".env").write_text(
        "HERMES_WEBUI_OIDC_OWNER_CLAIM=email\n"
        "HERMES_WEBUI_OIDC_OWNER_VALUES=attacker@example.com\n",
        encoding="utf-8",
    )

    profiles._reload_dotenv(tmp_path)
    runtime_env = profiles.get_profile_runtime_env(tmp_path)

    assert os.environ["HERMES_WEBUI_OIDC_OWNER_CLAIM"] == "groups"
    assert os.environ["HERMES_WEBUI_OIDC_OWNER_VALUES"] == OWNER_GROUP
    assert "HERMES_WEBUI_OIDC_OWNER_CLAIM" not in runtime_env
    assert "HERMES_WEBUI_OIDC_OWNER_VALUES" not in runtime_env


def test_startup_warning_explains_an_unresolved_operator_config(monkeypatch, tmp_path):
    """A denied-owner state must be diagnosable, not a silent lockout."""
    import api.auth as auth
    import api.auth_oidc as auth_oidc
    import api.profiles as profiles

    _configure(monkeypatch, owner_claim=None, owner_values=None)
    monkeypatch.setattr(auth_oidc, "_load_operator_config", _REAL_LOAD_OPERATOR_CONFIG)
    config_path = tmp_path / "config.yaml"
    config_path.write_text("webui_oidc: [this is: not, a mapping\n", encoding="utf-8")
    monkeypatch.setattr(profiles, "_INITIAL_HERMES_CONFIG_PATH", str(config_path))

    warning = auth.get_oidc_startup_warning() or ""

    assert "could not be parsed" in warning
    assert "owner operations are denied" in warning


def test_removing_the_policy_does_not_re_elevate_a_policy_era_session(monkeypatch):
    """A session minted under the policy carries a fingerprint naming it."""
    import api.auth as auth

    private_key, token = _configure(monkeypatch)
    cookie = _session(monkeypatch, _login(monkeypatch, private_key, token, {
        "email": "user@example.com", "groups": ["users"],
    }))

    try:
        assert auth.session_can_manage_server(auth.get_session_info(cookie)) is False
        monkeypatch.delenv("HERMES_WEBUI_OIDC_OWNER_CLAIM")
        monkeypatch.delenv("HERMES_WEBUI_OIDC_OWNER_VALUES")

        assert auth.session_can_manage_server(auth.get_session_info(cookie)) is False
    finally:
        auth.invalidate_session(cookie)


def test_environment_overrides_config_file_owner_policy(monkeypatch):
    import api.auth_oidc as auth_oidc

    monkeypatch.setattr(auth_oidc, "_load_operator_config", lambda: {
        "webui_oidc": {"owner_claim": "file-claim", "owner_values": ["file-group"]}
    })
    monkeypatch.setenv("HERMES_WEBUI_OIDC_OWNER_CLAIM", "env-claim")
    monkeypatch.setenv("HERMES_WEBUI_OIDC_OWNER_VALUES", "env-group")

    cfg = auth_oidc._resolve_oidc_config()

    assert cfg["owner_claim"] == "env-claim"
    assert cfg["owner_values"] == ["env-group"]


def test_config_file_owner_policy_is_read_when_env_is_unset(monkeypatch):
    import api.auth_oidc as auth_oidc

    monkeypatch.setattr(auth_oidc, "_load_operator_config", lambda: {
        "webui_oidc": {"owner_claim": "groups", "owner_values": [OWNER_GROUP]}
    })

    cfg = auth_oidc._resolve_oidc_config()

    assert cfg["owner_policy_configured"] is True
    assert (cfg["owner_claim"], cfg["owner_values"]) == ("groups", [OWNER_GROUP])


def test_startup_warning_reports_a_broken_owner_policy(monkeypatch):
    import api.auth as auth
    import api.auth_oidc as auth_oidc

    monkeypatch.setattr(auth_oidc, "_load_operator_config", lambda: {
        "webui_oidc": {
            "issuer": ISSUER,
            "client_id": CLIENT_ID,
            "allow_claim": "email",
            "allow_values": ["user@example.com"],
            "owner_claim": "groups",
        }
    })

    assert auth_oidc._OWNER_POLICY_ERROR in (auth.get_oidc_startup_warning() or "")


# ── claim matching ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "claims, expected",
    [
        ({"groups": OWNER_GROUP}, True),
        ({"groups": ["users", OWNER_GROUP]}, True),
        ({"groups": ["users"]}, False),
        ({"groups": "WebUI-Owners"}, False),          # case-sensitive
        ({"groups": f"{OWNER_GROUP}-readonly"}, False),  # no substring match
        ({"groups": "webui-owner"}, False),
        ({}, False),                                   # missing claim
        ({"groups": None}, False),
        ({"groups": []}, False),
        ({"groups": ""}, False),
        ({"groups": True}, False),
        ({"groups": 1}, False),
        ({"groups": {"name": OWNER_GROUP}}, False),
        ({"groups": [OWNER_GROUP, 7]}, False),         # mixed array fails closed
    ],
)
def test_owner_claim_matching_is_exact_and_fails_closed(claims, expected):
    import api.auth_oidc as auth_oidc

    cfg = {
        "owner_policy_configured": True,
        "owner_claim": "groups",
        "owner_values": [OWNER_GROUP],
    }
    assert auth_oidc._resolve_owner_permission(cfg, claims) is expected


def test_owner_claim_supports_a_dotted_path():
    import api.auth_oidc as auth_oidc

    cfg = {
        "owner_policy_configured": True,
        "owner_claim": "realm_access.roles",
        "owner_values": [OWNER_GROUP],
    }
    assert auth_oidc._resolve_owner_permission(
        cfg, {"realm_access": {"roles": [OWNER_GROUP]}}
    ) is True
    assert auth_oidc._resolve_owner_permission(cfg, {"realm_access": {}}) is False


def test_unconfigured_policy_never_resolves_owner_permission():
    import api.auth_oidc as auth_oidc

    assert auth_oidc._resolve_owner_permission(
        {"owner_policy_configured": False, "owner_claim": "groups", "owner_values": []},
        {"groups": [OWNER_GROUP]},
    ) is False


# ── login produces (or withholds) owner evidence ─────────────────────────────


def test_matching_identity_receives_owner_evidence(monkeypatch):
    private_key, token = _configure(monkeypatch)

    result = _login(monkeypatch, private_key, token, {
        "email": "owner@example.com", "groups": ["users", OWNER_GROUP],
    })

    binding = result["oidc_binding"]
    assert binding["owner"] is True
    assert "owner_expiry" not in binding
    assert result["bound_profile"] is None


def test_admitted_nonmatching_identity_receives_no_owner_evidence(monkeypatch):
    private_key, token = _configure(monkeypatch)

    result = _login(monkeypatch, private_key, token, {
        "email": "user@example.com", "groups": ["users"],
    })

    assert "owner" not in result["oidc_binding"]


@pytest.mark.parametrize(
    "overrides, sign_with_other_key, tamper",
    [
        ({"iss": "https://evil.example"}, False, False),
        ({"aud": "other-client"}, False, False),
        ({"nonce": "not-the-nonce"}, False, False),
        ({}, True, False),
        ({}, False, True),
    ],
)
def test_invalid_id_tokens_never_elevate(monkeypatch, overrides, sign_with_other_key, tamper):
    import api.auth_oidc as auth_oidc

    private_key, token = _configure(monkeypatch)
    other_key = ec.generate_private_key(ec.SECP256R1()) if sign_with_other_key else None

    with pytest.raises(auth_oidc.OIDCAuthError):
        _login(
            monkeypatch, private_key, token,
            {"email": "owner@example.com", "groups": [OWNER_GROUP], **overrides},
            sign_key=other_key,
            tamper=tamper,
        )


def test_failed_login_admission_never_elevates(monkeypatch):
    import api.auth_oidc as auth_oidc

    private_key, token = _configure(monkeypatch)

    with pytest.raises(auth_oidc.OIDCAuthError, match="not allowed"):
        _login(monkeypatch, private_key, token, {
            "email": "stranger@example.com", "groups": [OWNER_GROUP],
        })


def test_profile_mapping_stays_mandatory_for_a_matching_owner(monkeypatch):
    import api.auth_oidc as auth_oidc

    private_key, token = _configure(
        monkeypatch, profile_map={"user@example.com": "default"}
    )

    with pytest.raises(auth_oidc.OIDCAuthError, match="not assigned to a profile"):
        _login(monkeypatch, private_key, token, {
            "email": "owner@example.com", "groups": [OWNER_GROUP],
        })


def test_owner_permission_does_not_clear_profile_binding(monkeypatch):
    private_key, token = _configure(
        monkeypatch, profile_map={"owner@example.com": "default"}
    )

    result = _login(monkeypatch, private_key, token, {
        "email": "owner@example.com", "groups": [OWNER_GROUP],
    })

    assert result["bound_profile"] == "default"
    assert result["oidc_binding"]["owner"] is True
    assert result["oidc_binding"]["profile_identity"]


# ── route authorization and /api/auth/status agree ───────────────────────────


def _session(monkeypatch, result):
    """Mint the session a real OIDC callback would mint for *result*."""
    import api.auth as auth

    monkeypatch.setattr(auth, "is_auth_enabled", lambda: True)
    return auth.create_session(
        auth_type="oidc",
        username="oidc-user",
        bound_profile=result.get("bound_profile"),
        oidc_binding=result.get("oidc_binding"),
    )


def _status(monkeypatch, cookie):
    import api.auth as auth
    import api.passkeys as passkeys
    import api.routes as routes

    monkeypatch.setattr(auth, "_passkey_feature_flag_enabled", lambda: False)
    monkeypatch.setattr(auth, "get_password_hash", lambda: None)
    monkeypatch.setattr(passkeys, "registered_credentials", lambda: [])
    handler = RouteFakeHandler(cookie)
    routes.handle_get(handler, SimpleNamespace(path="/api/auth/status", query=""))
    return handler.json_body()


def _operator_guard(cookie, path="/api/updates/apply"):
    import api.auth as auth

    handler = RouteFakeHandler(cookie)
    allowed = auth.check_auth(handler, SimpleNamespace(path=path, query=""))
    return allowed, handler


@pytest.mark.parametrize("profile_map", [None, {"owner@example.com": "default"}])
def test_elevated_session_passes_the_owner_guard_and_status_agrees(monkeypatch, profile_map):
    import api.auth as auth

    private_key, token = _configure(monkeypatch, profile_map=profile_map)
    result = _login(monkeypatch, private_key, token, {
        "email": "owner@example.com", "groups": [OWNER_GROUP],
    })
    cookie = _session(monkeypatch, result)

    try:
        assert _status(monkeypatch, cookie)["can_manage_server"] is True
        allowed, handler = _operator_guard(cookie)
        assert (allowed, handler.status) == (True, None)
    finally:
        auth.invalidate_session(cookie)


def test_ordinary_admitted_session_is_denied_and_status_agrees(monkeypatch):
    import api.auth as auth

    private_key, token = _configure(monkeypatch)
    result = _login(monkeypatch, private_key, token, {
        "email": "user@example.com", "groups": ["users"],
    })
    cookie = _session(monkeypatch, result)

    try:
        assert _status(monkeypatch, cookie)["can_manage_server"] is False
        for path in ("/api/updates/apply", "/api/profile/create", "/api/auth/passkeys"):
            allowed, handler = _operator_guard(cookie, path)
            assert allowed is False
            assert handler.status == 403
    finally:
        auth.invalidate_session(cookie)


def test_legacy_oidc_session_cannot_inherit_owner_permission(monkeypatch):
    """An unbound session minted before the policy existed carries no evidence."""
    import api.auth as auth

    _configure(monkeypatch)
    monkeypatch.setattr(auth, "is_auth_enabled", lambda: True)
    cookie = auth.create_session(auth_type="oidc", username="legacy@example.com")

    try:
        assert _status(monkeypatch, cookie)["can_manage_server"] is False
        allowed, handler = _operator_guard(cookie)
        assert (allowed, handler.status) == (False, 403)
    finally:
        auth.invalidate_session(cookie)


def test_unbound_oidc_session_is_the_owner_when_no_policy_is_configured(monkeypatch):
    """Legacy behaviour is preserved while owner_claim/owner_values are unset."""
    import api.auth as auth

    _configure(monkeypatch, owner_claim=None, owner_values=None)
    monkeypatch.setattr(auth, "is_auth_enabled", lambda: True)
    cookie = auth.create_session(auth_type="oidc", username="legacy@example.com")

    try:
        assert _status(monkeypatch, cookie)["can_manage_server"] is True
        allowed, _handler = _operator_guard(cookie)
        assert allowed is True
    finally:
        auth.invalidate_session(cookie)


def test_untyped_legacy_session_is_not_an_owner_once_the_policy_is_configured(monkeypatch):
    """A record predating typed logins could be an unbound OIDC session.

    Its provenance is unknowable, so it must not carry owner authority while a
    selective policy is active. One re-login mints a typed session.
    """
    import api.auth as auth

    _configure(monkeypatch)
    monkeypatch.setattr(auth, "is_auth_enabled", lambda: True)
    legacy = auth.create_session()
    typed = auth.create_session(auth_type="password")

    try:
        assert _status(monkeypatch, legacy)["can_manage_server"] is False
        allowed, handler = _operator_guard(legacy)
        assert (allowed, handler.status) == (False, 403)

        assert _status(monkeypatch, typed)["can_manage_server"] is True
        assert _operator_guard(typed)[0] is True
    finally:
        auth.invalidate_session(legacy)
        auth.invalidate_session(typed)


def test_untyped_legacy_session_keeps_owner_access_without_a_policy(monkeypatch):
    import api.auth as auth

    _configure(monkeypatch, owner_claim=None, owner_values=None)
    monkeypatch.setattr(auth, "is_auth_enabled", lambda: True)
    legacy = auth.create_session()

    try:
        assert _status(monkeypatch, legacy)["can_manage_server"] is True
    finally:
        auth.invalidate_session(legacy)


def test_ordinary_unbound_session_is_revoked_when_login_policy_changes(monkeypatch):
    """A fingerprint is reconciled regardless of privilege level."""
    import api.auth as auth

    private_key, token = _configure(monkeypatch)
    cookie = _session(monkeypatch, _login(monkeypatch, private_key, token, {
        "email": "user@example.com", "groups": ["users"],
    }))

    try:
        assert auth.ensure_trusted_auth_session(RouteFakeHandler(cookie)) is not None
        monkeypatch.setenv("HERMES_WEBUI_OIDC_ALLOW_VALUES", "owner@example.com")

        assert auth.ensure_trusted_auth_session(RouteFakeHandler(cookie)) is None
        assert auth.verify_session(cookie) is False
    finally:
        auth.invalidate_session(cookie)


def test_password_session_owner_behaviour_is_unchanged(monkeypatch):
    import api.auth as auth

    _configure(monkeypatch)
    monkeypatch.setattr(auth, "is_auth_enabled", lambda: True)
    cookie = auth.create_session(auth_type="password")

    try:
        assert _status(monkeypatch, cookie)["can_manage_server"] is True
    finally:
        auth.invalidate_session(cookie)


def test_auth_disabled_and_unauthenticated_paths_are_unchanged(monkeypatch):
    import api.auth as auth

    _configure(monkeypatch)
    monkeypatch.setattr(auth, "is_auth_enabled", lambda: True)
    assert _status(monkeypatch, None)["can_manage_server"] is False

    monkeypatch.setattr(auth, "is_auth_enabled", lambda: False)
    assert auth.session_can_manage_server({"auth_type": "oidc", "bound_profile": "alice"}) is True


def test_elevated_owner_is_still_isolated_to_its_bound_profile(monkeypatch):
    import api.auth as auth
    import api.profiles as profiles
    import api.routes as routes

    private_key, token = _configure(
        monkeypatch, profile_map={"owner@example.com": "default"}
    )
    result = _login(monkeypatch, private_key, token, {
        "email": "owner@example.com", "groups": [OWNER_GROUP],
    })
    cookie = _session(monkeypatch, result)

    try:
        info = auth.get_session_info(cookie)
        assert auth.session_can_manage_server(info) is True
        assert info["bound_profile"] == "default"

        # Data-access isolation: another active profile is still refused.
        profiles.set_request_profile("someone-else")
        assert auth.trusted_session_allows_active_profile(info) is False
        profiles.clear_request_profile()

        # Profile-selection isolation: an owner cannot switch away from its binding.
        monkeypatch.setattr(routes, "_check_csrf", lambda _handler: True)
        monkeypatch.setattr(routes, "read_body", lambda _handler: {"name": "someone-else"})
        monkeypatch.setattr(
            "api.profiles.switch_profile",
            lambda *_a, **_kw: pytest.fail("a bound owner must not switch profiles"),
        )
        handler = RouteFakeHandler(cookie)
        handler.command = "POST"
        routes.handle_post(handler, SimpleNamespace(path="/api/profile/switch", query=""))
        assert handler.status == 403
        assert handler.json_body() == {"error": "Profile is bound to the current session"}
    finally:
        profiles.clear_request_profile()
        auth.invalidate_session(cookie)


@pytest.mark.parametrize(
    "path, body",
    [
        ("/api/profile/create", {"name": "victim"}),
        ("/api/auth/passkey/register/options", {}),
        ("/api/settings", {"_set_password": "hunter2hunter2"}),
    ],
)
def test_sibling_owner_guards_follow_the_same_helper(monkeypatch, path, body):
    """Elevated OIDC owners reach owner administration; ordinary users do not."""
    import api.auth as auth
    import api.routes as routes

    private_key, token = _configure(monkeypatch)
    monkeypatch.setattr(routes, "_check_csrf", lambda _handler: True)
    monkeypatch.setattr(routes, "read_body", lambda _handler: dict(body))
    monkeypatch.setattr(auth, "_passkey_feature_flag_enabled", lambda: True)

    ordinary = _session(monkeypatch, _login(monkeypatch, private_key, token, {
        "email": "user@example.com", "groups": ["users"],
    }))
    elevated = _session(monkeypatch, _login(monkeypatch, private_key, token, {
        "email": "owner@example.com", "groups": [OWNER_GROUP],
    }))
    try:
        denied = RouteFakeHandler(ordinary)
        denied.command = "POST"
        routes.handle_post(denied, SimpleNamespace(path=path, query=""))
        assert denied.status == 403
        assert "owner session is required" in denied.json_body()["error"].lower()

        reached = []
        monkeypatch.setattr(
            "api.profiles.create_profile_api",
            lambda *_a, **_kw: reached.append(path) or {"name": "victim"},
        )
        monkeypatch.setattr(
            "api.passkeys.registration_options",
            lambda _handler: reached.append(path) or {"publicKey": {}},
        )
        monkeypatch.setattr(
            routes, "save_settings", lambda *_a, **_kw: reached.append(path) or {},
        )
        allowed = RouteFakeHandler(elevated)
        allowed.command = "POST"
        routes.handle_post(allowed, SimpleNamespace(path=path, query=""))
        assert allowed.status != 403, allowed.wfile.getvalue()
        assert reached == [path], "the elevated owner must reach the real handler"
    finally:
        auth.invalidate_session(ordinary)
        auth.invalidate_session(elevated)


def test_relay_publisher_registration_uses_the_owner_helper(monkeypatch):
    import api.auth as auth
    import api.routes as routes

    private_key, token = _configure(monkeypatch)
    monkeypatch.setattr(routes, "_check_csrf", lambda _handler: True)
    monkeypatch.setattr(routes, "read_body", lambda _handler: {})
    seen = []
    monkeypatch.setattr(
        "api.talaria_relay.pair_talaria_relay",
        lambda _body, *, profile, operator: seen.append((profile, operator)) or {"ok": True},
    )

    for claims, expected_operator in (
        ({"email": "owner@example.com", "groups": [OWNER_GROUP]}, True),
        ({"email": "user@example.com", "groups": ["users"]}, False),
    ):
        cookie = _session(monkeypatch, _login(monkeypatch, private_key, token, claims))
        try:
            handler = RouteFakeHandler(cookie)
            handler.command = "POST"
            routes.handle_post(handler, SimpleNamespace(path="/api/talaria/relay/pair", query=""))
        finally:
            auth.invalidate_session(cookie)
        assert seen[-1][1] is expected_operator


# ── session lifetime and policy revocation ──────────────────────────────────


def _owner_session(monkeypatch):
    private_key, token = _configure(monkeypatch)
    return _session(monkeypatch, _login(monkeypatch, private_key, token, {
        "email": "owner@example.com", "groups": [OWNER_GROUP],
    }))


def test_owner_permission_survives_one_hour_until_session_expiry(monkeypatch):
    import api.auth as auth

    monkeypatch.setenv("HERMES_WEBUI_SESSION_TTL", str(30 * 86400))
    now = time.time()
    monkeypatch.setattr(time, "time", lambda: now)
    cookie = _owner_session(monkeypatch)
    expiry = auth.get_session_info(cookie)["expiry"]

    try:
        for instant in (now + 60, now + 7200, expiry - 1):
            now = instant
            assert auth.session_can_manage_server(auth.get_session_info(cookie)) is True
            assert auth.ensure_trusted_auth_session(RouteFakeHandler(cookie)) is not None
            assert _operator_guard(cookie)[0] is True
            assert _status(monkeypatch, cookie)["can_manage_server"] is True
        now = expiry + 1
        assert auth.ensure_trusted_auth_session(RouteFakeHandler(cookie)) is None
        assert auth.session_can_manage_server(auth.get_session_info(cookie)) is False
        assert _operator_guard(cookie)[1].status == 401
    finally:
        auth.invalidate_session(cookie)


def test_owner_permission_ends_at_a_shorter_session_expiry(monkeypatch):
    import api.auth as auth

    monkeypatch.setenv("HERMES_WEBUI_SESSION_TTL", "60")
    now = time.time()
    monkeypatch.setattr(time, "time", lambda: now)
    cookie = _owner_session(monkeypatch)

    try:
        assert auth.get_session_info(cookie)["expiry"] == now + 60
        now += 59
        assert _operator_guard(cookie)[0] is True
        now += 2
        assert _operator_guard(cookie)[1].status == 401
        assert auth.session_can_manage_server(auth.get_session_info(cookie)) is False
    finally:
        auth.invalidate_session(cookie)


def test_persisted_reload_keeps_owner_permission_and_drops_obsolete_evidence(monkeypatch):
    import api.auth as auth

    cookie = _owner_session(monkeypatch)
    token = cookie.rsplit(".", 1)[0]
    persisted = json.loads(auth._SESSIONS_FILE.read_text())
    persisted[token]["oidc_owner_expiry"] = time.time() - 3601
    auth._SESSIONS_FILE.write_text(json.dumps(persisted))

    try:
        with auth._SESSIONS_LOCK:
            auth._sessions.clear()
            auth._sessions.update(auth._load_sessions())
        assert auth.verify_session(cookie) is True, "the session itself has not expired"
        assert auth.ensure_trusted_auth_session(RouteFakeHandler(cookie)) is not None
        assert auth.session_can_manage_server(auth.get_session_info(cookie)) is True
        assert _operator_guard(cookie)[0] is True
        auth._persist_sessions()
        rewritten = json.loads(auth._SESSIONS_FILE.read_text())
        expected = dict(persisted[token])
        del expected["oidc_owner_expiry"]
        assert rewritten[token] == expected
    finally:
        auth.invalidate_session(cookie)


def test_logout_ends_owner_permission(monkeypatch):
    import api.auth as auth

    private_key, token = _configure(monkeypatch)
    cookie = _session(monkeypatch, _login(monkeypatch, private_key, token, {
        "email": "owner@example.com", "groups": [OWNER_GROUP],
    }))

    auth.invalidate_session(cookie)

    assert auth.get_session_info(cookie) is None
    assert auth.session_can_manage_server(None) is False


def test_owner_policy_change_invalidates_existing_evidence(monkeypatch):
    import api.auth as auth

    private_key, token = _configure(monkeypatch)
    cookie = _session(monkeypatch, _login(monkeypatch, private_key, token, {
        "email": "owner@example.com", "groups": [OWNER_GROUP],
    }))

    try:
        assert auth.ensure_trusted_auth_session(RouteFakeHandler(cookie)) is not None
        monkeypatch.setenv("HERMES_WEBUI_OIDC_OWNER_VALUES", "some-other-group")

        assert auth.session_can_manage_server(auth.get_session_info(cookie)) is False
        assert auth.ensure_trusted_auth_session(RouteFakeHandler(cookie)) is None
        assert auth.verify_session(cookie) is False
    finally:
        auth.invalidate_session(cookie)


def test_fresh_login_after_group_removal_drops_owner_permission(monkeypatch):
    import api.auth as auth

    private_key, token = _configure(monkeypatch)
    elevated = _session(monkeypatch, _login(monkeypatch, private_key, token, {
        "email": "owner@example.com", "groups": [OWNER_GROUP],
    }))
    auth.invalidate_session(elevated)

    # The IdP stops issuing the group; the next login carries no evidence.
    demoted = _session(monkeypatch, _login(monkeypatch, private_key, token, {
        "email": "owner@example.com", "groups": ["users"],
    }))
    try:
        assert auth.session_can_manage_server(auth.get_session_info(demoted)) is False
    finally:
        auth.invalidate_session(demoted)


# ── native handoff ───────────────────────────────────────────────────────────


def _native_handoff(monkeypatch, routes, claims):
    """Run start → browser callback → app callback and return the app URL."""
    import api.auth_oidc as auth_oidc

    verifier, challenge = _pkce()
    body = json.dumps({
        "callback_url": "talaria://oidc-callback",
        "state": "native-state-1234567890",
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }).encode()
    start_handler = RouteFakeHandler()
    start_handler.rfile = io.BytesIO(body)
    start_handler.headers["Content-Length"] = str(len(body))
    routes.handle_post(start_handler, SimpleNamespace(path="/api/auth/oidc/native/start"))
    assert start_handler.status == 200, start_handler.wfile.getvalue()
    start = start_handler.json_body()

    browser = RouteFakeHandler()
    routes.handle_get(browser, urlparse(start["authorization_url"]))
    provider = parse_qs(urlparse(browser.header_values("Location")[0]).query)

    payload = {
        "iss": ISSUER,
        "aud": CLIENT_ID,
        "iat": time.time(),
        "exp": time.time() + 300,
        "nonce": provider["nonce"][0],
        "sub": "synthetic-user",
        **claims,
    }
    monkeypatch.setattr(
        auth_oidc, "_post_form_json",
        lambda *_a, **_kw: {"id_token": _sign(auth_oidc, _native_handoff.key, payload)},
    )
    callback = RouteFakeHandler()
    routes.handle_get(callback, SimpleNamespace(
        path="/api/auth/oidc/callback",
        query=f"state={provider['state'][0]}&code=synthetic-code",
    ))
    assert callback.status == 302
    return start, verifier, callback.header_values("Location")[0]


def _pkce():
    import hashlib
    import api.auth_oidc as auth_oidc

    verifier = auth_oidc._b64u(hashlib.sha256(b"hweb71-native").digest())
    challenge = auth_oidc._b64u(hashlib.sha256(verifier.encode()).digest())
    return verifier, challenge


def _exchange(routes, start, verifier):
    body = json.dumps({
        "flow_id": start["flow_id"],
        "code": start["code"],
        "state": "native-state-1234567890",
        "code_verifier": verifier,
    }).encode()
    handler = RouteFakeHandler()
    handler.rfile = io.BytesIO(body)
    handler.headers["Content-Length"] = str(len(body))
    routes.handle_post(handler, SimpleNamespace(path="/api/auth/oidc/native/exchange"))
    return handler


def test_native_exchange_carries_owner_evidence_without_leaking_claims(monkeypatch):
    import api.auth as auth
    import api.routes as routes

    monkeypatch.setenv("HERMES_WEBUI_SECURE", "1")
    _native_handoff.key, _ = _configure(monkeypatch)
    start, verifier, app_url = _native_handoff(monkeypatch, routes, {
        "email": "owner@example.com", "groups": [OWNER_GROUP],
    })
    handoff = parse_qs(urlparse(app_url).query)
    assert set(handoff) == {"code", "state", "flow_id", "server_id"}
    assert OWNER_GROUP not in app_url

    monkeypatch.setattr(auth, "is_auth_enabled", lambda: True)
    handler = _exchange(routes, {**start, "code": handoff["code"][0]}, verifier)
    assert handler.status == 200
    cookie = handler.header_values("Set-Cookie")[0].split(";", 1)[0].split("=", 1)[1]
    try:
        info = auth.get_session_info(cookie)
        assert info["oidc_owner"] is True
        assert auth.session_can_manage_server(info) is True
        assert "oidc_owner_expiry" not in info
        later = time.time() + 7200
        monkeypatch.setattr(time, "time", lambda: later)
        assert auth.ensure_trusted_auth_session(RouteFakeHandler(cookie)) is not None
        assert _operator_guard(cookie, "/api/provider/quotas")[0] is True
        assert _status(monkeypatch, cookie)["can_manage_server"] is True
        monkeypatch.setattr(auth, "_passkey_feature_flag_enabled", lambda: True)
        owner_route = RouteFakeHandler(cookie)
        owner_route.command = "POST"
        owner_route.headers[auth.CSRF_HEADER_NAME] = auth.csrf_token_for_session(cookie)
        parsed = SimpleNamespace(path="/api/auth/passkeys", query="")
        assert auth.check_auth(owner_route, parsed) is True
        routes.handle_post(owner_route, parsed)
        assert owner_route.status == 200
        assert owner_route.json_body() == {"credentials": []}
    finally:
        auth.invalidate_session(cookie)


def test_pending_native_exchange_cannot_mint_privilege_after_a_policy_change(monkeypatch):
    import api.auth as auth
    import api.routes as routes

    monkeypatch.setenv("HERMES_WEBUI_SECURE", "1")
    _native_handoff.key, _ = _configure(monkeypatch)
    start, verifier, app_url = _native_handoff(monkeypatch, routes, {
        "email": "owner@example.com", "groups": [OWNER_GROUP],
    })
    handoff = parse_qs(urlparse(app_url).query)

    monkeypatch.setenv("HERMES_WEBUI_OIDC_OWNER_VALUES", "some-other-group")
    monkeypatch.setattr(auth, "is_auth_enabled", lambda: True)
    handler = _exchange(routes, {**start, "code": handoff["code"][0]}, verifier)

    assert handler.status == 401
    assert handler.header_values("Set-Cookie") == []
