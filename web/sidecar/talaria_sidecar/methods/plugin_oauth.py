"""OAuth clients a plugin declares in ``plugin.yaml`` (Agent v0.22.3+, TAL-1276): status, sign-in and sign-out from Web.

``plugins.oauth_status`` and ``plugins.oauth_logout`` read and remove grants through the Agent's ``plugin_oauth``
helpers, mapped exactly as ``hermes auth status|logout <plugin>:<id>``. The sign-in is the ``oauth.*`` flow kind
``plugin:<key>:<id>``: the Agent's PKCE config, loopback listener, token request and grant store, with the waiting
that ``auth_oauth_pkce_plugin.login`` does in a terminal run here so a flow can be cancelled, can expire, and can also
finish from a pasted redirect address when the browser runs on another machine. The Agent's helpers are private, so
each is checked by name: an Agent without any of them offers no status and no sign-in.
"""

from __future__ import annotations

import hmac
import logging
import secrets
import threading
import time
import types
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext

log = logging.getLogger("talaria_sidecar.plugin_oauth")

PREFIX = "plugin:"
_NEEDED = {
    "plugin_oauth": ("_declared_clients", "_read_grant", "_write_grant", "_usable_grant", "_pkce_config", "plugin_key", "_installed_client", "_logout_key"),
    "auth_oauth_pkce_plugin": ("validate_config", "_post_token", "_err"),
    "auth_device_flow": ("_make_loopback_callback_handler", "_bind_loopback_callback_server", "_pkce_code_verifier", "_pkce_code_challenge"),
    "plugins_cmd": ("_discover_all_plugins",),
    "plugin_provider_requests": ("ProviderNotSignedIn",),
}


def _agent() -> types.SimpleNamespace | None:
    """The Agent modules this needs, or None when one of them or one of their helpers is missing."""
    import importlib

    modules = {}
    for name, attrs in _NEEDED.items():
        try:
            module = importlib.import_module(f"hermes_cli.{name}")
        except ImportError:
            return None
        if not all(hasattr(module, attr) for attr in attrs):
            return None
        modules[name] = module
    return types.SimpleNamespace(**modules)


def _required() -> types.SimpleNamespace:
    agent = _agent()
    if agent is None:
        raise RpcError("This Hermes Agent cannot sign in to plugin OAuth clients.", condition="oauth_unsupported")
    return agent


def _hosts(client) -> dict:
    """The two hosts ``hermes auth add`` names before it signs in: the code is approved at one and exchanged at the other."""
    return {"authorize_host": urlparse(client.authorize_url).hostname or "", "token_host": urlparse(client.token_url).hostname or ""}


def _state(agent: types.SimpleNamespace, client, key: str) -> str:
    """``_cli_status``'s answer for one grant."""
    row = agent.plugin_oauth._read_grant(key)
    try:
        agent.plugin_oauth._usable_grant(row, client, key)
    except agent.plugin_provider_requests.ProviderNotSignedIn:
        return "logged_out" if row is None else "revoked" if row.get("dead") else "sign_in_needed"
    return "signed_in"


def oauth_status() -> dict:
    """Every discovered plugin that declares OAuth clients, with each client's sign-in state."""
    agent = _agent()
    if agent is None:
        return {"supported": False, "plugins": []}
    rows = []
    for _name, _version, _desc, _source, plugin_dir, key in agent.plugins_cmd._discover_all_plugins():
        if not plugin_dir:
            continue
        directory = Path(str(plugin_dir))
        try:
            clients = agent.plugin_oauth._declared_clients(directory)
        except ValueError:  # a malformed oauth: block, which the Agent refuses to sign in to as well
            log.warning("plugin %s declares an invalid oauth: block", key)
            continue
        if clients:
            grant_base = agent.plugin_oauth.plugin_key(directory)
            rows.append({"key": key, "clients": [{"id": c.id, "state": _state(agent, c, f"{grant_base}:{c.id}"), **_hosts(c)} for c in clients]})
    return {"supported": True, "plugins": rows}


def oauth_logout(key: str, oauth_id: str) -> dict:
    """``hermes auth logout <plugin>:<id>``: removes the stored grant, which needs no valid manifest entry."""
    if not key or not oauth_id:
        raise InvalidParams("plugins.oauth_logout requires 'key' and 'id'")
    agent = _required()
    grant = agent.plugin_oauth._logout_key(key, oauth_id)
    if grant is not None:
        agent.plugin_oauth._write_grant(grant, None)
    return {"key": key, "id": oauth_id, "removed": grant is not None}


# ── the plugin:<key>:<id> flow kind for oauth.start ────────────────────


def steps(provider: str):
    """``(begin, wait, save)`` for ``plugin:<key>:<id>``; None for every other provider."""
    if not provider.startswith(PREFIX):
        return None
    plugin, _, oauth_id = provider[len(PREFIX):].rpartition(":")
    if not plugin or not oauth_id:
        raise InvalidParams("a plugin sign-in is 'plugin:<key>:<id>'")
    return (lambda: _begin(plugin, oauth_id), _wait, _save)


def _begin(plugin: str, oauth_id: str) -> tuple[dict, dict]:
    """Bind the loopback listener and build the authorize link as ``login`` does; runs under the flow's home."""
    agent = _required()
    try:
        found = agent.plugin_oauth._installed_client(plugin, oauth_id)
    except ValueError as exc:
        raise RpcError(str(exc), condition="oauth_failed") from exc
    if found is None:
        raise RpcError(f"Plugin '{plugin}' declares no OAuth client '{oauth_id}'.", condition="plugin_not_found")
    plugin_dir, client = found
    key = f"{agent.plugin_oauth.plugin_key(plugin_dir)}:{client.id}"
    pkce, loopback = agent.auth_oauth_pkce_plugin, agent.auth_device_flow
    cfg = agent.plugin_oauth._pkce_config(client, key)
    pkce.validate_config(key, cfg)
    path = cfg.redirect_path if cfg.redirect_path.startswith("/") else f"/{cfg.redirect_path}"
    handler_cls, result = loopback._make_loopback_callback_handler(path, display_name=cfg.label or key)
    server = loopback._bind_loopback_callback_server("127.0.0.1", int(cfg.redirect_port), handler_cls,
                                                     err=lambda message, code: pkce._err(key, message, code), bind_failed_code="oauth_callback_bind_failed")
    port = server.server_address[1]
    redirect_uri = f"http://127.0.0.1:{port}{path}"
    verifier, state = loopback._pkce_code_verifier(), secrets.token_urlsafe(32)
    params = {**cfg.extra_authorize_params, "client_id": cfg.client_id, "response_type": "code", "redirect_uri": redirect_uri, "state": state,
              "code_challenge": loopback._pkce_code_challenge(verifier), "code_challenge_method": "S256"}
    if cfg.scopes:
        params["scope"] = " ".join(cfg.scopes)
    if cfg.audience:
        params["audience"] = cfg.audience
    authorize_url = f"{cfg.authorize_url}{'&' if urlparse(cfg.authorize_url).query else '?'}{urlencode(params)}"
    display = {"verification_url": authorize_url, "redirect_uri": redirect_uri, **_hosts(client), "expires_in": int(cfg.timeout_seconds), "interval": 2}
    flow_state = {"agent": agent, "key": key, "client": client, "cfg": cfg, "server": server, "result": result, "port": port, "path": path,
                  "redirect_uri": redirect_uri, "verifier": verifier, "state": state, "answer_lock": threading.Lock()}
    flow_state["submit"] = lambda url: _submit(flow_state, url)
    return display, flow_state


def _submit(state: dict, url: str) -> None:
    """A pasted redirect address, delivered as the loopback listener would have received it."""
    parsed = urlparse(str(url or "").strip())
    try:
        port = parsed.port
    except ValueError:
        port = None
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or port != state["port"] or parsed.path != state["path"]:
        raise RpcError("That is not the address this sign-in redirects to.", condition="oauth_redirect_invalid")
    query = parse_qs(parsed.query)
    if not (query.get("code") or query.get("error")):
        raise RpcError("That address carries no sign-in answer.", condition="oauth_redirect_invalid")
    result = state["result"]
    with state["answer_lock"]:
        if result["code"] or result["error"]:
            return  # the browser's own redirect already answered
        # ``code`` and ``error`` go last: the waiting loop reads the answer once one of them is set.
        for name in ("state", "error_description", "error", "code"):
            result[name] = query.get(name, [None])[0]


def _wait(flow, state: dict) -> dict:
    from .oauth import _EXPIRED, _Stop

    agent, server, result, key = state["agent"], state["server"], state["result"], state["key"]
    pkce = agent.auth_oauth_pkce_plugin
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True, name=f"oauth-loopback-{flow.flow_id[:6]}")
    thread.start()
    try:
        # The Agent's ``_serve_loopback_callback`` cannot be stopped, so its loop runs here with the flow's cancel and deadline.
        while not (result["code"] or result["error"]):
            if flow.cancelled.wait(0.1):
                raise _Stop()
            if time.time() >= flow.expires_at:
                raise TimeoutError(_EXPIRED)
    finally:
        # Once ``shutdown`` returns, a callback request in progress has finished writing the answer.
        server.shutdown()
        server.server_close()
        thread.join(timeout=1.0)
    if flow.cancelled.is_set():
        raise _Stop()
    if result["error"]:
        code = "access_denied" if result["error"] == "access_denied" else "oauth_authorization_denied"
        raise pkce._err(key, f"authorization failed: {result.get('error_description') or result['error']}", code)
    if not hmac.compare_digest(str(result.get("state") or ""), state["state"]):
        raise pkce._err(key, "callback state mismatch — the redirect did not come from this login. Aborting.", "oauth_state_mismatch")
    code = str(result.get("code") or "").strip()
    if not code:
        raise pkce._err(key, "callback carried no authorization code.", "oauth_no_code")
    # The token request reads the client id (and secret) from the flow's profile at the moment it posts.
    with scoped_home(flow.home):
        return pkce._post_token(key, state["cfg"], {"grant_type": "authorization_code", "code": code, "redirect_uri": state["redirect_uri"],
                                                    "code_verifier": state["verifier"]}, code="oauth_token_exchange_failed")


def _save(flow, state: dict, fields: dict) -> None:
    state["agent"].plugin_oauth._write_grant(state["key"], {**fields, "fingerprint": state["client"].fingerprint})


def discard(state: dict) -> None:
    """Close the listener of a begun sign-in that is never published."""
    server = state.get("server")
    if server is not None:
        server.server_close()


def register(reg) -> None:
    @reg.method("plugins.oauth_status")
    def status_(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return oauth_status()

    @reg.method("plugins.oauth_logout")
    def logout_(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return oauth_logout(str(params.get("key") or "").strip(), str(params.get("id") or "").strip())
