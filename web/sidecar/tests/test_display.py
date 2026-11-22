"""TAL-2380: the owner's Bot Screen through ``display.*``: status, one connection per viewer, and control on it."""
import asyncio
import io
from contextlib import asynccontextmanager, nullcontext
import sys
import threading
from types import SimpleNamespace

import pytest

from talaria_sidecar.errors import RpcError
from talaria_sidecar.methods import display
from talaria_sidecar.rpc import CallContext, RpcServer


class OwnerRefused(Exception):
    def __init__(self, reason, code=None):
        super().__init__(reason)
        self.unknown_method = code == -32601


@pytest.fixture
def owner(tmp_path, monkeypatch):
    """One owner for ``tmp_path``: each connection mints its own viewer id, and every call is kept with its connection."""
    state = SimpleNamespace(calls=[], connections=0, status=None, endpoint=SimpleNamespace(api_origin="http://127.0.0.1:47231", bridge=None, control_home=None))

    @asynccontextmanager
    async def connect(home, endpoint):
        assert home == tmp_path.resolve() and endpoint is state.endpoint
        state.connections += 1
        connection = state.connections

        async def rpc(method, **params):
            state.calls.append((connection, method, params))
            if method == "display.status":
                if isinstance(state.status, Exception):
                    raise state.status
                return state.status
            if method == "display.observe":
                return {"ticket": "tic/ket+1", "path": "/api/display/ws", "viewer_id": f"minted-{connection}", "running": True}
            if method in {"display.lease.acquire", "display.lease.release"}:
                held = method.endswith("acquire")
                return {"lease": {"holder": "human" if held else "agent", "viewer_id": None, "viewer_hash": "abc" if held else None, "epoch": 2}}
            raise AssertionError(method)
        yield SimpleNamespace(rpc=rpc), asyncio.Queue()

    monkeypatch.setitem(sys.modules, "hermes_cli.gateway_client", SimpleNamespace(GatewayRPCError=OwnerRefused))
    monkeypatch.setattr(display, "_owner", lambda home: (state.endpoint, None))
    # Profile scoping is home.py's own contract; these cases exercise only what crosses the owner connection.
    monkeypatch.setattr(display, "scoped_home", lambda home: nullcontext())
    monkeypatch.setattr(display, "_connect", connect)
    return state


def test_status_carries_the_owner_screen_without_its_viewer_ids(owner, tmp_path):
    owner.status = {"profile": "default", "supported": True, "installed": False, "missing": ["Xvnc"], "running": False,
                    "install_command": "sudo apt-get install -y tigervnc-standalone-server", "geometry": "1280x800",
                    "lease": {"holder": "human", "viewer_id": None, "viewer_hash": "abc", "since": 1.0, "epoch": 3}, "profile_key": "k"}
    assert display.status({"profile_home": str(tmp_path)}) == {"state": "ready", "reason": None, "status": {
        "supported": True, "installed": False, "running": False, "install_command": "sudo apt-get install -y tigervnc-standalone-server",
        "lease": {"holder": "human", "viewer_hash": "abc"}}}


def test_an_owner_without_display_methods_has_no_screen(owner, tmp_path):
    owner.status = OwnerRefused("unknown_method", -32601)
    assert display.status({"profile_home": str(tmp_path)}) == {"state": "unavailable", "reason": "display_unsupported", "status": None}


def test_a_view_keeps_its_ticket_to_the_server_and_controls_through_its_own_connection(owner, tmp_path):
    frames, ready = [], threading.Event()

    class Recorded(CallContext):
        """The sidecar's own call context, recording what it emits."""
        def emit(self, event, data=None):
            super().emit(event, data)
            frames.append((event, data))
            ready.set()
    ctx = Recorded(RpcServer({}, stdout=io.BytesIO()), 7, "display.view")
    result = {}
    viewer = threading.Thread(target=lambda: result.update(display.view(ctx, {"profile_home": str(tmp_path)})))
    viewer.start()
    assert ready.wait(10)
    (event, data), = frames
    assert event == "ready"
    assert data["rfb_url"] == "ws://127.0.0.1:47231/api/display/ws?display_ticket=tic%2Fket%2B1"
    assert set(data) == {"rfb_url", "view_id", "viewer_hash"} and "minted" not in repr(data)

    assert display.lease({"view_id": data["view_id"]}, "acquire") == {"lease": {"holder": "human", "viewer_hash": "abc"}}
    ctx.cancel_event.set()
    viewer.join(10)
    assert result == {"ended": True}
    # Observe, take over and the closing hand-back all ride the view's one connection, under the id it minted.
    assert owner.calls == [(1, "display.observe", {}), (1, "display.lease.acquire", {"viewer_id": "minted-1"}), (1, "display.lease.release", {"viewer_id": "minted-1"})]
    with pytest.raises(RpcError) as closed:
        display.lease({"view_id": data["view_id"]}, "release")
    assert closed.value.data == {"condition": "screen_view_closed"}
