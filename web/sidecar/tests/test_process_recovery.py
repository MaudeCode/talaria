"""TAL-533: a restarted sidecar re-adopts the background processes the Agent checkpointed per profile home."""

from __future__ import annotations

import json
import pathlib
import subprocess
import time

from conftest import SidecarProcess, requires_agent
from talaria_sidecar import SIDECAR_RPC_VERSION
from test_process_delivery import _agent


def _checkpoint(home: pathlib.Path, process_id: str, pid: int, session_key: str) -> None:
    """The ``processes.json`` entry a previous run's Agent wrote for a live notified process."""
    start = json.loads(_agent(home, "from gateway.status import get_process_start_time; print(json.dumps(get_process_start_time(int(sys.argv[2]))))", str(pid)))
    entry = {"session_id": process_id, "command": "sleep 300", "pid": pid, "pid_scope": "host", "host_start_time": start, "cwd": str(home),
             "started_at": time.time(), "task_id": session_key, "owner_task_id": session_key, "session_key": session_key, "notify_on_complete": True}
    (home / "processes.json").write_text(json.dumps([entry]))


def _checkpointed_ids(home: pathlib.Path) -> list[str]:
    return [e["session_id"] for e in json.loads((home / "processes.json").read_text())]


def _drain_until(sidecar: SidecarProcess, home: pathlib.Path, process_id: str) -> dict:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        for evt in sidecar.result("process.drain", {"profile_home": str(home)})["events"]:
            if evt["process_id"] == process_id:
                return evt
        time.sleep(0.2)
    raise AssertionError(f"no completion for {process_id}")


@requires_agent
def test_a_checkpointed_process_is_listed_after_restart_and_its_exit_completes_its_session(hermes_home: pathlib.Path) -> None:
    other = hermes_home / "profiles" / "work"
    other.mkdir(parents=True)
    sleepers = [subprocess.Popen(["sleep", "300"]) for _ in range(2)]
    _checkpoint(hermes_home, "proc_launch", sleepers[0].pid, "web-a")
    _checkpoint(other, "proc_work", sleepers[1].pid, "web-b")
    sidecar = SidecarProcess(hermes_home)
    try:
        assert sidecar.result("runtime.handshake", {"rpc_version": SIDECAR_RPC_VERSION})["compatible"]
        # The launch profile's drain runs first; the other profile's checkpoint must survive it.
        assert sidecar.result("process.drain", {"profile_home": str(hermes_home)})["events"] == []
        assert _checkpointed_ids(other) == ["proc_work"]
        for home, session, process_id in ((hermes_home, "web-a", "proc_launch"), (other, "web-b", "proc_work")):
            listed = sidecar.result("process.background_list", {"profile_home": str(home), "session_ids": [session]})["processes"]
            assert [(p["process_id"], p["session_key"], p["exited"]) for p in listed] == [(process_id, session, False)]
            assert process_id in _checkpointed_ids(home)

        sleepers[0].kill()
        sleepers[0].wait()
        evt = _drain_until(sidecar, hermes_home, "proc_launch")
        assert (evt["type"], evt["session_key"], evt["consumed"]) == ("completion", "web-a", False)
        listed = sidecar.result("process.background_list", {"profile_home": str(hermes_home), "session_ids": ["web-a"]})["processes"]
        assert [(p["process_id"], p["exited"]) for p in listed] == [("proc_launch", True)]
    finally:
        sidecar.close()
        for proc in sleepers:
            proc.kill()
            proc.wait()
