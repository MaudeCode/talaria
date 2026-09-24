#!/usr/bin/env python3
"""Build release artifacts without publishing or accessing production credentials."""

import argparse
import json
import os
import re
import subprocess
from pathlib import Path

from cli import ROOT, load, receipt, run_url, write
from plan import git


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("component", choices=("app", "web", "relay"))
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    plan = load(args.plan)
    name = args.component
    if not plan["changed"][name] or git(ROOT, "rev-parse", "HEAD") != plan["releaseSet"]:
        raise ValueError("build requires a changed component at the release-set source")
    component = plan["components"][name]
    workflow = os.environ.get("GITHUB_ACTIONS") == "true"
    if workflow:
        run_url()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    stamp = ["python3", str(ROOT / "scripts/stamp-release.py"), name, "--version", component["version"],
             "--source-revision", component["sourceRevision"]]
    values = {"tag": component["tag"]}
    if name == "relay":
        subprocess.run(["pnpm", "install", "--frozen-lockfile"], cwd=ROOT / "relay", check=True)
        subprocess.run(["pnpm", "check"], cwd=ROOT / "relay", check=True)
        subprocess.run([*stamp, "--deployment-id", component["deploymentId"]], cwd=ROOT, check=True)
        subprocess.run(["python3", str(ROOT / "scripts/check-relay-local.py")], cwd=ROOT, check=True)
        values["deploymentId"] = component["deploymentId"]
    elif name == "web":
        subprocess.run([*stamp, "--tag", component["tag"]], cwd=ROOT, check=True)
        provenance = load(ROOT / "web/_release.json")
        # npm distribution: build the workspace and pack @maudecode/talaria-web at the
        # release version (the stamped _release.json ships inside the tarball).
        subprocess.run(["npm", "ci", "--no-audit", "--no-fund"], cwd=ROOT / "web", check=True)
        subprocess.run(["npm", "run", "build", "-w", "packages/contracts"], cwd=ROOT / "web", check=True)
        subprocess.run(["npm", "run", "build", "-w", "packages/server"], cwd=ROOT / "web", check=True)
        for package in ("packages/contracts", "packages/server"):
            subprocess.run(["npm", "version", component["version"], "--no-git-tag-version", "--allow-same-version", "-w", package], cwd=ROOT / "web", check=True)
        # A published server must resolve the contracts package it was built and tested with, never a newer release.
        subprocess.run(["npm", "pkg", "set", f"dependencies.@maudecode/talaria-web-contracts={component['version']}", "-w", "packages/server"], cwd=ROOT / "web", check=True)
        (output / "npm").mkdir()
        subprocess.run(["npm", "pack", "--pack-destination", str(output / "npm"), "-w", "packages/contracts", "-w", "packages/server"], cwd=ROOT / "web", check=True)
        tarballs = sorted((output / "npm").glob("*.tgz"))
        if len(tarballs) != 2 or any(path.stat().st_size == 0 for path in tarballs):
            raise ValueError("npm pack must produce the contracts and server tarballs")
        values["npm"] = f"@maudecode/talaria-web@{component['version']}"
        metadata = output / "image-metadata.json"
        # The release workflow points this at the NAS S3 layer cache; BuildKit reads its credentials from AWS_*.
        cache = os.environ.get("TALARIA_DOCKER_CACHE")
        cache_args = ["--cache-from", cache, "--cache-to", cache + ",mode=max,ignore-error=true"] if cache else []
        subprocess.run([
            "docker", "buildx", "build", "--platform", "linux/amd64,linux/arm64",
            "--tag", f"ghcr.io/maudecode/talaria-web:{component['tag']}",
            "--build-arg", "HERMES_VERSION=" + component["tag"],
            "--build-arg", "TALARIA_PROVENANCE=" + json.dumps(provenance, separators=(",", ":")),
            "--label", "org.opencontainers.image.revision=" + component["sourceRevision"],
            "--label", "org.opencontainers.image.version=" + component["version"],
            *cache_args,
            "--output", f"type=oci,dest={output / 'web.oci.tar'}", "--metadata-file", str(metadata), str(ROOT / "web"),
        ], check=True)
        digest = load(metadata).get("containerimage.digest", "")
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
            raise ValueError("container builder did not return an immutable manifest digest")
        values["image"] = "ghcr.io/maudecode/talaria-web@" + digest
    else:
        if not plan["dryRun"]:
            raise ValueError("production App builds use the isolated signing workflow")
        number = component["buildNumber"]
        subprocess.run([*stamp, "--build-number", str(number)], cwd=ROOT, check=True)
        archive = output / "Talaria.xcarchive"
        derived_data = output.with_name(output.name + "-derived-data")
        subprocess.run(["xcodebuild", "-resolvePackageDependencies", "-project", "Talaria.xcodeproj", "-scheme", "Talaria",
                        "-derivedDataPath", str(derived_data), "-disableAutomaticPackageResolution"], cwd=ROOT / "app", check=True)
        subprocess.run([
            "xcodebuild", "archive", "-project", "Talaria.xcodeproj", "-scheme", "Talaria", "-configuration", "Release",
            "-destination", "generic/platform=iOS", "-archivePath", str(archive), "-derivedDataPath", str(derived_data),
            "-disableAutomaticPackageResolution", "CODE_SIGNING_ALLOWED=NO",
            "MARKETING_VERSION=" + component["version"], "CURRENT_PROJECT_VERSION=" + str(number),
        ], cwd=ROOT / "app", check=True)
        subprocess.run([str(ROOT / "app/ci/verify_bundle_versions"), str(archive / "Products/Applications/Talaria.app"),
                        component["version"], str(number)], check=True)
        values["buildNumber"] = number
    write(output / "build-result.json", {"component": name, "sourceRevision": plan["releaseSet"], "result": "success", **values})
    if workflow:
        write(output / "receipt.json", receipt("build" + name.title(), plan["releaseSet"], **values))


if __name__ == "__main__":
    main()
