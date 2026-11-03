"""Runtime lifetime owns the optional native worker, never status/OAuth reads."""
import sys
from types import ModuleType, SimpleNamespace

import pytest

from talaria_sidecar.runtime import AgentIncompatible, AgentRuntime, AgentRuntimeStale


@pytest.fixture
def native(tmp_path, monkeypatch):
    events = []
    thread = SimpleNamespace(is_alive=lambda: True)
    worker = SimpleNamespace(start_worker=lambda: (events.append("start"), thread)[1],
                             stop_worker=lambda timeout: events.append(("stop", timeout)))
    monkeypatch.setitem(sys.modules, "run_agent", SimpleNamespace(AIAgent=object))
    package = ModuleType("hermes_cli")
    package.__path__ = []
    monkeypatch.setitem(sys.modules, "hermes_cli", package)
    monkeypatch.setitem(sys.modules, "hermes_cli.auth", ModuleType("hermes_cli.auth"))
    monkeypatch.setitem(sys.modules, "hermes_cli.guest_handoff", worker)
    return AgentRuntime(tmp_path / "home"), worker, events


@pytest.mark.parametrize("all_profiles", [True, False], ids=["native-all-profiles", "launch-profile-only"])
def test_worker_starts_once_and_retirement_prevents_restart(native, monkeypatch, all_profiles):
    from talaria_sidecar import agent_mutation
    from talaria_sidecar import runtime as module

    runtime, worker, events = native
    if all_profiles:  # Agent 0.22.5 retries every profile itself
        worker.retry_all_profiles = lambda: []
    monkeypatch.setattr("talaria_sidecar.runtime.read_agent_revision", lambda *args: "a" * 40)
    runtime.load()
    runtime.load()
    runtime.describe()
    assert events == ["start"]
    tick = module._profile_handoff_thread
    assert (tick is None) is all_profiles and (all_profiles or tick.is_alive())
    runtime.retire()
    runtime.retire()
    assert events == ["start", ("stop", None)]
    assert module._profile_handoff_thread is None and (tick is None or not tick.is_alive())
    described = runtime.describe()
    assert described["compatible"] is False, "retired runtime still advertises readiness to dependency recovery"
    assert described["stale"] is True
    assert runtime.loaded is False
    monkeypatch.setattr(agent_mutation, "recovery_receipts", lambda *args, **kwargs: (["debt"], None))
    recovered = agent_mutation.recover_retained(runtime, None, complete_revision=runtime.revision)
    assert recovered["ok"] is False and recovered["owed"] is True
    assert recovered["detail"] == "The loaded Agent runtime does not match the recovered revision."
    with pytest.raises(AgentRuntimeStale):
        runtime.load()


def test_older_agent_without_worker_still_loads(native, monkeypatch):
    runtime, _, events = native
    monkeypatch.delitem(sys.modules, "hermes_cli.guest_handoff")
    runtime.load()
    assert runtime.loaded
    runtime.retire()
    assert runtime.loaded
    runtime.load()
    assert events == []


@pytest.mark.parametrize("failure", ["start", "dead", "import"])
def test_present_worker_failure_is_not_compatible(native, monkeypatch, failure):
    runtime, worker, events = native
    def fail():
        raise RuntimeError("synthetic startup failure")
    if failure == "start":
        worker.start_worker = fail
    elif failure == "dead":
        worker.start_worker = lambda: SimpleNamespace(is_alive=lambda: False)
    else:
        from talaria_sidecar import runtime as module
        real_import = module.importlib.import_module
        def import_module(name):
            if name == "hermes_cli.guest_handoff":
                raise ModuleNotFoundError("nested dependency unavailable", name="nested_dependency")
            return real_import(name)
        monkeypatch.setattr(module.importlib, "import_module", import_module)
    with pytest.raises(AgentIncompatible):
        runtime.load()
    assert not runtime.describe()["compatible"]
    if failure != "import":
        assert ("stop", None) in events


def test_source_drift_releases_worker(native, monkeypatch):
    runtime, _, events = native
    runtime.load()
    runtime.revision = "a" * 40
    from talaria_sidecar import runtime as module
    monkeypatch.setattr(module, "read_agent_revision", lambda *args: "b" * 40)
    assert runtime.is_stale()
    assert events == ["start", ("stop", None)]


def test_repair_obligation_releases_worker(native, monkeypatch):
    runtime, _, events = native
    runtime.load()
    monkeypatch.setattr(runtime, "web_repair_state", lambda: "present")
    with pytest.raises(AgentRuntimeStale):
        runtime.ensure_current()
    assert events == ["start", ("stop", None)]


@pytest.mark.parametrize("boundary", ["dependencies", "recovery"])
def test_mutation_releases_worker_before_starting_writer(native, monkeypatch, tmp_path, boundary):
    from talaria_sidecar import agent_mutation
    from talaria_sidecar.methods import Registry
    from talaria_sidecar.methods import runtime as methods

    runtime, _, events = native
    runtime.load()
    root = tmp_path / "agent"
    (root / "hermes_cli").mkdir(parents=True)
    (root / "hermes_cli/venv_sync.py").touch()
    runtime.agent_dir = root
    class WriterReached(Exception):
        pass
    def writer(*args, **kwargs):
        assert events == ["start", ("stop", None)], "writer started before native handoff released"
        raise WriterReached
    monkeypatch.setattr(agent_mutation.subprocess, "Popen", writer)
    if boundary == "dependencies":
        registry = Registry(runtime)
        methods.register(registry)
        with pytest.raises(WriterReached):
            registry.methods["runtime.sync_dependencies"](None, {"agent_dir": str(root)})
    else:
        monkeypatch.setattr(agent_mutation, "recovery_receipts", lambda *args, **kwargs: (["debt"], None))
        assert agent_mutation.recover_retained(runtime, None, probe=True)["owed"]
        assert events == ["start"], "recovery status read stopped native work"
        with pytest.raises(WriterReached):
            agent_mutation.recover_retained(runtime, None)


@pytest.mark.parametrize("accepted", [False, True])
def test_only_an_accepted_update_lease_retires_runtime(native, monkeypatch, tmp_path, accepted):
    import io
    from talaria_sidecar import agent_mutation

    runtime, _, events = native
    runtime.load()
    runtime.agent_dir = tmp_path / "agent"
    runtime.agent_dir.mkdir()
    process = SimpleNamespace(stdin=io.StringIO(), stdout=io.StringIO(), wait=lambda **kwargs: 0)
    monkeypatch.setattr(agent_mutation.subprocess, "Popen", lambda *args, **kwargs: process)
    monkeypatch.setattr(agent_mutation, "_exchange", lambda *args: {"ok": accepted})
    try:
        result = agent_mutation.call(runtime, None, {"action": "begin", "agent_dir": str(runtime.agent_dir),
            "revision": "a" * 40, "homes": [str(runtime.hermes_home)]})
        assert result["ok"] is accepted
        assert events == (["start", ("stop", None)] if accepted else ["start"])
        if not accepted:
            runtime.load()
    finally:
        agent_mutation.close_all()
        runtime.retire()


def test_profile_tick_drains_each_named_profile_owning_an_active_record(tmp_path, monkeypatch):
    import contextlib
    from pathlib import Path
    import re
    from talaria_sidecar import home, runtime as module

    base = tmp_path / "base"
    for name in ("broken", "due", "settled", "unowned"):
        (base / "profiles" / name).mkdir(parents=True)

    def profile(name):
        return str(base / "profiles" / name)

    records = {"due": {"state": "retrying", "profiles": [profile("due"), str(base)]},
               "broken": {"state": "pending", "profiles": [profile("broken")]},
               "settled": {"state": "claimed", "profiles": [profile("settled")]},
               "deleted": {"state": "retrying", "profiles": [profile("deleted")]}}
    scope, drained = [], []

    @contextlib.contextmanager
    def scoped_home(path, **options):
        assert options == {"recover_processes": False}
        scope.append(Path(path).name)
        yield path

    def drain():
        if scope[-1] == "broken":
            raise TimeoutError("records lock busy")
        drained.append(scope[-1])

    profiles = ModuleType("hermes_cli.profiles")
    profiles._PROFILE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
    constants = ModuleType("hermes_constants")
    constants.hermes_home_key = lambda path: str(Path(path).resolve())
    monkeypatch.setitem(sys.modules, "hermes_cli", ModuleType("hermes_cli"))
    monkeypatch.setitem(sys.modules, "hermes_cli.profiles", profiles)
    monkeypatch.setitem(sys.modules, "hermes_constants", constants)
    monkeypatch.setattr(home, "_PROCESS_HOME", base)
    monkeypatch.setattr(home, "scoped_home", scoped_home)
    native = SimpleNamespace(_load=lambda path: {"records": records}, _records_path=lambda: tmp_path / "records", drain=drain)
    module.drain_profile_handoffs(native)
    # The launch profile is the native worker's; a failing profile never starves the next one.
    assert scope == ["broken", "due"] and drained == ["due"]
