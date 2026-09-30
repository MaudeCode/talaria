#!/usr/bin/env python3
"""Production operations authorized only by the main-branch cutover workflow."""

import argparse
import base64
import contextlib
import hashlib
import json
import os
import plistlib
import subprocess
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path

from cli import REPOSITORY, ROOT, load, receipt, require_latest_predecessor, run_url, unused_release, write
from plan import git
from release_set import validate


@contextlib.contextmanager
def timed(label):
    """Log how long a publication phase took, also in the job's step summary, so each release measures it (TAL-414)."""
    start = time.monotonic()
    try:
        yield
    finally:
        line = f"{label}: {time.monotonic() - start:.0f} s"
        print(line, flush=True)
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
                summary.write(f"- {line}\n")


def authorize(plan):
    if (plan.get("dryRun") is not False or os.environ.get("GITHUB_REF") != "refs/heads/main"
            or os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
            or os.environ.get("GITHUB_WORKFLOW_REF") not in {
                f"{REPOSITORY}/.github/workflows/{name}@refs/heads/main"
                for name in ("production-cutover.yml", "recover-cutover.yml")}):
        raise ValueError("production requires the trusted main cutover workflow")
    run_url()
    if git(ROOT, "rev-parse", "HEAD") != plan["releaseSet"]:
        raise ValueError("production checkout differs from the approved source")


def verify_ipa(path, component):
    with zipfile.ZipFile(path) as archive:
        bundles = (("", "dev.kil.talaria", True),
                   ("PlugIns/TalariaShareExtension.appex/", "dev.kil.talaria.shareextension", False),
                   ("PlugIns/TalariaLiveActivityWidget.appex/", "dev.kil.talaria.liveactivitywidget", True))
        for directory, identifier, sends_requests in bundles:
            info = plistlib.loads(archive.read("Payload/Talaria.app/" + directory + "Info.plist"))
            if (info.get("CFBundleIdentifier") != identifier
                    or info.get("CFBundleShortVersionString") != component["version"]
                    or info.get("CFBundleVersion") != str(component["buildNumber"])
                    or (sends_requests and any(info.get("TalariaRelease", {}).get(key) != component[key]
                        for key in ("version", "buildNumber", "sourceRevision", "releaseSet", "contracts")))):
                raise ValueError("IPA identity differs from the release plan")
    return file_digest(path)


def file_digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def relay(plan, output):
    component = plan["components"]["relay"]
    deployment = component["deploymentId"]
    key = os.environ.get("CONVEX_DEPLOY_KEY", "")
    if not key.startswith(f"prod:{deployment}|") or not key.split("|", 1)[-1]:
        raise ValueError("Relay requires a production deployment-scoped key matching the planned deployment")
    with timed("Relay dependencies"):
        subprocess.run(["pnpm", "install", "--frozen-lockfile"], cwd=ROOT / "relay", check=True)
    subprocess.run(["python3", "scripts/stamp-release.py", "relay", "--version", component["version"],
                    "--source-revision", component["sourceRevision"], "--deployment-id", deployment], cwd=ROOT, check=True)
    # An explicit Convex env file is authoritative for both target and auth.
    with tempfile.NamedTemporaryFile(mode="w", prefix="talaria-relay-", suffix=".env",
                                     dir=os.environ.get("RUNNER_TEMP")) as environment:
        environment.write("CONVEX_DEPLOY_KEY=" + json.dumps(key) + "\n")
        environment.flush()
        with timed("Relay deploy"):
            subprocess.run(["pnpm", "exec", "convex", "deploy", "--typecheck", "enable", "--env-file", environment.name,
                            "--message", "Talaria release-set " + plan["releaseSet"]], cwd=ROOT / "relay", check=True)
    started = time.monotonic()
    for attempt in range(12):
        try:
            with urllib.request.urlopen(f"https://{deployment}.convex.site/v1/health", timeout=10) as response:
                health = json.load(response)
            expected = {key: component[key] for key in ("version", "sourceRevision", "releaseSet", "deploymentId")}
            actual = health.get("release", {})
            if health.get("ok") is True and all(actual.get(key) == value for key, value in expected.items()):
                print(f"Relay readiness readback: {time.monotonic() - started:.0f} s", flush=True)
                write(output, receipt("deployRelay", plan["releaseSet"], deploymentId=deployment,
                                      deployedRevision=actual["sourceRevision"]))
                return
        except (OSError, ValueError):
            pass
        if attempt < 11:
            time.sleep(5)
    raise ValueError("Relay readiness/provenance readback did not match the deployed release")


def _web_component(plan, build):
    component = plan["components"]["web"]
    if build.get("result") != "success" or build.get("gate") != "buildWeb" or build.get("sourceRevision") != plan["releaseSet"] or build.get("tag") != component["tag"]:
        raise ValueError("Web build receipt does not match the plan")
    return component


def web_npm(plan, build, directory):
    """npm publication, on the GitHub-hosted runner that npm trusted publishing requires, before the GHCR push.

    npm is the most failure-prone external publication, so it goes first, as Cove does; an identical retry accepts
    the immutable registry bytes without burning another version.
    """
    return publish_npm(_web_component(plan, build), build, directory)


def web(plan, build, directory, output):
    """GHCR publication on the self-hosted pool, after `web_npm`: confirm the npm readback, then push the image."""
    component = _web_component(plan, build)
    image = build["image"]
    tag = f"ghcr.io/maudecode/talaria-web:{component['tag']}"
    with timed("npm readback before GHCR"):
        npm_identity = verify_npm(component, build, directory)
    with timed("GHCR image copy and readback"), tempfile.TemporaryDirectory(prefix="talaria-registry-auth-") as temporary:
        auth = str(Path(temporary) / "auth.json")
        subprocess.run(["skopeo", "login", "--authfile", auth, "--username", os.environ["GITHUB_ACTOR"],
                        "--password-stdin", "ghcr.io"], input=os.environ["GH_TOKEN"], text=True, check=True)
        subprocess.run(["skopeo", "copy", "--all", "--preserve-digests", "--authfile", auth,
                        "oci-archive:" + str(directory / "web.oci.tar"), "docker://" + tag], check=True)
        raw = subprocess.check_output(["skopeo", "inspect", "--raw", "--authfile", auth, "docker://" + image])
        if "sha256:" + hashlib.sha256(raw).hexdigest() != image.split("@", 1)[1]:
            raise ValueError("published Web manifest digest differs from the build")
    write(output, receipt("publishWeb", plan["releaseSet"], tag=component["tag"], image=image, npm=npm_identity))


def _npm_integrity(path):
    return "sha512-" + base64.b64encode(hashlib.sha512(path.read_bytes()).digest()).decode()


def _npm_json(stdout):
    """`npm view --json` output; npm 12 wraps a single version's value in a one-element array."""
    value = json.loads(stdout)
    return value[0] if isinstance(value, list) and len(value) == 1 else value


def _npm_view(spec, field):
    """The registry's value for ``field`` of ``spec``, or None when that version is not published."""
    view = subprocess.run(["npm", "view", spec, field, "--json", "--prefer-online"], capture_output=True, text=True)
    if view.returncode == 0:
        return _npm_json(view.stdout) if view.stdout.strip() else None
    if "E404" in view.stderr:
        return None
    raise ValueError(f"npm registry lookup failed for {spec}: {view.stderr.strip()}")


def _npm_packages(component, build, directory):
    """The built tarballs, their package names and the channel's dist-tag, in publication order."""
    expected = f"@maudecode/talaria-web@{component['version']}"
    if build.get("npm") != expected:
        raise ValueError("Web build receipt does not name the npm package")
    tarballs = {path.name: path for path in (directory / "npm").glob("*.tgz")}
    ordered = [name for name in sorted(tarballs) if "contracts" in name] + [name for name in sorted(tarballs) if "contracts" not in name]
    if len(ordered) != 2:
        raise ValueError("Web publication requires the contracts and server tarballs")
    dist_tag = "experimental" if component["tag"].startswith("web-exp-") else "latest"
    packages = {name: "@maudecode/talaria-web-contracts" if "contracts" in name else "@maudecode/talaria-web" for name in ordered}
    return {"expected": expected, "tarballs": tarballs, "ordered": ordered, "dist_tag": dist_tag, "packages": packages}


def preflight_npm(component, build, directory):
    """Validate everything npm publication depends on without mutating the registry; returns the publication plan."""
    if not os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL") or not os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN"):
        raise ValueError("npm trusted publishing requires GitHub OIDC id-token permission")
    npm = _npm_packages(component, build, directory)
    tarballs, ordered, packages = npm["tarballs"], npm["ordered"], npm["packages"]
    # Preflight every package before any mutation so a mismatch on one never leaves the other re-tagged.
    published = {}
    for name in ordered:
        spec = f"{packages[name]}@{component['version']}"
        existing = _npm_view(spec, "dist.integrity")
        if existing is not None and existing != _npm_integrity(tarballs[name]):
            # Versions are immutable: a different tarball under this version came from another channel or build.
            raise ValueError(f"{spec} is already published with different contents; the version must be unique across channels")
        published[name] = existing is not None
    return {**npm, "published": published}


def publish_npm(component, build, directory):
    """Publish the packed tarballs (contracts first) and verify the registry readback."""
    plan = preflight_npm(component, build, directory)
    tarballs, dist_tag, published = plan["tarballs"], plan["dist_tag"], plan["published"]
    with timed("npm publish"):
        for name in plan["ordered"]:
            if not published[name]:
                result = subprocess.run(["npm", "publish", str(tarballs[name]), "--access", "public", "--tag", dist_tag],
                                        capture_output=True, text=True)
                print(result.stdout + result.stderr, end="", flush=True)
                # The preflight can read a stale 404 for a version npm already holds, so a resumed publication
                # meets "cannot publish over" (v1.13.0); the readback below still requires identical bytes (TAL-420).
                if result.returncode != 0 and "cannot publish over the previously published version" not in result.stderr:
                    raise subprocess.CalledProcessError(result.returncode, result.args, result.stdout, result.stderr)
    with timed("npm readback"):
        return verify_npm(component, build, directory)


# npm served v1.13.0 32 minutes after accepting it; wait up to 40 (TAL-420).
NPM_READBACK_ATTEMPTS = 240
NPM_READBACK_DELAY = 10


def verify_npm(component, build, directory):
    """The registry serves exactly the built tarballs under the channel's dist-tag; needs no publishing identity.

    npm processes a new version for a few minutes before serving it ("may take a few minutes to become
    available"), so a missing version or dist-tag is awaited; different bytes fail at once. Every read revalidates
    (--prefer-online): the CLI otherwise answers from its cached packument, which the preflight read just stored and
    which stays fresh for five minutes, so the readback saw the new version only once that cache expired (TAL-414).
    """
    npm = _npm_packages(component, build, directory)
    expected, tarballs, ordered = npm["expected"], npm["tarballs"], npm["ordered"]
    dist_tag, packages = npm["dist_tag"], npm["packages"]
    for name in ordered:
        spec = f"{packages[name]}@{component['version']}"
        for attempt in range(NPM_READBACK_ATTEMPTS):
            integrity = _npm_view(spec, "dist.integrity")
            tags = _npm_json(subprocess.check_output(["npm", "view", packages[name], "dist-tags", "--json", "--prefer-online"], text=True))
            if integrity is not None and integrity != _npm_integrity(tarballs[name]):
                raise ValueError("npm registry readback differs from the published tarball")
            if integrity is not None and tags.get(dist_tag) == component["version"]:
                break
            if attempt + 1 < NPM_READBACK_ATTEMPTS:
                time.sleep(NPM_READBACK_DELAY)
        else:
            if integrity is None:
                raise ValueError("npm registry readback differs from the published tarball: version never became available")
            raise ValueError(f"npm dist-tag {dist_tag} does not point at the published version")
    return expected


def _release_info(tag):
    # Native gh resolves both published tags and pending draft tags via GraphQL.
    result = subprocess.run(["gh", "release", "view", tag, "--repo", REPOSITORY,
                             "--json", "databaseId"], capture_output=True, text=True)
    if result.returncode:
        if result.stderr.strip() != "release not found":
            raise ValueError("release lookup failed; refusing to create a replacement")
        unused_release(tag)  # Also require an explicit REST 404 before creation.
        return None
    identifier = json.loads(result.stdout).get("databaseId")
    if type(identifier) is not int or identifier <= 0:
        raise ValueError("invalid release identity")
    return json.loads(subprocess.check_output(["gh", "api", f"repos/{REPOSITORY}/releases/{identifier}"], text=True))


def _publish_release(tag, source, notes, files, identity, *, latest=False):
    hashes = {path.name: file_digest(path) for path in files}
    marker = hashlib.sha256(json.dumps({"source": source, "manifest": identity, "files": hashes}, sort_keys=True).encode()).hexdigest()
    body = notes.rstrip() + "\n\n<!-- talaria-publication:" + marker + " -->\n"
    prerelease = tag.startswith("web-exp-")

    def matching(info):
        if (not info or info.get("tag_name") != tag or info.get("name") != tag
                or (info.get("body") or "").strip() != body.strip()
                or info.get("prerelease") is not prerelease or type(info.get("draft")) is not bool
                or {asset["name"] for asset in info.get("assets", [])} - hashes.keys()):
            raise ValueError("existing release does not match this run's verified publication")

    info = _release_info(tag)
    if info is None:
        with tempfile.TemporaryDirectory(prefix="talaria-release-notes-") as temporary:
            note_file = Path(temporary) / "notes.md"
            note_file.write_text(body)
            # No --target: GitHub refuses GITHUB_TOKEN a target_commitish that changes workflows (TAL-340).
            subprocess.run(["gh", "release", "create", tag, "--repo", REPOSITORY, "--verify-tag",
                            "--draft", "--title", tag, "--notes-file", str(note_file),
                            *( ["--prerelease"] if prerelease else [])], check=True)
        info = _release_info(tag)
    matching(info)
    for path in files:
        assets = [asset for asset in info["assets"] if asset["name"] == path.name]
        if not assets and info["draft"]:
            subprocess.run(["gh", "release", "upload", tag, str(path), "--repo", REPOSITORY], check=True)
            info = _release_info(tag)
            matching(info)
            assets = [asset for asset in info["assets"] if asset["name"] == path.name]
        if len(assets) != 1:
            raise ValueError("release asset is missing or duplicated")
        data = subprocess.check_output(["gh", "api", f"repos/{REPOSITORY}/releases/assets/{assets[0]['id']}",
                                        "-H", "Accept: application/octet-stream"])
        if hashlib.sha256(data).hexdigest() != hashes[path.name]:
            raise ValueError("release asset differs from the verified build")
    if info["draft"]:
        subprocess.run(["gh", "release", "edit", tag, "--repo", REPOSITORY, "--draft=false",
                        "--latest" if latest else "--latest=false"], check=True)
        info = _release_info(tag)
        matching(info)
        if info["draft"]:
            raise ValueError("release publication readback is still a draft")


def require_current_predecessor(plan, previous):
    try:
        require_latest_predecessor(previous)
    except ValueError:
        # A retry may follow this exact root's successful publication but failed
        # readback/cleanup. _publish_release still requires identical contents.
        require_latest_predecessor({"releaseSet": plan["releaseSet"]})


def finalize(plan, manifest, previous, artifacts):
    validate(manifest, previous)
    if manifest["status"] != "complete" or manifest["releaseSet"] != plan["releaseSet"]:
        raise ValueError("only this completed set may be published")
    if manifest["contracts"] != plan["contracts"] or manifest["agent"] != plan["agent"]:
        raise ValueError("completed compatibility metadata differs from the plan")
    for name, component in plan["components"].items():
        for key in ("tag", "version", "sourceRevision", "releaseSet", "deploymentId"):
            if key in component and manifest["components"][name].get(key) != component[key]:
                raise ValueError("completed component identity differs from the plan")
    root_tag = "release-set-" + plan["releaseSet"]
    require_current_predecessor(plan, previous)
    tarballs = sorted((artifacts / "web-build/npm").glob("*.tgz"))
    if plan["changed"]["web"] and (len(tarballs) != 2 or any(path.stat().st_size == 0 for path in tarballs)):
        raise ValueError("Web publication requires the built npm tarballs")
    identity = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
    # Component releases are prepared first. The updater consumes only the root
    # completed manifest, which is published as the final operation.
    for name, changed in plan["changed"].items():
        if not changed:
            continue
        tag = plan["components"][name]["tag"]
        _publish_release(tag, plan["releaseSet"], manifest["notes"][name], tarballs if name == "web" else [], identity)
    with tempfile.TemporaryDirectory(prefix="talaria-completed-set-") as temporary:
        directory = Path(temporary)
        write(directory / "release-set.json", manifest)
        _publish_release(root_tag, plan["releaseSet"], manifest["notes"]["combined"],
                         [directory / "release-set.json"], identity, latest=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("relay", "web-npm", "web", "build-app-receipt", "verify-app", "app", "finalize"))
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--build", type=Path)
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--previous", type=Path)
    parser.add_argument("--build-number", type=int)
    args = parser.parse_args()
    plan = load(args.plan)
    authorize(plan)
    component_name = {"relay": "relay", "web-npm": "web", "web": "web"}.get(args.operation, "app")
    if args.operation != "finalize" and not plan["changed"][component_name]:
        raise ValueError("unchanged components must not be republished")
    if args.operation == "relay":
        relay(plan, args.output)
    elif args.operation == "web-npm":
        print(web_npm(plan, load(args.build), args.directory))
    elif args.operation == "web":
        web(plan, load(args.build), args.directory, args.output)
    elif args.operation == "build-app-receipt":
        component = {**plan["components"]["app"], "buildNumber": args.build_number,
                     "contracts": {name: peers["app"] for name, peers in plan["contracts"].items() if "app" in peers}}
        files = list(args.directory.glob("*.ipa"))
        if len(files) != 1 or args.build_number is None or args.build_number < 1:
            raise ValueError("App build must contain one IPA and a selected build number")
        digest = verify_ipa(files[0], component)
        write(args.output, receipt("buildApp", plan["releaseSet"], tag=component["tag"], buildNumber=args.build_number, ipaSha256=digest))
    elif args.operation in ("verify-app", "app"):
        build = load(args.build)
        component = {**plan["components"]["app"], "buildNumber": build["buildNumber"],
                     "contracts": {name: peers["app"] for name, peers in plan["contracts"].items() if "app" in peers}}
        if build.get("gate") != "buildApp" or build.get("result") != "success" or build.get("sourceRevision") != plan["releaseSet"] or build.get("tag") != component["tag"]:
            raise ValueError("App build receipt differs from the plan")
        files = list(args.directory.glob("*.ipa"))
        if len(files) != 1 or verify_ipa(files[0], component) != build["ipaSha256"]:
            raise ValueError("App upload artifact differs from the verified build")
        if args.operation == "app":
            with timed("TestFlight upload and processing to VALID"):
                uploaded = subprocess.check_output([
                    "ruby", str(Path(__file__).resolve().parents[1] / "app/ci/upload_testflight.rb"), str(files[0]), component["version"],
                    str(component["buildNumber"]), build["ipaSha256"],
                ], text=True)
            result = json.loads(uploaded)
            if (any(result.get(key) != component[key] for key in ("version", "buildNumber"))
                    or result.get("ipaSha256") != build["ipaSha256"] or result.get("processingState") != "VALID"
                    or not result.get("buildId") or not result.get("uploadId")):
                raise ValueError("App Store Connect readback differs from the verified build")
            print(json.dumps(result, sort_keys=True))
            write(args.output.with_name("apple-build.json"), result)
            write(args.output, receipt("uploadApp", plan["releaseSet"], tag=component["tag"], buildNumber=component["buildNumber"], ipaSha256=build["ipaSha256"]))
    else:
        finalize(plan, load(args.manifest), load(args.previous) if args.previous else None, args.directory)


if __name__ == "__main__":
    main()
