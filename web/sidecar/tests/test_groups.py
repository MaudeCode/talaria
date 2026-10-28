"""Native room compatibility through the actual sidecar RPC boundary."""
from pathlib import Path
import subprocess
import asyncio
from types import SimpleNamespace

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, isolated_env, requires_agent


@requires_agent
def test_native_group_round_trip(tmp_path):
    if not (AGENT_DIR / "gateway/session_group_controls.py").exists():
        pytest.skip("this supported Agent has no native groups")
    env = isolated_env(tmp_path / "hermes", HERMES_WEBUI_AGENT_DIR=str(AGENT_DIR),
                       HERMES_WEBUI_PYTHON=str(AGENT_PYTHON),
                       PYTHONPATH=f"{SIDECAR_ROOT}:{Path(pytest.__file__).parent.parent}")
    result = subprocess.run([AGENT_PYTHON, str(Path(__file__).parent / "fixtures/group_peer.py")],
                            env=env, capture_output=True, text=True, timeout=150, check=False)
    assert result.returncode == 0, result.stdout + result.stderr


def test_canceled_room_read_detaches_native_rpc():
    from talaria_sidecar.errors import Cancelled
    from talaria_sidecar.methods.groups import _read
    async def probe():
        entered, detached = asyncio.Event(), asyncio.Event()
        ctx = SimpleNamespace(cancelled=False)
        def check():
            if ctx.cancelled:
                raise Cancelled()
        ctx.check_cancelled = check
        async def native():
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                detached.set()
        task = asyncio.create_task(_read(ctx, native()))
        await entered.wait()
        ctx.cancelled = True
        with pytest.raises(Cancelled):
            await task
        assert detached.is_set()
    asyncio.run(probe())
