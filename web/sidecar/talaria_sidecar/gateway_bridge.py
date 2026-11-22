"""Optional private Unix socket to a Gateway owner in another Linux network namespace (TAL-1977).

A Gateway's native bootstrap is loopback-only, so a Talaria Web container sharing its home still cannot
attach. The helper (``python -m talaria_sidecar.gateway_bridge``) runs in the Gateway's network namespace
with the installed Agent environment. It discovers the owner of an allowlisted profile, mints the native
ticket itself and relays canonical frames. It never starts or restarts a Gateway, writes history or sends a
ticket, path or diagnostic to the client.

Both ends require Linux same-UID peer credentials on a canonical, non-symlink socket in a private ``0700``
directory, the socket itself ``0600``. The client names a profile, never a path. The helper attests the
owner it reached; the client keeps Talaria's own owner checks and binds that owner to the ``state.db`` it
reads through its own mount of the profile home, so a socket repointed at another deployment or profile
fails closed instead of admitting a durable submission a second time.
"""
from __future__ import annotations

import argparse
import asyncio
from contextlib import asynccontextmanager, closing
from dataclasses import dataclass
from functools import cache
import json
import os
from pathlib import Path, PurePosixPath
import signal
import socket
import sqlite3
import sys

PROTOCOL = "talaria-gateway-session-bridge-v1"
# The native client's own frame ceiling (``connect_gateway``): a resume answer carries the whole history.
MAX_SIZE = 8 * 1024 * 1024
HANDSHAKE_TIMEOUT = 10
_HANDSHAKE_MAX = 1024
_SUPERVISORS = {"none", "systemd", "launchd", "windows", "external"}


class BridgeRefused(ConnectionError):
    """A bounded refusal code; never a path, peer diagnostic or credential."""


@dataclass(frozen=True)
class Bridge:
    socket: Path
    profile: str


def _profile_name(name: str) -> bool:
    from hermes_cli.profiles import _PROFILE_ID_RE
    return bool(_PROFILE_ID_RE.match(name)) and name != "default"


def configured(home: Path) -> Bridge | None:
    """The profile's opt-in bridge from its own ``config.yaml`` (``talaria.gateway_session_socket``), else None.

    The profile it asks for comes from the home's place in the server's layout (a named home is
    ``<root>/profiles/<name>``, anything else is the root alias ``default``), never from the config, so one
    profile's file cannot reach another's sessions."""
    from .methods.profiles import _yaml_load
    config = _yaml_load(home / "config.yaml")
    section = config.get("talaria") if isinstance(config, dict) else None
    value = section.get("gateway_session_socket") if isinstance(section, dict) else None
    if value is None:
        return None
    if not isinstance(value, str) or not value or not os.path.isabs(value):
        raise BridgeRefused("bridge_config_invalid")
    if home.parent.name != "profiles":
        return Bridge(Path(value), "default")
    if not _profile_name(home.name):
        raise BridgeRefused("bridge_profile_unlisted")
    return Bridge(Path(value), home.name)


def supported() -> bool:
    return sys.platform.startswith("linux") and hasattr(socket, "SO_PEERCRED")


def private_path(path: Path, *, directory: bool = False) -> os.stat_result:
    """A canonical absolute node of this UID that no group or other user can reach; never follows a link. The kind,
    owner and mode policy is the Agent's own for its control socket."""
    from hermes_cli.gateway_runtime_discovery import DiscoveryError, _private_node
    if not path.is_absolute() or os.path.normpath(path) != str(path) or os.path.realpath(path) != str(path):
        raise BridgeRefused("bridge_path_unsafe")
    try:
        return _private_node(path, kind="directory" if directory else "socket")
    except FileNotFoundError:
        raise BridgeRefused("bridge_socket_missing") from None
    except (DiscoveryError, OSError):
        raise BridgeRefused("bridge_path_unsafe") from None


def peer_uid(connection) -> int:
    from hermes_cli.gateway_runtime_discovery import socket_peer_uid
    peer = connection.transport.get_extra_info("socket")
    if peer is None or not supported():
        raise BridgeRefused("bridge_unsupported_platform")
    return socket_peer_uid(peer)


def check_peer(connection) -> None:
    """Kernel credentials of the connected process close the gap between the path check and the connect."""
    if peer_uid(connection) != os.getuid():
        raise BridgeRefused("bridge_peer_foreign")


# ---- Web side: discovery and attachment through the helper -------------------------------------------------


@cache
def _bridged_endpoint():
    from hermes_cli.gateway_runtime import GatewayEndpoint

    @dataclass(frozen=True)
    class BridgedEndpoint(GatewayEndpoint):
        """An owner the helper attested. ``bridge`` selects this transport in the session adapter's connector."""
        bridge: Bridge | None = None
    return BridgedEndpoint


def _attested(value, bridge: Bridge):
    """Rebuild the helper's discovery verdict so the adapter's own served, revision and describe checks apply."""
    from hermes_cli.gateway_runtime import GatewayDiscovery
    if not isinstance(value, dict) or not isinstance(value.get("state"), str):
        raise BridgeRefused("bridge_protocol")
    reason = value.get("reason_code")
    if reason is not None and not (isinstance(reason, str) and len(reason) <= 80 and reason.replace("_", "").isalnum()):
        raise BridgeRefused("bridge_protocol")
    raw = value.get("endpoint")
    if raw is None:
        return GatewayDiscovery(value["state"], reason_code=reason)
    if not isinstance(raw, dict):
        raise BridgeRefused("bridge_protocol")
    capabilities, control_home = raw.get("capabilities"), raw.get("control_home")
    if (not isinstance(raw.get("profile_id"), str) or not raw["profile_id"]
            or not isinstance(raw.get("instance_id"), str) or not raw["instance_id"]
            or type(raw.get("authority_epoch")) is not int or raw["authority_epoch"] <= 0
            or raw.get("runtime_protocol") != 1 or raw.get("supervisor") not in _SUPERVISORS
            or not isinstance(capabilities, list) or not all(isinstance(item, str) for item in capabilities)
            or not (control_home is None or isinstance(control_home, str) and control_home)
            or not (raw.get("code_sha") is None or isinstance(raw["code_sha"], str))):
        raise BridgeRefused("bridge_protocol")
    endpoint = _bridged_endpoint()(
        profile_id=raw["profile_id"], instance_id=raw["instance_id"], authority_epoch=raw["authority_epoch"],
        runtime_protocol=1, api_origin="", supervisor=raw["supervisor"], capabilities=frozenset(capabilities),
        control_home=control_home, code_sha=raw.get("code_sha") or None, bridge=bridge)
    return GatewayDiscovery(value["state"], endpoint, reason_code=reason)


def _mapped_profile(endpoint, bridge: Bridge) -> bool:
    """The helper's profile id is its own home path: a named profile's ends in ``profiles/<name>``; the root's does not."""
    path = PurePosixPath(endpoint.profile_id)
    named = path.parent.name == "profiles" and _profile_name(path.name)
    return path.name == bridge.profile and named if bridge.profile != "default" else not named


def _bound_store(home: Path, endpoint) -> bool:
    """Whether the attested owner holds this home's store: its ``runtime_epoch`` row names that owner's instance
    (and, for an owner serving its own home, its epoch). The row is the store's, so a socket that reaches another
    deployment or profile cannot match it. Read-only: opening SessionDB here would run its schema writer."""
    try:
        with closing(sqlite3.connect((home / "state.db").as_uri() + "?mode=ro", uri=True, timeout=5)) as db:
            row = db.execute("SELECT epoch, instance_id FROM runtime_epoch WHERE singleton=1").fetchone()
    except (sqlite3.Error, OSError):
        return False
    if row is None or row[1] != endpoint.instance_id:
        return False
    # A served profile's endpoint carries its multiplexer's epoch; its own store counts its own.
    return endpoint.control_home is not None or row[0] == endpoint.authority_epoch


# Refusals the helper names in its handshake reply; anything else it sends is a protocol error.
_REFUSALS = {"bridge_protocol", "bridge_profile_unlisted", "bridge_profile_unsafe", "bridge_unavailable"}


@asynccontextmanager
async def _open(bridge: Bridge, request: dict):
    if not supported():
        raise BridgeRefused("bridge_unsupported_platform")
    from websockets.asyncio.client import unix_connect
    private_path(bridge.socket.parent, directory=True)
    private_path(bridge.socket)
    try:
        connection = await unix_connect(str(bridge.socket), subprotocols=[PROTOCOL], open_timeout=HANDSHAKE_TIMEOUT,
                                        max_size=MAX_SIZE)
    except Exception as exc:  # noqa: BLE001 - a refused, absent or mismatched listener is one bounded refusal
        raise BridgeRefused("bridge_unavailable") from exc
    try:
        try:
            check_peer(connection)
            if connection.subprotocol != PROTOCOL:
                raise BridgeRefused("bridge_protocol")
            await connection.send(json.dumps(request))
            raw = await asyncio.wait_for(connection.recv(), HANDSHAKE_TIMEOUT)
        except BridgeRefused:
            raise
        except Exception as exc:  # noqa: BLE001 - a helper that hung up or never answered
            raise BridgeRefused("bridge_unavailable") from exc
        try:
            reply = json.loads(raw) if isinstance(raw, str) and len(raw) <= 64 * 1024 else None
        except ValueError:
            reply = None
        if not isinstance(reply, dict) or reply.get("profile") != bridge.profile:
            raise BridgeRefused("bridge_protocol")
        if "refused" in reply:
            raise BridgeRefused(reply["refused"] if reply["refused"] in _REFUSALS else "bridge_protocol")
        yield connection, reply
    finally:
        await connection.close()


def _verified(home: Path, bridge: Bridge, reply: dict):
    found = _attested(reply.get("discovery"), bridge)
    if found.endpoint is not None and not _mapped_profile(found.endpoint, bridge):
        raise BridgeRefused("bridge_profile_mismatch")
    if found.endpoint is not None and not _bound_store(home, found.endpoint):
        raise BridgeRefused("bridge_owner_unbound")
    return found


def discover(home: Path, bridge: Bridge):
    """The helper's attested discovery for this home, as ``gateway_runtime.discover_gateway_endpoint`` reports it."""
    from hermes_cli.gateway_runtime import GatewayDiscovery

    async def ask():
        async with _open(bridge, {"profile": bridge.profile, "attach": False}) as (_, reply):
            return reply
    try:
        return _verified(home, bridge, asyncio.run(ask()))
    except BridgeRefused as refused:
        return GatewayDiscovery("inaccessible", reason_code=str(refused))


@asynccontextmanager
async def attach(home: Path, endpoint):
    """A native ``GatewayClient`` on the helper's relay to exactly the owner ``endpoint`` names."""
    from hermes_cli.gateway_client import GatewayClient

    bridge = endpoint.bridge
    async with _open(bridge, {"profile": bridge.profile, "attach": True}) as (connection, reply):
        found = _verified(home, bridge, reply)
        attached = found.endpoint
        if (reply.get("attached") is not True or attached is None
                or (attached.profile_id, attached.instance_id, attached.authority_epoch)
                != (endpoint.profile_id, endpoint.instance_id, endpoint.authority_epoch)):
            raise BridgeRefused("owner_changed")
        async with GatewayClient(connection) as client:
            yield client


# ---- Gateway side: the helper ------------------------------------------------------------------------------


def profile_home(root: Path, profile: str, allowed: frozenset[str]) -> Path:
    """The helper's own home for an allowlisted profile name; the client never supplies a path."""
    if profile not in allowed or not (profile == "default" or _profile_name(profile)):
        raise BridgeRefused("bridge_profile_unlisted")
    home = root if profile == "default" else root / "profiles" / profile
    try:
        real = home.resolve(strict=True)
    except OSError:
        raise BridgeRefused("bridge_profile_unsafe") from None
    if real != home or not home.is_dir():
        raise BridgeRefused("bridge_profile_unsafe")
    return home


def _attest(found, home: Path) -> dict:
    endpoint = found.endpoint
    served = endpoint is not None and endpoint.control_home and Path(endpoint.control_home).resolve() != home
    return {"state": found.state, "reason_code": found.reason_code, "endpoint": None if endpoint is None else {
        "profile_id": endpoint.profile_id, "instance_id": endpoint.instance_id, "authority_epoch": endpoint.authority_epoch,
        "runtime_protocol": endpoint.runtime_protocol, "supervisor": endpoint.supervisor,
        "capabilities": sorted(endpoint.capabilities), "code_sha": endpoint.code_sha,
        "control_home": endpoint.control_home if served else None}}


@asynccontextmanager
async def _upstream(home: Path, endpoint):
    """The owner's canonical WebSocket on loopback, with a ticket this helper minted and never forwards."""
    from websockets.asyncio.client import connect
    from hermes_cli.gateway_client import GATEWAY_WS_PROTOCOL, _session_ticket, gateway_ws_target
    from hermes_cli.gateway_runtime import gateway_profile_home

    ticket = await asyncio.to_thread(_session_ticket, gateway_profile_home(home), endpoint)
    url, protocols = gateway_ws_target(endpoint, ticket)
    async with connect(url, subprotocols=protocols, open_timeout=HANDSHAKE_TIMEOUT, max_size=MAX_SIZE, proxy=None) as upstream:
        if upstream.subprotocol != GATEWAY_WS_PROTOCOL:
            raise BridgeRefused("owner_protocol")
        yield upstream


async def _forward(source, target) -> None:
    async for frame in source:
        await target.send(frame)


async def handle(connection, *, root: Path, profiles: frozenset[str]) -> None:
    from hermes_cli import gateway_runtime

    tasks: list[asyncio.Task] = []
    try:
        # A foreign peer gets no answer at all.
        check_peer(connection)
        raw = await asyncio.wait_for(connection.recv(), HANDSHAKE_TIMEOUT)
        request = json.loads(raw) if isinstance(raw, str) and len(raw) <= _HANDSHAKE_MAX else None
        if (not isinstance(request, dict) or set(request) != {"profile", "attach"}
                or not isinstance(request["profile"], str) or len(request["profile"]) > 64 or type(request["attach"]) is not bool):
            raise BridgeRefused("bridge_protocol")
        try:
            home = profile_home(root, request["profile"], profiles)
        except BridgeRefused as refused:
            await connection.send(json.dumps({"profile": request["profile"], "refused": str(refused)}))
            raise
        found = await asyncio.to_thread(gateway_runtime.discover_gateway_endpoint, home)
        reply = {"profile": request["profile"], "discovery": _attest(found, home)}
        if not request["attach"]:
            await connection.send(json.dumps(reply))
            return
        if not gateway_runtime.attachable(found):
            await connection.send(json.dumps({**reply, "attached": False}))
            return
        async with _upstream(home, found.endpoint) as upstream:
            await connection.send(json.dumps({**reply, "attached": True}))
            tasks = [asyncio.create_task(_forward(connection, upstream)), asyncio.create_task(_forward(upstream, connection))]
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except Exception:  # noqa: BLE001 - no endpoint, ticket, path or remote error reaches the client or the log
        pass
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        # Closing the relay detaches this viewer; the owner keeps every admission and running turn.
        await connection.close(code=1011 if not tasks else 1000)


async def serve(path: Path, root: Path, profiles: frozenset[str], *, stop: asyncio.Event, ready=None) -> None:
    """Listen until ``stop``. Never replaces an existing node at ``path``; removes only the socket it created."""
    if not supported():
        raise BridgeRefused("bridge_unsupported_platform")
    from websockets.asyncio.server import unix_serve
    try:
        canonical = root.is_absolute() and root.resolve(strict=True) == root
    except OSError:
        canonical = False
    if not canonical:
        raise BridgeRefused("bridge_profile_unsafe")
    if not profiles:
        raise BridgeRefused("bridge_profile_unlisted")
    for profile in profiles:
        profile_home(root, profile, profiles)
    private_path(path.parent, directory=True)
    if os.path.lexists(path):
        raise BridgeRefused("bridge_socket_exists")
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    identity = None
    try:
        # The directory is private, so nobody can connect between the bind and the chmod.
        listener.bind(str(path))
        os.chmod(path, 0o600)
        identity = private_path(path)
        listener.listen(64)
        listener.setblocking(False)

        async def accept(connection):
            await handle(connection, root=root, profiles=profiles)
        async with unix_serve(accept, sock=listener, subprotocols=[PROTOCOL], origins=[None],
                              max_size=MAX_SIZE, open_timeout=HANDSHAKE_TIMEOUT):
            if ready is not None:
                ready()
            await stop.wait()
    finally:
        listener.close()
        if identity is not None:
            try:
                current = os.lstat(path)
                if (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino):
                    os.unlink(path)
            except FileNotFoundError:
                pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m talaria_sidecar.gateway_bridge", description=__doc__.split("\n\n")[0])
    parser.add_argument("--socket", required=True, help="canonical absolute socket path in a private 0700 directory")
    parser.add_argument("--home", required=True, help="the Gateway's canonical HERMES_HOME as this helper sees it")
    parser.add_argument("--profile", action="append", required=True, help="an allowed profile name; default is the root")
    args = parser.parse_args(argv)
    os.umask(0o077)

    async def run() -> None:
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, stop.set)
        await serve(Path(args.socket), Path(args.home), frozenset(args.profile), stop=stop,
                    ready=lambda: print("gateway session bridge listening", flush=True))
    try:
        asyncio.run(run())
    except BridgeRefused as refused:
        print(f"gateway session bridge refused to start: {refused}", file=sys.stderr)
        return 1
    except OSError:
        print("gateway session bridge could not start; check its socket directory and profile homes", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
