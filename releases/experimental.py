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


def moves_forward(root, current, source):
    """Move `experimental` onto `source` only when it is missing or `source` descends from its revision."""
    if current is None:
        return True
    result = subprocess.run(["git", "-C", str(root), "merge-base", "--is-ancestor", current, source], capture_output=True, check=False)
    if result.returncode not in (0, 1):
        raise ValueError(f"cannot order the current {MOVING} revision {current} against {source}")
    return result.returncode == 0


def pruned(versions, retained=RETAINED):
    """Package version IDs beyond the newest `retained` by creation time, never the one `experimental` names."""
    newest = sorted(versions, key=lambda version: version["created_at"], reverse=True)
    return [version["id"] for version in newest[retained:] if MOVING not in version["metadata"]["container"]["tags"]]


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
    current = current_revision()
    if moves_forward(ROOT, current, source):
        subprocess.run(["oras", "tag", f"{REGISTRY}:sha-{source}", MOVING], check=True)
    else:
        print(f"{MOVING} stays at {current}; {source} is not its descendant.")
    pages = json.loads(subprocess.check_output(["gh", "api", "--paginate", "--slurp", f"{PACKAGE}/versions?per_page=100"]))
    for version_id in pruned([version for page in pages for version in page]):
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
