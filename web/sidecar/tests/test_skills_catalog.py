"""Resolved identities must agree across listing, inspection and config toggles."""

import json
import subprocess
import sys
import types

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent, load_schema, validate
from talaria_sidecar.errors import InvalidParams
from talaria_sidecar.methods import skills


@pytest.fixture
def skill_helpers(monkeypatch):
    tool = types.ModuleType("tools.skills_tool")
    utils = types.ModuleType("agent.skill_utils")
    utils.get_disabled_skill_names = lambda platform: set()
    utils.is_disabled_entry = lambda entry, disabled: False
    utils.resolve_skill_catalog = lambda: []
    utils.iter_skill_index_files = lambda root, filename: sorted(root.rglob(filename))
    tool.MAX_DESCRIPTION_LENGTH = 1000
    tool._EXCLUDED_SKILL_DIRS = set()
    tool._parse_frontmatter = lambda text: ({}, text)
    tool.skill_matches_platform = lambda frontmatter: True
    for name, module in (("tools.skills_tool", tool), ("agent.skill_utils", utils)):
        package = name.split(".")[0]
        monkeypatch.setitem(sys.modules, package, types.ModuleType(package))
        monkeypatch.setitem(sys.modules, name, module)
    return tool


@pytest.mark.parametrize("catalog", [True, False], ids=["catalog", "legacy"])
@pytest.mark.parametrize("spelling", ["public", "private", "both", "missing"])
def test_skill_listing_helper_spellings(tmp_path, skill_helpers, catalog, spelling):
    rows = [("zebra", None), ("beta", "z"), ("alpha", None)]
    for name, category in rows:
        folder = tmp_path / "skills" / (category or "") / name
        folder.mkdir(parents=True)
        (folder / "SKILL.md").write_text(name)
    if catalog:
        skill_helpers._skill_catalog = lambda **kwargs: [
            {"load_name": name, "name": name, "category": category, "status": "unique", "tier": 0}
            for name, category in rows
        ]
    expected = ["zebra", "beta", "alpha"] if spelling != "missing" else ["alpha", "zebra", "beta"]
    sort = lambda items: sorted(items, key=lambda item: item["name"], reverse=True)
    if spelling in ("public", "both"):
        skill_helpers.sort_skills = sort
    if spelling in ("private", "both"):
        skill_helpers._sort_skills = sort if spelling == "private" else lambda _: pytest.fail("public helper must win")
    result = skills.list_skills(tmp_path)
    assert [row["name"] for row in result["skills"]] == expected
    assert result["count"] == 3
    if catalog:
        assert result["categories"] == ["z"]
        assert [row["name"] for row in skills.list_skills(tmp_path, "z")["skills"]] == ["beta"]


@pytest.mark.parametrize("spelling", ["public", "private", "both", "mixed"])
def test_canonical_skill_lookup_helper_spellings(tmp_path, skill_helpers, spelling):
    folder = tmp_path / "canonical"
    roots = [tmp_path]
    seen = []

    def locate(name, local_name, search_roots):
        seen.append((name, local_name, search_roots))
        if name == "ambiguous":
            return json.dumps({"error": "Ambiguous skill name", "matches": ["a/one", "b/two"]}), None, None
        if name == "absent":
            return json.dumps({"error": "not found"}), None, None
        return None, folder, folder / "SKILL.md"

    helpers = {"locate_skill": locate, "skill_lookup_path_error": lambda name: "unsafe path" if ".." in name else None,
               "skill_search_dirs": lambda: (roots, [])}
    for index, (name, helper) in enumerate(helpers.items()):
        public = spelling != "private" and (spelling != "mixed" or index == 0)
        setattr(skill_helpers, name if public else "_" + name, helper)
        if spelling == "both":
            setattr(skill_helpers, "_" + name, lambda *args: pytest.fail("public helper must win"))
    assert skills.find_skill("pack:one", []) == (folder, folder / "SKILL.md")
    assert seen == [("pack:one", "pack/one", roots)]
    with pytest.raises(InvalidParams, match="Ambiguous skill name"):
        skills.find_skill("ambiguous", [])
    with pytest.raises(InvalidParams, match="unsafe path"):
        skills.find_skill("../outside", [])
    assert skills.find_skill("absent", []) == (None, None)


@pytest.mark.parametrize("missing", ["locate_skill", "skill_lookup_path_error", "skill_search_dirs"])
def test_incomplete_skill_lookup_helpers_keep_legacy_lookup(tmp_path, skill_helpers, missing):
    folder = tmp_path / "legacy"
    folder.mkdir()
    (folder / "SKILL.md").write_text("legacy")
    for name in ("locate_skill", "skill_lookup_path_error", "skill_search_dirs"):
        if name != missing:
            setattr(skill_helpers, name, lambda *args: pytest.fail("incomplete canonical API must not run"))
    assert skills.find_skill("legacy", [tmp_path]) == (folder, folder / "SKILL.md")


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
