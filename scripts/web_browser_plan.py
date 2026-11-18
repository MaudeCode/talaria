#!/usr/bin/env python3
"""Which Playwright specs a pull request runs (TAL-2391), the filters that select them and the receipts that prove it.

scripts/changed-components.py owns the diff and calls `plan()` for a pull request. A plan's mode is `none` (no browser
job), `specs` (the listed spec files, on every project, in one job) or `full` (every shard), with the reasons that chose
it. Only two kinds of change narrow, and only when no file in the frontend package imports them:

- A Playwright spec under e2e/ runs alone; a deleted one runs nothing.
- A Vitest test file (vitest.config.ts `include`) needs no browser job: Playwright and the bundle never load it.

Any other path that selects web_frontend (application code, e2e helpers, fixtures, global setup, Playwright and Vite
config, lockfiles, contracts, server code, the browser workflow and its scripts), a computed import() or require() in
e2e/ or the Playwright config, an unreadable source file, or a path with a control character runs every shard. Main pushes and manual runs never ask for a plan and run every shard.

scripts/check-web-browser runs a `specs` plan with `--spec=PATH` arguments. It turns them into anchored, escaped
Playwright file filters with `filters` and, after the run, requires `receipts`: test cases from every selected file on
every project and from no other file.
"""

import json
import os
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ElementTree

FRONTEND = "web/packages/frontend/"
# playwright.config.ts `projects`: every selected spec runs on each.
PROJECTS = ("desktop", "mobile")
# Playwright's default testMatch inside the config's testDir.
SPEC = re.compile(r"e2e/.+\.(?:spec|test)\.[cm]?[jt]sx?")
# vitest.config.ts `include`.
UNIT = re.compile(r"(?:src/.+\.test\.tsx?|scripts/i18n-gate\.test\.ts|scripts/check-ui-rules\.test\.ts)")
# ponytail: a file-count cap. A full shard runs about 30 spec files after the same setup, so ten never take longer than
# one; measure per-spec time if larger selections should narrow too.
MAX_SPECS = 10
SOURCES = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs")
IMPORT = re.compile(r"""(?:\bfrom|\bimport|\brequire\s*\(|\bimport\s*\()\s*(['"])([^'"\n]+)\1""")
# import() or require() of a computed name: the scan cannot tell which file it loads.
COMPUTED = re.compile(r"""(?<![\w$.])(?:import|require)\s*\(\s*(?!['"\s)])""")


class Uncertain(Exception):
    """The scan cannot bound which files the browser suite loads; every shard runs."""


def full(reason):
    return {"mode": "full", "specs": [], "reasons": [reason]}


def targets(importer, specifier):
    """The repository paths an import specifier can name: as written, with each source extension, or as a directory's
    index. A `.js` specifier also names its TypeScript source. Package imports name nothing in the repository."""
    if specifier.startswith("~/"):
        stem = FRONTEND + "src/" + specifier[2:]
    elif specifier.startswith("."):
        stem = os.path.normpath(os.path.join(os.path.dirname(importer), specifier))
    else:
        return set()
    base, extension = os.path.splitext(stem)
    stems = {stem, base} if extension in SOURCES else {stem}
    return {stem} | {f"{name}{suffix}" for name in stems for suffix in SOURCES} | {
        f"{stem}/index{suffix}" for suffix in SOURCES}


def importers(tree):
    """Every frontend source file's relative imports, as {imported path: importers}."""
    paths = [path for path in tree.paths if path.startswith(FRONTEND) and path.endswith(SOURCES)]
    result = {}
    for path, text in tree.read(paths).items():
        if text is None:
            raise Uncertain(f"{path} could not be read")
        local = path.removeprefix(FRONTEND)
        if (local.startswith("e2e/") or local.startswith("playwright.config.")) and COMPUTED.search(text):
            raise Uncertain(f"{path} loads a module by a computed name")
        for match in IMPORT.finditer(text):
            for target in targets(path, match.group(2)) - {path}:
                result.setdefault(target, set()).add(path)
    return result


def plan(paths, tree, path_suites):
    """The browser plan for a pull request's changed `paths`, read against the tested `tree` (app_test_plan.Tree rooted
    at the frontend package), with the router's per-path classification."""
    candidates = []
    for path in sorted(paths):
        if "web_frontend" not in path_suites(path):
            continue
        local = path.removeprefix(FRONTEND) if path.startswith(FRONTEND) else ""
        if not (SPEC.fullmatch(local) or UNIT.fullmatch(local)):
            return full(f"{path} reaches the browser suite.")
        if any(ord(character) < 32 or ord(character) == 127 for character in path):
            return full(f"{path!r} has a control character.")
        candidates.append(path)
    if not candidates:
        return {"mode": "none", "specs": [], "reasons": ["No changed path reaches the browser suite."]}
    try:
        imported = importers(tree)
    except Uncertain as error:
        return full(f"{error}.")
    present = set(tree.paths)
    specs, reasons = [], []
    for path in candidates:
        if imported.get(path):
            return full(f"{path} is imported by {min(imported[path])}.")
        local = path.removeprefix(FRONTEND)
        if not SPEC.fullmatch(local):
            reasons.append(f"{path}: a Vitest test, which the browser suite never loads.")
        elif path in present:
            specs.append(local)
            reasons.append(f"{path}: an independent spec, run on every project.")
        else:
            reasons.append(f"{path}: a deleted spec.")
    if len(specs) > MAX_SPECS:
        return full(f"{len(specs)} changed specs: more than {MAX_SPECS} run faster across every shard.")
    return {"mode": "specs" if specs else "none", "specs": specs, "reasons": reasons}


def describe(result):
    lines = [f"Browser plan: {result['mode']}"]
    lines += [f"  run {spec}" for spec in result["specs"]]
    lines += [f"  why {reason}" for reason in result["reasons"]]
    return "\n".join(lines)


def validate(frontend, specs):
    """The selected spec paths, relative to the frontend package: each an existing Playwright spec, once."""
    if not specs:
        raise ValueError("no spec selected")
    if len(set(specs)) != len(specs):
        raise ValueError("a spec is selected twice")
    for spec in specs:
        if not SPEC.fullmatch(spec) or ".." in spec.split("/") or not (Path(frontend) / spec).is_file():
            raise ValueError(f"{spec!r} is not a Playwright spec under {frontend}/e2e")
    return specs


def filters(frontend, specs):
    """One Playwright file filter per spec: a regular expression anchored to the spec's absolute path, every character
    with a regular-expression meaning escaped, and no flags, so it is case-sensitive and matches that file alone."""
    root = os.path.realpath(frontend)
    return ["/^" + re.sub(r"([\\^$.*+?()[\]{}|/])", r"\\\1", f"{root}/{spec}") + "$/" for spec in validate(frontend, specs)]


def receipts(report, specs):
    """Require the JUnit report's test cases to come from every selected spec on every project, and from nothing else.
    A test a project skips still reports a case, so project-specific skips count."""
    ran = {}
    for suite in ElementTree.parse(report).getroot().iter("testsuite"):
        if int(suite.get("tests", "0")):
            key = (f"e2e/{suite.get('name')}", suite.get("hostname"))
            ran[key] = ran.get(key, 0) + int(suite.get("tests"))
    expected = {(spec, project) for spec in specs for project in PROJECTS}
    errors = [f"{spec} ran no test on {project}" for spec, project in sorted(expected - set(ran))]
    errors += [f"{spec} on {project} was not selected" for spec, project in sorted(set(ran) - expected)]
    if errors:
        raise ValueError("; ".join(errors))
    return sum(ran.values())


def main():
    command, *args = sys.argv[1:] or [""]
    try:
        if command == "filters" and args:
            print("\n".join(filters(args[0], args[1:])))
        elif command == "receipts" and len(args) >= 2:
            count = receipts(args[0], validate(args[1], args[2:]))
            print(f"Every selected spec ran on {', '.join(PROJECTS)}: {count} test case(s).")
        else:
            raise ValueError("usage: web_browser_plan.py filters FRONTEND SPEC... | receipts REPORT FRONTEND SPEC...")
    except (OSError, ValueError, ElementTree.ParseError) as error:
        print(f"web_browser_plan.py: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
