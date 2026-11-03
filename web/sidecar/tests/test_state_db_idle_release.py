"""TAL-1746: a burst of ``state_db.*`` writes to one home moves that home's idle deadline instead of starting an idle
timer thread per write. In-process, with a stand-in handle registry."""

from __future__ import annotations

import sys
import threading
import time
import types

from talaria_sidecar.methods import state_db


def test_a_write_burst_keeps_one_idle_thread_and_releases_every_reference(monkeypatch, tmp_path) -> None:
    acquired, released = [], []
    registry = types.ModuleType("hermes_state_registry")
    registry.acquire = lambda path: acquired.append(types.SimpleNamespace(ensure_session=lambda **kwargs: None)) or acquired[-1]
    registry.release_or_close = released.append
    monkeypatch.setitem(sys.modules, "hermes_state_registry", registry)
    monkeypatch.setattr(state_db, "_pins", {})
    monkeypatch.setattr(state_db, "_idle_threads", {}, raising=False)
    monkeypatch.setattr(state_db, "_IDLE_RELEASE_S", 0.3)
    (tmp_path / "state.db").touch()
    started, live = [], []
    start = threading.Thread.start

    def counting_start(thread):
        started.append(thread)
        start(thread)

    monkeypatch.setattr(threading.Thread, "start", counting_start)
    for n in range(20):
        assert state_db.sync_session_start(tmp_path, f"webui-{n}")
        live.append(sum(thread.is_alive() for thread in started))
    assert max(live) == 1
    assert len(started) == 1
    # Idle past the last write's deadline: the one pin is given back and its thread exits.
    started[0].join(5)
    assert not started[0].is_alive()
    assert sorted(map(id, released)) == sorted(map(id, acquired))
