#!/usr/bin/env python3
"""Reject images committed outside the asset locations (TAL-390).

Screenshots and other validation evidence belong in the PR description, never in git.
A tracked image is allowed only as a shipped or tested asset: an asset catalog, the
Web brand files, the App README images, or a snapshot-test reference.

Run: python3 scripts/check-committed-images.py   (checks `git ls-files` from the repo root)
"""
import subprocess
import sys
from pathlib import Path

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".svg", ".ico", ".icns", ".pdf"}
ALLOWED_PREFIXES = (
    "app/TalariaTests/VisualReferences/",  # snapshot-test references
    "app/docs/assets/readme/",  # App README images
    "web/static/brand/",  # shipped Web brand assets
)
ALLOWED_BUNDLES = (".xcassets", ".icon")  # Xcode asset catalogs and icon bundles


def allowed(path: str) -> bool:
    if Path(path).suffix.lower() not in IMAGE_SUFFIXES:
        return True
    if path.startswith(ALLOWED_PREFIXES):
        return True
    return any(part.endswith(ALLOWED_BUNDLES) for part in Path(path).parts[:-1])


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    tracked = subprocess.run(["git", "ls-files", "-z"], cwd=root, check=True, capture_output=True).stdout.decode().split("\0")
    rejected = sorted(path for path in tracked if path and not allowed(path))
    if rejected:
        print("Images committed outside the asset locations. Put screenshots and other validation evidence in the PR description instead:", file=sys.stderr)
        for path in rejected:
            print(f"  {path}", file=sys.stderr)
        return 1
    print("check-committed-images: every tracked image is a shipped or tested asset")
    return 0


if __name__ == "__main__":
    sys.exit(main())
