#!/usr/bin/env python3
"""Prepare an exact Hermes Agent range for the read-only release review (TAL-352).

``prepare`` resolves the candidate (a release tag, ``main``, or a full SHA) and the
base (``--base`` or the state file's last reviewed SHA) to exact commits, fetches a
disposable shallow checkout and deepens it until the base is an ancestor of the
candidate. Missing or rewritten history is reported instead of narrowing the
range. It prints a JSON manifest: identities, compare link, non-merge commit count,
changed files per area, and the changed Agent modules the sidecar imports.

``advance`` records the reviewed watermark after a complete report. It changes only
``lastReviewed`` in the state file; last observed and last passing SHAs stay as-is.
Nothing here edits Talaria source, the Agent pin, the tracker, or a deployment.
"""

import argparse
import ast
import collections
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPOSITORY = "NousResearch/hermes-agent"
SHA = re.compile(r"[0-9a-f]{40}")
SECRET = re.compile(r"(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abp]-[A-Za-z0-9-]{10,})")


def git(checkout, *args, check=True):
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_NOSYSTEM": "1"}
    # Detached auto-maintenance after a fetch rewrites .git/shallow under the next --deepen.
    result = subprocess.run(["git", "-C", str(checkout), "-c", "gc.auto=0", "-c", "maintenance.auto=false", *args],
                            env=env, text=True, capture_output=True)
    if check and result.returncode:
        raise SystemExit(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result


def resolve(remote, ref):
    """Return (exact SHA, kind). Tags are releases; ``main`` and bare SHAs are unreleased."""
    if SHA.fullmatch(ref):
        return ref, "unreleased"
    name = "refs/heads/main" if ref == "main" else f"refs/tags/{ref}"
    listed = subprocess.run(["git", "ls-remote", remote, name, f"{name}^{{}}"], text=True, capture_output=True, check=True).stdout
    refs = dict(reversed(line.split("\t")) for line in listed.splitlines())
    sha = refs.get(f"{name}^{{}}") or refs.get(name)  # prefer the peeled commit of an annotated tag
    if not sha:
        raise SystemExit(f"{ref} does not exist in {remote}")
    return sha, "unreleased" if ref == "main" else "release"


def sidecar_modules():
    """Top-level-absolute modules the sidecar imports, including literal importlib calls."""
    modules = set()
    for path in (ROOT / "web/sidecar/talaria_sidecar").rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Import):
                modules.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                modules.add(node.module)
                modules.update(f"{node.module}.{alias.name}" for alias in node.names)
            elif (isinstance(node, ast.Call) and getattr(node.func, "attr", None) == "import_module"
                  and node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)):
                modules.add(node.args[0].value)
    return modules


def complete(checkout, base, candidate):
    """The base is an ancestor and no history boundary falls inside base..candidate.

    Old side-branch commits merged into the range would otherwise count as new when
    their link to the base lies below the shallow boundary (or they reach a root).
    """
    if (git(checkout, "cat-file", "-e", f"{base}^{{commit}}", check=False).returncode
            or git(checkout, "merge-base", "--is-ancestor", base, candidate, check=False).returncode):
        return False
    shallow = checkout / ".git/shallow"
    if not shallow.exists():
        return True  # complete local history: the range is exact
    boundary = set(shallow.read_text().split())
    for line in git(checkout, "rev-list", "--parents", f"{base}..{candidate}").stdout.splitlines():
        commit, *parents = line.split()
        if commit in boundary or not parents:
            return False
    return True


def prepare(args):
    state = json.loads(Path(args.state).read_text()) if args.state and Path(args.state).exists() else {}
    candidate, kind = resolve(args.remote, args.candidate)
    base_ref = args.base or state.get("lastReviewed", {}).get("sha")
    if not base_ref:
        raise SystemExit("pass --base or a --state file with lastReviewed.sha")
    base, _ = resolve(args.remote, base_ref)
    manifest = {"repository": REPOSITORY, "base": {"ref": base_ref, "sha": base},
                "candidate": {"ref": args.candidate, "sha": candidate, "kind": kind},
                "compare": f"https://github.com/{REPOSITORY}/compare/{base}...{candidate}"}
    if state.get("lastReviewed", {}).get("sha") == candidate:
        return {**manifest, "status": "already_reviewed"}

    checkout = Path(args.checkout or tempfile.mkdtemp(prefix="talaria-agent-review-"))
    if not (checkout / ".git").exists():
        git(Path.cwd(), "init", "--quiet", str(checkout))
    git(checkout, "fetch", "--quiet", "--depth=1", "--no-tags", args.remote, candidate)
    depth = args.deepen
    while not complete(checkout, base, candidate):
        if git(checkout, "rev-parse", "--is-shallow-repository").stdout.strip() != "true":
            # The candidate's complete history lacks the base: either it is gone or it is not an ancestor.
            found = git(checkout, "fetch", "--quiet", "--depth=1", "--no-tags", args.remote, base, check=False).returncode == 0
            return {**manifest, "status": "not_ancestor" if found else "history_missing", "checkout": str(checkout)}
        git(checkout, "fetch", "--quiet", f"--deepen={depth}", "--no-tags", args.remote, candidate)
        depth *= 2
    git(checkout, "checkout", "--quiet", "--detach", candidate)

    changed = git(checkout, "diff", "--name-only", base, candidate).stdout.split()
    touched = collections.defaultdict(int)
    for path in changed:
        touched[path.split("/")[0] if "/" in path else "(root)"] += 1
    surface = []
    for module in sorted(sidecar_modules()):
        stem = module.replace(".", "/")
        for path in (f"{stem}.py", f"{stem}/__init__.py"):
            if path in changed:
                surface.append({"module": module, "path": path,
                                "commits": int(git(checkout, "rev-list", "--count", "--no-merges", f"{base}..{candidate}", "--", path).stdout)})
    return {**manifest, "status": "complete", "checkout": str(checkout),
            "commits": int(git(checkout, "rev-list", "--count", "--no-merges", f"{base}..{candidate}").stdout),
            "changedFiles": len(changed), "areas": dict(sorted(touched.items(), key=lambda item: -item[1])),
            "sidecarModules": surface}


def advance(args):
    report = Path(args.report).read_text()
    if args.sha not in report:
        raise SystemExit("the report does not name the reviewed candidate SHA")
    leaks = [pattern for pattern in (str(Path.home()), "/Users/", "/home/") if pattern in report] + SECRET.findall(report)
    if leaks:
        raise SystemExit("the report contains a local home path or credential; redact it before recording")
    path = Path(args.state)
    state = json.loads(path.read_text()) if path.exists() else {}
    reviewed = {"ref": args.ref, "sha": args.sha}
    if state.get("lastReviewed") != reviewed:  # an unchanged watermark leaves the file untouched
        path.write_text(json.dumps({**state, "lastReviewed": reviewed}, indent=2, sort_keys=True) + "\n")
    return {"lastReviewed": reviewed}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    prep = commands.add_parser("prepare")
    prep.add_argument("--candidate", required=True, help="Release tag, main, or a full 40-character SHA.")
    prep.add_argument("--base", help="Previously reviewed tag or SHA; defaults to the state file's lastReviewed.sha.")
    prep.add_argument("--state", help="Review state JSON kept outside the repository.")
    prep.add_argument("--checkout", help="Disposable checkout directory; defaults to a new temporary directory.")
    prep.add_argument("--remote", default=f"https://github.com/{REPOSITORY}.git", help=argparse.SUPPRESS)
    prep.add_argument("--deepen", type=int, default=256, help=argparse.SUPPRESS)
    record = commands.add_parser("advance")
    record.add_argument("--state", required=True)
    record.add_argument("--ref", required=True)
    record.add_argument("--sha", required=True, type=lambda value: value if SHA.fullmatch(value) else parser.error("--sha must be a full SHA"))
    record.add_argument("--report", required=True, help="The completed review report.")
    args = parser.parse_args()
    json.dump(prepare(args) if args.command == "prepare" else advance(args), sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
