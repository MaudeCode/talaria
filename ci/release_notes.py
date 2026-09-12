#!/usr/bin/env python3
"""Validate tracked release fragments and render notes from immutable Git refs."""

import argparse
from datetime import datetime, timezone
import html
import json
from pathlib import Path
import re
import subprocess


DIRECTORY = "changelog.d"
CATEGORIES = ("Added", "Changed", "Fixed", "Security")
VERSION = r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
FILENAME = re.compile(r"TAL-([1-9][0-9]*)\.json")


def git(*args):
    result = subprocess.run(["git", *args], encoding="utf-8", capture_output=True)
    if result.returncode:
        raise ValueError(f"git {' '.join(args)}: {result.stderr.strip()}")
    return result.stdout.rstrip("\n")


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
                if not isinstance(entry, dict) or set(entry) != {"category", "summary", "highlight"}:
                    raise ValueError("each entry requires only category, summary, and highlight")
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


def snapshot(ref):
    paths = git("ls-tree", "-r", "--name-only", "-z", ref, "--", DIRECTORY).split("\0")
    return {path: fragment(path, git("show", f"{ref}:{path}")) for path in paths if path}


def changes(base, target=None):
    args = ["diff", "--no-renames", "--name-only", "-z", base]
    if target:
        args.append(target)
    return [path for path in git(*args, "--").split("\0") if path]


def introduced(base, target, current):
    old = snapshot(base)
    for path in changes(base, target):
        if path.startswith(DIRECTORY + "/") and path in old:
            raise ValueError(f"{path}: out-of-range fragment already exists at base; add a new ticket fragment")
    return {path: data for path, data in current.items() if path not in old}


def repository_only(path):
    # Fail closed for app sources, assets, project settings, and unknown paths.
    return (
        path.endswith(".md")
        or path.startswith((
            "docs/", "ci/", "scripts/", ".github/", ".agents/", ".agy/", ".codex/",
            ".xcodebuildmcp/", DIRECTORY + "/", "TalariaTests/", "TalariaUITests/",
        ))
        or path in {"LICENSE", ".gitignore", "CLAUDE.md"}
    )


def validate(base=None):
    paths = sorted(path for path in Path(DIRECTORY).rglob("*") if path.is_file())
    current = {path.as_posix(): fragment(path.as_posix(), path.read_text(encoding="utf-8")) for path in paths}
    if base:
        base = commit(base)
        selected = introduced(base, None, current)
        changed = changes(base)
        if changed and not selected:
            raise ValueError(f"missing release metadata: add {DIRECTORY}/TAL-<number>.json with entries or an explicit skip reason")
        if any(not repository_only(path) for path in changed) and not any("entries" in data for data in selected.values()):
            raise ValueError("app or unclassified changes require user-facing entries; skip is only for repository/docs/test work")
        # Subjects identify tickets only; release prose always comes from JSON.
        subjects = git("log", "--no-merges", "--format=%s", f"{base}..HEAD")
        tickets = set()
        for subject in subjects.splitlines():
            prefix = subject.split(":", 1)[0]
            if re.fullmatch(r"TAL-[1-9][0-9]*(?:, TAL-[1-9][0-9]*)*", prefix):
                tickets.update(prefix.split(", "))
        missing = tickets - {Path(path).stem for path in selected}
        if missing:
            raise ValueError(f"missing release fragments for tracked commits: {', '.join(sorted(missing))}")
    print(f"Validated {len(current)} release fragments.")


def previous_tag(target, version):
    target_version = tuple(map(int, version.split(".")))
    candidates = []
    for tag in git("tag", "--merged", target).splitlines():
        if re.fullmatch("v" + VERSION, tag):
            parts = tuple(map(int, tag[1:].split(".")))
            if parts < target_version:
                candidates.append((parts, tag))
    if not candidates:
        raise ValueError("no preceding semantic release tag is reachable; supply --previous for an explicit initial baseline")
    return max(candidates)[1]


def markdown_text(value):
    value = html.escape(value, quote=False)
    return re.sub(r"([\\`*_{}\[\]()#+.!|>~-])", r"\\\1", value)


def generate(previous, target, version, output):
    if not re.fullmatch(VERSION, version):
        raise ValueError("version must use X.Y.Z numeric semantic versioning")
    target = commit(target)
    if previous == "auto":
        previous = previous_tag(target, version)
    base = commit(previous)
    if git("merge-base", base, target) != base or base == target:
        raise ValueError("previous release must be a strict ancestor of target")
    current = snapshot(target)
    selected = introduced(base, target, current)
    if not selected:
        raise ValueError("missing release fragments in the requested range; add entries or an explicit skip")
    sections = {category: [] for category in CATEGORIES}
    highlights = []
    for path in sorted(selected, key=lambda path: int(FILENAME.fullmatch(Path(path).name)[1])):
        for index, entry in enumerate(selected[path].get("entries", [])):
            item = {"id": f"{Path(path).stem}-{index + 1}", "ticket": Path(path).stem, **entry}
            sections[entry["category"]].append(item)
            if entry["highlight"]:
                highlights.append(item)
    date = datetime.fromtimestamp(int(git("show", "-s", "--format=%ct", target)), timezone.utc).date().isoformat()
    release = {"version": version, "date": date, "highlights": highlights,
               "sections": [{"category": category, "entries": entries} for category, entries in sections.items() if entries]}
    catalog = {"schemaVersion": 1, "releases": [release]}
    lines = [f"## [{version}] - {date}", ""]
    groups = [("Featured", highlights), *sections.items()]
    for title, entries in groups:
        if entries:
            lines.extend([f"### {title}", ""])
            lines.extend(f"- {markdown_text(entry['summary'])}" for entry in entries)
            lines.append("")
    if not any(sections.values()):
        lines.extend(["No app-facing release notes were recorded for this release.", ""])
    output.mkdir(parents=True, exist_ok=True)
    (output / "release-notes.md").write_text("\n".join(lines), encoding="utf-8")
    (output / "release-notes.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Generated {version} from {previous}..{target} ({len(selected)} fragments) in {output}.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    check = commands.add_parser("validate", help="validate working-tree fragments; stage new files before --base checks")
    check.add_argument("--base", help="require metadata for the change since this commit")
    render = commands.add_parser("generate", help="render the target Git tree, ignoring working-tree edits")
    render.add_argument("--previous", default="auto", help="previous release tag; default: highest lower reachable vX.Y.Z tag")
    render.add_argument("--target", required=True)
    render.add_argument("--version", required=True)
    render.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "validate":
            validate(args.base)
        else:
            generate(args.previous, args.target, args.version, args.output)
    except (ValueError, OSError) as error:
        parser.exit(1, f"release notes: {error}\n")


if __name__ == "__main__":
    main()
