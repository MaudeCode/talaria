#!/usr/bin/env python3
"""Stamp a clean immutable checkout before building a component artifact."""

import argparse
import json
import plistlib
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_SHA = r"[a-f0-9]{40}"
_VERSION = r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"


def web_version_ok(version, tag, source):
    """X.Y.Z, or an Experimental package's X.Y.Z-exp.<12-hex source> under a web-exp tag (TAL-343)."""
    if re.fullmatch(_VERSION, version):
        return True
    return tag.startswith("web-exp-v") and re.fullmatch(_VERSION + r"-exp\.[a-f0-9]{12}", version) and version.endswith(source[:12])


def web_identity():
    """The packaged Agent pin and supported contract versions (Web `release.ts` reads the same files)."""
    pin = json.loads((ROOT / "web/sidecar/agent_dependency.json").read_text())
    versions = json.loads((ROOT / "web/contract_versions.json").read_text())
    return ({**pin["x-talaria"], "image": pin["services"]["hermes-agent"]["image"]},
            {"appWeb": [versions["appWeb"]["fixtureVersion"]], "webRelay": [versions["webRelay"]["protocolVersion"]]})


def validate_release_info(metadata):
    """Mirror of Web `validateReleaseInfo` so a stamp the server would reject never ships."""
    compatible_agent, supported_contracts = web_identity()
    fields = {"tag", "version", "sourceRevision", "releaseSet", "contracts", "compatibleAgent"}
    if set(metadata) != fields:
        raise ValueError("Invalid Web release metadata fields")
    for key in ("sourceRevision", "releaseSet"):
        if not re.fullmatch(_SHA, str(metadata[key])):
            raise ValueError(f"Web {key} must be an immutable commit")
    if metadata["sourceRevision"] != metadata["releaseSet"]:
        raise ValueError("Web release-set identity must match its source")
    if not web_version_ok(str(metadata["version"]), str(metadata["tag"]), metadata["sourceRevision"]):
        raise ValueError("Web release version must be X.Y.Z")
    if metadata["tag"] not in (f"web-v{metadata['version']}", f"web-exp-v{metadata['version']}"):
        raise ValueError("Web release tag must match its namespaced version")
    if metadata["contracts"] != supported_contracts or metadata["compatibleAgent"] != compatible_agent:
        raise ValueError("Web release metadata disagrees with its packaged contracts or Agent pin")
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("component", choices=("app", "web", "relay"))
    parser.add_argument("--version", required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--deployment-id", help="Required for Relay; non-secret deployment identity.")
    parser.add_argument("--build-number", type=int, help="Required for App; selected TestFlight build number.")
    parser.add_argument("--tag", help="Web tag; defaults to web-vVERSION. Use web-exp-vVERSION for experimental releases.")
    args = parser.parse_args()
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    if head != args.source_revision:
        parser.error("checkout must match the immutable release source")
    if subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=normal"], cwd=ROOT):
        parser.error("release stamping requires a clean checkout")
    if not (re.fullmatch(_VERSION, args.version) or args.component == "web" and web_version_ok(args.version, args.tag or "", head)):
        parser.error("release version must be X.Y.Z")
    metadata = {"version": args.version, "sourceRevision": head, "releaseSet": head}
    if args.component == "web":
        metadata["tag"] = args.tag or f"web-v{args.version}"
        compatible_agent, supported_contracts = web_identity()
        metadata.update(contracts=supported_contracts, compatibleAgent=compatible_agent)
        validate_release_info(metadata)
        destination, mode = ROOT / "web/_release.json", "x"
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
        bundles = []
        for name in ("Talaria", "TalariaLiveActivityWidget"):
            destination = ROOT / "app" / name / "Resources/Info.plist"
            info = plistlib.loads(destination.read_bytes())
            if info.get("TalariaRelease", {}).get("sourceRevision"):
                parser.error("refusing to replace an already stamped App artifact")
            info.update(TalariaRelease=metadata, CFBundleShortVersionString=args.version,
                        CFBundleVersion=str(args.build_number))
            bundles.append((destination, info))
        for destination, info in bundles:
            destination.write_bytes(plistlib.dumps(info, sort_keys=False))
    if args.component != "app":
        with destination.open(mode) as stream:
            stream.write(json.dumps(metadata, indent=2) + "\n")
    # The Web container uses this same JSON as its provenance label. Relay
    # bundles it into its functions; neither record claims publication success.
    print(json.dumps(metadata, separators=(",", ":")))


if __name__ == "__main__":
    main()
