#!/usr/bin/env python3
"""Stamp a clean immutable checkout before building a component artifact."""

import argparse
import json
import plistlib
import re
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
    parser.add_argument("component", choices=("app", "web", "relay"))
    parser.add_argument("--version", required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--deployment-id", help="Required for Relay; non-secret deployment identity.")
    parser.add_argument("--build-number", type=int, help="Required for App; selected TestFlight build number.")
    args = parser.parse_args()
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    if head != args.source_revision:
        parser.error("checkout must match the immutable release source")
    if subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=normal"], cwd=ROOT):
        parser.error("release stamping requires a clean checkout")
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", args.version):
        parser.error("release version must be X.Y.Z")
    metadata = {"version": args.version, "sourceRevision": head, "releaseSet": head}
    if args.component == "web":
        metadata.update(upstreamBase=(ROOT / "web/UPSTREAM_BASE_SHA").read_text().strip(),
                        contracts=SUPPORTED_CONTRACTS, compatibleAgent=COMPATIBLE_AGENT)
        validate_release_info(metadata)
        if subprocess.run(["git", "merge-base", "--is-ancestor", metadata["upstreamBase"], head], cwd=ROOT, check=False).returncode:
            parser.error("upstream base must be reachable from this checkout")
        destination, mode = ROOT / "web/api/_release.json", "x"
    elif args.component == "relay":
        if not args.deployment_id or not re.fullmatch(r"[a-z][a-z0-9-]+", args.deployment_id):
            parser.error("Relay requires a deployment ID")
        versions = json.loads((ROOT / "contracts/versions.json").read_text())
        metadata.update(deploymentId=args.deployment_id, contracts={
            "webRelay": [versions["webRelay"]["protocolVersion"]],
            "appRelay": [versions["appRelay"]["aggregateSchemaVersion"]],
            "activityScene": [versions["activityScene"]["version"]],
        })
        destination, mode = ROOT / "relay/convex/releaseInfo.json", "w"
        if json.loads(destination.read_text())["sourceRevision"] is not None:
            parser.error("refusing to replace an already stamped Relay artifact")
    else:
        if args.build_number is None or args.build_number < 1:
            parser.error("App requires a positive build number")
        versions = json.loads((ROOT / "contracts/versions.json").read_text())
        metadata.update(buildNumber=args.build_number, contracts={
            "appWeb": [versions["appWeb"]["fixtureVersion"]],
            "appRelay": [versions["appRelay"]["aggregateSchemaVersion"]],
            "activityScene": [versions["activityScene"]["version"]],
        })
        destination = ROOT / "app/Talaria/Resources/Info.plist"
        info = plistlib.loads(destination.read_bytes())
        if info.get("TalariaRelease", {}).get("sourceRevision"):
            parser.error("refusing to replace an already stamped App artifact")
        info.update(TalariaRelease=metadata, CFBundleShortVersionString=args.version,
                    CFBundleVersion=str(args.build_number))
        destination.write_bytes(plistlib.dumps(info, sort_keys=False))
    if args.component != "app":
        with destination.open(mode) as stream:
            stream.write(json.dumps(metadata, indent=2) + "\n")
    # The Web container uses this same JSON as its provenance label. Relay
    # bundles it into its functions; neither record claims publication success.
    print(json.dumps(metadata, separators=(",", ":")))


if __name__ == "__main__":
    main()
