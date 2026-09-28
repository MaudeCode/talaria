#!/usr/bin/env python3
"""Validate tracked release fragments and render notes from immutable Git refs."""

import argparse
from datetime import datetime, timezone
import html
import io
import json
import os
from pathlib import Path
import re
import subprocess
import zipfile


DIRECTORY = "changelog.d"
CATEGORIES = ("Added", "Changed", "Fixed", "Security")
COMPONENTS = ("app", "web", "relay")
VERSION = r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
FILENAME = re.compile(r"TAL-([1-9][0-9]*)\.json")


def git(*args, strip=True):
    result = subprocess.run(["git", *args], encoding="utf-8", capture_output=True)
    if result.returncode:
        raise ValueError(f"git {' '.join(args)}: {result.stderr.strip()}")
    return result.stdout.rstrip("\n") if strip else result.stdout


def commit(ref):
    return git("rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}")


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def plain_text(value, field):
    if not isinstance(value, str) or not value.strip() or value != value.strip():
        raise ValueError(f"{field} must be non-empty text without surrounding whitespace")
    value.encode("utf-8")
    if len(value.splitlines()) != 1 or any(ord(char) < 32 for char in value):
        raise ValueError(f"{field} must be a single line of plain text")


def fragment(path, source):
    try:
        if not FILENAME.fullmatch(Path(path).name) or Path(path).parent != Path(DIRECTORY):
            raise ValueError(f"use {DIRECTORY}/TAL-<number>.json")
        data = json.loads(source, object_pairs_hook=unique_keys)
        if not isinstance(data, dict):
            raise ValueError('expected an object with "entries" or "skip"')
        if set(data) == {"skip"}:
            plain_text(data["skip"], "skip reason")
        elif set(data) == {"entries"} and isinstance(data["entries"], list) and data["entries"]:
            for entry in data["entries"]:
                required = {"category", "summary", "highlight"}
                if (not isinstance(entry, dict) or not required <= set(entry)
                        or not set(entry) <= required | {"components"}):
                    raise ValueError("each entry requires only category, summary, highlight, and optional components")
                components = entry.get("components", ["app"])
                if (not isinstance(components, list) or not components
                        or any(component not in COMPONENTS for component in components)
                        or len(set(components)) != len(components)):
                    raise ValueError("components must be a non-empty unique list of app, web, or relay")
                if entry["category"] not in CATEGORIES:
                    raise ValueError(f"unsupported category; use {', '.join(CATEGORIES)}")
                plain_text(entry["summary"], "summary")
                if type(entry["highlight"]) is not bool:
                    raise ValueError("highlight must be true or false")
        else:
            raise ValueError('provide a non-empty "entries" array OR a "skip" reason')
        return data
    except (ValueError, TypeError) as error:
        raise ValueError(f"{path}: {error}") from error


def snapshot_sources(ref):
    paths = git("ls-tree", "-r", "--name-only", "-z", ref, "--", DIRECTORY, "app/" + DIRECTORY).split("\0")
    result = {}
    for path in filter(None, paths):
        key = path.removeprefix("app/")
        if key in result:
            raise ValueError(f"duplicate release fragment across layouts: {key}")
        result[key] = git("show", f"{ref}:{path}", strip=False)
    return result


def snapshot(ref):
    return {path: fragment(path, source) for path, source in snapshot_sources(ref).items()}


def changes(base, target=None):
    args = ["diff", "--find-renames=100%", "--name-status", "-z", base]
    if target:
        args.append(target)
    fields = iter(git(*args, "--").split("\0"))
    paths = []
    for status in fields:
        if not status:
            continue
        path = next(fields)
        if status.startswith("R"):
            destination = next(fields)
            # A byte-identical app relocation has no app-facing release note.
            if status == "R100" and destination == "app/" + path:
                continue
            paths.append(destination.removeprefix("app/"))
        paths.append(path.removeprefix("app/"))
    return paths


def introduced(base, target, current):
    old = snapshot_sources(base)
    if target:
        sources = snapshot_sources(target)
    else:
        directory = Path("app") if Path("app/changelog.d").is_dir() else Path(".")
        sources = {path: (directory / path).read_text(encoding="utf-8")
                   for path in current}
    for path, source in old.items():
        if sources.get(path) != source:
            raise ValueError(f"{path}: out-of-range fragment already exists at base; add a new ticket fragment")
    return {path: data for path, data in current.items() if path not in old}


def repository_only(path):
    # Fail closed for app sources, assets, project settings, and unknown paths.
    # Uppercase extensionless top-level files (LICENSE and the like) are repository metadata.
    return (
        path.endswith(".md")
        or re.fullmatch(r"[A-Z][A-Z_]*", path) is not None
        or path.startswith((
            "web/", "relay/", "contracts/", "releases/", "docs/", "ci/", "scripts/", ".github/", ".agents/", ".agy/", ".codex/",
            ".xcodebuildmcp/", DIRECTORY + "/", "TalariaTests/", "TalariaUITests/",
        ))
        or path in {".gitignore", ".gitattributes", ".gitleaksignore", "CLAUDE.md"}
    )


def validate(base=None, target=None):
    if target and not base:
        raise ValueError("--target requires --base for change-scope validation")
    directory = Path("app") if Path("app/changelog.d").is_dir() else Path(".")
    paths = sorted(path for path in (directory / DIRECTORY).rglob("*") if path.is_file())
    current = {path.relative_to(directory).as_posix(): fragment(
        path.relative_to(directory).as_posix(), path.read_text(encoding="utf-8")) for path in paths}
    if base:
        base = commit(base)
        target = commit(target) if target else None
        selected = introduced(base, target, snapshot(target) if target else current)
        changed = changes(base, target)
        if changed and not selected:
            raise ValueError(f"missing release metadata: add {DIRECTORY}/TAL-<number>.json with entries or an explicit skip reason")
        has_app_entries = any("app" in entry.get("components", ["app"])
                              for data in selected.values() for entry in data.get("entries", []))
        if any(not repository_only(path) for path in changed) and not has_app_entries:
            raise ValueError("app or unclassified changes require user-facing entries; skip is only for repository/docs/test work")
        # Subjects identify tickets only; release prose always comes from JSON.
        subjects = git("log", "--first-parent", "--no-merges", "--format=%s", f"{base}..{target or 'HEAD'}")
        tickets = set()
        for subject in subjects.splitlines():
            prefix = subject.split(":", 1)[0]
            if re.fullmatch(r"TAL-[1-9][0-9]*(?:, TAL-[1-9][0-9]*)*", prefix):
                tickets.update(prefix.split(", "))
        missing = tickets - {Path(path).stem for path in selected}
        if missing:
            raise ValueError(f"missing release fragments for tracked commits: {', '.join(sorted(missing))}")
    print(f"Validated {len(current)} release fragments.")


def version_from_tag(tag, component="app"):
    prefixes = ("app-v", "v") if component == "app" else (f"{component}-v",)
    for prefix in prefixes:
        if tag.startswith(prefix) and re.fullmatch(VERSION, tag[len(prefix):]):
            return tag[len(prefix):]
    return None


def previous_tag(target, version, component="app"):
    target_version = tuple(map(int, version.split(".")))
    candidates = []
    for tag in git("tag", "--merged", target).splitlines():
        parsed = version_from_tag(tag, component)
        if parsed:
            parts = tuple(map(int, parsed.split(".")))
            if parts < target_version:
                candidates.append((parts, tag))
    if not candidates:
        raise ValueError("no preceding semantic release tag is reachable; supply --previous for an explicit initial baseline")
    return max(candidates)[1]


def github_api(path, paginate=True):
    options = ["--paginate", "--slurp"] if paginate else []
    result = subprocess.run(["gh", "api", path, *options], capture_output=True)
    if result.returncode:
        raise ValueError(f"GitHub release history: {result.stderr.decode('utf-8').strip()}")
    return json.loads(result.stdout) if paginate else result.stdout


def previous_published(target, version, repository, require_latest=False):
    """Use successful uploads, never the mere existence of a semantic tag."""
    if not re.fullmatch(VERSION, version):
        raise ValueError("version must use X.Y.Z numeric semantic versioning")
    target = commit(target)
    target_version = tuple(map(int, version.split(".")))
    root = f"repos/{repository}/actions"
    published = []
    pages = github_api(f"{root}/workflows/release.yml/runs?status=success&per_page=100")
    for run in (run for page in pages for run in page["workflow_runs"]):
        if run["conclusion"] != "success" or run["event"] not in {"push", "workflow_dispatch"}:
            continue
        jobs = github_api(f"{root}/runs/{run['id']}/jobs?per_page=100")
        for page in jobs:
            for job in page["jobs"]:
                if job["name"] == "Publish iOS app" and job["conclusion"] == "success":
                    published.append((job["completed_at"], run))
    artifact_cache = {}

    def publication_artifact(run):
        if run["id"] not in artifact_cache:
            pages = github_api(f"{root}/runs/{run['id']}/artifacts?per_page=100")
            artifacts = [artifact for page in pages for artifact in page["artifacts"]
                         if artifact["name"].startswith("release-notes-")]
            if len(artifacts) != 1:
                raise ValueError(f"published manual run {run['id']} lacks retained release-note provenance")
            artifact_cache[run["id"]] = artifacts[0]
        return artifact_cache[run["id"]]

    if require_latest:
        latest = None
        for date, run in published:
            released = (version_from_tag(run["head_branch"] or "") if run["event"] == "push"
                        else publication_artifact(run)["name"].removeprefix("release-notes-"))
            if released is None:
                continue
            if not re.fullmatch(VERSION, released):
                raise ValueError(f"invalid published version in run {run['id']}")
            parts = tuple(map(int, released.split(".")))
            if parts >= target_version:
                raise ValueError(f"bootstrap App version {version} must advance published TestFlight version {released}")
            if latest is None or (parts, date) > latest[:2]:
                latest = (parts, date, run)
        published = [(latest[1], latest[2])] if latest else []

    for _, run in sorted(published, key=lambda item: item[0], reverse=True):
        if run["event"] == "push":
            tag = run["head_branch"] or ""
            released_version = version_from_tag(tag)
            if not released_version:
                continue
            sha = run["head_sha"]
            if tuple(map(int, released_version.split("."))) >= target_version:
                continue
            if commit(f"refs/tags/{tag}") != sha:
                raise ValueError(f"published tag {tag} no longer matches run {run['id']}; refusing an ambiguous baseline")
        else:
            # Dispatch run.head_sha is the workflow ref, not the checked-out tag.
            artifacts = [publication_artifact(run)]
            artifact_version = artifacts[0]["name"].removeprefix("release-notes-")
            if not re.fullmatch(VERSION, artifact_version):
                raise ValueError(f"invalid release artifact name in run {run['id']}")
            if tuple(map(int, artifact_version.split("."))) >= target_version:
                continue
            if artifacts[0]["expired"]:
                raise ValueError(f"published manual run {run['id']} lacks retained release-note provenance")
            archive = github_api(f"{root}/artifacts/{artifacts[0]['id']}/zip", paginate=False)
            with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
                catalog = json.loads(bundle.read("release-notes.json"))
            if catalog["schemaVersion"] != 1 or len(catalog["releases"]) != 1:
                raise ValueError(f"invalid release catalog in run {run['id']}")
            released_version = catalog["releases"][0]["version"]
            sha = catalog["sourceCommit"]
            if artifacts[0]["name"] != f"release-notes-{released_version}":
                raise ValueError(f"release artifact version mismatch in run {run['id']}")
        if (not isinstance(released_version, str) or not re.fullmatch(VERSION, released_version)
                or not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha)):
            raise ValueError(f"invalid release provenance in run {run['id']}")
        parts = tuple(map(int, released_version.split(".")))
        if parts < target_version and git("merge-base", sha, target) == sha:
            return sha
    raise ValueError("no successful published release baseline found in retained GitHub Actions history")


def markdown_text(value):
    value = html.escape(value, quote=False)
    return re.sub(r"([\\`*_{}\[\]()#+.!|>~-])", r"\\\1", value)


def generate(previous, target, version, output, component="app"):
    if component not in COMPONENTS:
        raise ValueError("component must be app, web, or relay")
    if not re.fullmatch(VERSION, version):
        raise ValueError("version must use X.Y.Z numeric semantic versioning")
    target = commit(target)
    if previous == "auto":
        previous = previous_tag(target, version, component)
    base = commit(previous)
    if git("merge-base", base, target) != base:
        raise ValueError("previous release must be an ancestor of target")
    current = snapshot(target)
    selected = introduced(base, target, current)
    if not selected and changes(base, target):
        raise ValueError("missing release fragments in the requested range; add entries or an explicit skip")
    sections = {category: [] for category in CATEGORIES}
    highlights = []
    for path in sorted(selected, key=lambda path: int(FILENAME.fullmatch(Path(path).name)[1])):
        for index, entry in enumerate(selected[path].get("entries", [])):
            if component not in entry.get("components", ["app"]):
                continue
            item = {"id": f"{Path(path).stem}-{index + 1}", "ticket": Path(path).stem,
                    **{key: value for key, value in entry.items() if key != "components"}}
            sections[entry["category"]].append(item)
            if entry["highlight"]:
                highlights.append(item)
    date = datetime.fromtimestamp(int(git("show", "-s", "--format=%ct", target)), timezone.utc).date().isoformat()
    release = {"version": version, "date": date, "highlights": highlights,
               "sections": [{"category": category, "entries": entries} for category, entries in sections.items() if entries]}
    catalog = {"schemaVersion": 1, "sourceCommit": target, "releases": [release]}
    lines = [f"## [{version}] - {date}", ""]
    groups = [("Featured", highlights), *sections.items()]
    for title, entries in groups:
        if entries:
            lines.extend([f"### {title}", ""])
            lines.extend(f"- {markdown_text(entry['summary'])}" for entry in entries)
            lines.append("")
    if not any(sections.values()):
        empty_message = ("No app-facing release notes were recorded for this release." if component == "app"
                         else "No component-specific release notes were recorded for this release.")
        lines.extend([empty_message, ""])
    output.mkdir(parents=True, exist_ok=True)
    (output / "release-notes.md").write_text("\n".join(lines), encoding="utf-8")
    (output / "release-notes.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Generated {version} from {previous}..{target} ({len(selected)} fragments) in {output}.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    check = commands.add_parser("validate", help="validate working-tree fragments; stage new files before --base checks")
    check.add_argument("--base", help="require metadata for the change since this commit")
    check.add_argument("--target", help="scope --base checks to this Git ref; still validate all working-tree fragments")
    render = commands.add_parser("generate", help="render the target Git tree, ignoring working-tree edits")
    render.add_argument("--previous", default="auto", help="previous release tag; default: highest lower reachable component tag")
    render.add_argument("--component", choices=COMPONENTS, default="app")
    render.add_argument("--target", required=True)
    render.add_argument("--version", required=True)
    render.add_argument("--output", type=Path, required=True)
    published = commands.add_parser("previous-published", help="resolve the last successful upload using GitHub Actions history")
    published.add_argument("--target", required=True)
    published.add_argument("--version", required=True)
    published.add_argument("--repo", required=True)
    published.add_argument("--require-latest", action="store_true", help="bootstrap must advance the latest successful TestFlight publication")
    args = parser.parse_args()
    if args.command == "generate":
        args.output = args.output.resolve()
    try:
        os.chdir(git("rev-parse", "--show-toplevel"))
        if args.command == "validate":
            validate(args.base, args.target)
        elif args.command == "previous-published":
            print(previous_published(args.target, args.version, args.repo, args.require_latest))
        else:
            generate(args.previous, args.target, args.version, args.output, args.component)
    except (ValueError, OSError, KeyError, IndexError, TypeError, zipfile.BadZipFile) as error:
        parser.exit(1, f"release notes: {error}\n")


if __name__ == "__main__":
    main()
