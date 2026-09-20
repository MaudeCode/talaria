"""Every implemented namespace against the pinned Agent, validated with the contract schemas."""

from __future__ import annotations

import json
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
    subprocess.run([AGENT_PYTHON, "-c", code, str(AGENT_DIR), str(home)], check=True, env={"HOME": str(home.parent), "HERMES_HOME": str(home), "PATH": "/usr/bin:/bin", "HERMES_STATE_DB_GUARD_BYPASS": "1"})


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
    message, _ = handshaken.call("cron.delete", {"profile_home": home, "job_id": "../etc"})
    assert message["error"]["code"] == -32602
    message, _ = handshaken.call("commands.exec", {"profile_home": home, "command": "/definitely-not-a-command"})
    assert message["error"]["data"]["condition"] == "command_not_found"
    message, _ = handshaken.call("stt.transcribe", {"profile_home": home, "audio_b64": "not base64!"})
    assert message["error"]["code"] == -32602
    message, _ = handshaken.call("worktree.create", {"profile_home": home, "repo_root": home})
    assert message["error"]["data"]["condition"] == "not_a_repo"


@requires_agent
def test_stdout_is_reserved_for_rpc_frames(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    """Agent code prints (profile deletion confirms on stdout); the channel must survive it."""
    home = str(hermes_home)
    handshaken.result("profiles.create", {"base_home": home, "name": "printy"})
    assert handshaken.result("profiles.delete", {"base_home": home, "name": "printy"}) == {"ok": True}
    assert "runtime.status" in handshaken.result("rpc.methods")["methods"]
