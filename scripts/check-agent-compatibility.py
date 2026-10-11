#!/usr/bin/env python3
"""Check a stable Agent release, or an exact Agent main canary, in disposable source and container state.

Talaria supports exactly three stable Agent releases, recorded in ``web/sidecar/agent_support.json``; the
active deployment pin in ``web/sidecar/agent_dependency.json`` must be one of them. Without a selector this
checks the active pin. ``--release TAG`` checks a supported release, ``--identity JSON`` an unpromoted
candidate, and ``--main SHA`` a canary that never enters the support record. ``--list`` validates the
record offline and prints its tags.

Provisions the Agent checkout and its venv in a temporary directory on the newest Python its lockfile
allows (``--python`` overrides), runs the sidecar pytest suite on that interpreter, runs an optional extra
command with ``HERMES_WEBUI_AGENT_DIR``/``HERMES_WEBUI_PYTHON`` set (``--command``), and verifies the
release image (unless ``--skip-docker``). ``--receipt PATH`` records the result, pass or fail, with the
pytest JUnit report beside it.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import tomllib
import urllib.request
import uuid
import xml.etree.ElementTree as ElementTree
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
AGENT_REPOSITORY = "NousResearch/hermes-agent"
IDENTITY = ("releaseTag", "version", "sourceRevision", "image")
FORMATS = {
    # Upstream tagged date releases until v0.21.5 and semantic versions since v0.21.6.
    "releaseTag": r"v(?:[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}(?:\.[0-9]+)?|(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))",
    "version": r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)",
    "sourceRevision": r"[a-f0-9]{40}",
    "image": r"docker\.io/nousresearch/hermes-agent@sha256:[a-f0-9]{64}",
}
# ponytail: newest of these that the lockfile allows; extend the range when an Agent requires a newer Python.
PYTHON_MINORS = range(11, 15)


def stable_identity(entry):
    if not isinstance(entry, dict) or not all(isinstance(entry.get(key), str) and re.fullmatch(FORMATS[key], entry[key])
                                              for key in IDENTITY):
        raise ValueError("Agent release tag, version, source, and image must be immutable")
    return {key: entry[key] for key in IDENTITY}


def active_pin(root):
    pin = json.loads((root / "web/sidecar/agent_dependency.json").read_text())
    return stable_identity({**pin["x-talaria"], "image": pin["services"]["hermes-agent"]["image"]})


def supported_releases(root):
    record = json.loads((root / "web/sidecar/agent_support.json").read_text())
    if not isinstance(record, dict) or set(record) != {"schemaVersion", "releases"} or record["schemaVersion"] != 1 \
            or not isinstance(record["releases"], list):
        raise ValueError("invalid Agent support record")
    releases = []
    for entry in record["releases"]:
        if not isinstance(entry, dict) or set(entry) != {*IDENTITY, "validatedBy"} \
                or not re.fullmatch(r"TAL-[1-9][0-9]*", str(entry["validatedBy"])):
            raise ValueError("each supported Agent release names its identity and validating ticket")
        releases.append(stable_identity(entry))
    if len(releases) != 3:
        raise ValueError("Talaria supports exactly three stable Agent releases")
    for key in IDENTITY:
        if len({release[key] for release in releases}) != len(releases):
            raise ValueError(f"supported Agent releases repeat a {key}")
    if active_pin(root) not in releases:
        raise ValueError("the active Agent pin is outside the supported releases")
    return releases


def lockfile_python(agent):
    """Newest Python minor the checkout's uv.lock ``requires-python`` allows, by PEP 440 specifier rules."""
    try:
        from packaging.specifiers import SpecifierSet
    except ImportError:  # Not installed on a bare runner; pip ships the same library.
        from pip._vendor.packaging.specifiers import SpecifierSet
    allowed = SpecifierSet(tomllib.loads((agent / "uv.lock").read_text())["requires-python"])
    for minor in reversed(PYTHON_MINORS):
        # A minor qualifies when some patch release of it does (`<=3.13` admits only 3.13.0).
        if any(allowed.contains(f"3.{minor}.{patch}") for patch in (0, 99)):
            return f"3.{minor}"
    raise RuntimeError("no supported Python satisfies the Agent lockfile")


def require_published(tag):
    # The workflow's read-only token avoids shared-runner API limits; locally the request is anonymous.
    headers = {"Accept": "application/vnd.github+json"}
    if os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['GITHUB_TOKEN']}"
    request = urllib.request.Request(f"https://api.github.com/repos/{AGENT_REPOSITORY}/releases/tags/{tag}", headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        release = json.load(response)
    if release.get("tag_name") != tag or release.get("draft") is not False or release.get("prerelease") is not False:
        raise RuntimeError(f"Agent {tag} is not a published stable release")


def test_counts(report):
    counts = {"tests": 0, "failures": 0, "errors": 0, "skipped": 0}
    root = ElementTree.parse(report).getroot()
    for suite in [root] if root.tag == "testsuite" else root.iter("testsuite"):
        for key in counts:
            counts[key] += int(suite.get(key, 0))
    return {"passed": counts["tests"] - counts["failures"] - counts["errors"] - counts["skipped"],
            "failed": counts["failures"] + counts["errors"], "skipped": counts["skipped"]}


def select(args):
    if args.main:
        if not re.fullmatch(FORMATS["sourceRevision"], args.main):
            raise ValueError("an Agent main canary needs an exact commit")
        return "canary", {"sourceRevision": args.main}
    if args.identity:
        return "candidate", stable_identity(json.loads(args.identity))
    releases = supported_releases(ROOT)
    if args.release:
        match = [release for release in releases if release["releaseTag"] == args.release]
        if not match:
            raise ValueError(f"Agent {args.release} is not a supported release")
        return "supported", match[0]
    return "active", active_pin(ROOT)


def image_source(image):
    """The commit an Agent image was built from, and the release attempt that built it. Images before Agent 0.21.6
    carry an OCI revision label; later ones only record a CI build stamp."""
    config = json.loads(subprocess.check_output(["docker", "image", "inspect", image]))[0]["Config"]
    revision = (config.get("Labels") or {}).get("org.opencontainers.image.revision")
    if revision:
        return revision, None
    stamp = json.loads(subprocess.check_output(["docker", "run", "--rm", "--network", "none", "--entrypoint", "cat",
                                                image, "/opt/hermes/install-stamp.json"]))
    if stamp.get("source") != "ci" or stamp.get("dirty") is not False:
        raise RuntimeError("Agent image build stamp is not a clean CI build")
    return stamp.get("commit"), stamp.get("branch")


def remote_tag_commit(tag):
    refs = dict(line.split("\t")[::-1] for line in subprocess.check_output(
        ["git", "ls-remote", f"https://github.com/{AGENT_REPOSITORY}.git", f"refs/tags/{tag}", f"refs/tags/{tag}^{{}}"],
        text=True).splitlines() if line)
    return refs.get(f"refs/tags/{tag}^{{}}", refs.get(f"refs/tags/{tag}"))


def verify_image(identity, sha):
    image, release_tag, version = identity["image"], identity["releaseTag"], identity["version"]
    # Docker needs the caller's daemon context, but the container receives only
    # these synthetic environment values, read-only code and temporary state.
    subprocess.run(["docker", "pull", image], check=True)
    source, attempt = image_source(image)
    if source != sha:
        raise RuntimeError("Agent image source label or build stamp does not match its tested source")
    # Upstream publishes each release attempt as rc.N-<tag>, and its v0.21.6 Docker tag kept an earlier attempt's
    # image. The attempt that built this image counts when its Git tag is the release commit.
    tags = [release_tag]
    if attempt and re.fullmatch(rf"rc\.[0-9]+-{re.escape(release_tag)}", attempt) and remote_tag_commit(attempt) == sha:
        tags.append(attempt)
    for tag in tags:
        tagged = f"docker.io/nousresearch/hermes-agent:{tag}"
        subprocess.run(["docker", "pull", tagged], check=True)
        if any(ref.endswith("@" + image.rsplit("@", 1)[1])
               for ref in json.loads(subprocess.check_output(["docker", "image", "inspect", tagged]))[0].get("RepoDigests", [])):
            break
    else:
        raise RuntimeError("Agent release tag image does not match the compatibility pin")
    name = "talaria-agent-compatibility-" + uuid.uuid4().hex[:12]
    try:
        subprocess.run([
            "docker", "run", "--rm", "--name", name, "--network", "none", "--read-only",
            "--tmpfs", "/tmp", "--tmpfs", "/opt/data", "--entrypoint", "/opt/hermes/.venv/bin/python",
            "-e", "HOME=/tmp/home", "-e", "HERMES_HOME=/tmp/home/hermes", "-e", "PYTHONPATH=/web/sidecar:/opt/hermes",
            "-v", f"{ROOT / 'web'}:/web:ro", "-v", f"{ROOT / 'releases/agent_probe.py'}:/probe.py:ro",
            image, "/probe.py", version,
        ], check=True)
    finally:
        subprocess.run(["docker", "rm", "--force", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


def check(args, kind, identity, receipt, junit):
    sha = identity["sourceRevision"]
    if kind != "canary":
        require_published(identity["releaseTag"])
    with tempfile.TemporaryDirectory(prefix="talaria-agent-compatibility-") as directory:
        state = Path(directory)
        for name in ("home", "tmp", "agent"):
            (state / name).mkdir()
        env = {"PATH": os.environ["PATH"], "HOME": str(state / "home"), "TMPDIR": str(state / "tmp"),
               "UV_CACHE_DIR": str(state / "uv-cache"), "HERMES_HOME": str(state / "home/hermes"),
               "HERMES_WEBUI_STATE_DIR": str(state / "home/webui"), "PIP_CONFIG_FILE": os.devnull,
               "GIT_CONFIG_NOSYSTEM": "1", "GIT_TERMINAL_PROMPT": "0"}
        for key in ("LD_LIBRARY_PATH", "PLAYWRIGHT_BROWSERS_PATH"):
            if key in os.environ:
                env[key] = os.environ[key]
        agent = state / "agent"
        ref = sha if kind == "canary" else f"refs/tags/{identity['releaseTag']}"
        # A local release tag lets Agents that derive their version from git see the release they are.
        for command in (["git", "init", "--quiet", str(agent)],
                        ["git", "-C", str(agent), "fetch", "--depth=1", "--no-tags", f"https://github.com/{AGENT_REPOSITORY}.git",
                         ref if kind == "canary" else f"+{ref}:{ref}"],
                        ["git", "-C", str(agent), "checkout", "--quiet", "--detach", "FETCH_HEAD"]):
            subprocess.run(command, env=env, check=True)
        actual = subprocess.check_output(["git", "-C", str(agent), "rev-parse", "HEAD"], env=env, text=True).strip()
        if actual != sha:
            raise RuntimeError(f"Agent {ref} resolves to {actual}, not the recorded {sha}; the tag moved")
        python = args.python or lockfile_python(agent)
        # The mcp extra (shipped in the image via [all]) lets the sidecar suite drive a real stub MCP server.
        subprocess.run(["uv", "sync", "--frozen", "--no-dev", "--extra", "mcp", "--python", python], cwd=agent, env=env, check=True)
        agent_python = agent / ".venv/bin/python"
        receipt["python"] = subprocess.check_output([str(agent_python), "-c", "import platform; print(platform.python_version())"],
                                                    env=env, text=True).strip()
        env.update(HERMES_WEBUI_AGENT_DIR=str(agent), HERMES_WEBUI_PYTHON=str(agent_python), HERMES_WEBUI_TEST_PYTHON=sys.executable)
        # A canary has no release version to require; the probe still exercises imports and SessionDB.
        subprocess.run([str(agent_python), str(ROOT / "releases/agent_probe.py"), *([identity["version"]] if kind != "canary" else [])],
                       cwd=agent, env={**env, "PYTHONPATH": str(ROOT / "web/sidecar")}, check=True)
        if not args.skip_sidecar_tests:
            # The sidecar suite spawns `python -m talaria_sidecar` on this venv with disposable homes.
            try:
                subprocess.run([str(ROOT / "web/sidecar/scripts/test.sh"), f"--junitxml={junit}", *args.tests],
                               cwd=ROOT / "web", env=env, check=True)
            finally:
                if junit.exists():
                    receipt["tests"] = test_counts(junit)
        if args.command:
            subprocess.run(args.command, cwd=ROOT, env={**os.environ, **env, "PATH": os.environ["PATH"]}, check=True)
    if not args.skip_docker and kind != "canary":
        verify_image(identity, sha)
        receipt["imageVerified"] = True


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("tests", nargs="*", help="Optional sidecar pytest selectors; defaults to the full sidecar suite.")
    selector = parser.add_mutually_exclusive_group()
    selector.add_argument("--list", action="store_true", help="Validate the support record and print its release tags as JSON.")
    selector.add_argument("--release", help="Check this supported release tag.")
    selector.add_argument("--identity", help="Check an unpromoted candidate: JSON with releaseTag, version, sourceRevision and image.")
    selector.add_argument("--main", metavar="SHA", help="Check an exact Agent main commit as a canary.")
    parser.add_argument("--python", help="Python for the Agent venv; defaults to the newest its lockfile allows.")
    parser.add_argument("--receipt", type=Path, help="Write the machine-readable result here, pass or fail.")
    parser.add_argument("--command", nargs=argparse.REMAINDER, help="Extra command to run with the provisioned Agent in its environment.")
    parser.add_argument("--skip-docker", action="store_true", help="Skip the release image verification (no Docker daemon).")
    parser.add_argument("--skip-sidecar-tests", action="store_true")
    args = parser.parse_args()
    if args.list:
        print(json.dumps([release["releaseTag"] for release in supported_releases(ROOT)]))
        return
    kind, identity = select(args)
    if args.receipt:
        args.receipt = args.receipt.resolve()  # The sidecar suite writes its JUnit report from another directory.
    web = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True)
    receipt = {"kind": kind, **identity, "webRevision": web.stdout.strip() or None, "python": None, "tests": None,
               "imageVerified": False, "result": "failure"}
    with tempfile.TemporaryDirectory(prefix="talaria-agent-junit-") as scratch:
        junit = args.receipt.with_suffix(".junit.xml") if args.receipt else Path(scratch) / "sidecar.junit.xml"
        if args.receipt:
            args.receipt.parent.mkdir(parents=True, exist_ok=True)
            receipt["diagnostics"] = junit.name
        try:
            check(args, kind, identity, receipt, junit)
            receipt["result"] = "success"
        except BaseException as error:
            receipt["failure"] = str(error) or type(error).__name__
            raise
        finally:
            if args.receipt:
                temporary = args.receipt.with_suffix(".tmp")
                temporary.write_text(json.dumps(receipt, indent=2) + "\n")
                temporary.replace(args.receipt)
            print(json.dumps(receipt))


if __name__ == "__main__":
    main()
