"""``skills.*``: skill discovery and parsing through the Agent's skill utilities.

File writes (save, delete, toggle) live in the server; this namespace only
parses SKILL.md trees the way ``tools.skills_tool`` does so the WebUI list
matches what the Agent loads.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from ..errors import InvalidParams
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext
from .profiles import disabled_skill_names

log = logging.getLogger("talaria_sidecar.skills")


def _within(base: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(base.resolve())
        return True
    except (OSError, ValueError):
        return False


def search_dirs(skills_dir: Path) -> list[Path]:
    dirs = [skills_dir]
    try:
        from agent.skill_utils import get_external_skills_dirs

        dirs.extend(Path(p) for p in get_external_skills_dirs())
    except Exception:  # noqa: BLE001
        pass
    return [p for p in dirs if p.exists()]


def _category(skill_md: Path, dirs: list[Path], local: Path) -> str | None:
    for skills_dir in dirs:
        try:
            rel = skill_md.relative_to(skills_dir)
        except ValueError:
            continue
        parts = rel.parts[:-1]  # drop SKILL.md
        if len(parts) >= 2:
            return parts[0]
        if len(parts) == 1 and skills_dir.resolve() != local.resolve():
            return skills_dir.name
        return None
    return None


def list_skills(profile_home: Path, category: str | None = None) -> dict:
    skills_dir = profile_home / "skills"
    try:
        from agent.skill_utils import iter_skill_index_files
        from tools.skills_tool import MAX_DESCRIPTION_LENGTH, _EXCLUDED_SKILL_DIRS, _parse_frontmatter, _sort_skills, skill_matches_platform
    except ImportError:
        return {"skills": [], "categories": [], "count": 0}
    if not skills_dir.exists():
        skills_dir.mkdir(parents=True, exist_ok=True)
        return {"success": True, "skills": [], "categories": [], "count": 0, "message": f"No skills found. Skills directory created at {skills_dir}/"}
    disabled = disabled_skill_names(profile_home)
    dirs = search_dirs(skills_dir)
    seen: set[str] = set()
    out = []
    for scan in dirs:
        for skill_md in iter_skill_index_files(scan, "SKILL.md"):
            if any(part in _EXCLUDED_SKILL_DIRS for part in skill_md.parts):
                continue
            try:
                frontmatter, body = _parse_frontmatter(skill_md.read_text(encoding="utf-8")[:4000])
                if not skill_matches_platform(frontmatter):
                    continue
                name = frontmatter.get("name", skill_md.parent.name)[:64]
                if name in seen:
                    continue
                description = frontmatter.get("description", "")
                if not description:
                    for line in body.strip().split("\n"):
                        line = line.strip()
                        if line and not line.startswith("#"):
                            description = line
                            break
                if len(description) > MAX_DESCRIPTION_LENGTH:
                    description = description[: MAX_DESCRIPTION_LENGTH - 3] + "..."
                seen.add(name)
                out.append({"name": name, "description": description, "category": _category(skill_md, dirs, skills_dir), "disabled": name in disabled})
            except Exception:  # noqa: BLE001
                log.debug("Skipping skill at %s", skill_md, exc_info=True)
    if category:
        out = [s for s in out if s.get("category") == category]
    out = _sort_skills(out)
    categories = sorted({s["category"] for s in out if s.get("category")})
    return {"success": True, "skills": out, "categories": categories, "count": len(out)}


def find_skill(name: str, dirs: list[Path]) -> tuple[Path | None, Path | None]:
    from agent.skill_utils import iter_skill_index_files
    from tools.skills_tool import _EXCLUDED_SKILL_DIRS, _parse_frontmatter

    raw = str(name or "").strip().strip("/")
    if not raw:
        return None, None
    candidates = [raw]
    if ":" in raw:
        namespace, bare = raw.split(":", 1)
        if namespace and bare:
            candidates.append(f"{namespace}/{bare}")
    for skills_dir in dirs:
        if not skills_dir.exists():
            continue
        for candidate in candidates:
            direct = skills_dir / candidate
            if not _within(skills_dir, direct):
                continue
            if direct.is_dir() and (direct / "SKILL.md").exists():
                return direct, direct / "SKILL.md"
            legacy = direct.with_suffix(".md")
            if legacy.exists() and _within(skills_dir, legacy):
                return legacy.parent, legacy
        for skill_md in iter_skill_index_files(skills_dir, "SKILL.md"):
            if any(part in _EXCLUDED_SKILL_DIRS for part in skill_md.parts):
                continue
            if skill_md.parent.name == raw:
                return skill_md.parent, skill_md
            try:
                frontmatter, _ = _parse_frontmatter(skill_md.read_text(encoding="utf-8")[:4000])
                if frontmatter.get("name") == raw:
                    return skill_md.parent, skill_md
            except Exception:  # noqa: BLE001
                continue
        for legacy_md in _legacy_markdown(skills_dir):
            if legacy_md.stem == raw and _within(skills_dir, legacy_md):
                return legacy_md.parent, legacy_md
    return None, None


def _legacy_markdown(skills_dir: Path):
    """Pruned walk for legacy ``<name>.md`` skills (never rglob)."""
    import os

    try:
        from agent.skill_utils import EXCLUDED_SKILL_DIRS
    except Exception:  # noqa: BLE001
        EXCLUDED_SKILL_DIRS = frozenset({".git", ".venv", "node_modules", "site-packages"})
    for root, dirnames, filenames in os.walk(skills_dir, followlinks=True):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDED_SKILL_DIRS]
        for filename in filenames:
            if filename != "SKILL.md" and filename.endswith(".md"):
                yield Path(root) / filename


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
    dirs = search_dirs(skills_dir)
    skill_dir, skill_md = find_skill(name, dirs)
    if skill_md:
        return view_from_file(skill_dir, skill_md)
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
                    return json.loads(raw) if isinstance(raw, str) else raw
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
    @registry.method("skills.list")
    def list_(ctx: CallContext, params: dict) -> dict:
        home = profile_home_param(params)
        with scoped_home(home):
            return list_skills(home, params.get("category") or None)

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
            skill_dir, skill_md = find_skill(name, search_dirs(home / "skills"))
        return {"found": skill_md is not None, "skill_dir": str(skill_dir) if skill_dir else None, "skill_md": str(skill_md) if skill_md else None}
