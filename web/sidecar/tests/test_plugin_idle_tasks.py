"""TAL-2664: ``plugins.idle_tasks`` lists a profile's plugin idle tasks and ``plugins.idle_task_set_paused`` pauses or
resumes one through the Agent's own enumeration and writer, without running a task."""

from __future__ import annotations

import json
import pathlib
import sys
from types import ModuleType

import pytest

from conftest import AGENT_DIR, SidecarProcess, load_schema, requires_agent, share_pm_store, validate
from talaria_sidecar.errors import RpcError
from talaria_sidecar.methods import plugin_idle_tasks


@pytest.fixture
def native(monkeypatch, tmp_path):
    """An Agent idle-task module over one synthetic state file whose writer can be made to lose the write, as the
    Agent's ``save_state`` does when it swallows an error."""
    path = tmp_path / "compact-notes.json"
    path.write_text(json.dumps({"plugin": "team-notes", "task": "compact-notes", "paused": False, "last_run_at": "2026-11-20T08:00:00+00:00", "interval_hours": 24}))
    state = {"lose_write": False, "writes": []}

    def load_state(p, plugin_id="", name=""):
        return {"last_run_at": None, "run_count": 0, "paused": False, "last_summary": None, "last_status": None, "last_error": None, "interval_hours": None, **json.loads(p.read_text())}

    def set_paused(p, paused):
        state["writes"].append(paused)
        if not state["lose_write"]:
            p.write_text(json.dumps({**json.loads(p.read_text()), "paused": paused}))

    module = ModuleType("hermes_cli.plugins_idle_tasks")
    module.__dict__.update(load_state=load_state, set_paused=set_paused, next_due=lambda s: "2026-11-21T08:00:00+00:00",
                           iter_state_files=lambda plugin_id=None: iter([(path, load_state(path))] if plugin_id in (None, "team-notes") else []))
    monkeypatch.setitem(sys.modules, "hermes_cli", ModuleType("hermes_cli"))
    monkeypatch.setitem(sys.modules, "hermes_cli.plugins_idle_tasks", module)
    return state


def test_pausing_reads_the_state_back_and_refuses_a_write_the_agent_lost(native):
    assert plugin_idle_tasks.set_paused("team-notes", "compact-notes", True)["paused"] is True
    native["lose_write"] = True
    with pytest.raises(RpcError) as lost:
        plugin_idle_tasks.set_paused("team-notes", "compact-notes", False)
    assert lost.value.data == {"condition": "idle_task_not_saved"}
    with pytest.raises(RpcError) as unknown:
        plugin_idle_tasks.set_paused("team-notes", "never-seeded", True)
    assert unknown.value.data == {"condition": "idle_task_not_found"}
    assert native["writes"] == [True, False]


def test_an_agent_without_idle_tasks_lists_none_and_refuses_a_pause(monkeypatch):
    monkeypatch.setitem(sys.modules, "hermes_cli.plugins_idle_tasks", None)
    assert plugin_idle_tasks.idle_tasks() == {"supported": False, "tasks": []}
    with pytest.raises(RpcError) as refused:
        plugin_idle_tasks.set_paused("team-notes", "compact-notes", True)
    assert refused.value.data == {"condition": "idle_tasks_unsupported"}


SUPPORTED = AGENT_DIR is not None and (AGENT_DIR / "hermes_cli" / "plugins_idle_tasks.py").exists()
PLUGIN = """def register(ctx):
    if hasattr(ctx, "register_idle_task"):
        ctx.register_idle_task("fresh-index", lambda run: "ran", interval_hours=6)
"""


@requires_agent
def test_each_profile_lists_and_pauses_only_its_own_tasks(tmp_path: pathlib.Path) -> None:
    """Two profiles hold a task of the same plugin and name. The real Agent enumerates, computes next due times and
    persists a pause in one profile only; a registered task no owner seeded is listed and cannot be paused."""
    root = tmp_path / "home" / ".hermes"
    work = root / "profiles" / "work"
    offline = share_pm_store(root)
    plugin = root / "plugins" / "team-notes"
    plugin.mkdir(parents=True)
    (plugin / "plugin.yaml").write_text("name: team-notes\nversion: 0.0.1\ndescription: Synthetic probe\n")
    (plugin / "__init__.py").write_text(PLUGIN)
    (root / "config.yaml").write_text("plugins:\n  enabled: [team-notes]\n")
    secret = "sk-ant-api03-" + "x" * 40
    for home, error in ((root, f"RuntimeError: refused key {secret}"), (work, None)):
        state = home / "plugin-data" / "team-notes" / "idle-tasks" / "compact-notes.json"
        state.parent.mkdir(parents=True)
        state.write_text(json.dumps({"plugin": "team-notes", "task": "compact-notes", "last_run_at": "2026-11-20T08:00:00+00:00", "run_count": 3,
                                     "paused": False, "last_status": "error" if error else "ok", "last_summary": "Compacted 12 notes", "last_error": error, "interval_hours": 24}))
    sidecar = SidecarProcess(root, env=offline)
    try:
        def listed(home: pathlib.Path) -> dict:
            result = sidecar.result("plugins.idle_tasks", {"profile_home": str(home)})
            assert validate(result, load_schema("plugins.idle_tasks")) == []
            return result

        def pause(home: pathlib.Path, task: str, paused: bool) -> dict:
            message, _ = sidecar.call("plugins.idle_task_set_paused", {"profile_home": str(home), "key": "team-notes", "task": task, "paused": paused})
            return message

        if not SUPPORTED:
            assert listed(root) == {"supported": False, "tasks": []}
            assert pause(root, "compact-notes", True)["error"]["data"]["condition"] == "idle_tasks_unsupported"
            return
        seeded = {"plugin": "team-notes", "task": "compact-notes", "seeded": True, "paused": False, "run_count": 3, "last_run_at": "2026-11-20T08:00:00+00:00",
                  "next_due_at": "2026-11-21T08:00:00+00:00", "interval_hours": 24.0}
        default = listed(root)["tasks"]
        assert default[0] == {**seeded, "last_status": "error", "last_result": default[0]["last_result"]}
        assert default[0]["last_result"].startswith("RuntimeError: refused key") and secret not in default[0]["last_result"]
        assert default[1:] == [{"plugin": "team-notes", "task": "fresh-index", "seeded": False, "paused": False, "run_count": 0, "last_run_at": None,
                                "next_due_at": None, "interval_hours": 6.0, "last_status": None, "last_result": None}]
        assert listed(work)["tasks"] == [{**seeded, "last_status": "ok", "last_result": "Compacted 12 notes"}]

        assert pause(root, "compact-notes", True)["result"]["paused"] is True
        assert [row["paused"] for row in listed(root)["tasks"]] == [True, False]
        assert [row["paused"] for row in listed(work)["tasks"]] == [False]
        assert pause(root, "fresh-index", True)["error"]["data"]["condition"] == "idle_task_not_found"
        assert pause(root, "compact-notes", False)["result"]["paused"] is False
        state = json.loads((root / "plugin-data" / "team-notes" / "idle-tasks" / "compact-notes.json").read_text())
        assert (state["paused"], state["run_count"], state["last_run_at"]) == (False, 3, "2026-11-20T08:00:00+00:00")
    finally:
        sidecar.close()
