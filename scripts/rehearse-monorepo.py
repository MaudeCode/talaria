#!/usr/bin/env python3
"""Rebuild the migration from its recorded source heads in a fresh directory."""

import argparse
import json
import os
import re
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parent.parent


def verify_web_base(repo, recipe, env):
    command = ["git", "-C", str(repo)]
    listed = subprocess.run(command + ["ls-tree", "--name-only", recipe, "web/UPSTREAM_BASE_SHA"],
                            env=env, text=True, capture_output=True, check=True).stdout.strip()
    if not listed:
        return  # Public upstream imports were retired with the TypeScript backend.
    pin = subprocess.check_output(command + ["show", f"{recipe}:web/UPSTREAM_BASE_SHA"],
                                  env=env, text=True, stderr=subprocess.PIPE).strip()
    if not re.fullmatch(r"[a-f0-9]{40}", pin):
        raise ValueError("Web upstream base must be an immutable commit")
    subprocess.run(command + ["merge-base", "--is-ancestor", pin, recipe], env=env,
                   check=True, stderr=subprocess.PIPE)


def apply_integration_tree(source, destination, base, target, env):
    """Replay the complete tree delta, including changes behind merge parents."""
    patch = subprocess.check_output([
        "git", "-C", str(source), "diff", "--binary", "--full-index", base, target, "--",
    ], env=env)
    if patch:
        subprocess.run(["git", "-C", str(destination), "apply", "--index"],
                       input=patch, env=env, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path, nargs="?")
    parser.add_argument("--recipe-ref", default="HEAD")
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    if not args.verify_only and args.destination is None:
        parser.error("destination is required unless --verify-only is selected")
    destination = args.destination.resolve() if args.destination else None
    if destination is not None and destination.exists():
        parser.error("destination must not exist")
    env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
               GIT_COMMITTER_NAME="Migration rehearsal",
               GIT_COMMITTER_EMAIL="migration@example.invalid",
               GIT_AUTHOR_NAME="Migration rehearsal",
               GIT_AUTHOR_EMAIL="migration@example.invalid")

    def git(repo, *arguments):
        return subprocess.check_output(["git", "-c", "credential.helper=!gh auth git-credential",
                                        "-C", str(repo), *arguments],
                                       env=env, text=True).strip()

    recipe = git(ROOT, "rev-parse", "--verify", f"{args.recipe_ref}^{{commit}}")
    verify_web_base(ROOT, recipe, env)
    metadata = json.loads(git(ROOT, "show", f"{recipe}:docs/monorepo-sources.json"))
    sources = metadata["sources"]
    for component, source in sources.items():
        git(ROOT, "merge-base", "--is-ancestor", source["commit"], recipe)
        if component in ("web", "relay"):
            imported = metadata[component + "ImportCommit"]
            if git(ROOT, "rev-parse", f"{imported}:{component}") != git(ROOT, "rev-parse", source["commit"] + "^{tree}"):
                raise RuntimeError(f"import tree differs from recorded {component} source")
    git(ROOT, "cat-file", "-e", metadata["appMoveCommit"] + "^{commit}")
    if args.verify_only:
        print("PASS recorded source ancestry and import trees")
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    git(destination.parent, "clone", "--no-checkout", "--no-tags",
        sources["app"]["repository"], str(destination))
    git(destination, "fetch", "--no-tags", str(ROOT), f"{recipe}:refs/remotes/migration/recipe")
    git(destination, "checkout", "-b", "migration-rehearsal", sources["app"]["commit"])
    git(destination, "cherry-pick", metadata["appMoveCommit"])
    for component in ("web", "relay"):
        source = sources[component]
        git(destination, "subtree", "add", f"--prefix={component}", source["repository"],
            source["commit"], "-m", f"TAL-202: import {component} history")
        git(destination, "merge-base", "--is-ancestor", source["commit"], "HEAD")
    # A PR merge's first parent bypasses the import branch. Replay its complete
    # integration delta instead; the original history remains in the recipe ref.
    apply_integration_tree(ROOT, destination, metadata["relayImportCommit"], recipe, env)
    git(destination, "commit", "--allow-empty", "-m", "TAL-202: replay monorepo integration tree")
    for source in sources.values():
        for tag, expected in source["tags"].items():
            git(destination, "fetch", "--no-tags", source["repository"],
                f"refs/tags/{tag}:refs/tags/{tag}")
            actual = git(destination, "rev-parse", f"refs/tags/{tag}")
            if actual != expected:
                raise RuntimeError(f"source tag changed: {tag}")
    expected = git(ROOT, "rev-parse", f"{recipe}^{{tree}}")
    actual = git(destination, "rev-parse", "HEAD^{tree}")
    if actual != expected:
        raise RuntimeError(f"tracked tree mismatch: expected {expected}, got {actual}")
    git(destination, "fsck", "--full", "--no-dangling")
    print(json.dumps({"tree": actual, "recipe": recipe, "destination": str(destination)}))


if __name__ == "__main__":
    main()
