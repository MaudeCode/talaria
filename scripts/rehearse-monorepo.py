#!/usr/bin/env python3
"""Rebuild the migration from its recorded source heads in a fresh directory."""

import argparse
import json
import os
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--recipe-ref", default="HEAD")
    args = parser.parse_args()
    destination = args.destination.resolve()
    if destination.exists():
        parser.error("destination must not exist")
    env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
               GIT_COMMITTER_NAME="Migration rehearsal",
               GIT_COMMITTER_EMAIL="migration@example.invalid",
               GIT_AUTHOR_NAME="Migration rehearsal",
               GIT_AUTHOR_EMAIL="migration@example.invalid")

    def git(repo, *arguments):
        return subprocess.check_output(["git", "-C", str(repo), *arguments],
                                       env=env, text=True).strip()

    recipe = git(ROOT, "rev-parse", "--verify", f"{args.recipe_ref}^{{commit}}")
    metadata = json.loads(git(ROOT, "show", f"{recipe}:docs/monorepo-sources.json"))
    sources = metadata["sources"]
    destination.parent.mkdir(parents=True, exist_ok=True)
    git(destination.parent, "clone", "--no-checkout", "--no-tags",
        sources["app"]["repository"], str(destination))
    git(destination, "fetch", "--no-tags", str(ROOT), recipe)
    git(destination, "checkout", "-b", "migration-rehearsal", sources["app"]["commit"])
    git(destination, "cherry-pick", metadata["appMoveCommit"])
    for component in ("web", "relay"):
        source = sources[component]
        git(destination, "subtree", "add", f"--prefix={component}", source["repository"],
            source["commit"], "-m", f"TAL-202: import {component} history")
        git(destination, "merge-base", "--is-ancestor", source["commit"], "HEAD")
    # Reapply the reviewed path/contract/CI integration after the two pure imports.
    for revision in git(destination, "rev-list", "--reverse", "--first-parent",
                        f"{metadata['relayImportCommit']}..{recipe}").splitlines():
        git(destination, "cherry-pick", revision)
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
