"""The private session bridge's socket boundary on Linux (TAL-1977): synthetic owners, disposable sockets.

Usage: gateway_bridge_peer.py CHECK. Run by test_gateway_bridge.py on the Agent interpreter, whose websockets and native
client the bridge uses, one check per run over a fresh world. Prints ``CHECKS [...]`` with the checks it passed. Canonical admission, recovery and fences
through the bridge are proved on a real owner by gateway_session_peer.py's ``bridge`` mode, not by these echoes.
"""
import asyncio
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import socket
import sqlite3
import sys
import tempfile

if __name__ == "__main__":
    sys.path[:0] = [os.environ["TALARIA_WEB_AGENT_DIR"], str(Path(__file__).resolve().parents[2])]


def private_socket_dir():
    """A fresh 0700 directory short enough for a socket path, chosen as the Agent chooses its control socket's."""
    for base in (tempfile.gettempdir(), "/tmp"):
        base = os.path.realpath(base)
        if len(base) <= 64:
            return Path(tempfile.mkdtemp(prefix="b", dir=base))
    raise AssertionError("no temporary directory is short enough for a socket path")


def store(home, epoch, instance):
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    with sqlite3.connect(home / "state.db") as db:
        db.execute("CREATE TABLE IF NOT EXISTS runtime_epoch (singleton INTEGER PRIMARY KEY, epoch INTEGER NOT NULL, instance_id TEXT NOT NULL)")
        db.execute("INSERT OR REPLACE INTO runtime_epoch VALUES (1, ?, ?)", (epoch, instance))


def configure(home, path):
    (home / "config.yaml").write_text(json.dumps({"talaria": {"gateway_session_socket": str(path)}}))


class Owners:
    """Synthetic owners for the helper's discovery, one per Gateway home, and one loopback WebSocket standing in for
    their canonical sockets: it announces an event, answers each request with what it received and records frames."""

    def __init__(self, homes):
        from hermes_cli.gateway_runtime import GatewayDiscovery, GatewayEndpoint
        self.identity = {home: (instance, epoch) for home, (instance, epoch) in homes.items()}
        self.discovered, self.received, self.dialed = [], [], []
        self.discovery = lambda home: GatewayDiscovery("ready", GatewayEndpoint(
            profile_id=str(home), instance_id=self.identity[home][0], authority_epoch=self.identity[home][1], runtime_protocol=1,
            api_origin="http://127.0.0.1:9", supervisor="none", capabilities=frozenset({"session-authority-v1"}), code_sha="0" * 40))

    def discover(self, home, **_):
        self.discovered.append(home)
        return self.discovery(home)

    async def __aenter__(self):
        from websockets.asyncio.server import serve

        async def owner(connection):
            await connection.send(json.dumps({"jsonrpc": "2.0", "method": "event", "params": {"type": "owner.hello"}}))
            async for raw in connection:
                frame = json.loads(raw)
                self.received.append(frame)
                await connection.send(json.dumps({"jsonrpc": "2.0", "id": frame["id"], "result": {"echo": frame["method"], **frame["params"]}}))
        self.server = await serve(owner, "127.0.0.1", 0)
        port = self.server.sockets[0].getsockname()[1]

        @asynccontextmanager
        async def upstream(home, endpoint):
            from websockets.asyncio.client import connect
            self.dialed.append((home, endpoint.instance_id))
            async with connect(f"ws://127.0.0.1:{port}/") as connection:
                yield connection
        return upstream

    async def __aexit__(self, *exc):
        self.server.close()
        await self.server.wait_closed()


async def refused(code, coroutine):
    from talaria_sidecar.gateway_bridge import BridgeRefused
    try:
        await coroutine
    except BridgeRefused as exc:
        assert str(exc) == code, (str(exc), code)
    else:
        raise AssertionError(f"expected {code}")


def refused_now(code, call, *args, **kwargs):
    from talaria_sidecar.gateway_bridge import BridgeRefused
    try:
        call(*args, **kwargs)
    except BridgeRefused as exc:
        assert str(exc) == code, (str(exc), code)
    else:
        raise AssertionError(f"expected {code}")


async def attach_and_echo(home, bridge):
    """Discover, attach and run one RPC; returns the attested endpoint, the RPC answer and the first queued event."""
    from talaria_sidecar import gateway_bridge
    found = await asyncio.to_thread(gateway_bridge.discover, home, bridge)
    if found.endpoint is None:
        raise gateway_bridge.BridgeRefused(found.reason_code)
    async with gateway_bridge.attach(home, found.endpoint) as client:
        answer = await client.rpc("runtime.describe", probe=home.name)
        event = await asyncio.wait_for(client.events.get(), 10)
    return found.endpoint, answer, event


class World:
    """Two disposable homes for one deployment: the Gateway's (root, alpha, beta) and Web's own mount of them, whose
    stores name the synthetic owner holding each; one private socket path. Discovery is the synthetic owners'."""

    def __init__(self):
        from hermes_cli import gateway_runtime
        self.gw = Path(tempfile.mkdtemp()).resolve() / "gw"
        self.web = Path(tempfile.mkdtemp()).resolve() / "web"
        for profile in ("", "profiles/alpha", "profiles/beta"):
            (self.gw / profile).mkdir(mode=0o700, parents=True, exist_ok=True)
        self.owners = Owners({self.gw: ("root-owner", 3), self.gw / "profiles/alpha": ("alpha-owner", 5),
                              self.gw / "profiles/beta": ("beta-owner", 7)})
        store(self.web, 3, "root-owner")
        store(self.web / "profiles/alpha", 5, "alpha-owner")
        store(self.web / "profiles/beta", 7, "beta-owner")
        gateway_runtime.discover_gateway_endpoint = self.owners.discover
        self.private = private_socket_dir()
        self.path = self.private / "s"

    def bridge(self, profile="default", path=None):
        from talaria_sidecar.gateway_bridge import Bridge
        return Bridge(path or self.path, profile)

    @asynccontextmanager
    async def helper(self, profiles=("default", "alpha")):
        """The helper serving the synthetic owners; yields its stop event and awaits its exit."""
        from talaria_sidecar import gateway_bridge
        async with self.owners as upstream:
            gateway_bridge._upstream = upstream
            stop, listening = asyncio.Event(), asyncio.Event()
            task = asyncio.create_task(gateway_bridge.serve(self.path, self.gw, frozenset(profiles), stop=stop, ready=listening.set))
            await asyncio.wait_for(listening.wait(), 10)
            try:
                yield stop, task
            finally:
                stop.set()
                await asyncio.wait_for(task, 15)


async def check_config(world):
    """The profile's own file names only the socket; the profile follows the home's place in the layout."""
    from talaria_sidecar import gateway_bridge
    web = world.web
    assert gateway_bridge.configured(web) is None
    configure(web, "relative/session.sock")
    refused_now("bridge_config_invalid", gateway_bridge.configured, web)
    configure(web, world.path)
    configure(web / "profiles/alpha", world.path)
    assert gateway_bridge.configured(web) == world.bridge()
    assert gateway_bridge.configured(web / "profiles/alpha") == world.bridge("alpha")
    (web / "profiles/default").mkdir(mode=0o700)
    configure(web / "profiles/default", world.path)
    refused_now("bridge_profile_unlisted", gateway_bridge.configured, web / "profiles/default")


async def check_paths(world):
    """Canonical, absolute, never a link, this UID's only; startup never replaces a node or serves an unsafe home."""
    from talaria_sidecar import gateway_bridge
    private, path, gw = world.private, world.path, world.gw
    refused_now("bridge_path_unsafe", gateway_bridge.private_path, Path("relative"))
    refused_now("bridge_path_unsafe", gateway_bridge.private_path, private / ".." / private.name, directory=True)
    refused_now("bridge_socket_missing", gateway_bridge.private_path, path)
    linked = Path(tempfile.mkdtemp(dir=private.parent)) / "link"
    linked.symlink_to(private)
    refused_now("bridge_path_unsafe", gateway_bridge.private_path, linked, directory=True)
    os.chmod(private, 0o750)
    refused_now("bridge_path_unsafe", gateway_bridge.private_path, private, directory=True)
    os.chmod(private, 0o700)
    with socket.socket(socket.AF_UNIX) as loose:
        loose.bind(str(path))
        os.chmod(path, 0o660)
        refused_now("bridge_path_unsafe", gateway_bridge.private_path, path)
        (private / "alias").symlink_to(path)
        refused_now("bridge_path_unsafe", gateway_bridge.private_path, private / "alias")
        await refused("bridge_socket_exists", gateway_bridge.serve(path, gw, frozenset({"default"}), stop=asyncio.Event()))
        assert path.exists()
    os.unlink(path)
    await refused("bridge_profile_unsafe", gateway_bridge.serve(path, gw, frozenset({"gamma"}), stop=asyncio.Event()))
    (linked.parent / "gw-alias").symlink_to(gw)
    await refused("bridge_profile_unsafe", gateway_bridge.serve(path, linked.parent / "gw-alias", frozenset({"default"}), stop=asyncio.Event()))
    os.chmod(private, 0o755)
    await refused("bridge_path_unsafe", gateway_bridge.serve(path, gw, frozenset({"default"}), stop=asyncio.Event()))
    assert not os.path.lexists(path)


async def check_platform(world):
    """Without Linux peer credentials neither end connects or listens."""
    from talaria_sidecar import gateway_bridge
    real = sys.platform
    sys.platform = "darwin"
    try:
        found = await asyncio.to_thread(gateway_bridge.discover, world.web, world.bridge())
        assert (found.state, found.reason_code, found.endpoint) == ("inaccessible", "bridge_unsupported_platform", None), found
        await refused("bridge_unsupported_platform", gateway_bridge.serve(world.path, world.gw, frozenset({"default"}), stop=asyncio.Event()))
    finally:
        sys.platform = real
    assert not world.owners.discovered


async def check_relay(world):
    """One canonical relay per attach, in both directions; the reply names the owner and nothing to dial it with."""
    from talaria_sidecar import gateway_bridge
    async with world.helper():
        assert oct(os.lstat(world.path).st_mode & 0o777) == oct(0o600)
        endpoint, answer, event = await attach_and_echo(world.web, world.bridge())
        assert (endpoint.profile_id, endpoint.instance_id, endpoint.authority_epoch, endpoint.control_home) == (str(world.gw), "root-owner", 3, None)
        assert endpoint.bridge == world.bridge() and endpoint.code_sha == "0" * 40
        assert answer == {"echo": "runtime.describe", "probe": "web"}, answer
        assert event["params"] == {"type": "owner.hello"}, event
        assert world.owners.received == [{"jsonrpc": "2.0", "id": 1, "method": "runtime.describe", "params": {"probe": "web"}}]
        assert world.owners.dialed == [(world.gw, "root-owner")]
        async with gateway_bridge._open(world.bridge(), {"profile": "default", "attach": False}) as (_, reply):
            assert set(reply) == {"profile", "discovery"} and set(reply["discovery"]) == {"state", "reason_code", "endpoint"}
            assert set(reply["discovery"]["endpoint"]) == {"profile_id", "instance_id", "authority_epoch", "runtime_protocol",
                                                           "supervisor", "capabilities", "code_sha", "control_home"}
            assert "ticket" not in json.dumps(reply) and "127.0.0.1" not in json.dumps(reply)


async def check_profiles(world):
    """Each Web home reaches its own Gateway home; an unlisted profile and a crossed mapping reach no owner."""
    async with world.helper():
        endpoint, answer, _ = await attach_and_echo(world.web / "profiles/alpha", world.bridge("alpha"))
        assert (endpoint.profile_id, endpoint.instance_id) == (str(world.gw / "profiles/alpha"), "alpha-owner"), endpoint
        assert answer["probe"] == "alpha"
        await refused("bridge_profile_unlisted", attach_and_echo(world.web / "profiles/beta", world.bridge("beta")))
        # A helper whose mapping sends alpha to the root's owner.
        honest = world.owners.discovery
        world.owners.discovery = lambda home: honest(world.gw if home == world.gw / "profiles/alpha" else home)
        await refused("bridge_profile_mismatch", attach_and_echo(world.web / "profiles/alpha", world.bridge("alpha")))
        await refused("bridge_profile_mismatch", attach_and_echo(world.web, world.bridge("alpha")))
        assert world.owners.dialed == [(world.gw / "profiles/alpha", "alpha-owner")]


async def check_binding(world):
    """The attested owner must hold the store this side reads, or nothing is attached."""
    alpha = world.web / "profiles/alpha"
    async with world.helper():
        for epoch, instance in ((5, "another-deployment"), (4, "alpha-owner")):
            store(alpha, epoch, instance)
            await refused("bridge_owner_unbound", attach_and_echo(alpha, world.bridge("alpha")))
        os.unlink(alpha / "state.db")
        await refused("bridge_owner_unbound", attach_and_echo(alpha, world.bridge("alpha")))
        assert world.owners.dialed == []


async def check_peers(world):
    """Kernel credentials on both ends: a foreign client gets no answer and reaches no owner; a foreign helper is never
    sent a request."""
    from talaria_sidecar import gateway_bridge
    from websockets.asyncio.server import ServerConnection
    real = gateway_bridge.peer_uid
    async with world.helper():
        try:
            gateway_bridge.peer_uid = lambda c: os.getuid() + 1 if isinstance(c, ServerConnection) else real(c)
            await refused("bridge_unavailable", attach_and_echo(world.web, world.bridge()))
            gateway_bridge.peer_uid = lambda c: real(c) if isinstance(c, ServerConnection) else os.getuid() + 1
            await refused("bridge_peer_foreign", attach_and_echo(world.web, world.bridge()))
        finally:
            gateway_bridge.peer_uid = real
    assert world.owners.discovered == [] and world.owners.dialed == []


async def check_framing(world):
    """A malformed or oversized handshake gets no reply; a listener speaking another protocol is refused."""
    from talaria_sidecar import gateway_bridge
    from websockets.asyncio.client import unix_connect
    from websockets.asyncio.server import unix_serve
    from websockets.exceptions import ConnectionClosed
    async with world.helper():
        for raw in ("not json", json.dumps({"profile": "default"}), json.dumps({"profile": "default", "attach": False, "path": "/"}),
                    json.dumps({"profile": "x" * 2000, "attach": False})):
            async with unix_connect(str(world.path), subprotocols=[gateway_bridge.PROTOCOL]) as rogue:
                await rogue.send(raw)
                try:
                    answered = await asyncio.wait_for(rogue.recv(), 10)
                except ConnectionClosed:
                    answered = None
                assert answered is None, f"answered a malformed handshake: {raw[:40]}"
    other = world.private / "other"

    async def silent(connection):
        await connection.wait_closed()
    async with unix_serve(silent, str(other)):
        os.chmod(other, 0o600)
        await refused("bridge_protocol", attach_and_echo(world.web, world.bridge(path=other)))
    assert world.owners.discovered == []


async def check_shutdown(world):
    """Stopping the helper detaches every viewer, sends the owner nothing of its own and removes its socket."""
    from talaria_sidecar import gateway_bridge
    from hermes_cli.gateway_client import GatewayClientError
    async with world.helper() as (stop, task):
        found = await asyncio.to_thread(gateway_bridge.discover, world.web, world.bridge())
        async with gateway_bridge.attach(world.web, found.endpoint) as client:
            stop.set()
            await asyncio.wait_for(task, 15)
            try:
                await client.rpc("runtime.describe")
            except GatewayClientError:
                pass
            else:
                raise AssertionError("a relay outlived its helper")
    assert world.owners.received == [] and not os.path.lexists(world.path)


async def check_cleanup(world):
    """Shutdown removes only the inode it bound: a node someone else put at the path stays."""
    from talaria_sidecar import gateway_bridge
    stop, listening = asyncio.Event(), asyncio.Event()
    task = asyncio.create_task(gateway_bridge.serve(world.path, world.gw, frozenset({"default"}), stop=stop, ready=listening.set))
    await asyncio.wait_for(listening.wait(), 10)
    os.unlink(world.path)
    with socket.socket(socket.AF_UNIX) as stranger:
        stranger.bind(str(world.path))
        stop.set()
        await asyncio.wait_for(task, 15)
        assert os.path.lexists(world.path)


CHECKS = {"config": check_config, "paths": check_paths, "platform": check_platform, "relay": check_relay,
          "profiles": check_profiles, "binding": check_binding, "peers": check_peers, "framing": check_framing,
          "shutdown": check_shutdown, "cleanup": check_cleanup}


async def main(names):
    ran = []
    for name in names:
        await CHECKS[name](World())
        ran.append(name)
    print("CHECKS " + json.dumps(ran), flush=True)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:] or list(CHECKS)))
