"""``oauth.*``: the Agent's device-code sign-ins for Nous Portal, OpenAI Codex, xAI and MiniMax (TAL-398).

``oauth.start`` asks the provider for a code and answers what the user has to see; a daemon thread then waits for the
approval and saves the credential with the Agent's own auth-store helpers under the flow's profile home, the steps its
dashboard and ``hermes auth add`` run. Only the lifecycle is ours: a flow belongs to the home that started it, a cancel
or an expiry means nothing is saved afterwards, and a new start for the same home and provider supersedes the old one.
Flows live in this process only.
"""

from __future__ import annotations

import logging
import os
import secrets
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext

log = logging.getLogger("talaria_sidecar.oauth")

_CODEX_ISSUER = "https://auth.openai.com"
_CODEX_EXPIRES_IN = 15 * 60  # OpenAI's device-code lifetime, as the Agent dashboard uses it
# An ended flow stays readable this long so the last poll still sees its ending.
_ENDED_TTL = 10 * 60
# A pending flow past its code's expiry by this much ends expired even if its provider call has not returned yet.
_EXPIRY_GRACE = 60

_DENIED = "Sign-in was declined."
_EXPIRED = "The sign-in code expired before it was approved."


class _Stop(Exception):
    """Raised inside a cancelled flow's provider call so the worker unwinds without saving."""


@dataclass
class Flow:
    flow_id: str
    provider: str
    home: Path
    expires_at: float
    interval: int
    status: str = "pending"
    error: str | None = None
    ended_at: float | None = None
    # The OAuth ``error`` code of the provider's last non-200 answer (``access_denied``, ``expired_token``).
    oauth_error: str = ""
    cancelled: threading.Event = field(default_factory=threading.Event)
    # Serialises the cancel check with the credential save: a cancel cannot land between them.
    lock: threading.Lock = field(default_factory=threading.Lock)

    def end(self, status: str, error: str | None = None) -> None:
        self.status, self.error, self.ended_at = status, error, time.time()

    def view(self) -> dict:
        return {"flow_id": self.flow_id, "provider": self.provider, "status": self.status, "error": self.error}


class _Watched:
    """The HTTP client handed to an Agent poll helper: stops a cancelled flow and records the OAuth error code."""

    def __init__(self, client: Any, flow: Flow):
        self._client, self._flow = client, flow

    def _guard(self) -> None:
        if self._flow.cancelled.is_set():
            raise _Stop()

    def post(self, *args: Any, **kwargs: Any) -> Any:
        self._guard()
        response = self._client.post(*args, **kwargs)
        if response.status_code != 200:
            try:
                payload = response.json()
            except Exception:  # noqa: BLE001 - a non-JSON error carries no OAuth code
                payload = None
            if isinstance(payload, dict) and isinstance(payload.get("error"), str):
                self._flow.oauth_error = payload["error"]
        return response

    def send(self, *args: Any, **kwargs: Any) -> Any:
        self._guard()
        return self._client.send(*args, **kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._client, name)


def _first_line(exc: BaseException) -> str:
    text = (str(exc).strip().splitlines() or [""])[0].strip() or type(exc).__name__
    return text[:300]


def _remaining(flow: Flow) -> int:
    return max(1, int(flow.expires_at - time.time()))


def _now_z() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _client(timeout: float, **kwargs: Any) -> Any:
    import httpx

    return httpx.Client(timeout=httpx.Timeout(timeout), headers={"Accept": "application/json"}, **kwargs)


# ── providers: (begin, wait, save) over the Agent's own steps ──────────
# begin() -> (display, state) runs under the flow's home; wait(flow, state) -> tokens polls; save(flow, state, tokens)
# runs under the home with the flow's lock held.


def _nous_begin() -> tuple[dict, dict]:
    from hermes_cli import anon_auth
    from hermes_cli.auth import PROVIDER_REGISTRY, _request_device_code

    if anon_auth.guest_enabled() and anon_auth.has_guest():
        # The free tier's sign-in moves its connectors to the account (``anon_auth.run_sign_in``); a plain device-code
        # sign-in here would orphan them.
        raise RpcError("This profile uses the Nous free tier. Sign in from Hermes with `hermes portal`.", condition="oauth_unsupported")
    pconfig = PROVIDER_REGISTRY["nous"]
    portal = (os.getenv("HERMES_PORTAL_BASE_URL") or os.getenv("NOUS_PORTAL_BASE_URL") or pconfig.portal_base_url).rstrip("/")
    with _client(15.0) as client:
        data = _request_device_code(client, portal, pconfig.client_id, pconfig.scope)
    display = {"user_code": str(data["user_code"]), "verification_url": str(data["verification_uri_complete"]), "expires_in": int(data["expires_in"]), "interval": int(data["interval"])}
    return display, {"portal": portal, "client_id": pconfig.client_id, "scope": pconfig.scope, "device_code": str(data["device_code"])}


def _nous_wait(flow: Flow, state: dict) -> dict:
    from hermes_cli.auth import _poll_for_token

    with _client(15.0) as client:
        return _poll_for_token(client=_Watched(client, flow), portal_base_url=state["portal"], client_id=state["client_id"], device_code=state["device_code"],
                               expires_in=_remaining(flow), poll_interval=flow.interval)


def _nous_save(flow: Flow, state: dict, token_data: dict) -> None:
    from hermes_cli import anon_auth
    from hermes_cli.auth import persist_nous_credentials, refresh_nous_oauth_from_state

    now = datetime.now(timezone.utc)
    ttl = int(token_data.get("expires_in") or 0)
    auth_state = {
        "portal_base_url": state["portal"], "inference_base_url": token_data.get("inference_base_url"), "client_id": state["client_id"],
        "scope": token_data.get("scope") or state["scope"], "token_type": token_data.get("token_type", "Bearer"),
        "access_token": token_data["access_token"], "refresh_token": token_data.get("refresh_token"), "obtained_at": now.isoformat(),
        "expires_at": datetime.fromtimestamp(now.timestamp() + ttl, tz=timezone.utc).isoformat() if ttl else None, "expires_in": ttl,
    }
    full_state = refresh_nous_oauth_from_state(auth_state, timeout_seconds=15.0, force_refresh=False)
    persist_nous_credentials(full_state)
    anon_auth.settle_after_upgrade(full_state)


def _codex_begin() -> tuple[dict, dict]:
    from hermes_cli.auth import CODEX_OAUTH_CLIENT_ID
    from hermes_cli.auth_codex import _codex_request_device_code

    data = _codex_request_device_code(_CODEX_ISSUER, CODEX_OAUTH_CLIENT_ID)
    display = {"user_code": str(data["user_code"]), "verification_url": f"{_CODEX_ISSUER}/codex/device", "expires_in": _CODEX_EXPIRES_IN, "interval": int(data["interval"])}
    return display, {"device_auth_id": str(data["device_auth_id"]), "user_code": str(data["user_code"])}


def _codex_wait(flow: Flow, state: dict) -> dict:
    """The Agent's Codex poll (``auth_codex._codex_poll_authorization_code``) cannot be stopped, so its loop runs here:
    403/404 is still pending, a transport error is retried a few times in a row, and the exchange is the Agent's."""
    import httpx
    from hermes_cli.auth import CODEX_OAUTH_CLIENT_ID
    from hermes_cli.auth_codex import _codex_exchange_authorization_code, _codex_http_client

    payload = {"device_auth_id": state["device_auth_id"], "user_code": state["user_code"]}
    blips = 0
    code_resp = None
    with _codex_http_client(timeout=httpx.Timeout(15.0)) as client:
        while code_resp is None:
            if flow.cancelled.wait(flow.interval):
                raise _Stop()
            if time.time() >= flow.expires_at:
                raise TimeoutError(_EXPIRED)
            try:
                response = client.post(f"{_CODEX_ISSUER}/api/accounts/deviceauth/token", json=payload, headers={"Content-Type": "application/json"})
            except httpx.TransportError:
                blips += 1
                if blips >= 6:
                    raise
                continue
            blips = 0
            if response.status_code == 200:
                code_resp = response.json()
            elif response.status_code not in (403, 404):
                raise RuntimeError(f"OpenAI device sign-in returned HTTP {response.status_code}.")
    if flow.cancelled.is_set():
        raise _Stop()
    tokens = _codex_exchange_authorization_code(_CODEX_ISSUER, CODEX_OAUTH_CLIENT_ID, code_resp)
    return {"access_token": tokens.get("access_token", ""), "refresh_token": tokens.get("refresh_token", "")}


def _codex_save(flow: Flow, state: dict, tokens: dict) -> None:
    from hermes_cli.auth import _save_codex_tokens

    _save_codex_tokens(tokens, _now_z())


def _xai_begin() -> tuple[dict, dict]:
    from hermes_cli.auth import _xai_oauth_discovery, _xai_oauth_request_device_code

    discovery = _xai_oauth_discovery(20.0)
    with _client(20.0) as client:
        data = _xai_oauth_request_device_code(client)
    display = {"user_code": str(data["user_code"]), "verification_url": str(data.get("verification_uri_complete") or data["verification_uri"]),
               "expires_in": int(data["expires_in"]), "interval": int(data["interval"])}
    return display, {"discovery": discovery, "device_code": str(data["device_code"])}


def _xai_wait(flow: Flow, state: dict) -> dict:
    from hermes_cli.auth import _xai_oauth_poll_device_token

    with _client(20.0) as client:
        data = _xai_oauth_poll_device_token(_Watched(client, flow), token_endpoint=state["discovery"]["token_endpoint"], device_code=state["device_code"],
                                            expires_in=_remaining(flow), poll_interval=flow.interval)
    return {
        "access_token": str(data.get("access_token", "") or "").strip(), "refresh_token": str(data.get("refresh_token", "") or "").strip(),
        "id_token": str(data.get("id_token", "") or "").strip(), "expires_in": data.get("expires_in"),
        "token_type": str(data.get("token_type") or "Bearer").strip() or "Bearer",
    }


def _xai_save(flow: Flow, state: dict, tokens: dict) -> None:
    from hermes_cli.auth import _save_xai_oauth_tokens, mark_provider_active_if_unset, unsuppress_credential_source

    # As the Agent dashboard does: persist without taking over an active chat provider, become active only when none
    # is, and re-enable the device-code source an earlier removal suppressed.
    _save_xai_oauth_tokens(tokens, discovery=state["discovery"], auth_mode="oauth_device_code", set_active=False, last_refresh=_now_z())
    mark_provider_active_if_unset("xai-oauth")
    unsuppress_credential_source("xai-oauth", "device_code")


def _minimax_begin() -> tuple[dict, dict]:
    from hermes_cli.auth import MINIMAX_OAUTH_CLIENT_ID, MINIMAX_OAUTH_GLOBAL_BASE, _minimax_pkce_pair, _minimax_request_user_code

    verifier, challenge, csrf_state = _minimax_pkce_pair()
    portal = (os.getenv("MINIMAX_PORTAL_BASE_URL") or MINIMAX_OAUTH_GLOBAL_BASE).rstrip("/")
    with _client(15.0, follow_redirects=True) as client:
        data = _minimax_request_user_code(client, portal_base_url=portal, client_id=MINIMAX_OAUTH_CLIENT_ID, code_challenge=challenge, state=csrf_state)
    interval_ms = int(data["interval"]) if data.get("interval") is not None else None
    # ``expired_in`` is a unix-ms deadline or a TTL in seconds (the Agent's own heuristic).
    expired_in = int(data["expired_in"])
    expires_in = max(0, int(expired_in / 1000.0 - time.time())) if expired_in > 1_000_000_000_000 else expired_in
    display = {"user_code": str(data["user_code"]), "verification_url": str(data["verification_uri"]), "expires_in": expires_in, "interval": max(2, (interval_ms or 2000) // 1000)}
    return display, {"portal": portal, "client_id": MINIMAX_OAUTH_CLIENT_ID, "verifier": verifier, "user_code": str(data["user_code"]), "expired_in": expired_in, "interval_ms": interval_ms}


def _minimax_wait(flow: Flow, state: dict) -> dict:
    from hermes_cli.auth import _minimax_poll_token

    with _client(15.0, follow_redirects=True) as client:
        return _minimax_poll_token(_Watched(client, flow), portal_base_url=state["portal"], client_id=state["client_id"], user_code=state["user_code"],
                                   code_verifier=state["verifier"], expired_in=state["expired_in"], interval_ms=state["interval_ms"])


def _minimax_save(flow: Flow, state: dict, token_data: dict) -> None:
    from hermes_cli.auth import MINIMAX_OAUTH_GLOBAL_INFERENCE, MINIMAX_OAUTH_SCOPE, _minimax_resolve_token_expiry_unix, _minimax_save_auth_state

    now = datetime.now(timezone.utc)
    expires_at = _minimax_resolve_token_expiry_unix(int(token_data["expired_in"]), now=now)
    _minimax_save_auth_state({
        "provider": "minimax-oauth", "region": "global", "portal_base_url": state["portal"], "inference_base_url": MINIMAX_OAUTH_GLOBAL_INFERENCE,
        "client_id": state["client_id"], "scope": MINIMAX_OAUTH_SCOPE, "token_type": token_data.get("token_type", "Bearer"),
        "access_token": token_data["access_token"], "refresh_token": token_data["refresh_token"], "resource_url": token_data.get("resource_url"),
        "obtained_at": now.isoformat(), "expires_at": datetime.fromtimestamp(expires_at, tz=timezone.utc).isoformat(), "expires_in": max(0, int(expires_at - now.timestamp())),
    })


Provider = tuple[Callable[[], tuple[dict, dict]], Callable[[Flow, dict], dict], Callable[[Flow, dict, dict], None]]
PROVIDERS: dict[str, Provider] = {
    "nous": (_nous_begin, _nous_wait, _nous_save),
    "openai-codex": (_codex_begin, _codex_wait, _codex_save),
    "xai-oauth": (_xai_begin, _xai_wait, _xai_save),
    "minimax-oauth": (_minimax_begin, _minimax_wait, _minimax_save),
}

_FLOWS: dict[str, Flow] = {}
_FLOWS_LOCK = threading.Lock()


def _ending(flow: Flow, exc: BaseException) -> tuple[str, str]:
    """Classify why a provider call ended without tokens: declined, expired, or another failure with its reason."""
    code = str(getattr(exc, "code", None) or getattr(exc, "oauth_error_code", None) or "")
    if flow.oauth_error == "access_denied" or code in ("access_denied", "authorization_denied"):
        return "denied", _DENIED
    if flow.oauth_error == "expired_token" or code in ("expired_token", "device_code_timeout", "timeout") or isinstance(exc, TimeoutError) or time.time() >= flow.expires_at:
        return "expired", _EXPIRED
    return "error", _first_line(exc)


def _run(flow: Flow, wait: Callable[[Flow, dict], dict], save: Callable[[Flow, dict, dict], None], state: dict) -> None:
    try:
        tokens = wait(flow, state)
        with flow.lock:
            if flow.status != "pending":  # cancelled or expired while the provider answered: nothing is saved
                return
            with scoped_home(flow.home):
                save(flow, state, tokens)
            flow.end("approved")
        log.info("oauth: %s sign-in approved (flow=%s)", flow.provider, flow.flow_id[:6])
    except _Stop:
        pass
    except Exception as exc:  # noqa: BLE001 - the thread has no caller; the ending is the flow's status
        with flow.lock:
            if flow.status == "pending":
                flow.end(*_ending(flow, exc))
        log.info("oauth: %s sign-in ended %s (flow=%s)", flow.provider, flow.status, flow.flow_id[:6])


def _cancel(flow: Flow) -> None:
    with flow.lock:
        if flow.status == "pending":
            flow.cancelled.set()
            flow.end("cancelled")


def _same_home(left: Path, right: Path) -> bool:
    try:
        return left.resolve() == right.resolve()
    except OSError:
        return False


def _gc(now: float) -> None:
    with _FLOWS_LOCK:
        for flow_id, flow in list(_FLOWS.items()):
            if flow.ended_at is not None and now - flow.ended_at > _ENDED_TTL:
                del _FLOWS[flow_id]


def _pending(home: Path, provider: str) -> list[Flow]:
    with _FLOWS_LOCK:
        return [f for f in _FLOWS.values() if f.provider == provider and f.status == "pending" and _same_home(f.home, home)]


def start(home: Path, provider: str, *, providers: dict[str, Provider] | None = None) -> dict:
    steps = (providers or PROVIDERS).get(provider)
    if steps is None:
        raise InvalidParams(f"{provider} has no device-code sign-in")
    begin, wait, save = steps
    _gc(time.time())
    # A new start replaces the pending flow for this home and provider before the code request, so an approval of the
    # old code that lands while the provider answers can no longer save. A start racing this one is caught below.
    for old in _pending(home, provider):
        _cancel(old)
    try:
        with scoped_home(home):
            display, state = begin()
    except RpcError:
        raise
    except Exception as exc:  # noqa: BLE001
        log.debug("oauth: %s start failed", provider, exc_info=True)
        raise RpcError(_first_line(exc), condition="oauth_failed") from exc
    if not str(display["verification_url"]).lower().startswith(("https://", "http://")):
        # The browser opens this link: anything but a web address is refused before a flow exists.
        raise RpcError("The provider answered an invalid sign-in link.", condition="oauth_failed")
    flow = Flow(secrets.token_urlsafe(16), provider, home, time.time() + int(display["expires_in"]), max(1, int(display["interval"])))
    superseded = _pending(home, provider)
    with _FLOWS_LOCK:
        _FLOWS[flow.flow_id] = flow
    for old in superseded:
        _cancel(old)
    threading.Thread(target=_run, args=(flow, wait, save, state), daemon=True, name=f"oauth-{flow.flow_id[:6]}").start()
    return {"flow_id": flow.flow_id, "provider": provider, "status": "pending", **display}


def _flow(home: Path, flow_id: str) -> Flow:
    with _FLOWS_LOCK:
        flow = _FLOWS.get(flow_id)
    if flow is None or not _same_home(flow.home, home):
        raise RpcError("Unknown or expired sign-in.", condition="oauth_flow_not_found")
    return flow


def poll(home: Path, flow_id: str) -> dict:
    flow = _flow(home, flow_id)
    if flow.status == "pending" and time.time() > flow.expires_at + _EXPIRY_GRACE:
        # The provider call outlived its code: end it now, and a late approval can no longer save.
        with flow.lock:
            if flow.status == "pending":
                flow.cancelled.set()
                flow.end("expired", _EXPIRED)
    return flow.view()


def cancel(home: Path, flow_id: str) -> dict:
    flow = _flow(home, flow_id)
    _cancel(flow)
    return flow.view()


def _flow_id(params: dict) -> str:
    flow_id = str(params.get("flow_id") or "").strip()
    if not flow_id:
        raise InvalidParams("flow_id is required")
    return flow_id


def register(reg) -> None:
    @reg.method("oauth.start")
    def start_(ctx: CallContext, params: dict) -> dict:
        provider = str(params.get("provider") or "").strip().lower()
        if not provider:
            raise InvalidParams("provider is required")
        return start(profile_home_param(params), provider)

    @reg.method("oauth.poll", requires_agent=False)
    def poll_(ctx: CallContext, params: dict) -> dict:
        return poll(profile_home_param(params), _flow_id(params))

    @reg.method("oauth.cancel", requires_agent=False)
    def cancel_(ctx: CallContext, params: dict) -> dict:
        return cancel(profile_home_param(params), _flow_id(params))
