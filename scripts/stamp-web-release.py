#!/usr/bin/env python3
"""Stamp a validated checkout before building its wheel or container."""

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "web"))
from api.release_info import (
    COMPATIBLE_AGENT,
    SUPPORTED_CONTRACTS,
    validate_release_info,
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--source-revision", required=True)
    args = parser.parse_args()
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    if head != args.source_revision:
        parser.error("checkout must match the immutable release source")
    if subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=normal"], cwd=ROOT):
        parser.error("release stamping requires a clean checkout")
    metadata = validate_release_info({
        "version": args.version, "sourceRevision": head, "releaseSet": head,
        "upstreamBase": (ROOT / "web/UPSTREAM_BASE_SHA").read_text().strip(), "contracts": SUPPORTED_CONTRACTS,
        "compatibleAgent": COMPATIBLE_AGENT,
    })
    if subprocess.run(["git", "merge-base", "--is-ancestor", metadata["upstreamBase"], head], cwd=ROOT, check=False).returncode:
        parser.error("upstream base must be reachable from this checkout")
    with (ROOT / "web/api/_release.json").open("x") as stream:
        stream.write(json.dumps(metadata, indent=2) + "\n")
    # The container build uses this same JSON as dev.talaria.provenance, plus
    # standard OCI version/revision labels. The image digest is recorded later.
    print(json.dumps(metadata, separators=(",", ":")))


if __name__ == "__main__":
    main()
