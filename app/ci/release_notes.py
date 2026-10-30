#!/usr/bin/env python3
"""Validate tracked release fragments and render notes from immutable Git refs."""

import argparse
import difflib
from datetime import datetime, timezone
import functools
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
# The What's New announcement contract, generated from web/packages/contracts (TAL-1616).
ANNOUNCEMENT_SCHEMA = Path(__file__).resolve().parents[2] / "contracts/whats-new.schema.json"
ANNOUNCED = ("app", "web")


@functools.cache
def announcement_rules():
    """Icons, text limits and row limit from the shared announcement schema."""
    rows = json.loads(ANNOUNCEMENT_SCHEMA.read_text(encoding="utf-8"))["properties"]["rows"]
    row = rows["items"]["properties"]
    return {"icons": row["icon"]["enum"], "title": row["title"]["maxLength"],
            "description": row["description"]["maxLength"], "rows": rows["maxItems"]}


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


def announcement_fields(announcement, components):
    if not isinstance(announcement, dict) or set(announcement) != {"title", "description", "icon"}:
        raise ValueError("announcement requires exactly title, description, and icon")
    if not set(components) & set(ANNOUNCED):
        raise ValueError("an announcement needs an app or web component")
    rules = announcement_rules()
    for field in ("title", "description"):
        plain_text(announcement[field], f"announcement {field}")
        # The contract measures UTF-16 code units, as the Web server's validator does.
        if len(announcement[field].encode("utf-16-le")) // 2 > rules[field]:
            raise ValueError(f"announcement {field} must be at most {rules[field]} characters")
    if announcement["icon"] not in rules["icons"]:
        raise ValueError(f"announcement icon must be one of {', '.join(rules['icons'])}")


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
                        or not set(entry) <= required | {"components", "announcement"}):
                    raise ValueError("each entry requires only category, summary, highlight, and optional components and announcement")
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
                if "announcement" in entry:
                    announcement_fields(entry["announcement"], components)
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
            ".xcodebuildmcp/", DIRECTORY + "/", "TalariaKit/Tests/",
            # The UI-test fixture server is compiled only into DEBUG builds (`#if DEBUG`), so it never ships.
            "Talaria/Config/UITestFixture",
        ))
        or TEST_DIRECTORY.match(path) is not None
        or path in {".gitignore", ".gitattributes", ".gitleaksignore", "CLAUDE.md"}
        # Archive export options configure signing and upload, never the App bundle's contents.
        or re.fullmatch(r"Config/\w*ExportOptions\.plist", path) is not None
    )


PROJECT = "Talaria.xcodeproj/project.pbxproj"
SCHEMES = "Talaria.xcodeproj/xcshareddata/xcschemes/"
# The App's test bundles: TalariaTests, and test targets since removed whose files historical ranges still delete.
TEST_DIRECTORY = re.compile(r"(Talaria\w*Tests)/")
OBJECT = re.compile(r"^(\t+)([0-9A-Z]{24})(?: /\* (.*?) \*/)? = \{$|^\t\t([0-9A-Z]{24}) /\* (.*?) \*/ = \{.*\};$")


def source_at(ref, path):
    """The file at `ref` (the working tree without one); a file that is absent there is empty."""
    if ref:
        try:
            return git("show", f"{ref}:{path}", strip=False)
        except ValueError:
            return ""
    file = Path(git("rev-parse", "--show-toplevel")) / path
    return file.read_text(encoding="utf-8") if file.exists() else ""


def changed_lines(base, target, path):
    """Each side's lines, with the indices the change removed from the base and added in the target."""
    before = source_at(base, path).split("\n")
    after = source_at(target, path).split("\n")
    removed, added = [], []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, before, after, autojunk=False).get_opcodes():
        if tag != "equal":
            removed += range(i1, i2)
            added += range(j1, j2)
    return (before, removed), (after, added)


def project_test_only(base, target, path, names):
    # A project edit that touches only test targets and what only they use leaves the App building as before. An
    # object is a test's when its name is a test file or target, or when only test objects mention it; every other
    # object, less its lines naming test objects, must stay the same.
    def parse(source):
        objects, outside, current = {}, [], None
        for line in source.split("\n"):
            if current is None and (match := OBJECT.match(line)) and len(match[1] or "\t\t") == 2:
                identifier, comment = (match[4], match[5]) if match[4] else (match[2], match[3])
                objects[identifier] = (comment, [line])
                current = None if match[4] else identifier
            elif current is not None:
                objects[current][1].append(line)
                current = None if line == "\t\t};" else current
            else:
                outside.append(line)
        tests = {identifier for identifier, (comment, _) in objects.items()
                 if comment and re.sub(r' in \w+$|^Build configuration list for PBXNativeTarget "|"$', "", comment) in names}
        while grown := {identifier for identifier in objects if identifier not in tests
                        and (users := {other for other, (_, lines) in objects.items() if other != identifier
                                       and any(identifier in line for line in lines)})
                        and users <= tests}:
            tests |= grown
        return objects, outside, tests

    def without_tests(lines, tests):
        kept, skip = [], None
        for line in lines:
            if skip is not None:
                skip = None if line == skip else skip
            elif (match := OBJECT.match(line)) and match[2] in tests:
                skip = match[1] + "};"
            elif not any(identifier in line for identifier in tests):
                kept.append(line)
        return kept

    before, before_outside, before_tests = parse(source_at(base, path))
    after, after_outside, after_tests = parse(source_at(target, path))
    if before_outside != after_outside:
        return False
    for identifier in before.keys() | after.keys():
        if identifier not in after:
            if identifier not in before_tests:
                return False
        elif identifier not in before:
            if identifier not in after_tests:
                return False
        elif not (identifier in before_tests and identifier in after_tests) and \
                without_tests(before[identifier][1], before_tests) != without_tests(after[identifier][1], after_tests):
            return False
    return True


def scheme_test_only(base, target, path):
    # A scheme edit inside its test references only changes which tests run.
    def check(lines, indices):
        inside, testable = False, set()
        for number, line in enumerate(lines):
            if "<TestableReference" in line:
                inside = True
            if inside:
                testable.add(number)
            if "</TestableReference>" in line:
                inside = False
        return set(indices) <= testable
    return all(check(*side) for side in changed_lines(base, target, path))


def debug_whole(text):
    """Whether every non-blank line of a Swift file is inside `#if DEBUG`."""
    lines = text.split("\n")
    return debug_lines(lines) >= {number for number, line in enumerate(lines) if line.strip()}


def debug_lines(lines):
    debug, stack = set(), []
    for number, line in enumerate(lines):
        directive = line.strip()
        if directive.startswith("#if"):
            stack.append(directive == "#if DEBUG")
        if any(stack):
            debug.add(number)
        if directive.startswith(("#else", "#elseif")) and stack:
            # The other branch of a DEBUG check is what ships.
            stack[-1] = False
        if directive.startswith("#endif") and stack:
            stack.pop()
    return debug


def debug_only(base, target, path):
    # Code inside `#if DEBUG` is compiled out of the shipped App, so a change confined to it changes no release.
    def check(lines, indices):
        debug = debug_lines(lines)
        return all(number in debug or not lines[number].strip() for number in indices)
    return all(check(*side) for side in changed_lines(base, target, path))


def test_support_only(base, target, path):
    files = {path.removeprefix("app/") for path in git("ls-tree", "-r", "--name-only", "--full-tree", base).splitlines()}
    files |= {path.removeprefix("app/") for path in (
        git("ls-tree", "-r", "--name-only", "--full-tree", target) if target
        else git("ls-files", "--full-name", "--cached", "--others", "--exclude-standard", ":(top)")).splitlines()}
    # Test bundles' files, and the DEBUG-only UI-test fixture the App target compiles.
    tests = {file for file in files if TEST_DIRECTORY.match(file) or file.startswith("Talaria/Config/UITestFixture")}
    prefix = "app/" if git("ls-tree", "--full-tree", "--name-only", base, "app/" + PROJECT) else ""
    if path == PROJECT:
        # A Swift file that is DEBUG-only from end to end never ships, so neither does its project membership.
        tests |= {other for other in changes(base, target) if other.endswith(".swift")
                  and all(debug_whole(text) for ref in (base, target) if (text := source_at(ref, prefix + other)))}
        # The project names files by basename, so a name a shipping file also has counts as the App's.
        names = {Path(file).name for file in tests} - {Path(file).name for file in files - tests}
        targets = {match[1] for file in files if (match := TEST_DIRECTORY.match(file))}
        names |= {name + suffix for name in targets | {"TalariaTests"} for suffix in ("", ".xctest")}
        return project_test_only(base, target, prefix + path, names)
    if path.startswith(SCHEMES):
        return scheme_test_only(base, target, prefix + path)
    if path.endswith(".swift"):
        return debug_only(base, target, prefix + path)
    if path.endswith(".xcconfig"):
        # A comment-only edit leaves every build setting as before.
        return all(not lines[number].strip() or lines[number].lstrip().startswith("//")
                   for lines, indices in changed_lines(base, target, prefix + path) for number in indices)
    return False


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
        app_changes = [path for path in changed if not repository_only(path)
                       and not test_support_only(base, target, path)]
        if app_changes and not has_app_entries:
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


def release_range(previous, target, version, component):
    """The fragments a component release at `target` introduces after `previous` (`auto`: the highest lower tag)."""
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
    selected = introduced(base, target, snapshot(target))
    if not selected and changes(base, target):
        raise ValueError("missing release fragments in the requested range; add entries or an explicit skip")
    return previous, target, selected


def component_entries(selected, component):
    """`(id, ticket, entry)` for the component's entries, by numeric ticket and then authored order."""
    for path in sorted(selected, key=lambda path: int(FILENAME.fullmatch(Path(path).name)[1])):
        for index, entry in enumerate(selected[path].get("entries", [])):
            if component in entry.get("components", ["app"]):
                yield f"{Path(path).stem}-{index + 1}", Path(path).stem, entry


def announcement(previous, target, version, component):
    """The installed release's What's New payload as exact JSON text, or None when no entry opted in.

    An Experimental Web version (`X.Y.Z-exp.<source>`) is ranged like its `X.Y.Z` core."""
    if component not in ANNOUNCED:
        raise ValueError("announcements are generated for app or web")
    match = re.fullmatch(VERSION + r"(-exp\.[a-f0-9]{12})?", version)
    if not match or match[4] and component != "web":
        raise ValueError("version must use X.Y.Z numeric semantic versioning")
    core = version.split("-", 1)[0]
    _, target, selected = release_range(previous, target, core, component)
    if match[4] and match[4] != "-exp." + target[:12]:
        raise ValueError("an Experimental version must name its source")
    rows = [{"id": identifier, **{key: entry["announcement"][key] for key in ("icon", "title", "description")}}
            for identifier, _, entry in component_entries(selected, component) if "announcement" in entry]
    if not rows:
        return None
    payload = {"schemaVersion": 1, "id": f"{component}-{version}", "component": component, "version": version,
               "sourceCommit": target, "rows": rows[:announcement_rules()["rows"]]}
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def generate(previous, target, version, output, component="app"):
    previous, target, selected = release_range(previous, target, version, component)
    sections = {category: [] for category in CATEGORIES}
    highlights = []
    for identifier, ticket, entry in component_entries(selected, component):
        item = {"id": identifier, "ticket": ticket,
                **{key: value for key, value in entry.items() if key not in ("components", "announcement")}}
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
    announce = commands.add_parser("announcement", help="write the installed release's What's New payload, if any entry opted in")
    announce.add_argument("--previous", default="auto", help="previous release tag; default: highest lower reachable component tag")
    announce.add_argument("--component", choices=ANNOUNCED, required=True)
    announce.add_argument("--target", required=True)
    announce.add_argument("--version", required=True, help="X.Y.Z, or a Web X.Y.Z-exp.<source> Experimental version")
    announce.add_argument("--output", type=Path, required=True)
    published = commands.add_parser("previous-published", help="resolve the last successful upload using GitHub Actions history")
    published.add_argument("--target", required=True)
    published.add_argument("--version", required=True)
    published.add_argument("--repo", required=True)
    published.add_argument("--require-latest", action="store_true", help="bootstrap must advance the latest successful TestFlight publication")
    args = parser.parse_args()
    if args.command in ("generate", "announcement"):
        args.output = args.output.resolve()
    try:
        os.chdir(git("rev-parse", "--show-toplevel"))
        if args.command == "validate":
            validate(args.base, args.target)
        elif args.command == "previous-published":
            print(previous_published(args.target, args.version, args.repo, args.require_latest))
        elif args.command == "announcement":
            payload = announcement(args.previous, args.target, args.version, args.component)
            if payload is None:
                print(f"No {args.component} announcement: no entry in this release opted in.")
            else:
                args.output.parent.mkdir(parents=True, exist_ok=True)
                args.output.write_text(payload, encoding="utf-8")
                print(f"Wrote the {args.component} {args.version} announcement to {args.output}.")
        else:
            generate(args.previous, args.target, args.version, args.output, args.component)
    except (ValueError, OSError, KeyError, IndexError, TypeError, zipfile.BadZipFile) as error:
        parser.exit(1, f"release notes: {error}\n")


if __name__ == "__main__":
    main()
