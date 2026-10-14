"""``write_approval.*`` lists, approves and rejects the Agent's staged skill and memory writes (TAL-819).

The Agent's own memory and skill tools stage each write in a disposable HERMES_HOME with the gates on.
"""

from __future__ import annotations

import json
import pathlib
import subprocess

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SidecarProcess, assert_matches, isolated_env, requires_agent

SKILL = "---\nname: demo-skill\ndescription: Staged by the test\n---\n\nStep one.\n"


def _agent(home: pathlib.Path, code: str, *args: str) -> dict:
    """Run ``code`` on the Agent's interpreter in ``home``; it prints one tool result."""
    out = subprocess.run([AGENT_PYTHON, "-c", f"import sys; sys.path.insert(0, sys.argv[1]); {code}", str(AGENT_DIR), *args],
                         check=True, capture_output=True, text=True, cwd=AGENT_DIR, env=isolated_env(home, PATH="/usr/bin:/bin"), timeout=120)
    return json.loads(out.stdout.strip().splitlines()[-1])


def _remember(home: pathlib.Path, entry: str) -> dict:
    return _agent(home, "from tools.memory_tool import memory_tool, load_on_disk_store; "
                        "print(memory_tool(action='add', target='memory', content=sys.argv[2], store=load_on_disk_store()))", entry)


def create_skill(home: pathlib.Path) -> dict:
    return _agent(home, "from tools.skill_manager_tool import skill_manage; print(skill_manage(action='create', name='demo-skill', content=sys.argv[2]))", SKILL)


def set_gates(home: pathlib.Path, on: bool) -> None:
    flag = "true" if on else "false"
    (home / "config.yaml").write_text(f"memory:\n  write_approval: {flag}\nskills:\n  write_approval: {flag}\n", encoding="utf-8")


def _pending(proc: SidecarProcess, home: pathlib.Path, kind: str) -> dict:
    result = proc.result("write_approval.pending", {"profile_home": str(home), "kind": kind})
    assert_matches("write_approval.pending", result)
    return result


def _review(proc: SidecarProcess, home: pathlib.Path, verb: str, kind: str, items: list[dict]) -> list[dict]:
    writes = [{"id": item["id"], "revision": item["revision"]} for item in items]
    result = proc.result(f"write_approval.{verb}", {"profile_home": str(home), "kind": kind, "writes": writes})
    assert_matches(f"write_approval.{verb}", result)
    return result["results"]


@requires_agent
def test_staged_writes_list_with_diffs_and_approve_applies_them(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    set_gates(hermes_home, True)
    assert _remember(hermes_home, "User prefers tabs")["staged"] is True
    assert create_skill(hermes_home)["staged"] is True
    memory_file = hermes_home / "memories" / "MEMORY.md"
    skill_file = hermes_home / "skills" / "demo-skill" / "SKILL.md"
    assert not skill_file.exists() and "User prefers tabs" not in (memory_file.read_text() if memory_file.exists() else "")

    memory = _pending(handshaken, hermes_home, "memory")
    assert memory["supported"] is True and memory["enabled"] is True
    (staged_memory,) = memory["items"]
    assert (staged_memory["kind"], staged_memory["target"], staged_memory["op"]) == ("memory", "memory", "add")
    assert "+User prefers tabs" in staged_memory["diff"]

    (staged_skill,) = _pending(handshaken, hermes_home, "skills")["items"]
    assert (staged_skill["kind"], staged_skill["target"], staged_skill["op"]) == ("skills", "demo-skill", "create")
    assert staged_skill["diff"] == SKILL

    (applied,) = _review(handshaken, hermes_home, "approve", "memory", [staged_memory])
    assert applied["done"] is True, applied
    assert "User prefers tabs" in memory_file.read_text()
    (applied,) = _review(handshaken, hermes_home, "approve", "skills", [staged_skill])
    assert applied["done"] is True, applied
    assert skill_file.read_text() == SKILL
    assert _pending(handshaken, hermes_home, "memory")["items"] == [] and _pending(handshaken, hermes_home, "skills")["items"] == []


@requires_agent
def test_reject_discards_a_staged_write(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    set_gates(hermes_home, True)
    create_skill(hermes_home)
    (staged,) = _pending(handshaken, hermes_home, "skills")["items"]
    (rejected,) = _review(handshaken, hermes_home, "reject", "skills", [staged])
    assert rejected["done"] is True, rejected
    assert _pending(handshaken, hermes_home, "skills")["items"] == []
    assert not (hermes_home / "skills" / "demo-skill").exists()
    # A record that is already gone reports not done instead of claiming the reject.
    (again,) = _review(handshaken, hermes_home, "reject", "skills", [staged])
    assert again["done"] is False


@requires_agent
def test_gates_off_stage_nothing(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    set_gates(hermes_home, False)
    assert not _remember(hermes_home, "User prefers tabs").get("staged")
    assert not create_skill(hermes_home).get("staged")
    for kind in ("memory", "skills"):
        assert _pending(handshaken, hermes_home, kind) == {"supported": True, "enabled": False, "items": []}


@requires_agent
@pytest.mark.parametrize("bad", ["../../config", "a/b", ""])
def test_ids_outside_the_pending_store_are_refused(handshaken: SidecarProcess, hermes_home: pathlib.Path, bad: str) -> None:
    (hermes_home / "pending" / "skills").mkdir(parents=True)  # as after any staged skill write
    (hermes_home / "config.json").write_text("{}", encoding="utf-8")
    message = handshaken.call("write_approval.reject", {"profile_home": str(hermes_home), "kind": "skills", "writes": [{"id": bad, "revision": ""}]})[0]
    assert (hermes_home / "config.json").exists()
    assert message.get("error", {}).get("code") == -32602, message


@requires_agent
def test_a_staged_memory_remove_diffs_against_the_file_and_leaves_it_until_approved(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    set_gates(hermes_home, False)
    _remember(hermes_home, "User prefers tabs")
    _remember(hermes_home, "Deploys go through staging")
    set_gates(hermes_home, True)
    staged = _agent(hermes_home, "from tools.memory_tool import memory_tool, load_on_disk_store; "
                                 "print(memory_tool(action='remove', target='memory', old_text='tabs', store=load_on_disk_store()))")
    assert staged["staged"] is True
    memory_file = hermes_home / "memories" / "MEMORY.md"
    before = memory_file.read_bytes()
    (item,) = _pending(handshaken, hermes_home, "memory")["items"]
    assert item["op"] == "remove"
    assert "-User prefers tabs" in item["diff"] and "+" not in item["diff"].split("@@")[-1]
    assert memory_file.read_bytes() == before
    (applied,) = _review(handshaken, hermes_home, "approve", "memory", [item])
    assert applied["done"] is True, applied
    assert memory_file.read_text() == "Deploys go through staging"


@requires_agent
def test_an_approval_is_refused_once_the_file_changed_after_the_review(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    set_gates(hermes_home, False)
    _remember(hermes_home, "User prefers tabs")
    set_gates(hermes_home, True)
    _remember(hermes_home, "Deploys go through staging")
    (reviewed,) = _pending(handshaken, hermes_home, "memory")["items"]
    memory_file = hermes_home / "memories" / "MEMORY.md"
    # Another Agent run writes the file after the user read the diff.
    memory_file.write_text("User prefers spaces", encoding="utf-8")
    (refused,) = _review(handshaken, hermes_home, "approve", "memory", [reviewed])
    assert refused["done"] is False, refused
    assert memory_file.read_text() == "User prefers spaces"
    (current,) = _pending(handshaken, hermes_home, "memory")["items"]
    assert current["id"] == reviewed["id"] and current["revision"] != reviewed["revision"]
    assert "User prefers spaces" in current["diff"]
    (applied,) = _review(handshaken, hermes_home, "approve", "memory", [current])
    assert applied["done"] is True, applied
    assert memory_file.read_text() == "User prefers spaces\n§\nDeploys go through staging"
