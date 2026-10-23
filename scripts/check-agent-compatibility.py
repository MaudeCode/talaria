#!/usr/bin/env python3
"""Check a stable Agent release, or an exact Agent main canary, in a cached or disposable Agent checkout.

Talaria supports exactly three stable Agent releases, recorded in ``web/sidecar/agent_support.json``; the
active deployment pin in ``web/sidecar/agent_dependency.json`` must be one of them. Without a selector this
checks the active pin. ``--release TAG`` checks a supported release, ``--identity JSON`` an unpromoted
candidate, and ``--main SHA`` a canary that never enters the support record. ``--list`` validates the
record offline and prints its tags.

Provisions the Agent checkout and its venv on the newest Python its lockfile allows (``--python`` overrides).
Supported releases, the active pin among them, are cached under ``$XDG_CACHE_HOME/talaria/agents/<tag>`` and
reused; each run deletes cached releases that left the support record. Candidates and canaries use a
temporary directory removed at exit. It runs the Agent probe, the sidecar pytest suite on that interpreter,
an optional extra command with ``HERMES_WEBUI_AGENT_DIR``/``HERMES_WEBUI_PYTHON`` set (``--command``, whose
exit status the run returns; ``web/sidecar/scripts/test.sh`` re-runs itself this way), and verifies the
release image (unless ``--skip-docker``). ``--receipt PATH`` records the result, pass or fail, with the
pytest JUnit report beside it.
"""

import argparse
import contextlib
import fcntl
import json
import os
import re
import shutil
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
# The mcp extra (shipped in the image via [all]) lets the sidecar suite drive a real stub MCP server.
SYNC = ["uv", "sync", "--frozen", "--no-dev", "--extra", "mcp"]
CACHE_SUFFIXES = (".lock", ".ready", ".python", ".tmp")
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
    if not isinstance(record, dict) or set(record) - {"schemaVersion", "releases", "nativeContracts"} or record.get("schemaVersion") != 1 \
            or not isinstance(record.get("releases"), list):
        raise ValueError("invalid Agent support record")
    contracts = record.get("nativeContracts", {})
    if (not isinstance(contracts, dict) or set(contracts) - {"served-local-policy-v1", "captured-command-v1", "message-reactions-v1"}
            or any(not isinstance(revisions, list) or not revisions
                   or any(not isinstance(sha, str) or not re.fullmatch(FORMATS["sourceRevision"], sha) for sha in revisions)
                   or len(set(revisions)) != len(revisions) for revisions in contracts.values())):
        raise ValueError("native contracts require verified immutable Agent revisions")
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


def verify_image(identity, sha, observations, compression, *, retained_cron):
    image, release_tag, version = identity["image"], identity["releaseTag"], identity["version"]
    # Docker needs the caller's daemon context, but the container receives only
    # these synthetic environment values, read-only code and temporary state.
    subprocess.run(["docker", "pull", image], check=True)
    source, attempt = image_source(image)
    if source != sha:
        raise RuntimeError("Agent image source label or build stamp does not match its tested source")
    # Upstream publishes each release attempt as rc.N-<tag>, and its v0.21.6 Docker tag kept an earlier attempt's
    # image, while v0.21.7 has no plain Docker tag at all. The attempt that built this image counts when its Git
    # tag is the release commit; a tag missing from the registry is no match, any other pull failure is fatal.
    tags = [release_tag]
    if attempt and re.fullmatch(rf"rc\.[0-9]+-{re.escape(release_tag)}", attempt) and remote_tag_commit(attempt) == sha:
        tags.append(attempt)
    for tag in tags:
        tagged = f"docker.io/nousresearch/hermes-agent:{tag}"
        pull = subprocess.run(["docker", "pull", tagged], stderr=subprocess.PIPE, text=True)
        sys.stderr.write(pull.stderr)
        # The containerd image store reports a missing tag as "<ref>: not found", the classic one as "manifest unknown".
        if pull.returncode and f"{tagged}: not found" not in pull.stderr and "manifest unknown" not in pull.stderr:
            raise subprocess.CalledProcessError(pull.returncode, pull.args, stderr=pull.stderr)
        if pull.returncode == 0 and any(ref.endswith("@" + image.rsplit("@", 1)[1])
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
            "-e", "HERMES_WEBUI_AGENT_DIR=/opt/hermes",
            "-e", "TALARIA_AGENT_UPGRADE_PROBE=" + ("1" if retained_cron else "0"),
            "-e", "TALARIA_AGENT_SSH_EXPECTED=" + json.dumps(observations),
            "-e", "TALARIA_AGENT_COMPRESSION_EXPECTED=" + json.dumps(compression),
            "-v", f"{ROOT / 'web'}:/web:ro", "-v", f"{ROOT / 'releases/agent_probe.py'}:/probe.py:ro",
            image, "/probe.py", version,
        ], check=True)
    finally:
        subprocess.run(["docker", "rm", "--force", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


def cache_root():
    return Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "talaria/agents"


def prune(root, keep):
    """Delete cached releases outside the support record, skipping any a run holds. Lock files stay, so every run
    locks the same file for a tag."""
    tags = {next((path.name.removesuffix(suffix) for suffix in CACHE_SUFFIXES if path.name.endswith(suffix)), path.name)
            for path in root.iterdir()}
    for tag in tags - keep:
        with open(root / f"{tag}.lock", "a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                continue
            for path in (root / tag, root / f"{tag}.python"):
                shutil.rmtree(path, ignore_errors=True)
            for path in (root / f"{tag}.ready", root / f"{tag}.tmp"):
                path.unlink(missing_ok=True)


def provision(args, kind, identity, env, agent):
    sha = identity["sourceRevision"]
    if kind != "canary":
        require_published(identity["releaseTag"])
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
    subprocess.run([*SYNC, "--python", python], cwd=agent, env=env, check=True)
    return python


@contextlib.contextmanager
def agent_checkout(args, kind, identity, env):
    """Yield a provisioned Agent checkout: a cached supported release, or a temporary candidate or canary."""
    if kind in ("candidate", "canary"):
        with tempfile.TemporaryDirectory(prefix="talaria-agent-") as directory:
            env["UV_PYTHON_INSTALL_DIR"] = str(Path(directory) / "python")
            agent = Path(directory) / "agent"
            provision(args, kind, identity, env, agent)
            yield agent
        return
    root = cache_root()
    root.mkdir(parents=True, exist_ok=True)
    prune(root, {release["releaseTag"] for release in supported_releases(ROOT)})
    tag = identity["releaseTag"]
    agent, ready = root / tag, root / f"{tag}.ready"
    # A uv-downloaded interpreter must outlive this run's HOME; it sits beside its release and is pruned with it.
    env["UV_PYTHON_INSTALL_DIR"] = str(root / f"{tag}.python")

    # An explicit --python may resolve to another interpreter each run, so only this run's own provisioning counts.
    provisioned = {}

    def current():
        try:
            expected = provisioned if args.python else \
                {"sourceRevision": identity["sourceRevision"], "python": lockfile_python(agent), "sync": SYNC}
            if not expected or json.loads(ready.read_text()) != expected:
                return False
        except (OSError, ValueError):
            return False
        venv = agent / ".venv/bin/python"
        return venv.is_file() and subprocess.run([str(venv), "-c", ""], env=env, capture_output=True).returncode == 0

    with open(root / f"{tag}.lock", "a") as lock:
        # Shared while in use and exclusive only to provision, so runs share a release and neither a reprovision nor
        # a prune removes it under one. Converting a flock is not atomic, so each conversion re-checks the entry.
        fcntl.flock(lock, fcntl.LOCK_SH)
        while not current():
            fcntl.flock(lock, fcntl.LOCK_EX)
            if not current():
                ready.unlink(missing_ok=True)
                shutil.rmtree(agent, ignore_errors=True)
                provisioned.update(sourceRevision=identity["sourceRevision"], python=provision(args, kind, identity, env, agent), sync=SYNC)
                temporary = root / f"{tag}.tmp"
                temporary.write_text(json.dumps(provisioned))
                temporary.replace(ready)
            fcntl.flock(lock, fcntl.LOCK_SH)
        yield agent


def check(args, kind, identity, receipt, junit):
    with tempfile.TemporaryDirectory(prefix="talaria-agent-compatibility-") as directory:
        state = Path(directory)
        for name in ("home", "tmp"):
            (state / name).mkdir()
        env = {"PATH": os.environ["PATH"], "HOME": str(state / "home"), "TMPDIR": str(state / "tmp"),
               "UV_CACHE_DIR": str(state / "uv-cache"), "HERMES_HOME": str(state / "home/hermes"),
               "HERMES_WEBUI_STATE_DIR": str(state / "home/webui"), "PIP_CONFIG_FILE": os.devnull,
               "GIT_CONFIG_NOSYSTEM": "1", "GIT_TERMINAL_PROMPT": "0"}
        for key in ("LD_LIBRARY_PATH", "PLAYWRIGHT_BROWSERS_PATH", "TALARIA_SIDECAR_WORKERS", "TALARIA_SIDECAR_TOTAL_WORKERS"):
            if key in os.environ:
                env[key] = os.environ[key]
        with agent_checkout(args, kind, identity, env) as agent:
            agent_python = agent / ".venv/bin/python"
            receipt["python"] = subprocess.check_output([str(agent_python), "-c", "import platform; print(platform.python_version())"],
                                                        env=env, text=True).strip()
            env.update(HERMES_WEBUI_AGENT_DIR=str(agent), HERMES_WEBUI_PYTHON=str(agent_python), HERMES_WEBUI_TEST_PYTHON=sys.executable)
            # The retained formats first shipped in 0.22.1; promotion must not bypass their probe.
            retained_cron = kind in ("candidate", "canary") or tuple(map(int, identity["version"].split("."))) >= (0, 22, 1)
            observations = probe_agent(agent, identity, {**env, "TALARIA_AGENT_UPGRADE_PROBE": "1" if retained_cron else "0"}, receipt)
            if not args.skip_sidecar_tests:
                # The sidecar suite spawns `python -m talaria_sidecar` on this venv with disposable homes.
                try:
                    subprocess.run([str(ROOT / "web/sidecar/scripts/test.sh"), f"--agent-release={identity.get('releaseTag', '')}", f"--junitxml={junit}", *args.tests],
                                   cwd=ROOT / "web", env=env, check=True)
                finally:
                    if junit.exists():
                        receipt["tests"] = test_counts(junit)
            if args.command:
                # The command runs while this run holds the release, and its exit status is the run's.
                command = subprocess.run(args.command, cwd=ROOT, env={**os.environ, **env, "PATH": os.environ["PATH"]})
                if command.returncode:
                    raise SystemExit(command.returncode)
    if not args.skip_docker and kind != "canary":
        verify_image(identity, identity["sourceRevision"], observations, receipt["compressionBackoff"]["observations"], retained_cron=retained_cron)
        receipt["imageVerified"] = True


def probe_agent(agent, identity, env, receipt):
    # Separate disposable state for each baseline/candidate, including the real file tools' task cwd.
    with tempfile.TemporaryDirectory(prefix="talaria-agent-probe-") as directory:
        state = Path(directory)
        report = state / "agent-probe.json"
        probe_env = {**env, "HOME": str(state), "HERMES_HOME": str(state / "hermes"),
                     "TALARIA_AGENT_PROBE_REPORT": str(report), "PYTHONPATH": str(ROOT / "web/sidecar"),
                     "HERMES_WEBUI_AGENT_DIR": str(agent)}
        try:
            subprocess.run([str(agent / ".venv/bin/python"), str(ROOT / "releases/agent_probe.py"),
                            *([identity["version"]] if "version" in identity else [])], cwd=agent, env=probe_env, check=True)
        finally:
            if report.exists():
                result = json.loads(report.read_text())
                observations = result.pop("sshConfigApproval")
                compression = result.pop("compressionBackoff")
                # Agent-internal observations are diagnostics, not Talaria compatibility requirements.
                receipt["compressionBackoff"] = {"observations": compression}
                receipt["sshConfigApproval"] = {"observations": observations}
                receipt["agentProbe"] = result
        return observations


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
