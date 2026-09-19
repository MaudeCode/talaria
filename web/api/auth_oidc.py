import copy
import base64
import hashlib
import ipaddress
import json
import logging
import math
import os
import re
import secrets
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa, utils

from api.config import get_config

logger = logging.getLogger(__name__)

_DEFAULT_SCOPES = ("openid", "profile", "email")
_PENDING_TTL_SECONDS = 600
_MAX_PENDING_FLOWS = 128
_CLOCK_SKEW_SECONDS = 60
_CACHE_TTL_SECONDS = 300
_NATIVE_FLOW_TTL_SECONDS = 600
_NATIVE_EXCHANGE_TTL_SECONDS = 60
_NATIVE_CALLBACK_HOST = "oidc-callback"
_NATIVE_CALLBACK_SCHEMES = {"talaria", "talaria-branch"}
_NATIVE_VALUE_RE = re.compile(r"^[A-Za-z0-9._~-]{16,256}$")
_PKCE_CHALLENGE_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")
_PKCE_VERIFIER_RE = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")
_CALLBACK_SCHEME_RE = re.compile(r"^[a-z][a-z0-9+.-]{1,63}$")

_pending_lock = threading.Lock()
_pending_flows: dict[str, dict[str, Any]] = {}
_native_flows: dict[str, dict[str, Any]] = {}
_native_exchange_codes: dict[str, dict[str, Any]] = {}

_discovery_lock = threading.Lock()
_discovery_cache: dict[str, tuple[float, dict[str, Any]]] = {}

_jwks_lock = threading.Lock()
_jwks_cache: dict[str, tuple[float, dict[str, Any]]] = {}

_warned_allow_values: set[str] = set()

_ALLOW_VALUES_WHITESPACE_WARNING = (
    "webui_oidc.allow_values (HERMES_WEBUI_OIDC_ALLOW_VALUES) has one or more entries "
    "with internal whitespace; whitespace is not a value separator, so a value like "
    '"alice@example.com bob@example.com" is treated as a single entry. '
    'Use a comma-delimited scalar (e.g. "value1,value2") or a YAML array. '
    "If this is one intentional multi-word group, it is already correct and no action is needed."
)

_OWNER_POLICY_ERROR = (
    "webui_oidc.owner_claim (HERMES_WEBUI_OIDC_OWNER_CLAIM) and webui_oidc.owner_values "
    "(HERMES_WEBUI_OIDC_OWNER_VALUES) must both be set to a non-empty claim path and a "
    "non-empty list of exact string values. The selective owner policy is active but "
    "matches nothing, so no OIDC identity can perform owner operations."
)

_warned_owner_policy = False

# Distinguishes "the operator did not write this key" from "the operator wrote
# it with no value". YAML resolves the latter to None, which .get() cannot tell
# apart from absence -- and the two must not mean the same thing for a setting
# that gates privilege.
_UNSET = object()

# A ``${VAR}`` that survived expansion was never resolved. In a policy that
# grants privilege it is a configuration error, not a group name an identity
# may be issued.
_UNRESOLVED_PLACEHOLDER_RE = re.compile(r"\${[^}]+}")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class OIDCConfigError(Exception):
    pass


class OIDCAuthError(Exception):
    def __init__(self, message: str, *, status_code: int = 401):
        super().__init__(message)
        self.status_code = status_code


def is_oidc_enabled() -> bool:
    """True when OIDC login is configured for this deployment.

    An unresolved config reports True rather than False. api.auth's global auth
    gate is the OR of the configured methods, so answering "not configured" for
    a config we simply could not read would drop a deployment whose settings
    live in that file into no-auth mode and serve every non-public request
    without a session. Unknown must mean "still gated": login is refused by
    _require_oidc_config, so SSO is unavailable while authentication stays
    required. An operator config that cannot be read leaves the rest of Hermes
    without its settings anyway, so this trades a broken install for a locked
    one rather than an open one.
    """
    cfg = _resolve_oidc_config()
    if cfg.get("config_read_failed"):
        return True
    return bool(
        cfg.get("issuer")
        and cfg.get("client_id")
        and cfg.get("allow_claim")
        and cfg.get("allow_values")
    )


def build_authorization_redirect(
    request_base_url: str,
    next_path: str | None = None,
    native_flow_id: str | None = None,
) -> str:
    cfg = _require_oidc_config()
    discovery = _get_discovery_document(cfg["issuer"])
    authorization_endpoint = str(discovery.get("authorization_endpoint") or "").strip()
    if not authorization_endpoint:
        raise OIDCConfigError("OIDC discovery document is missing authorization_endpoint")
    redirect_uri = _resolve_redirect_uri(cfg, request_base_url)
    state = secrets.token_urlsafe(24)
    nonce = secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(48)
    challenge = _b64u(hashlib.sha256(verifier.encode("ascii")).digest())
    _store_pending_flow(
        state,
        {
            "created_at": time.time(),
            "nonce": nonce,
            "code_verifier": verifier,
            "next_path": _safe_next_path(next_path),
            "native_flow_id": native_flow_id,
        },
        request_base_url=request_base_url if native_flow_id else None,
    )
    params = {
        "response_type": "code",
        "client_id": cfg["client_id"],
        "redirect_uri": redirect_uri,
        "scope": " ".join(cfg["scopes"]),
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    return authorization_endpoint + "?" + urllib.parse.urlencode(params)


def complete_authorization_code_flow(
    request_base_url: str,
    state: str,
    code: str,
) -> dict[str, Any]:
    cfg = _require_oidc_config()
    pending = _consume_pending_flow(state)
    if pending is None:
        raise OIDCAuthError("Invalid OIDC state", status_code=401)
    try:
        discovery = _get_discovery_document(cfg["issuer"])
        discovery_issuer = str(discovery.get("issuer") or "").strip()
        if discovery_issuer and discovery_issuer != cfg["issuer"]:
            raise OIDCAuthError("OIDC discovery issuer did not match the configured issuer", status_code=502)
        token_endpoint = str(discovery.get("token_endpoint") or "").strip()
        if not token_endpoint:
            raise OIDCConfigError("OIDC discovery document is missing token_endpoint")
        redirect_uri = _resolve_redirect_uri(cfg, request_base_url)
        token_response = _post_form_json(
            token_endpoint,
            {
                "grant_type": "authorization_code",
                "client_id": cfg["client_id"],
                "code": code,
                "code_verifier": pending["code_verifier"],
                "redirect_uri": redirect_uri,
                **({"client_secret": cfg["client_secret"]} if cfg.get("client_secret") else {}),
            },
        )
        id_token = str(token_response.get("id_token") or "").strip()
        if not id_token:
            raise OIDCAuthError("OIDC token response did not include an id_token", status_code=502)
        claims = _validate_id_token(
            id_token,
            client_id=cfg["client_id"],
            issuer=cfg["issuer"],
            nonce=pending["nonce"],
            jwks_uri=str(discovery.get("jwks_uri") or "").strip(),
        )
        _enforce_allowlist(
            claims,
            allow_claim=cfg.get("allow_claim"),
            allow_values=cfg.get("allow_values") or [],
        )
        bound_profile = _resolve_bound_profile(cfg, claims)
        oidc_binding = _oidc_profile_binding(
            cfg, bound_profile, owner=_resolve_owner_permission(cfg, claims)
        )
        return {
            "next_path": pending["next_path"],
            "native_flow_id": pending.get("native_flow_id"),
            "subject": str(claims.get("sub") or ""),
            "email": str(claims.get("email") or ""),
            "bound_profile": bound_profile,
            "oidc_binding": oidc_binding,
            "claims": claims,
        }
    except (OIDCAuthError, OIDCConfigError) as exc:
        exc.native_flow_id = pending.get("native_flow_id")
        raise


def begin_native_authorization(
    request_base_url: str,
    callback_url: str,
    client_state: str,
    code_challenge: str,
) -> dict[str, Any]:
    """Create the app-bound half of an OIDC flow without exposing credentials."""
    if not is_oidc_enabled():
        raise OIDCConfigError("Native OIDC login is not configured")
    origin = _normalize_server_origin(request_base_url)
    callback = _validate_native_callback_url(callback_url)
    state = str(client_state or "").strip()
    challenge = str(code_challenge or "").strip()
    if not _NATIVE_VALUE_RE.fullmatch(state):
        raise OIDCAuthError("Invalid native OIDC state", status_code=400)
    if not _PKCE_CHALLENGE_RE.fullmatch(challenge):
        raise OIDCAuthError("Invalid native OIDC PKCE challenge", status_code=400)

    now = time.time()
    flow_id = secrets.token_urlsafe(24)
    server_id = _server_identity(origin)
    with _pending_lock:
        _prune_native_state(now)
        if len(_native_flows) >= _MAX_PENDING_FLOWS:
            raise OIDCAuthError("Too many pending native OIDC flows", status_code=429)
        _native_flows[flow_id] = {
            "created_at": now,
            "callback_url": callback,
            "client_state": state,
            "code_challenge": challenge,
            "server_origin": origin,
            "server_id": server_id,
        }
    authorization_path = "/api/auth/oidc/start?" + urllib.parse.urlencode(
        {"native_flow": flow_id}
    )
    return {
        "flow_id": flow_id,
        "authorization_url": _native_authorization_base_url(origin) + authorization_path,
        "server_id": server_id,
        "expires_in": _NATIVE_FLOW_TTL_SECONDS,
    }


def finish_native_authorization(
    request_base_url: str,
    flow_id: str,
    *,
    subject: str,
    email: str,
    bound_profile: str | None = None,
    oidc_binding: dict[str, str] | None = None,
) -> str:
    """Turn a successful provider login into one short-lived app exchange code."""
    now = time.time()
    with _pending_lock:
        _prune_native_state(now)
        flow = _native_flows.pop(str(flow_id or ""), None)
        if flow is None:
            raise OIDCAuthError("Invalid or expired native OIDC flow", status_code=401)
        if not _constant_time_equal(_normalize_server_origin(request_base_url), flow["server_origin"]):
            raise OIDCAuthError("Native OIDC flow belongs to a different server", status_code=401)
        _trim_state_map(_native_exchange_codes, _MAX_PENDING_FLOWS)
        code = secrets.token_urlsafe(32)
        _native_exchange_codes[code] = {
            "created_at": now,
            "flow_id": flow_id,
            "client_state": flow["client_state"],
            "code_challenge": flow["code_challenge"],
            "server_origin": flow["server_origin"],
            "subject": str(subject or ""),
            "email": str(email or ""),
            "bound_profile": bound_profile,
            "oidc_binding": oidc_binding,
        }

    separator = "&" if urllib.parse.urlsplit(flow["callback_url"]).query else "?"
    return flow["callback_url"] + separator + urllib.parse.urlencode(
        {
            "code": code,
            "state": flow["client_state"],
            "flow_id": flow_id,
            "server_id": flow["server_id"],
        }
    )


def fail_native_authorization(request_base_url: str, flow_id: str, error: str) -> str:
    """Return a sanitized app callback for a failed provider flow."""
    now = time.time()
    with _pending_lock:
        _prune_native_state(now)
        flow = _native_flows.pop(str(flow_id or ""), None)
    if flow is None:
        raise OIDCAuthError("Invalid or expired native OIDC flow", status_code=401)
    if not _constant_time_equal(_normalize_server_origin(request_base_url), flow["server_origin"]):
        raise OIDCAuthError("Native OIDC flow belongs to a different server", status_code=401)
    separator = "&" if urllib.parse.urlsplit(flow["callback_url"]).query else "?"
    return flow["callback_url"] + separator + urllib.parse.urlencode(
        {
            "error": str(error or "authentication_failed"),
            "state": flow["client_state"],
            "flow_id": flow_id,
            "server_id": flow["server_id"],
        }
    )


def consume_failed_provider_authorization(state: str) -> str | None:
    """Consume a provider-declined flow and return its native owner, if any."""
    pending = _consume_pending_flow(str(state or ""))
    if pending is None:
        return None
    return str(pending.get("native_flow_id") or "").strip() or None


def exchange_native_authorization(
    request_base_url: str,
    flow_id: str,
    code: str,
    client_state: str,
    code_verifier: str,
) -> dict[str, Any]:
    """Consume a native exchange code and return the server-side session identity."""
    now = time.time()
    with _pending_lock:
        _prune_native_state(now)
        exchange = _native_exchange_codes.pop(str(code or ""), None)
    if exchange is None:
        raise OIDCAuthError("Invalid or expired native OIDC exchange code", status_code=401)
    if not _constant_time_equal(_normalize_server_origin(request_base_url), exchange["server_origin"]):
        raise OIDCAuthError("Native OIDC exchange code belongs to a different server", status_code=401)
    if not _constant_time_equal(str(flow_id or ""), exchange["flow_id"]):
        raise OIDCAuthError("Native OIDC flow did not match", status_code=401)
    if not _constant_time_equal(str(client_state or ""), exchange["client_state"]):
        raise OIDCAuthError("Native OIDC state did not match", status_code=401)
    verifier = str(code_verifier or "")
    if not _PKCE_VERIFIER_RE.fullmatch(verifier):
        raise OIDCAuthError("Native OIDC PKCE verifier did not match", status_code=401)
    challenge = _b64u(hashlib.sha256(verifier.encode("ascii")).digest())
    if not _constant_time_equal(challenge, exchange["code_challenge"]):
        raise OIDCAuthError("Native OIDC PKCE verifier did not match", status_code=401)
    # A policy edit between the browser login and this exchange must not mint a
    # session -- least of all an elevated one -- from pre-change evidence.
    if not _oidc_binding_is_current(exchange.get("oidc_binding"), exchange.get("bound_profile")):
        raise OIDCAuthError("OIDC policy changed; sign in again", status_code=401)
    result = {
        "subject": exchange["subject"],
        "email": exchange["email"],
        "bound_profile": exchange.get("bound_profile"),
    }
    if exchange.get("oidc_binding"):
        result["oidc_binding"] = exchange["oidc_binding"]
    return result


def cancel_native_authorization(flow_id: str, client_state: str) -> bool:
    """Invalidate every pending phase owned by one app flow."""
    flow_id = str(flow_id or "")
    state = str(client_state or "")
    if not _NATIVE_VALUE_RE.fullmatch(flow_id) or not _NATIVE_VALUE_RE.fullmatch(state):
        return False
    with _pending_lock:
        flow = _native_flows.get(flow_id)
        if flow is not None and not _constant_time_equal(state, flow["client_state"]):
            return False
        matching_exchanges = [
            (code, exchange)
            for code, exchange in _native_exchange_codes.items()
            if _constant_time_equal(str(exchange.get("flow_id") or ""), flow_id)
        ]
        if any(
            not _constant_time_equal(state, str(exchange.get("client_state") or ""))
            for _, exchange in matching_exchanges
        ):
            return False
        removed = _native_flows.pop(flow_id, None) is not None
        for code, _ in matching_exchanges:
            _native_exchange_codes.pop(code, None)
            removed = True
        for provider_state, pending in list(_pending_flows.items()):
            native_flow_id = str(pending.get("native_flow_id") or "")
            if native_flow_id and _constant_time_equal(native_flow_id, flow_id):
                _pending_flows.pop(provider_state, None)
                removed = True
    return removed


def _validate_native_callback_url(raw_url: str) -> str:
    value = str(raw_url or "").strip()
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise OIDCAuthError("Invalid native OIDC callback URL", status_code=400) from exc
    scheme = parsed.scheme.lower()
    if (
        not _CALLBACK_SCHEME_RE.fullmatch(scheme)
        or scheme not in _NATIVE_CALLBACK_SCHEMES
        or parsed.hostname != _NATIVE_CALLBACK_HOST
        or parsed.username is not None
        or parsed.password is not None
        or port is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise OIDCAuthError("Invalid native OIDC callback URL", status_code=400)
    return urllib.parse.urlunsplit((scheme, parsed.netloc.lower(), "", "", ""))


def _normalize_server_origin(raw_url: str) -> str:
    value = str(raw_url or "").strip()
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise OIDCAuthError("Invalid native OIDC server identity", status_code=400) from exc
    scheme = parsed.scheme.lower()
    if (
        scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise OIDCAuthError("Invalid native OIDC server identity", status_code=400)
    host = parsed.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    default_port = (scheme == "https" and port == 443) or (scheme == "http" and port == 80)
    return f"{scheme}://{host}{'' if port is None or default_port else f':{port}'}"


def _native_authorization_base_url(origin: str) -> str:
    """Preserve a configured public proxy prefix for the browser start URL."""
    redirect_uri = str(_resolve_oidc_config().get("redirect_uri") or "").strip()
    if not redirect_uri:
        return origin
    try:
        parsed = urllib.parse.urlsplit(redirect_uri)
    except ValueError:
        return origin
    callback_path = "/api/auth/oidc/callback"
    if parsed.query or parsed.fragment or not parsed.path.endswith(callback_path):
        return origin
    redirect_origin = _normalize_server_origin(
        urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
    )
    if not _constant_time_equal(redirect_origin, origin):
        return origin
    prefix = parsed.path[: -len(callback_path)].rstrip("/")
    decoded_prefix = urllib.parse.unquote(prefix)
    if (
        not prefix
        or "\\" in decoded_prefix
        or any(segment in {".", ".."} for segment in decoded_prefix.split("/"))
        or any(ord(char) < 32 or ord(char) == 127 or char.isspace() for char in decoded_prefix)
    ):
        return origin
    return origin + prefix


def _server_identity(origin: str) -> str:
    return _b64u(hashlib.sha256(origin.encode("utf-8")).digest())


def _constant_time_equal(left: str, right: str) -> bool:
    return secrets.compare_digest(str(left).encode("utf-8"), str(right).encode("utf-8"))


def _prune_native_state(now: float) -> None:
    for flow_id, flow in list(_native_flows.items()):
        if now - float(flow.get("created_at") or 0) > _NATIVE_FLOW_TTL_SECONDS:
            _native_flows.pop(flow_id, None)
    for code, exchange in list(_native_exchange_codes.items()):
        if now - float(exchange.get("created_at") or 0) > _NATIVE_EXCHANGE_TTL_SECONDS:
            _native_exchange_codes.pop(code, None)


def _trim_state_map(values: dict[str, dict[str, Any]], maximum: int) -> None:
    overflow = len(values) - maximum + 1
    if overflow <= 0:
        return
    oldest = sorted(values, key=lambda key: float(values[key].get("created_at") or 0))
    for key in oldest[:overflow]:
        values.pop(key, None)


def _load_operator_config() -> dict[str, Any]:
    try:
        from api.config import _load_yaml_config_file_raw
        from api.profiles import _INITIAL_HERMES_CONFIG_PATH, get_hermes_home_for_profile
    except ImportError:
        return get_config()

    configured_path = str(_INITIAL_HERMES_CONFIG_PATH or "").strip()
    path = Path(configured_path).expanduser() if configured_path else get_hermes_home_for_profile("default") / "config.yaml"
    # Expand this file ourselves rather than through _load_yaml_config_file:
    # its placeholders must resolve against the operator environment, not the
    # one a profile .env has written into. The raw parse stays memoized.
    raw_config = _load_yaml_config_file_raw(path, _copy=False)
    if raw_config and not os.access(path, os.R_OK):
        # api.config memoizes on (mtime, size), so a permission change alone
        # keeps serving the cached parse without reopening the file. A snapshot
        # we can no longer read is unverified, and unverified is not authority.
        raise OIDCConfigError(f"Operator config at {path} could not be read")
    loaded = _expand_operator_env(raw_config) if raw_config else {}
    if isinstance(loaded, dict) and loaded:
        return loaded
    # api.config's loader flattens missing, empty, unreadable, and malformed
    # files into {}. A caller that gates privilege on this config must not read
    # "unknown" as "nothing configured", so resolve it once more, and return
    # what that read saw rather than the empty result it supersedes.
    return _reresolve_operator_config(path)


def _reresolve_operator_config(path: Path) -> dict[str, Any]:
    """Resolve the operator config from one read, raising on a real failure.

    This is the authoritative outcome for the empty case: the dict returned and
    the success/failure decision come from the same read, so a file repaired or
    broken between two reads cannot leave the caller with data from one and a
    verdict from the other. An empty document, an explicit ``{}``, and a
    comments-only file are all legitimately "nothing configured".
    """
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except OSError as exc:
        raise OIDCConfigError(f"Operator config at {path} could not be read") from exc
    try:
        import yaml as _yaml
    except ImportError:
        return {}
    try:
        parsed = _yaml.safe_load(text)
    except Exception as exc:
        raise OIDCConfigError(f"Operator config at {path} could not be parsed") from exc
    if parsed is None:
        return {}
    if not isinstance(parsed, dict):
        raise OIDCConfigError(f"Operator config at {path} is not a mapping")
    expanded = _expand_operator_env(parsed)
    return expanded if isinstance(expanded, dict) else {}


def _expand_operator_env(obj: Any) -> Any:
    """Expand ``${VAR}`` in the operator config against the operator environment.

    api.config's expansion resolves placeholders thread-local-first and then
    from the live process environment, which ``_reload_dotenv`` writes a
    profile's own ``.env`` into. That is correct for a profile's config and
    wrong for this one: the operator config decides authentication policy, so a
    contained profile must not get to supply the value behind
    ``owner_values: ["${GROUP}"]``. Protecting the two setting names is not
    enough, because the indirection can name any variable.
    """
    if isinstance(obj, str):
        return re.sub(
            r"\${([^}]+)}",
            lambda m: _operator_env_value(m.group(1), m.group(0)),
            obj,
        )
    if isinstance(obj, dict):
        return {key: _expand_operator_env(value) for key, value in obj.items()}
    if isinstance(obj, list):
        return [_expand_operator_env(item) for item in obj]
    return obj


def _operator_env_value(name: str, placeholder: str) -> str:
    """Resolve one placeholder, ignoring anything a profile .env supplied.

    An unresolvable reference stays literal, so it matches no claim value and
    no profile rather than silently becoming an empty string.
    """
    env_name = str(name or "").strip()
    if not env_name:
        return placeholder
    try:
        from api import profiles

        # The startup snapshot owns any name the operator set, whichever
        # profile is active now: _reload_dotenv both overwrites a shadowed
        # value and pops it again on the next switch, so the live environment
        # is not a reliable source for this file.
        startup = getattr(profiles, "_INITIAL_PROCESS_ENV", None) or {}
        if env_name in startup:
            return str(startup[env_name])
        if env_name in (getattr(profiles, "_loaded_profile_env_keys", None) or set()):
            logger.warning(
                "Ignoring profile-supplied %s while expanding the operator config; "
                "operator authentication policy is not profile-controlled",
                env_name,
            )
            return placeholder
    except Exception:
        logger.debug("Failed to inspect profile-supplied env keys", exc_info=True)
        return placeholder
    return os.environ.get(env_name, placeholder)


def _resolve_oidc_config() -> dict[str, Any]:
    raw = {}
    config_read_failed = False
    try:
        cfg = _load_operator_config()
        value = cfg.get("webui_oidc") if isinstance(cfg, dict) else None
        if isinstance(value, dict):
            raw.update(value)
        elif value is not None:
            # The section parsed but is not a mapping (``webui_oidc: []``, or a
            # scalar). Silently discarding it would present a policy the
            # operator did write as one they never wrote.
            raise OIDCConfigError("webui_oidc must be a mapping")
    except Exception:
        # An unreadable config is "unknown", not "unset". Callers that gate
        # privilege on the resolved policy must be able to tell them apart.
        config_read_failed = True
        logger.debug("Failed to read webui_oidc config", exc_info=True)

    def pick(name: str, env_name: str) -> Any:
        env_value = os.getenv(env_name)
        return env_value if env_value is not None else raw.get(name)

    scopes = _normalize_scopes(pick("scopes", "HERMES_WEBUI_OIDC_SCOPES"))
    raw_allow = pick("allow_values", "HERMES_WEBUI_OIDC_ALLOW_VALUES")
    allow_values = _normalize_allow_values(raw_allow)
    trusted_private_hosts = _normalize_trusted_private_hosts(
        pick("trusted_private_hosts", "HERMES_WEBUI_OIDC_TRUSTED_PRIVATE_HOSTS")
    )
    profile_map, profile_map_error, profile_map_configured = _normalize_profile_map(
        pick("profile_map", "HERMES_WEBUI_OIDC_PROFILE_MAP")
    )
    owner_claim, owner_values, owner_policy_error, owner_policy_configured = _normalize_owner_policy(
        _pick_owner_setting(raw, "owner_claim", "HERMES_WEBUI_OIDC_OWNER_CLAIM"),
        _pick_owner_setting(raw, "owner_values", "HERMES_WEBUI_OIDC_OWNER_VALUES"),
    )
    raw_profile_claim = str(pick("profile_claim", "HERMES_WEBUI_OIDC_PROFILE_CLAIM") or "sub").strip()
    profile_claim = _reject_unresolved(raw_profile_claim)
    if not profile_claim:
        # Falling through to the "sub" default would bind identities through a
        # claim path the operator did not configure.
        profile_map_error = profile_map_error or (
            "webui_oidc.profile_claim could not be resolved; it still contains an "
            "unexpanded ${...} reference"
        )
    if owner_policy_error:
        global _warned_owner_policy
        if not _warned_owner_policy:
            _warned_owner_policy = True
            logger.warning(owner_policy_error)
    if (
        raw_allow is not None
        and not isinstance(raw_allow, (list, tuple, set))
        and any(any(ch.isspace() for ch in v) for v in allow_values)
    ):
        key = str(raw_allow)
        if key not in _warned_allow_values:
            _warned_allow_values.add(key)
            logger.warning(_ALLOW_VALUES_WHITESPACE_WARNING)
    return {
        "issuer": str(pick("issuer", "HERMES_WEBUI_OIDC_ISSUER") or "").strip(),
        "client_id": str(pick("client_id", "HERMES_WEBUI_OIDC_CLIENT_ID") or "").strip(),
        "client_secret": str(pick("client_secret", "HERMES_WEBUI_OIDC_CLIENT_SECRET") or "").strip(),
        "redirect_uri": str(pick("redirect_uri", "HERMES_WEBUI_OIDC_REDIRECT_URI") or "").strip(),
        "scopes": scopes,
        "allow_claim": _reject_unresolved(
            str(pick("allow_claim", "HERMES_WEBUI_OIDC_ALLOW_CLAIM") or "").strip()
        ),
        "allow_values": allow_values,
        "trusted_private_hosts": trusted_private_hosts,
        "profile_claim": profile_claim,
        "profile_map": profile_map,
        "profile_map_configured": profile_map_configured,
        "profile_map_error": profile_map_error,
        "owner_claim": owner_claim,
        "owner_values": owner_values,
        "owner_policy_configured": owner_policy_configured,
        "owner_policy_error": owner_policy_error,
        "config_read_failed": config_read_failed,
    }


def _reject_unresolved(value: str) -> str:
    """Blank a claim path that still contains an unexpanded ``${VAR}``."""
    return "" if _UNRESOLVED_PLACEHOLDER_RE.search(value) else value


def _require_oidc_config() -> dict[str, Any]:
    cfg = _resolve_oidc_config()
    if cfg.get("config_read_failed"):
        # The profile map lives in that file. Minting an unbound session while
        # it is unresolved would hand the identity the profile access the map
        # exists to withhold, so login waits for the config rather than
        # guessing at the policy.
        raise OIDCConfigError(
            "The operator config could not be resolved; OIDC login is unavailable "
            "until it is readable"
        )
    if not cfg.get("issuer") or not cfg.get("client_id"):
        raise OIDCConfigError("Native OIDC login is not configured")
    if not cfg.get("allow_claim") or not cfg.get("allow_values"):
        raise OIDCConfigError(
            "Native OIDC login requires webui_oidc.allow_claim and allow_values"
        )
    if cfg.get("profile_map_error"):
        raise OIDCConfigError(str(cfg["profile_map_error"]))
    return cfg


def _normalize_scopes(raw: Any) -> list[str]:
    items = _normalize_text_list(raw)
    if not items:
        return list(_DEFAULT_SCOPES)
    if "openid" not in items:
        items.insert(0, "openid")
    deduped = []
    seen = set()
    for item in items:
        if item not in seen:
            seen.add(item)
            deduped.append(item)
    return deduped


def _normalize_allow_values(raw: Any) -> list[str]:
    """Normalize allowlist values, splitting only on commas/newlines.

    Unlike ``_normalize_text_list`` (which also splits on whitespace), this
    preserves multi-word values such as OIDC group names containing spaces
    (e.g. ``"Hermes Users"`` stays as one entry).

    RFC 6749 §3.3 requires space-delimited scope strings, so
    ``_normalize_scopes`` must keep using ``_normalize_text_list`` -- this
    function is for allow-values only.
    """
    if raw is None:
        return []
    if isinstance(raw, (list, tuple, set)):
        values = [value for value in (str(item).strip() for item in raw) if value]
    else:
        text = str(raw).replace("\n", ",")
        values = [part.strip() for part in text.split(",") if part.strip()]
    # A reference that was never resolved is not a value an identity may hold.
    # Emptying the list disables OIDC login rather than admitting whoever can
    # present a claim equal to the literal placeholder.
    if any(_UNRESOLVED_PLACEHOLDER_RE.search(value) for value in values):
        return []
    return values


def _normalize_trusted_private_hosts(raw: Any) -> list[str]:
    trusted = []
    seen = set()
    for value in _normalize_text_list(raw):
        hostname = value.strip().lower().rstrip(".")
        if (
            not hostname
            or hostname == "localhost"
            or _parse_ip_address(hostname) is not None
            or any(char in hostname for char in ":/\\@*")
        ):
            continue
        try:
            hostname = hostname.encode("idna").decode("ascii")
        except UnicodeError:
            continue
        labels = hostname.split(".")
        if any(
            not label
            or len(label) > 63
            or label.startswith("-")
            or label.endswith("-")
            or not all(char.isalnum() or char == "-" for char in label)
            for label in labels
        ):
            continue
        if hostname not in seen:
            seen.add(hostname)
            trusted.append(hostname)
    return trusted


def _normalize_profile_map(raw: Any) -> tuple[dict[str, str] | None, str | None, bool]:
    if raw is None or raw == "":
        return None, None, False
    value = raw
    if isinstance(raw, str):
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            return None, "webui_oidc.profile_map must be a JSON object", True
    if not isinstance(value, dict):
        return None, "webui_oidc.profile_map must be an object", True
    mapping = {}
    for claim_value, profile in value.items():
        claim_value = str(claim_value or "").strip()
        profile = str(profile or "").strip()
        if not claim_value or not profile:
            return None, "webui_oidc.profile_map entries must have non-empty claim values and profiles", True
        mapping[claim_value] = profile
    return mapping, None, True


def _normalize_owner_policy(
    raw_claim: Any, raw_values: Any
) -> tuple[str, list[str], str | None, bool]:
    """Resolve the opt-in owner allowlist into (claim, values, error, configured).

    Absent (unset or blank) on both settings means the policy is off and legacy
    OIDC owner behaviour applies. Once either setting is present the policy is
    configured, and anything short of a usable claim path plus a non-empty list
    of exact strings resolves to an empty allowlist that matches nothing --
    never to the legacy fallback. Values are not coerced: a number, boolean, or
    object in the list is a configuration error, not a group name.
    """
    configured = _owner_setting_present(raw_claim) or _owner_setting_present(raw_values)
    if not configured:
        return "", [], None, False
    claim = raw_claim.strip() if isinstance(raw_claim, str) else ""
    values = _normalize_owner_values(raw_values)
    if not claim or not values or _UNRESOLVED_PLACEHOLDER_RE.search(claim):
        return claim, [], _OWNER_POLICY_ERROR, True
    return claim, values, None, True


def _pick_owner_setting(raw: dict[str, Any], name: str, env_name: str) -> Any:
    """Resolve one owner setting, preserving whether it was supplied at all."""
    env_value = os.getenv(env_name)
    if env_value is not None:
        return env_value
    return raw[name] if name in raw else _UNSET


def _owner_setting_present(raw: Any) -> bool:
    """True when the operator supplied the key, even with an unusable value.

    Only a key the operator never wrote is absent. An explicitly blank value --
    a templated ``HERMES_WEBUI_OIDC_OWNER_CLAIM=""``, or a bare ``owner_claim:``
    in YAML -- is security configuration they meant to supply, so it activates
    the match-nobody path instead of restoring legacy owner access.
    """
    return raw is not _UNSET


def _normalize_owner_values(raw: Any) -> list[str]:
    """Strictly normalize the owner allowlist; anything non-string yields []."""
    if isinstance(raw, str):
        values = [part.strip() for part in raw.replace("\n", ",").split(",")]
    elif isinstance(raw, (list, tuple)):
        # An explicitly authored list must contain only non-empty strings; a
        # blank entry is a malformed policy, not a value to quietly drop.
        if not all(isinstance(item, str) and item.strip() for item in raw):
            return []
        values = [item.strip() for item in raw]
    else:
        return []
    values = [value for value in values if value]
    if any(_UNRESOLVED_PLACEHOLDER_RE.search(value) for value in values):
        return []
    return values


def _resolve_owner_permission(cfg: dict[str, Any], claims: dict[str, Any]) -> bool:
    """True when the validated claims match the configured owner allowlist.

    Exact, case-sensitive comparison against a string claim or an array of
    strings. Any other claim shape -- object, number, boolean, mixed array --
    grants nothing.
    """
    if not cfg.get("owner_policy_configured"):
        return False
    allowed = cfg.get("owner_values") or []
    claim_path = str(cfg.get("owner_claim") or "")
    if not allowed or not claim_path:
        return False
    value = _get_claim_path(claims, claim_path)
    if isinstance(value, str):
        present = [value]
    elif isinstance(value, (list, tuple)) and all(isinstance(item, str) for item in value):
        present = list(value)
    else:
        return False
    return any(item in allowed for item in present)


def _resolve_bound_profile(cfg: dict[str, Any], claims: dict[str, Any]) -> str | None:
    if not cfg.get("profile_map_configured"):
        return None
    claim_value = _get_claim_path(claims, str(cfg.get("profile_claim") or "sub"))
    if isinstance(claim_value, (dict, list, tuple, set)):
        raise OIDCAuthError("OIDC identity is not assigned to a profile", status_code=403)
    profile = (cfg.get("profile_map") or {}).get(str(claim_value or "").strip())
    if not profile:
        raise OIDCAuthError("OIDC identity is not assigned to a profile", status_code=403)

    from api.profiles import _PROFILE_ID_RE, get_hermes_home_for_profile

    if profile != "default" and not _PROFILE_ID_RE.fullmatch(profile):
        raise OIDCConfigError(f"OIDC profile mapping targets invalid profile {profile!r}")
    if not get_hermes_home_for_profile(profile).is_dir():
        raise OIDCConfigError(f"OIDC profile mapping target {profile!r} does not exist")
    return profile


def _oidc_profile_binding(
    cfg: dict[str, Any],
    profile: str | None,
    *,
    owner: bool = False,
) -> dict[str, Any]:
    """Server-side evidence for one OIDC session.

    The fingerprint covers every policy input that decides admission, profile
    binding, and owner permission, so changing any of them invalidates existing
    sessions at their next authorization check. ``profile_identity`` is empty
    for an unbound session; owner permission lasts for the session lifetime.
    """
    mapping_payload = {
        "issuer": str(cfg.get("issuer") or ""),
        "client_id": str(cfg.get("client_id") or ""),
        "allow_claim": str(cfg.get("allow_claim") or ""),
        "allow_values": sorted(str(value) for value in (cfg.get("allow_values") or [])),
        "profile_claim": str(cfg.get("profile_claim") or "sub"),
        "profile_map": cfg.get("profile_map") or {},
        # An explicitly empty map admits nobody, which is a different policy
        # from having no map at all even though both normalize to {}.
        "profile_map_configured": bool(cfg.get("profile_map_configured")),
        "owner_claim": str(cfg.get("owner_claim") or ""),
        "owner_values": sorted(str(value) for value in (cfg.get("owner_values") or [])),
        "owner_policy_configured": bool(cfg.get("owner_policy_configured")),
    }
    mapping_fingerprint = hashlib.sha256(
        json.dumps(mapping_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    profile_identity = ""
    if profile:
        from api.profiles import get_hermes_home_for_profile

        stat = get_hermes_home_for_profile(profile).stat()
        profile_identity = f"{stat.st_dev}:{stat.st_ino}"
    binding: dict[str, Any] = {
        "mapping_fingerprint": mapping_fingerprint,
        "profile_identity": profile_identity,
    }
    if owner:
        binding["owner"] = True
    return binding


def _oidc_binding_is_current(
    binding: dict[str, Any] | None,
    profile: str | None,
    cfg: dict[str, Any] | None = None,
) -> bool:
    """True when evidence still matches the policy and the named profile.

    Callers that already resolved the policy pass their snapshot in, so one
    read both selects the decision and validates it; re-reading here would let
    a policy removed and restored between the two reads pass a check the first
    read had already routed down the legacy path.
    """
    if not binding:
        return True
    try:
        if cfg is None:
            cfg = _require_oidc_config()
        expected = _oidc_profile_binding(cfg, str(profile or "").strip() or None)
    except (OSError, OIDCAuthError, OIDCConfigError):
        return False
    return secrets.compare_digest(
        str(binding.get("mapping_fingerprint") or ""), expected["mapping_fingerprint"]
    ) and secrets.compare_digest(
        str(binding.get("profile_identity") or ""), expected["profile_identity"]
    )


def oidc_session_binding_is_current(
    session_info: dict[str, Any], cfg: dict[str, Any] | None = None
) -> bool:
    """Reconcile a persisted OIDC session against the live policy.

    Every session that recorded a fingerprint reconciles it, regardless of
    privilege: dropping an identity from the login allowlist or changing the
    issuer must end ordinary access too, not only owner access. Only a legacy
    record with no fingerprint, no profile, and no owner evidence has nothing
    to check.
    """
    profile = str(session_info.get("bound_profile") or "").strip()
    owner_evidence = bool(session_info.get("oidc_owner"))
    fingerprint = str(session_info.get("oidc_mapping_fingerprint") or "")
    if not fingerprint and not profile and not owner_evidence:
        return True
    binding = {
        "mapping_fingerprint": fingerprint,
        "profile_identity": session_info.get("oidc_profile_identity"),
    }
    return _oidc_binding_is_current(binding, profile, cfg)


def oidc_session_can_manage_server(session_info: dict[str, Any]) -> bool:
    """True when an OIDC session may perform owner-only operations.

    With no owner policy configured this preserves the legacy contract: an
    unbound OIDC session is the owner. Once a policy exists, only explicit
    server-created owner evidence counts -- an unbound session inherits nothing.
    A policy we could not resolve is neither: it denies.
    """
    try:
        cfg = _require_oidc_config()
    except (OIDCAuthError, OIDCConfigError):
        return False
    if cfg.get("config_read_failed"):
        # The owner policy may live in the config we could not read, so its
        # absence here is unknown, not disabled. Unknown is not authority --
        # base settings arriving from the environment do not change that.
        return False
    if not cfg.get("owner_policy_configured"):
        if str(session_info.get("bound_profile") or "").strip():
            return False
        # The session may have been minted while a policy was configured; its
        # fingerprint covers that policy, so a session from the policy era
        # cannot be re-read as a legacy owner after the settings disappear.
        return oidc_session_binding_is_current(session_info, cfg)
    if not session_info.get("oidc_owner"):
        return False
    return oidc_session_binding_is_current(session_info, cfg)


def _normalize_text_list(raw: Any) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, (list, tuple, set)):
        values = [str(item).strip() for item in raw]
    else:
        text = str(raw).replace("\n", ",")
        values = []
        for comma_part in text.split(","):
            values.extend(piece.strip() for piece in comma_part.split() if piece.strip())
    return [value for value in values if value]


def _safe_next_path(raw_path: str | None) -> str:
    path = str(raw_path or "").strip()
    if not path:
        return "/"
    if path[0] != "/":
        return "/"
    if path[1:2] in {"/", "\\"}:
        return "/"
    if any(ord(ch) < 32 or ord(ch) == 127 or ch.isspace() for ch in path):
        return "/"
    return path


def _resolve_redirect_uri(cfg: dict[str, Any], request_base_url: str) -> str:
    explicit = str(cfg.get("redirect_uri") or "").strip()
    if explicit:
        return explicit
    return request_base_url.rstrip("/") + "/api/auth/oidc/callback"


def _store_pending_flow(
    state: str,
    payload: dict[str, Any],
    *,
    request_base_url: str | None = None,
) -> None:
    now = time.time()
    with _pending_lock:
        native_flow_id = str(payload.get("native_flow_id") or "")
        if native_flow_id:
            _prune_native_state(now)
            flow = _native_flows.get(native_flow_id)
            if flow is None:
                raise OIDCAuthError("Invalid or expired native OIDC flow", status_code=401)
            if request_base_url is None or not _constant_time_equal(
                _normalize_server_origin(request_base_url), flow["server_origin"]
            ):
                raise OIDCAuthError("Native OIDC flow belongs to a different server", status_code=401)
        _prune_pending_flows(now)
        _trim_state_map(_pending_flows, _MAX_PENDING_FLOWS)
        _pending_flows[state] = payload


def _consume_pending_flow(state: str) -> dict[str, Any] | None:
    now = time.time()
    with _pending_lock:
        _prune_pending_flows(now)
        payload = _pending_flows.pop(state, None)
    return payload


def _prune_pending_flows(now: float) -> None:
    expired = [
        state
        for state, payload in _pending_flows.items()
        if now - float(payload.get("created_at") or 0) > _PENDING_TTL_SECONDS
    ]
    for state in expired:
        _pending_flows.pop(state, None)


def _get_discovery_document(issuer: str) -> dict[str, Any]:
    discovery_url = _discovery_url_for_issuer(issuer)
    cached = _cache_get(_discovery_lock, _discovery_cache, discovery_url)
    if cached is not None:
        return cached
    data = _fetch_json(discovery_url)
    if not isinstance(data, dict):
        raise OIDCAuthError("OIDC discovery response was not a JSON object", status_code=502)
    _cache_put(_discovery_lock, _discovery_cache, discovery_url, data)
    return data


def _discovery_url_for_issuer(issuer: str) -> str:
    if issuer.endswith("/.well-known/openid-configuration"):
        return issuer
    return issuer.rstrip("/") + "/.well-known/openid-configuration"


def _get_jwks_document(jwks_uri: str, *, force_refresh: bool = False) -> dict[str, Any]:
    if not jwks_uri:
        raise OIDCConfigError("OIDC discovery document is missing jwks_uri")
    if force_refresh:
        with _jwks_lock:
            _jwks_cache.pop(jwks_uri, None)
    else:
        cached = _cache_get(_jwks_lock, _jwks_cache, jwks_uri)
        if cached is not None:
            return cached
    data = _fetch_json(jwks_uri)
    if not isinstance(data, dict):
        raise OIDCAuthError("OIDC JWKS response was not a JSON object", status_code=502)
    _cache_put(_jwks_lock, _jwks_cache, jwks_uri, data)
    return data


def _cache_get(
    lock: threading.Lock,
    cache: dict[str, tuple[float, dict[str, Any]]],
    key: str,
) -> dict[str, Any] | None:
    now = time.time()
    with lock:
        entry = cache.get(key)
        if entry is None:
            return None
        expires_at, value = entry
        if expires_at <= now:
            cache.pop(key, None)
            return None
        return copy.deepcopy(value)


def _cache_put(
    lock: threading.Lock,
    cache: dict[str, tuple[float, dict[str, Any]]],
    key: str,
    value: dict[str, Any],
) -> None:
    with lock:
        cache[key] = (time.time() + _CACHE_TTL_SECONDS, copy.deepcopy(value))


def _fetch_json(url: str) -> dict[str, Any]:
    _validate_outbound_oidc_url(url)
    req = urllib.request.Request(
        url,
        headers={"Accept": "application/json"},
    )
    try:
        with _oidc_opener().open(req, timeout=10) as resp:
            payload = json.loads(
                resp.read().decode("utf-8"),
                parse_constant=_reject_non_finite_json_constant,
            )
    except (urllib.error.HTTPError, urllib.error.URLError) as exc:
        raise OIDCAuthError(f"Failed to reach OIDC endpoint: {url}", status_code=502) from exc
    except (json.JSONDecodeError, ValueError) as exc:
        raise OIDCAuthError(f"OIDC endpoint returned invalid JSON: {url}", status_code=502) from exc
    return payload if isinstance(payload, dict) else {}


def _post_form_json(url: str, form_data: dict[str, Any]) -> dict[str, Any]:
    _validate_outbound_oidc_url(url)
    body = urllib.parse.urlencode(form_data).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )
    try:
        with _oidc_opener().open(req, timeout=10) as resp:
            payload = json.loads(
                resp.read().decode("utf-8"),
                parse_constant=_reject_non_finite_json_constant,
            )
    except (urllib.error.HTTPError, urllib.error.URLError) as exc:
        raise OIDCAuthError("Failed to exchange the OIDC authorization code", status_code=502) from exc
    except (json.JSONDecodeError, ValueError) as exc:
        raise OIDCAuthError("OIDC token endpoint returned invalid JSON", status_code=502) from exc
    return payload if isinstance(payload, dict) else {}


def _oidc_opener() -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(_NoRedirect)


def _validate_outbound_oidc_url(url: str) -> None:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https":
        raise OIDCAuthError("OIDC endpoint URLs must use https", status_code=502)
    if parsed.username or parsed.password:
        raise OIDCAuthError("OIDC endpoint URLs must not contain credentials", status_code=502)
    hostname = str(parsed.hostname or "").strip()
    if not hostname:
        raise OIDCAuthError("OIDC endpoint URL was missing a hostname", status_code=502)
    normalized_hostname = hostname.lower().rstrip(".")
    trusted_private_hosts = set(
        _resolve_oidc_config().get("trusted_private_hosts") or []
    )
    if (
        _is_disallowed_oidc_host(hostname)
        and normalized_hostname not in trusted_private_hosts
    ):
        raise OIDCAuthError(
            "OIDC endpoint URLs must not target private or local addresses",
            status_code=502,
        )


def _is_disallowed_oidc_host(hostname: str) -> bool:
    literal_ip = _parse_ip_address(hostname)
    if literal_ip is not None:
        return _is_disallowed_oidc_ip(literal_ip)
    try:
        infos = socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)
    except socket.gaierror:
        return False
    for info in infos:
        sockaddr = info[4]
        address = _parse_ip_address(sockaddr[0] if sockaddr else "")
        if address is not None and _is_disallowed_oidc_ip(address):
            return True
    return False


def _parse_ip_address(value: str):
    try:
        return ipaddress.ip_address(value)
    except ValueError:
        return None


def _is_disallowed_oidc_ip(address) -> bool:
    candidate = getattr(address, "ipv4_mapped", None) or address
    return (
        candidate.is_loopback
        or candidate.is_private
        or candidate.is_link_local
        or candidate.is_multicast
        or candidate.is_unspecified
        or candidate.is_reserved
    )


def _reject_non_finite_json_constant(value: str):
    raise ValueError(f"OIDC JSON contained unsupported constant: {value}")


def _validate_id_token(
    token: str,
    *,
    client_id: str,
    issuer: str,
    nonce: str,
    jwks_uri: str,
) -> dict[str, Any]:
    header, claims, signed, signature = _parse_jwt(token)
    alg = str(header.get("alg") or "").strip()
    if not alg or alg == "none":
        raise OIDCAuthError("OIDC id_token uses an unsupported signing algorithm")
    jwks = _get_jwks_document(jwks_uri)
    try:
        public_key = _select_public_key(jwks, header)
    except OIDCAuthError as exc:
        if "did not contain the signing key" not in str(exc):
            raise
        jwks = _get_jwks_document(jwks_uri, force_refresh=True)
        public_key = _select_public_key(jwks, header)
    _verify_jwt_signature(public_key, alg, signed, signature)
    _validate_registered_claims(claims, client_id=client_id, issuer=issuer, nonce=nonce)
    if not str(claims.get("sub") or "").strip():
        raise OIDCAuthError("OIDC id_token did not include a subject")
    return claims


def _parse_jwt(token: str) -> tuple[dict[str, Any], dict[str, Any], bytes, bytes]:
    parts = token.split(".")
    if len(parts) != 3:
        raise OIDCAuthError("OIDC id_token was not a JWT")
    header_b64, payload_b64, signature_b64 = parts
    try:
        header = json.loads(
            _b64u_decode(header_b64),
            parse_constant=_reject_non_finite_json_constant,
        )
        claims = json.loads(
            _b64u_decode(payload_b64),
            parse_constant=_reject_non_finite_json_constant,
        )
        signature = _b64u_decode_bytes(signature_b64)
    except Exception as exc:
        raise OIDCAuthError("OIDC id_token could not be decoded") from exc
    if not isinstance(header, dict) or not isinstance(claims, dict):
        raise OIDCAuthError("OIDC id_token payload was malformed")
    signed = f"{header_b64}.{payload_b64}".encode("ascii")
    return header, claims, signed, signature


def _select_public_key(jwks: dict[str, Any], header: dict[str, Any]):
    keys = jwks.get("keys")
    if not isinstance(keys, list) or not keys:
        raise OIDCAuthError("OIDC JWKS did not contain any signing keys", status_code=502)
    kid = str(header.get("kid") or "").strip()
    alg = str(header.get("alg") or "").strip()
    matches = []
    for key in keys:
        if not isinstance(key, dict):
            continue
        if key.get("use") not in (None, "sig"):
            continue
        if kid and str(key.get("kid") or "").strip() != kid:
            continue
        if key.get("alg") not in (None, alg):
            continue
        if not _jwk_matches_alg_family(key, alg):
            continue
        matches.append(key)
    if not matches:
        raise OIDCAuthError("OIDC JWKS did not contain the signing key for this id_token", status_code=502)
    return _jwk_to_public_key(matches[0])


def _jwk_matches_alg_family(jwk: dict[str, Any], alg: str) -> bool:
    kty = str(jwk.get("kty") or "").strip()
    if alg.startswith("RS"):
        return kty == "RSA"
    if alg.startswith("ES"):
        return kty == "EC" and str(jwk.get("crv") or "").strip() == _ec_curve_for_alg(alg)
    return True


def _ec_curve_for_alg(alg: str) -> str:
    return {
        "ES256": "P-256",
        "ES384": "P-384",
        "ES512": "P-521",
    }.get(alg, "")


def _jwk_to_public_key(jwk: dict[str, Any]):
    kty = str(jwk.get("kty") or "").strip()
    if kty == "RSA":
        n = _int_from_b64u(jwk.get("n"))
        e = _int_from_b64u(jwk.get("e"))
        return rsa.RSAPublicNumbers(e, n).public_key()
    if kty == "EC":
        crv = str(jwk.get("crv") or "").strip()
        curve = {
            "P-256": ec.SECP256R1(),
            "P-384": ec.SECP384R1(),
            "P-521": ec.SECP521R1(),
        }.get(crv)
        if curve is None:
            raise OIDCAuthError(f"Unsupported OIDC EC curve: {crv}", status_code=502)
        x = _int_from_b64u(jwk.get("x"))
        y = _int_from_b64u(jwk.get("y"))
        return ec.EllipticCurvePublicNumbers(x, y, curve).public_key()
    raise OIDCAuthError(f"Unsupported OIDC key type: {kty}", status_code=502)


def _verify_jwt_signature(public_key, alg: str, signed: bytes, signature: bytes) -> None:
    try:
        if alg == "RS256":
            public_key.verify(signature, signed, padding.PKCS1v15(), hashes.SHA256())
            return
        if alg == "RS384":
            public_key.verify(signature, signed, padding.PKCS1v15(), hashes.SHA384())
            return
        if alg == "RS512":
            public_key.verify(signature, signed, padding.PKCS1v15(), hashes.SHA512())
            return
        if alg == "ES256":
            public_key.verify(_jose_ecdsa_signature_to_der(signature, 32), signed, ec.ECDSA(hashes.SHA256()))
            return
        if alg == "ES384":
            public_key.verify(_jose_ecdsa_signature_to_der(signature, 48), signed, ec.ECDSA(hashes.SHA384()))
            return
        if alg == "ES512":
            public_key.verify(_jose_ecdsa_signature_to_der(signature, 66), signed, ec.ECDSA(hashes.SHA512()))
            return
    except InvalidSignature as exc:
        raise OIDCAuthError("OIDC id_token signature verification failed") from exc
    raise OIDCAuthError(f"Unsupported OIDC signing algorithm: {alg}", status_code=502)


def _jose_ecdsa_signature_to_der(signature: bytes, part_size: int) -> bytes:
    if len(signature) != part_size * 2:
        raise OIDCAuthError("OIDC id_token ECDSA signature was malformed")
    r = int.from_bytes(signature[:part_size], "big")
    s = int.from_bytes(signature[part_size:], "big")
    return utils.encode_dss_signature(r, s)


def _validate_registered_claims(
    claims: dict[str, Any],
    *,
    client_id: str,
    issuer: str,
    nonce: str,
) -> None:
    now = time.time()
    if str(claims.get("iss") or "").strip() != issuer:
        raise OIDCAuthError("OIDC id_token issuer did not match the configured issuer")
    aud = claims.get("aud")
    if isinstance(aud, list):
        audiences = [str(item) for item in aud]
    elif aud is None:
        audiences = []
    else:
        audiences = [str(aud)]
    if client_id not in audiences:
        raise OIDCAuthError("OIDC id_token audience did not include this client")
    if len(audiences) > 1 and str(claims.get("azp") or "").strip() not in {"", client_id}:
        raise OIDCAuthError("OIDC id_token azp did not match this client")
    exp = _coerce_numeric_claim(claims, "exp")
    if exp is None or exp < now - _CLOCK_SKEW_SECONDS:
        raise OIDCAuthError("OIDC id_token has expired")
    nbf = _coerce_numeric_claim(claims, "nbf")
    if nbf is not None and nbf > now + _CLOCK_SKEW_SECONDS:
        raise OIDCAuthError("OIDC id_token is not valid yet")
    iat = _coerce_numeric_claim(claims, "iat")
    if iat is not None and iat > now + _CLOCK_SKEW_SECONDS:
        raise OIDCAuthError("OIDC id_token has an invalid issued-at time")
    if str(claims.get("nonce") or "").strip() != nonce:
        raise OIDCAuthError("OIDC id_token nonce did not match the login request")


def _coerce_numeric_claim(claims: dict[str, Any], name: str) -> float | None:
    value = claims.get(name)
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise OIDCAuthError(f"OIDC id_token claim {name} was not numeric") from exc
    if not math.isfinite(number):
        raise OIDCAuthError(f"OIDC id_token claim {name} was not numeric")
    return number


def _enforce_allowlist(
    claims: dict[str, Any],
    *,
    allow_claim: str,
    allow_values: list[str],
) -> None:
    if not allow_claim:
        return
    claim_value = _get_claim_path(claims, allow_claim)
    if claim_value is None:
        raise OIDCAuthError("OIDC identity is not allowed", status_code=403)
    actual_values = _claim_values(claim_value)
    if allow_values:
        if not any(value in actual_values for value in allow_values):
            raise OIDCAuthError("OIDC identity is not allowed", status_code=403)
        return
    if not actual_values:
        raise OIDCAuthError("OIDC identity is not allowed", status_code=403)


def _get_claim_path(claims: dict[str, Any], dotted_key: str) -> Any:
    current: Any = claims
    for part in dotted_key.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def _claim_values(value: Any) -> set[str]:
    if isinstance(value, (list, tuple, set)):
        return {str(item) for item in value if str(item).strip()}
    if isinstance(value, dict):
        return {str(item) for item in value.values() if str(item).strip()}
    text = str(value or "").strip()
    return {text} if text else set()


def _b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64u_decode(data: str) -> str:
    return _b64u_decode_bytes(data).decode("utf-8")


def _b64u_decode_bytes(data: str) -> bytes:
    padded = data + "=" * ((4 - len(data) % 4) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def _int_from_b64u(data: Any) -> int:
    if not data:
        raise OIDCAuthError("OIDC JWKS key was missing a required parameter", status_code=502)
    return int.from_bytes(_b64u_decode_bytes(str(data)), "big")
