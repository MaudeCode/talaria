"""Every implemented namespace against the pinned Agent, validated with the contract schemas."""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SidecarProcess, assert_matches, load_schema, requires_agent
from scenarios import SCENARIOS, UNEXERCISED
from talaria_sidecar import SIDECAR_RPC_VERSION


def _seed_state_db(home: pathlib.Path) -> None:
    code = (
        "import sys, pathlib; sys.path.append(sys.argv[1]); from hermes_state import SessionDB; "
        "db = SessionDB(pathlib.Path(sys.argv[2]) / 'state.db'); db.create_session('cli-1', source='cli'); "
        "db.append_message('cli-1', role='user', content='hi'); db.close()"
    )
    env = {"HOME": str(home.parent), "HERMES_HOME": str(home), "PATH": "/usr/bin:/bin", "HERMES_STATE_DB_GUARD_BYPASS": "1"}
    if os.environ.get("LD_LIBRARY_PATH"):  # relocated actions/setup-python interpreter
        env["LD_LIBRARY_PATH"] = os.environ["LD_LIBRARY_PATH"]
    subprocess.run([AGENT_PYTHON, "-c", code, str(AGENT_DIR), str(home)], check=True, env=env)


def run_scenarios(proc: SidecarProcess, home: pathlib.Path):
    """Yield ``(method, params, message, frames)`` for every scenario plus the dynamic ones."""
    profile = home / "profiles" / "alpha"
    substitutions = {"{home}": str(home), "{profile}": str(profile)}

    def fill(value):
        if isinstance(value, str):
            for key, replacement in substitutions.items():
                value = value.replace(key, replacement)
            return value
        if isinstance(value, dict):
            return {k: fill(v) for k, v in value.items()}
        if isinstance(value, list):
            return [fill(v) for v in value]
        return value

    task_ids: list[str] = []
    job_id: str | None = None
    for method, raw_params in SCENARIOS:
        params = fill(raw_params)
        if method == "state_db.delete_cli_session" and params["session_id"] == "cli-1":
            _seed_state_db(home)
        message, frames = proc.call(method, params, timeout=180)
        yield method, params, message, frames
        result = message.get("result") or {}
        if method == "kanban.create_task":
            task_ids.append(result["task"]["id"])
        if method == "cron.create":
            job_id = result["job"]["id"]
    first, second = task_ids[0], task_ids[1]
    output_dir = home / "cron" / "output" / str(job_id)
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "2026-09-20T12-00-00.md").write_text("# Cron run\n**Model:** test-model\n**Tokens:** 12 input, 4 output\n\n## Response\nhello\n", encoding="utf-8")
    dynamic = [
        ("kanban.task", {"profile_home": str(home), "task_id": first}),
        ("kanban.task_action", {"profile_home": str(home), "task_id": first, "action": "block", "reason": "waiting"}),
        ("kanban.task_action", {"profile_home": str(home), "task_id": first, "action": "unblock"}),
        ("kanban.patch_task", {"profile_home": str(home), "task_id": first, "patch": {"title": "renamed task", "status": "todo"}}),
        ("kanban.comment", {"profile_home": str(home), "task_id": first, "body": "note"}),
        ("kanban.link", {"profile_home": str(home), "parent_id": first, "child_id": second}),
        ("kanban.unlink", {"profile_home": str(home), "parent_id": first, "child_id": second}),
        ("kanban.task_log", {"profile_home": str(home), "task_id": first}),
        ("kanban.bulk", {"profile_home": str(home), "bulk": {"ids": [first, second], "priority": 5}}),
        ("cron.get", {"profile_home": str(home), "job_id": job_id}),
        ("cron.update", {"profile_home": str(home), "job_id": job_id, "updates": {"name": "hello2", "continuity": True}}),
        ("cron.pause", {"profile_home": str(home), "job_id": job_id}),
        ("cron.resume", {"profile_home": str(home), "job_id": job_id}),
        ("cron.history", {"profile_home": str(home), "job_id": job_id}),
        ("cron.output", {"profile_home": str(home), "job_id": job_id}),
        ("cron.run_detail", {"profile_home": str(home), "job_id": job_id, "filename": "2026-09-20T12-00-00.md"}),
        ("cron.status", {"job_id": job_id}),
        ("cron.delete", {"profile_home": str(home), "job_id": job_id}),
    ]
    for method, params in dynamic:
        message, frames = proc.call(method, params, timeout=60)
        yield method, params, message, frames


@requires_agent
def test_every_namespace_answers_with_contract_shapes(sidecar: SidecarProcess, hermes_home: pathlib.Path) -> None:
    result = sidecar.result("runtime.handshake", {"rpc_version": SIDECAR_RPC_VERSION})
    assert result["compatible"], result
    seen = set()
    for method, params, message, frames in run_scenarios(sidecar, hermes_home):
        assert "error" not in message, (method, params, message["error"])
        assert_matches(method, message["result"])
        seen.add(method)
    methods = set(sidecar.result("rpc.methods")["methods"]) - {"rpc.methods", "rpc.cancel"}
    schemas = set(json.loads((pathlib.Path(__file__).parent / "fixtures" / "schemas.json").read_text()))
    assert methods <= schemas, f"methods without a contract schema: {sorted(methods - schemas)}"
    assert schemas - {"rpc.methods", "rpc.cancel"} <= methods, f"contract schemas without a method: {sorted(schemas - methods - {'rpc.methods', 'rpc.cancel'})}"
    untested = methods - seen - UNEXERCISED
    assert not untested, f"implemented methods never exercised: {sorted(untested)}"


@requires_agent
def test_error_conditions_are_typed(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    home = str(hermes_home)
    message, _ = handshaken.call("providers.resolve_runtime", {"profile_home": home, "requested": "anthropic"})
    assert message["error"]["data"]["condition"] == "credential_missing"
    message, _ = handshaken.call("kanban.task", {"profile_home": home, "task_id": "t_missing"})
    assert message["error"]["data"]["condition"] == "not_found"
    # Delete resolves the id through the store like the predecessor (a traversal-shaped id is simply not found);
    # the output-file methods keep the strict id shape.
    message, _ = handshaken.call("cron.delete", {"profile_home": home, "job_id": "../etc"})
    assert message["error"]["data"]["condition"] == "not_found"
    message, _ = handshaken.call("cron.history", {"profile_home": home, "job_id": "../etc"})
    assert message["error"]["code"] == -32602
    message, _ = handshaken.call("commands.exec", {"profile_home": home, "command": "/definitely-not-a-command"})
    assert message["error"]["data"]["condition"] == "command_not_found"
    message, _ = handshaken.call("stt.transcribe", {"profile_home": home, "audio_b64": "not base64!"})
    assert message["error"]["code"] == -32602
    message, _ = handshaken.call("worktree.create", {"profile_home": home, "repo_root": home})
    assert message["error"]["data"]["condition"] == "not_a_repo"
    message, _ = handshaken.call("config.set", {"profile_home": home, "config_path": home + "/config.yaml", "config": "not an object"})
    assert message["error"]["code"] == -32602


@requires_agent
def test_config_round_trip_keeps_mode_and_key_order(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    """``config.set`` writes YAML the Agent reads back; the file mode survives and unrelated keys are preserved verbatim."""
    home = str(hermes_home)
    path = hermes_home / "config.yaml"
    path.write_text("model:\n  default: claude-sonnet-4-6\n  provider: anthropic\nagent:\n  reasoning_effort: high\n", encoding="utf-8")
    path.chmod(0o600)
    message, _ = handshaken.call("config.get", {"profile_home": home, "config_path": str(path)})
    config = message["result"]["config"]
    assert config["model"]["provider"] == "anthropic" and message["result"]["exists"] is True
    config["max_tokens"] = 4096
    message, _ = handshaken.call("config.set", {"profile_home": home, "config_path": str(path), "config": config})
    assert message["result"]["ok"] is True
    assert path.stat().st_mode & 0o777 == 0o600
    text = path.read_text(encoding="utf-8")
    assert text.index("model:") < text.index("agent:") < text.index("max_tokens: 4096")
    message, _ = handshaken.call("config.get", {"profile_home": home, "config_path": str(path)})
    assert message["result"]["config"]["max_tokens"] == 4096


@requires_agent
def test_config_rpcs_use_the_server_resolved_path(handshaken: SidecarProcess, hermes_home: pathlib.Path, tmp_path: pathlib.Path) -> None:
    """``config_path`` (the server's HERMES_CONFIG_PATH resolution) is the file read and written, not ``<home>/config.yaml``."""
    home = str(hermes_home)
    override = tmp_path / "managed" / "override.yaml"
    override.parent.mkdir()
    override.write_text("webui_oidc:\n  issuer: https://idp.example\n", encoding="utf-8")
    assert not (hermes_home / "config.yaml").exists()
    result = handshaken.result("config.get", {"profile_home": home, "config_path": str(override)})
    assert result["exists"] is True and result["config"]["webui_oidc"]["issuer"] == "https://idp.example"
    handshaken.result("config.set", {"profile_home": home, "config_path": str(override), "config": {"max_tokens": 7}})
    assert "max_tokens: 7" in override.read_text(encoding="utf-8")
    assert not (hermes_home / "config.yaml").exists()
    message, _ = handshaken.call("config.get", {"profile_home": home, "config_path": "relative.yaml"})
    assert message["error"]["code"] == -32602


@requires_agent
def test_config_set_writes_through_a_symlinked_config(handshaken: SidecarProcess, hermes_home: pathlib.Path, tmp_path: pathlib.Path) -> None:
    """An operator-managed ``config.yaml`` symlink keeps pointing at its referent; the referent gets the bytes."""
    home = str(hermes_home)
    managed = tmp_path / "managed.yaml"
    managed.write_text("model:\n  provider: anthropic\n", encoding="utf-8")
    managed.chmod(0o600)
    link = hermes_home / "config.yaml"
    link.symlink_to(managed)
    handshaken.result("config.set", {"profile_home": home, "config_path": str(link), "config": {"model": {"provider": "anthropic"}, "max_tokens": 9}})
    assert link.is_symlink() and os.readlink(link) == str(managed)
    assert "max_tokens: 9" in managed.read_text(encoding="utf-8")
    assert managed.stat().st_mode & 0o777 == 0o600
    assert handshaken.result("config.get", {"profile_home": home, "config_path": str(link)})["config"]["max_tokens"] == 9


def test_profile_reads_fail_closed_without_a_yaml_parser(tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A missing parser is an error, never a profile that looks visible with every skill enabled."""
    from talaria_sidecar.errors import RpcError
    from talaria_sidecar.methods import profiles

    monkeypatch.setitem(sys.modules, "hermes_yaml", None)
    monkeypatch.setitem(sys.modules, "yaml", None)
    assert profiles.disabled_skill_names(tmp_path) == set()  # absent files need no parser
    (tmp_path / "config.yaml").write_text("skills:\n  disabled: [alpha]\nterminal:\n  cwd: /work\n", encoding="utf-8")
    (tmp_path / "profile.yaml").write_text("visible: false\n", encoding="utf-8")
    for read in (profiles.disabled_skill_names, profiles._visible, lambda home: profiles.runtime_env(home, set())):
        with pytest.raises(RpcError) as error:
            read(tmp_path)
        assert error.value.data["condition"] == "yaml_unavailable"


def test_yaml_parser_prefers_the_agent_module_and_falls_back_to_pyyaml(monkeypatch: pytest.MonkeyPatch) -> None:
    from types import SimpleNamespace

    from talaria_sidecar.methods.config import yaml_parser

    agent_yaml, pyyaml = SimpleNamespace(name="hermes_yaml"), SimpleNamespace(name="yaml")
    monkeypatch.setitem(sys.modules, "hermes_yaml", agent_yaml)
    monkeypatch.setitem(sys.modules, "yaml", pyyaml)
    assert yaml_parser() is agent_yaml
    monkeypatch.setitem(sys.modules, "hermes_yaml", None)
    assert yaml_parser() is pyyaml


@requires_agent
def test_stdout_is_reserved_for_rpc_frames(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    """Agent code prints (profile deletion confirms on stdout); the channel must survive it."""
    home = str(hermes_home)
    handshaken.result("profiles.create", {"base_home": home, "name": "printy"})
    assert handshaken.result("profiles.delete", {"base_home": home, "name": "printy"}) == {"ok": True}
    assert "runtime.status" in handshaken.result("rpc.methods")["methods"]


@requires_agent
def test_image_mode_reads_the_profile_config(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    """TAL-545: the profile's ``config.yaml`` vision overrides decide the mode, with the requested provider's identity."""
    home = str(hermes_home)
    path = hermes_home / "config.yaml"
    params = {"profile_home": home, "provider": "custom:lab", "model": "lab-vision-1", "requested_provider": "custom:lab"}
    path.write_text("providers:\n  lab:\n    models:\n      lab-vision-1:\n        supports_vision: true\n", encoding="utf-8")
    assert handshaken.result("text.image_mode", params) == {"mode": "native", "reason": "", "supports_vision": True}
    path.write_text("agent:\n  image_input_mode: text\nmodel:\n  supports_vision: true\n", encoding="utf-8")
    assert handshaken.result("text.image_mode", params)["mode"] == "text"


@requires_agent
def test_kanban_tasks_report_claim_liveness_and_completion_evidence(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    """The server's card policy (TAL-557) reads these: a live worker's claim and the stored result the Agent needs to complete."""
    import sqlite3

    home = str(hermes_home)
    task_id = handshaken.result("kanban.create_task", {"profile_home": home, "task": {"title": "claimed task"}})["task"]["id"]
    task = handshaken.result("kanban.task", {"profile_home": home, "task_id": task_id})["task"]
    assert task["claim_live"] is False and task["has_completion_evidence"] is False
    db = next(p for p in hermes_home.rglob("*.db") if sqlite3.connect(p).execute("SELECT name FROM sqlite_master WHERE name = 'tasks'").fetchone())
    worker = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        with sqlite3.connect(db) as conn:
            conn.execute("UPDATE tasks SET status = 'running', claim_lock = 'test-claim', worker_pid = ?, result = 'shipped' WHERE id = ?", (worker.pid, task_id))
            # No start fingerprint: liveness is the worker PID's existence.
            if any(c[1] == "worker_started_at" for c in conn.execute("PRAGMA table_info(tasks)")):
                conn.execute("UPDATE tasks SET worker_started_at = NULL WHERE id = ?", (task_id,))
        task = handshaken.result("kanban.task", {"profile_home": home, "task_id": task_id})["task"]
        assert task["claim_live"] is True and task["has_completion_evidence"] is True
        # A client holding policy from before the claim still cannot release it.
        for method, params in (
            ("kanban.task_action", {"action": "block"}),
            ("kanban.patch_task", {"patch": {"status": "todo"}}),
            ("kanban.patch_task", {"patch": {"status": "done"}}),
        ):
            message, _ = handshaken.call(method, {"profile_home": home, "task_id": task_id, **params})
            assert message.get("error", {}).get("data", {}).get("condition") == "conflict", (method, params, message)
        assert handshaken.result("kanban.task", {"profile_home": home, "task_id": task_id})["task"]["status"] == "running"
    finally:
        worker.kill()
        worker.wait()
    board = handshaken.result("kanban.board", {"profile_home": home})
    running = next(t for c in board["columns"] for t in c["tasks"] if t["id"] == task_id)
    assert running["claim_live"] is False
    # Once the worker is gone the claim no longer protects a run, and the release goes through.
    assert handshaken.result("kanban.patch_task", {"profile_home": home, "task_id": task_id, "patch": {"status": "todo"}})["task"]["status"] == "todo"
