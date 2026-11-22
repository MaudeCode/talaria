"""TAL-2380: the profile owner's Bot Screen (``display.*``) for Talaria's viewer.

Every call reaches the owner already running for the profile and never starts one. ``display.view`` holds one owner
connection per viewer, because the owner mints a viewer id per connection and takes or hands back control only for an
id that connection minted. The display ticket and the viewer id stay in the sidecar and the server.
"""
from __future__ import annotations

import asyncio
from contextlib import suppress
import hashlib
from pathlib import Path
import secrets
import threading
from urllib.parse import quote

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from .gateway_sessions import _connect, _discover, _served

# view id → (the view's event loop, its owner client, the viewer id the owner minted on that connection)
_VIEWS: dict[str, tuple[asyncio.AbstractEventLoop, object, str]] = {}
_VIEWS_LOCK = threading.Lock()
_LEASE_TIMEOUT_S = 10.0


def _unavailable(reason: str) -> dict:
    return {"state": "unavailable", "reason": reason, "status": None}


def _owner(home: Path):
    """``(endpoint, None)`` for the owner whose display Talaria can view, else ``(None, reason)``."""
    from hermes_cli.gateway_runtime import attachable
    discovery = _discover(home)
    if discovery.endpoint is None or discovery.state != "ready" or not attachable(discovery):
        return None, discovery.reason_code or discovery.state or "owner_unavailable"
    endpoint = discovery.endpoint
    # A private bridge (TAL-1977) carries RPC but no route to the owner's display socket; a served profile's screen
    # answers only to its own profile name.
    if getattr(endpoint, "bridge", None) is not None or not getattr(endpoint, "api_origin", ""):
        return None, "screen_unreachable"
    if _served(home, endpoint):
        return None, "served_profile_screen_unavailable"
    return endpoint, None


def _lease(value) -> dict:
    lease = value if isinstance(value, dict) else {}
    holder = "human" if lease.get("holder") == "human" else "agent"
    viewer_hash = lease.get("viewer_hash")
    return {"holder": holder, "viewer_hash": viewer_hash if isinstance(viewer_hash, str) else None}


def _status(value: dict) -> dict:
    command = value.get("install_command")
    return {"supported": value.get("supported") is True, "installed": value.get("installed") is True,
            "running": value.get("running") is True, "install_command": command if isinstance(command, str) and command else None,
            "lease": _lease(value.get("lease"))}


async def _read_status(home: Path, endpoint) -> dict:
    from hermes_cli.gateway_client import GatewayRPCError
    async with _connect(home, endpoint) as (client, _events):
        try:
            return {"state": "ready", "reason": None, "status": _status(await client.rpc("display.status"))}
        except GatewayRPCError as exc:
            return _unavailable("display_unsupported" if exc.unknown_method else str(exc))


def status(params: dict) -> dict:
    home = profile_home_param(params).resolve()
    with scoped_home(home):
        endpoint, reason = _owner(home)
        if endpoint is None:
            return _unavailable(reason)
        try:
            return asyncio.run(_read_status(home, endpoint))
        except Exception:  # noqa: BLE001 - a lost owner is an unavailable screen; peer diagnostics stay here
            return _unavailable("owner_connection_lost")


def _rfb_url(endpoint, observed: dict) -> str:
    path, ticket = observed.get("path"), observed.get("ticket")
    if not isinstance(path, str) or not path.startswith("/") or not isinstance(ticket, str) or not ticket:
        raise RpcError("The owner did not open its screen", condition="screen_unavailable")
    origin = endpoint.api_origin.replace("https:", "wss:", 1).replace("http:", "ws:", 1)
    return f"{origin}{path}?display_ticket={quote(ticket, safe='')}"


async def _discard(events: asyncio.Queue) -> None:
    # The owner broadcasts screen and session events to every client; a viewer reads none of them.
    while True:
        await events.get()


async def _view(ctx, home: Path, endpoint) -> dict:
    async with _connect(home, endpoint) as (client, events):
        observed = await client.rpc("display.observe")
        viewer_id = observed.get("viewer_id") if isinstance(observed, dict) else None
        if not isinstance(viewer_id, str) or not viewer_id:
            raise RpcError("The owner did not open its screen", condition="screen_unavailable")
        rfb_url = _rfb_url(endpoint, observed)
        loop = asyncio.get_running_loop()
        stop = asyncio.Event()
        add_waker = getattr(getattr(ctx, "cancel_event", None), "add_waker", None)
        if callable(add_waker):
            add_waker(lambda: loop.call_soon_threadsafe(stop.set))
        view_id = secrets.token_urlsafe(16)
        drain = asyncio.create_task(_discard(events))
        with _VIEWS_LOCK:
            _VIEWS[view_id] = (loop, client, viewer_id)
        try:
            ctx.emit("ready", {"rfb_url": rfb_url, "view_id": view_id,
                               "viewer_hash": hashlib.sha256(viewer_id.encode()).hexdigest()[:12]})
            if not ctx.cancelled:
                await stop.wait()
        finally:
            with _VIEWS_LOCK:
                _VIEWS.pop(view_id, None)
            drain.cancel()
            # A closed viewer hands back what it still holds; the owner ignores it otherwise.
            with suppress(Exception):
                await asyncio.wait_for(client.rpc("display.lease.release", viewer_id=viewer_id), _LEASE_TIMEOUT_S)
    return {"ended": True}


def view(ctx, params: dict) -> dict:
    home = profile_home_param(params).resolve()
    with scoped_home(home):
        endpoint, reason = _owner(home)
        if endpoint is None:
            raise RpcError(f"The screen is unavailable ({reason})", condition="screen_unavailable")
        return asyncio.run(_view(ctx, home, endpoint))


def lease(params: dict, action: str) -> dict:
    from hermes_cli.gateway_client import GatewayRPCError
    view_id = params.get("view_id")
    if not isinstance(view_id, str) or not view_id:
        raise InvalidParams("view_id is required")
    with _VIEWS_LOCK:
        entry = _VIEWS.get(view_id)
    if entry is None:
        raise RpcError("That screen view is not open", condition="screen_view_closed")
    loop, client, viewer_id = entry
    method = "display.lease.acquire" if action == "acquire" else "display.lease.release"
    try:
        result = asyncio.run_coroutine_threadsafe(client.rpc(method, viewer_id=viewer_id), loop).result(_LEASE_TIMEOUT_S)
    except GatewayRPCError as exc:
        raise RpcError(f"The owner refused ({exc})", condition="screen_lease_refused") from None
    except Exception:  # noqa: BLE001 - a lost or slow owner connection; its diagnostics stay here
        raise RpcError("The screen viewer lost its owner", condition="screen_unavailable") from None
    return {"lease": _lease(result.get("lease") if isinstance(result, dict) else None)}


def register(registry) -> None:
    @registry.method("display.status")
    def status_(ctx, params: dict) -> dict:
        return status(params)

    @registry.method("display.view")
    def view_(ctx, params: dict) -> dict:
        return view(ctx, params)

    @registry.method("display.lease.acquire")
    def acquire_(ctx, params: dict) -> dict:
        return lease(params, "acquire")

    @registry.method("display.lease.release")
    def release_(ctx, params: dict) -> dict:
        return lease(params, "release")
