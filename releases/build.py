#!/usr/bin/env python3
"""Build release artifacts without publishing or accessing production credentials."""

import argparse
import json
import os
import re
import subprocess
import tarfile
import tempfile
from pathlib import Path

from cli import ROOT, load, receipt, run_url, write
from plan import VERSION, git
from release_set import BRIDGE_IMAGE
from smoke_npm import smoke

CONTRACTS = "@maudecode/talaria-web-contracts"


def next_patch(root, prefix):
    """`X.Y.(Z+1)` after the newest Stable `<prefix>X.Y.Z` tag: after the shipped version, before the next Stable one."""
    stable = [tag.removeprefix(prefix) for tag in git(root, "tag", "--list", prefix + "*").split()
              if re.fullmatch(re.escape(prefix) + VERSION, tag)]
    if not stable:
        raise ValueError(f"no published Stable {prefix}X.Y.Z tag")
    major, minor, patch = max(tuple(map(int, version.split("."))) for version in stable)
    return f"{major}.{minor}.{patch + 1}"


def experimental_component(root):
    """Experimental Web identity for HEAD: `<latest Stable version, patch bumped>-exp.<12-hex SHA>` (TAL-343).

    A SemVer prerelease sorts before its release, so `1.4.0-exp.*` would read as older than the shipped 1.4.0;
    `1.4.1-exp.*` sorts after it and before whatever Stable version ships next."""
    source = git(root, "rev-parse", "HEAD")
    base = next_patch(root, "web-v")
    if re.fullmatch(r"0[0-9]{11}", source[:12]):
        # A numeric SemVer identifier cannot start with 0 and npm would rewrite it; web-experimental.yml skips these (~0.04%).
        raise ValueError(f"{source[:12]} is not a valid SemVer prerelease identifier; this commit has no Experimental version")
    version = f"{base}-exp.{source[:12]}"
    return {"version": version, "sourceRevision": source, "tag": "web-exp-v" + version}


def require_bundled_contracts(tarball, version):
    """The Experimental server tarball must carry the contracts it was built with, never a registry lookup."""
    with tarfile.open(tarball) as archive:
        manifest = json.load(archive.extractfile("package/package.json"))
        try:
            bundled = json.load(archive.extractfile(f"package/node_modules/{CONTRACTS}/package.json"))
        except KeyError:
            bundled = {}
    if CONTRACTS not in manifest.get("bundleDependencies", []) or bundled.get("version") != version:
        raise ValueError("the Experimental package must bundle its exact contracts package")


def bundled_peers(package):
    """Direct dependencies that the bundled contracts closure peer-depends on. npm treats such a peer as part of
    the bundle and installs it as an empty directory unless the tarball carries it (`ws` via `@orpc/server`)."""
    modules = package / "node_modules"
    direct = load(package / "package.json").get("dependencies", {})
    seen, queue, peers = set(), [CONTRACTS], set()
    while queue:
        name = queue.pop()
        # ponytail: follows only top-level installs; a nested conflicting copy's own peers are not checked.
        if name in seen or not (modules / name / "package.json").exists():
            continue
        seen.add(name)
        manifest = load(modules / name / "package.json")
        queue += manifest.get("dependencies", {})
        peers |= manifest.get("peerDependencies", {}).keys() & direct.keys()
    return sorted(peers - seen)


def image_digest(metadata):
    """The manifest digest Buildx recorded for the OCI archive it wrote."""
    digest = load(metadata).get("containerimage.digest", "")
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
        raise ValueError("container builder did not return an immutable manifest digest")
    return digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("component", choices=("app", "web", "relay", "bridge"),
                        help="bridge: the Relay release's feedback bridge image")
    parser.add_argument("--plan", type=Path)
    parser.add_argument("--experimental", action="store_true",
                        help="Web only: pack the npm package for the Experimental channel from HEAD, without a plan or Docker image.")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    name = args.component
    experimental = args.experimental
    if experimental:
        if name != "web" or args.plan:
            parser.error("--experimental builds only Web and takes no plan")
        component = experimental_component(ROOT)
    else:
        if not args.plan:
            parser.error("--plan is required")
        plan = load(args.plan)
        # The bridge ships with Relay: it builds from the Relay release's tag and version.
        planned = "relay" if name == "bridge" else name
        if not plan["changed"][planned] or git(ROOT, "rev-parse", "HEAD") != plan["releaseSet"]:
            raise ValueError("build requires a changed component at the release-set source")
        component = plan["components"][planned]
    workflow = os.environ.get("GITHUB_ACTIONS") == "true" and not experimental
    if workflow:
        run_url()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    labels = ["--label", "org.opencontainers.image.revision=" + component["sourceRevision"],
              "--label", "org.opencontainers.image.version=" + component["version"]]
    stamp = ["python3", str(ROOT / "scripts/stamp-release.py"), name, "--version", component["version"],
             "--source-revision", component["sourceRevision"]]
    values = {"tag": component["tag"]}
    if name == "bridge":
        # Plain X.Y.Z, so registry consumers order tags as SemVer; the archive holds exactly the checked bytes.
        ref = f"{BRIDGE_IMAGE}:{component['version']}"
        subprocess.run([str(ROOT / "relay/bridge/build-image.sh"), ref, str(output), *labels], check=True)
        values["bridgeImage"] = {"ref": ref, "digest": image_digest(output / "image-metadata.json")}
    elif name == "relay":
        # scripts/check relay without its local validation, which must follow the stamp: the tests expect the
        # unstamped release info. The bridge's own npm lockfile feeds the typecheck (TAL-1646).
        subprocess.run(["pnpm", "install", "--frozen-lockfile"], cwd=ROOT / "relay", check=True)
        subprocess.run(["npm", "ci", "--prefix", "bridge", "--no-audit", "--no-fund"], cwd=ROOT / "relay", check=True)
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
        # The frontend bundle is built for every package; static/dist is not committed (TAL-379).
        subprocess.run(["npm", "run", "build:fast", "-w", "packages/frontend"], cwd=ROOT / "web", check=True)
        for package in ("packages/contracts", "packages/server"):
            subprocess.run(["npm", "version", component["version"], "--no-git-tag-version", "--allow-same-version", "-w", package], cwd=ROOT / "web", check=True)
        # A published server must resolve the contracts package it was built and tested with, never a newer release.
        subprocess.run(["npm", "pkg", "set", f"dependencies.{CONTRACTS}={component['version']}", "-w", "packages/server"], cwd=ROOT / "web", check=True)
        (output / "npm").mkdir()
        if experimental:
            # Experimental contracts are never published, so the one server tarball bundles them. npm bundles only
            # what is installed under the package itself, never the workspace's hoisted links, so the packed server
            # is staged and gets the packed contracts plus their dependency closure installed before repacking.
            with tempfile.TemporaryDirectory(prefix="talaria-web-experimental-") as temporary:
                stage = Path(temporary)
                subprocess.run(["npm", "pack", "--pack-destination", str(stage), "-w", "packages/contracts", "-w", "packages/server"], cwd=ROOT / "web", check=True)
                with tarfile.open(stage / f"maudecode-talaria-web-{component['version']}.tgz") as archive:
                    archive.extractall(stage, filter="data")
                package = stage / "package"
                # Installs never use devDependencies, and their peer sets break npm's ideal tree here.
                subprocess.run(["npm", "pkg", "delete", "devDependencies"], cwd=package, check=True)
                contracts = stage / f"maudecode-talaria-web-contracts-{component['version']}.tgz"
                subprocess.run(["npm", "pkg", "set", f"dependencies.{CONTRACTS}=file:{contracts}"], cwd=package, check=True)
                subprocess.run(["npm", "install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"], cwd=package, check=True)
                bundle = [CONTRACTS, *bundled_peers(package)]
                subprocess.run(["npm", "pkg", "set", f"dependencies.{CONTRACTS}={component['version']}",
                                *(f"bundleDependencies[{index}]={name}" for index, name in enumerate(bundle))], cwd=package, check=True)
                # The staged package already holds prepack's copies, and its prepack cannot see the Web root.
                subprocess.run(["npm", "pack", "--ignore-scripts", "--pack-destination", str(output / "npm")], cwd=package, check=True)
            tarballs = list((output / "npm").glob("*.tgz"))
            if len(tarballs) != 1:
                raise ValueError("npm pack must produce one Experimental server tarball")
            require_bundled_contracts(tarballs[0], component["version"])
            # Install and boot the exact bytes users get: workspace checks never see a broken pack (TAL-1011).
            smoke(tarballs[0])
            write(output / "build-result.json", {"component": name, "sourceRevision": component["sourceRevision"], "result": "success",
                                                 "tag": component["tag"], "version": component["version"], "tarball": tarballs[0].name})
            return
        subprocess.run(["npm", "pack", "--pack-destination", str(output / "npm"), "-w", "packages/contracts", "-w", "packages/server"], cwd=ROOT / "web", check=True)
        tarballs = sorted((output / "npm").glob("*.tgz"))
        if len(tarballs) != 2 or any(path.stat().st_size == 0 for path in tarballs):
            raise ValueError("npm pack must produce the contracts and server tarballs")
        values["npm"] = f"@maudecode/talaria-web@{component['version']}"
        metadata = output / "image-metadata.json"
        # The release workflow points this at the GitHub Actions layer cache (type=gha); Buildx reads its token from the environment.
        cache = os.environ.get("TALARIA_DOCKER_CACHE")
        cache_args = ["--cache-from", cache, "--cache-to", cache + ",mode=max,ignore-error=true"] if cache else []
        subprocess.run([
            "docker", "buildx", "build", "--platform", "linux/amd64,linux/arm64",
            "--tag", f"ghcr.io/maudecode/talaria-web:{component['tag']}",
            "--build-arg", "HERMES_VERSION=" + component["tag"],
            "--build-arg", "TALARIA_PROVENANCE=" + json.dumps(provenance, separators=(",", ":")),
            *labels, *cache_args,
            "--output", f"type=oci,dest={output / 'web.oci.tar'}", "--metadata-file", str(metadata), str(ROOT / "web"),
        ], check=True)
        values["image"] = "ghcr.io/maudecode/talaria-web@" + image_digest(metadata)
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
