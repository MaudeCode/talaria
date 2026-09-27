#!/usr/bin/env python3
"""Publish a `build.py web --experimental` tarball to GHCR as the Experimental OCI artifact (TAL-343)."""

import argparse
import json
import re
import subprocess
from pathlib import Path

from cli import ROOT, load

REGISTRY = "ghcr.io/maudecode/talaria-web-experimental"
PACKAGE = "orgs/MaudeCode/packages/container/talaria-web-experimental"
ARTIFACT_TYPE = "application/vnd.maudecode.talaria-web.experimental.v1"
LAYER_TYPE = "application/vnd.maudecode.talaria-web.npm.tgz"
REVISION = "org.opencontainers.image.revision"
MOVING = "experimental"
RETAINED = 50


def _ancestor(root, older, newer):
    """git merge-base --is-ancestor: True, False, or None when either commit is unknown."""
    code = subprocess.run(["git", "-C", str(root), "merge-base", "--is-ancestor", older, newer], capture_output=True, check=False).returncode
    return {0: True, 1: False}.get(code)


def moves_forward(root, current, source):
    """Move `experimental` onto `source` only when it is missing or `source` descends from its revision."""
    if current is None:
        return True
    forward = _ancestor(root, current, source)
    if forward is None:
        raise ValueError(f"cannot order the current {MOVING} revision {current} against {source}")
    return forward


def newest_published(root, current, sources, tip):
    """The newest published source on `tip`'s history that `experimental` may move forward to.

    Advances are serialized but can run out of commit order, so each one reconciles every
    published sha- tag instead of assuming its own commit is the newest.
    """
    target = current
    for source in sources:
        if _ancestor(root, source, tip) and moves_forward(root, target, source):
            target = source
    return target


def pruned(versions, protected=(MOVING,), retained=RETAINED):
    """Package version IDs beyond the newest `retained` by creation time, never one carrying a `protected` tag."""
    newest = sorted(versions, key=lambda version: version["created_at"], reverse=True)
    return [version["id"] for version in newest[retained:] if not set(protected) & set(version["metadata"]["container"]["tags"])]


def current_revision():
    result = subprocess.run(["oras", "manifest", "fetch", f"{REGISTRY}:{MOVING}"], capture_output=True, text=True, check=False)
    if result.returncode:
        if "not found" in result.stderr.lower():
            return None
        raise ValueError(f"could not read {MOVING}: {result.stderr.strip()}")
    revision = json.loads(result.stdout).get("annotations", {}).get(REVISION, "")
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError(f"{MOVING} lacks its source revision annotation")
    return revision


def push(build):
    result = load(build / "build-result.json")
    source, version = result["sourceRevision"], result["version"]
    reference = f"{REGISTRY}:sha-{source}"
    # sha- tags are immutable: a rerun keeps the first artifact rather than replacing it.
    if subprocess.run(["oras", "resolve", reference], capture_output=True, check=False).returncode:
        subprocess.run(["oras", "push", reference, "--artifact-type", ARTIFACT_TYPE,
                        "--annotation", f"{REVISION}={source}", "--annotation", f"org.opencontainers.image.version={version}",
                        f"{result['tarball']}:{LAYER_TYPE}"], cwd=build / "npm", check=True)


def advance(source):
    if not re.fullmatch(r"[a-f0-9]{40}", source):
        raise ValueError("advance requires the published 40-hex source revision")
    # Main may have moved past this run's checkout; later published commits must be orderable.
    subprocess.run(["git", "-C", str(ROOT), "fetch", "--quiet", "origin", "main"], check=True)
    pages = json.loads(subprocess.check_output(["gh", "api", "--paginate", "--slurp", f"{PACKAGE}/versions?per_page=100"]))
    versions = [version for page in pages for version in page]
    published = {tag.removeprefix("sha-") for version in versions for tag in version["metadata"]["container"]["tags"]
                 if re.fullmatch(r"sha-[a-f0-9]{40}", tag)} | {source}
    current = current_revision()
    target = newest_published(ROOT, current, sorted(published), "FETCH_HEAD")
    if target != current:
        subprocess.run(["oras", "tag", f"{REGISTRY}:sha-{target}", MOVING], check=True)
    print(f"{MOVING} is at {target}.")
    for version_id in pruned(versions, protected=(MOVING, f"sha-{target}")):
        subprocess.run(["gh", "api", "--method", "DELETE", f"{PACKAGE}/versions/{version_id}"], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    commands.add_parser("push", help="Push the build as its immutable sha- tag.").add_argument(
        "build", type=Path, help="The build.py web --experimental output directory.")
    commands.add_parser("advance", help="Move experimental forward to a pushed source, then prune.").add_argument("source")
    args = parser.parse_args()
    if args.action == "push":
        push(args.build)
    else:
        advance(args.source)


if __name__ == "__main__":
    main()
