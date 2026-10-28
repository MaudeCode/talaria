#!/usr/bin/env python3
"""The scheduled Nightly channel (TAL-1569): pick the day's source, upload its App build to TestFlight, record it.

The `nightly` git tag names the last source a run completed. A failed run leaves it in place, so the next run retries
everything since then.
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

from build import next_patch
from cli import REPOSITORY, ROOT
from experimental import newest_published
from publish import upload_testflight, verify_ipa

TAG = "nightly"


def last_nightly(root):
    result = subprocess.run(["git", "-C", str(root), "rev-parse", "--verify", "--quiet", f"refs/tags/{TAG}^{{commit}}"],
                            capture_output=True, text=True, check=False)
    return result.stdout.strip() or None


def green_commits():
    """Head commits of main's recent successful push CI runs, in whatever order they finished."""
    output = subprocess.check_output(["gh", "api", f"repos/{REPOSITORY}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=100",
                                      "--jq", ".workflow_runs[].head_sha"], text=True)
    return sorted(set(output.split()))


def select(root, green):
    """The newest green commit on HEAD's history after the last Nightly; whether the App changed since then; its version."""
    previous = last_nightly(root)
    source = newest_published(root, previous, green, "HEAD")
    if source is None or source == previous:
        return {"changed": "false"}
    # An unknown base (the first run) selects every suite, so the App uploads.
    suites = subprocess.check_output([sys.executable, str(ROOT / "scripts/changed-components.py"), f"--base={previous or ''}", f"--head={source}"],
                                     cwd=root, text=True).split()
    return {"changed": "true", "source": source, "app": str("app=true" in suites).lower(), "app_version": next_patch(root, "app-v")}


def upload(directory, version, build_number, source):
    component = {"version": version, "buildNumber": build_number, "sourceRevision": source, "releaseSet": source}
    files = list(directory.glob("*.ipa"))
    if len(files) != 1:
        raise ValueError("the Nightly upload needs exactly one IPA")
    upload_testflight(files[0], component, verify_ipa(files[0], component, keys=tuple(component)))


def record(source):
    """Move the `nightly` tag forward to `source`; GitHub refuses a non-fast-forward move."""
    if last_nightly(ROOT) is None:
        command = ["gh", "api", "--method", "POST", f"repos/{REPOSITORY}/git/refs", "-f", f"ref=refs/tags/{TAG}", "-f", f"sha={source}"]
    else:
        command = ["gh", "api", "--method", "PATCH", f"repos/{REPOSITORY}/git/refs/tags/{TAG}", "-f", f"sha={source}", "-F", "force=false"]
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
    print(f"{TAG} is at {source}.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    commands.add_parser("select", help="Print the selection as GITHUB_OUTPUT lines.")
    sending = commands.add_parser("upload", help="Verify the exported IPA and upload it to TestFlight.")
    sending.add_argument("--directory", type=Path, required=True)
    sending.add_argument("--version", required=True)
    sending.add_argument("--build-number", type=int, required=True)
    sending.add_argument("--source", required=True)
    commands.add_parser("record", help="Move the nightly tag to a completed source.").add_argument("source")
    args = parser.parse_args()
    if args.action == "select":
        selection = select(ROOT, green_commits())
        print(json.dumps(selection), file=sys.stderr)
        print("\n".join(f"{key}={value}" for key, value in selection.items()))
    elif args.action == "upload":
        upload(args.directory, args.version, args.build_number, args.source)
    else:
        record(args.source)


if __name__ == "__main__":
    main()
