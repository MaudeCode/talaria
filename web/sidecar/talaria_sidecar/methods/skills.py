"""``skills.*``: skill discovery and parsing through the Agent's skill utilities.

File writes (save, delete, toggle) live in the server; this namespace parses
SKILL.md trees the way ``tools.skills_tool`` does so the WebUI list matches what
the Agent loads, and writes the Agent's own lock record.
"""

from __future__ import annotations

import json
from pathlib import Path

from ..errors import InvalidParams
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext


def _skill_helper(name: str):
    from tools import skills_tool

    return getattr(skills_tool, name, None) or getattr(skills_tool, "_" + name, None)


def _sort_skills(rows: list[dict]) -> list[dict]:
    return _skill_helper("sort_skills")(rows)


def _within(base: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(base.resolve())
        return True
    except (OSError, ValueError):
        return False


def _locked_dirs() -> set[str] | None:
    """Locked directory names in the Agent's lock record (``tools.skill_usage``); None while that record is unreadable."""
    from tools import skill_usage

    try:
        # The listing reads a corrupt record as empty, and only the strict read tells that from no locks.
        skill_usage.is_locked("")
    except (OSError, ValueError):
        return None
    return set(skill_usage.locked_skill_names())


def _row_locked(locked: set[str] | None, skill_md: Path) -> bool | None:
    return None if locked is None else skill_md.parent.name in locked


def set_skill_lock(name: str, locked: bool) -> dict:
    """Write the lock under the skill's directory name, the key the Agent's write guards resolve."""
    from tools import skill_usage

    skill_dir, skill_md = find_skill(name)
    if skill_md is None or skill_md.name != "SKILL.md":
        return {"status": "not_found"}
    # The Agent's write starts from the same lenient read, so it would replace a corrupt record.
    if _locked_dirs() is None:
        return {"status": "unreadable"}
    return {"status": "ok" if skill_usage.set_locked(skill_dir.name, locked) else "failed"}


def list_skills(profile_home: Path, category: str | None = None) -> dict:
    from agent.skill_utils import get_disabled_skill_names, is_disabled_entry
    from tools.skills_tool import _skill_catalog

    disabled = get_disabled_skill_names("webui")
    locked = _locked_dirs()
    # Keep disabled rows manageable, but never advertise shadowed or unloadable copies.
    out = [{"name": entry["load_name"], "load_name": entry["load_name"],
            "declared_name": entry["name"], "status": entry["status"], "tier": entry["tier"],
            "description": entry.get("description") or "", "category": entry.get("category"),
            "disabled": is_disabled_entry(entry, disabled), "locked": _row_locked(locked, entry["path"])}
           for entry in _skill_catalog(skip_disabled=True) if entry["load_name"]]
    if category:
        out = [s for s in out if s.get("category") == category]
    out = _sort_skills(out)
    return {"success": True, "skills": out, "categories": sorted({s["category"] for s in out if s.get("category")}), "count": len(out)}


def find_skill(name: str) -> tuple[Path | None, Path | None]:
    """The Agent's own lookup (``tools.skills_tool``): ``pack:name`` also tries ``pack/name``; ambiguity and unsafe names refuse."""
    locate_skill = _skill_helper("locate_skill")
    skill_lookup_path_error = _skill_helper("skill_lookup_path_error")
    skill_search_dirs = _skill_helper("skill_search_dirs")
    if error := skill_lookup_path_error(name):
        raise InvalidParams(error)
    local_name = name.replace(":", "/", 1) if ":" in name else None
    if local_name and (error := skill_lookup_path_error(local_name)):
        raise InvalidParams(error)
    roots, _ = skill_search_dirs()
    error, skill_dir, skill_md = locate_skill(name, local_name, roots)
    if error:
        result = json.loads(error)
        if result.get("matches"):
            raise InvalidParams(result["error"])
        return None, None
    return skill_dir, skill_md


def _linked_files(skill_dir: Path | None) -> dict:
    if not skill_dir or not (skill_dir / "SKILL.md").exists():
        return {}
    linked: dict[str, list[str]] = {}
    refs = skill_dir / "references"
    if refs.exists():
        items = sorted(str(f.relative_to(skill_dir)) for f in refs.glob("*.md"))
        if items:
            linked["references"] = items
    templates = skill_dir / "templates"
    if templates.exists():
        items = set()
        for ext in ("*.md", "*.py", "*.yaml", "*.yml", "*.json", "*.tex", "*.sh"):
            items.update(str(f.relative_to(skill_dir)) for f in templates.rglob(ext))
        if items:
            linked["templates"] = sorted(items)
    assets = skill_dir / "assets"
    if assets.exists():
        items = sorted(str(f.relative_to(skill_dir)) for f in assets.rglob("*") if f.is_file())
        if items:
            linked["assets"] = items
    scripts = skill_dir / "scripts"
    if scripts.exists():
        items = set()
        for ext in ("*.py", "*.sh", "*.bash", "*.js", "*.ts", "*.rb"):
            items.update(str(f.relative_to(skill_dir)) for f in scripts.glob(ext))
        if items:
            linked["scripts"] = sorted(items)
    return linked


def view_from_file(skill_dir: Path | None, skill_md: Path) -> dict:
    from tools.skills_tool import _parse_frontmatter, _parse_tags, skill_matches_platform

    content = skill_md.read_text(encoding="utf-8")
    frontmatter, _ = _parse_frontmatter(content)
    if not skill_matches_platform(frontmatter):
        return {"success": False, "error": "Skill is not available on this platform."}
    metadata = frontmatter.get("metadata")
    hermes_meta = metadata.get("hermes", {}) if isinstance(metadata, dict) else {}
    try:
        path = str(skill_md.relative_to((skill_dir or skill_md.parent).parent))
    except ValueError:
        path = str(skill_md)
    return {
        "success": True, "name": frontmatter.get("name", skill_md.stem if not skill_dir else skill_dir.name), "description": frontmatter.get("description", ""),
        "tags": _parse_tags(hermes_meta.get("tags") or frontmatter.get("tags", "")), "related_skills": _parse_tags(hermes_meta.get("related_skills") or frontmatter.get("related_skills", "")),
        "content": content, "path": path, "skill_dir": str(skill_dir) if skill_dir else None, "linked_files": _linked_files(skill_dir),
    }


def view_skill(profile_home: Path, name: str) -> dict:
    skills_dir = profile_home / "skills"
    try:
        skill_dir, skill_md = find_skill(name)
    except InvalidParams as exc:
        return {"success": False, "error": str(exc)}
    if skill_md:
        result = view_from_file(skill_dir, skill_md)
        if result.get("success"):
            result["editable"] = skill_md.name == "SKILL.md" and _within(skills_dir, skill_md)
        return result
    if ":" in str(name or ""):
        try:
            from agent.skill_utils import is_valid_namespace, parse_qualified_name
            from hermes_cli.plugins import discover_plugins, get_plugin_manager
            from tools.skills_tool import skill_view

            namespace, _ = parse_qualified_name(name)
            if is_valid_namespace(namespace):
                discover_plugins()
                pm = get_plugin_manager()
                if pm.find_plugin_skill(name) is not None or pm.list_plugin_skills(namespace):
                    raw = skill_view(name)
                    result = json.loads(raw) if isinstance(raw, str) else raw
                    if result.get("success"):
                        result["editable"] = False
                    return result
        except Exception:  # noqa: BLE001
            pass
    names = [s["name"] for s in list_skills(profile_home).get("skills", [])]
    available = names[:20]
    truncated = len(names) > len(available)
    hint = "Use skills_list to see all available skills"
    if truncated:
        hint = f"Showing {len(available)} of {len(names)} skills. {hint}"
    return {"success": False, "error": f"Skill '{name}' not found.", "available_skills": available, "available_skills_truncated": truncated, "total_skills": len(names), "hint": hint}


def register(registry) -> None:
    @registry.method("skills.revisions")
    def revisions(ctx: CallContext, params: dict) -> dict:
        from .skill_revisions import inspect_revisions
        home = profile_home_param(params)
        ctx.check_cancelled()
        with scoped_home(home, load_plugins=False, recover_processes=False):
            result = inspect_revisions(home, params.get('name'), params.get('revision'), params.get('compare_to'))
        ctx.check_cancelled()
        return result

    @registry.method("skills.replay_plan")
    def replay_plan(ctx: CallContext, params: dict) -> dict:
        from .skill_replay import plan
        home = profile_home_param(params)
        with scoped_home(home, load_plugins=False, recover_processes=False):
            return plan(home, params.get('name'), params.get('baseline'), params.get('candidate'))

    @registry.method("skills.replay_case")
    def replay_case(ctx: CallContext, params: dict) -> dict:
        from .skill_replay import dispatch
        home = profile_home_param(params)
        ctx.check_cancelled()
        with scoped_home(home, load_plugins=False, recover_processes=False):
            return dispatch(home, params.get('name'), params)

    @registry.method("skills.list")
    def list_(ctx: CallContext, params: dict) -> dict:
        home = profile_home_param(params)
        with scoped_home(home):
            return list_skills(home, params.get("category") or None)

    @registry.method("skills.set_locked")
    def set_locked(ctx: CallContext, params: dict) -> dict:
        home = profile_home_param(params)
        name = str(params.get("name") or "").strip()
        if not name:
            raise InvalidParams("name is required")
        locked = params.get("locked")
        if not isinstance(locked, bool):
            raise InvalidParams("locked must be a boolean")
        with scoped_home(home):
            return set_skill_lock(name, locked)

    @registry.method("skills.view")
    def view(ctx: CallContext, params: dict) -> dict:
        home = profile_home_param(params)
        name = str(params.get("name") or "").strip()
        if not name:
            raise InvalidParams("name is required")
        with scoped_home(home):
            return view_skill(home, name)

    @registry.method("skills.find")
    def find(ctx: CallContext, params: dict) -> dict:
        home = profile_home_param(params)
        name = str(params.get("name") or "").strip()
        if not name:
            raise InvalidParams("name is required")
        with scoped_home(home):
            skill_dir, skill_md = find_skill(name)
            identity = {}
            if skill_md:
                from tools.skills_tool import _skill_catalog

                catalog = _skill_catalog(skip_disabled=True, include_hidden=True)
                entry = next((e for e in catalog if e["path"] == skill_md), None)
                if entry is not None:
                    if not entry["load_name"]:
                        raise InvalidParams("Skill has no unambiguous catalog identity")
                    identity = {"load_name": entry["load_name"], "declared_name": entry["name"],
                                "sibling_load_names": [e["load_name"] for e in catalog if e["name"] == entry["name"] and e["load_name"]]}
        return {"found": skill_md is not None, "skill_dir": str(skill_dir) if skill_dir else None, "skill_md": str(skill_md) if skill_md else None, **identity}
