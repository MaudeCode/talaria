"""Resolved identities must agree across listing, inspection and config toggles."""

import subprocess

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent, load_schema, validate


@requires_agent
def test_resolved_skill_catalog(hermes_home):
    code = r'''
from agent import skill_utils
if not hasattr(skill_utils, "resolve_skill_catalog"):
    print("legacy-agent")
    raise SystemExit(0)
from tools import skills_tool
from talaria_sidecar.methods.skills import list_skills, view_skill
from talaria_sidecar.home import scoped_home
from hermes_constants import get_hermes_home

home = get_hermes_home()
def skill(root, path, description):
    folder = root / path
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "SKILL.md").write_text(f"---\nname: dup-demo\ndescription: {description}\n---\n{description}\n")

skill(home / "skills", "a/one", "first copy")
skill(home / "skills", "b/two", "second copy")
with scoped_home(home):
    rows = list_skills(home)["skills"]
    assert [r["name"] for r in rows] == ["a/one", "b/two"], rows
    assert all(r["load_name"] == r["name"] and r["status"] == "ambiguous" for r in rows)
    assert all(r["tier"] == skill_utils.TIER_LOCAL for r in rows)
    assert "first copy" in view_skill(home, "a/one")["content"]
    assert "second copy" in view_skill(home, "b/two")["content"]
    assert view_skill(home, "dup-demo")["success"] is False
    (home / "config.yaml").write_text("skills:\n  disabled: [a/one]\n  platform_disabled:\n    webui: []\n")
    rows = list_skills(home)["skills"]
    assert {r["name"]: r["disabled"] for r in rows} == {"a/one": True, "b/two": False}, rows
    # Disabled skills remain inspectable in the management page.
    assert view_skill(home, "a/one")["success"] is True

    external = home / "external"
    skill(external, "third", "external copy")
    (home / "skills/b/two/SKILL.md").unlink()
    (home / "config.yaml").write_text(f"skills:\n  external_dirs: [{external}]\n")
    skills_tool.clear_skills_cache()
    rows = list_skills(home)["skills"]
    assert len(rows) == 1 and rows[0]["name"] == "dup-demo", rows
    assert rows[0]["status"] == "unique" and rows[0]["description"] == "first copy", rows
    assert "first copy" in view_skill(home, "dup-demo")["content"]
    assert view_skill(home, "dup-demo")["editable"] is True

    project = home / "project"
    (project / ".git").mkdir(parents=True)
    skill(project / ".agents/skills", "project-copy", "project copy")
    (home / "config.yaml").write_text(f"skills:\n  trusted_project_dirs: [{project}]\n")
    from agent.runtime_cwd import set_session_cwd, reset_session_cwd
    token = set_session_cwd(str(project))
    try:
        skills_tool.clear_skills_cache()
        rows = list_skills(home)["skills"]
        assert len(rows) == 1 and rows[0]["tier"] == skill_utils.TIER_PROJECT, rows
        detail = view_skill(home, "dup-demo")
        assert "project copy" in detail["content"]
        assert detail["editable"] is False, detail
    finally:
        reset_session_cwd(token)
print("catalog-ok")
'''
    result = subprocess.run(
        [AGENT_PYTHON, "-c", code], cwd=AGENT_DIR,
        env=isolated_env(hermes_home), text=True, capture_output=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    if "legacy-agent" in result.stdout:
        pytest.skip("Agent predates resolved skill catalogs")
    assert "catalog-ok" in result.stdout


@requires_agent
def test_skill_catalog_rpc_identity_and_profile_isolation(sidecar, hermes_home):
    for home, paths in [(hermes_home, ["a/one", "b/two"]), (hermes_home / "profiles/other", ["only"])]:
        for path in paths:
            folder = home / "skills" / path
            folder.mkdir(parents=True)
            (folder / "SKILL.md").write_text(f"---\nname: dup-demo\ndescription: {path}\n---\n{path}\n")
    params = {"profile_home": str(hermes_home)}
    rows = sidecar.result("skills.list", params)
    if "load_name" not in rows["skills"][0]:
        assert len(rows["skills"]) == 1  # Older Agents keep the legacy listing.
        pytest.skip("Agent predates resolved skill catalogs")
    assert validate(rows, load_schema("skills.list")) == []
    found = sidecar.result("skills.find", {**params, "name": "one"})
    assert validate(found, load_schema("skills.find")) == []
    assert found["load_name"] == "a/one"
    assert sorted(found["sibling_load_names"]) == ["a/one", "b/two"]
    ambiguous, _ = sidecar.call("skills.find", {**params, "name": "dup-demo"})
    assert "Ambiguous skill name" in ambiguous["error"]["message"]
    other = sidecar.result("skills.list", {"profile_home": str(hermes_home / "profiles/other")})
    assert [r["name"] for r in other["skills"]] == ["dup-demo"]
    assert [r["name"] for r in sidecar.result("skills.list", params)["skills"]] == ["a/one", "b/two"]
    for invalid in ("../outside", "/etc/passwd", "a:../../outside"):
        reply, _ = sidecar.call("skills.find", {**params, "name": invalid})
        assert "error" in reply
