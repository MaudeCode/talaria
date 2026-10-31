#!/usr/bin/env python3
"""Route PR and push diffs to affected suites; uncertainty runs every suite."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys


SUITES = {"app", "app_tooling", "web_server", "web_frontend", "web_sidecar", "docker", "relay", "contracts", "tooling"}
CONSUMERS = {"app", "web_server", "web_frontend", "web_sidecar", "relay", "contracts"}
# The sidecar job builds the server too, so the workspace build inputs select it (TAL-1161).
WEB_BUILD = {"web_server", "web_frontend", "web_sidecar", "docker", "contracts"}
# web_sidecar is the Agent-release pytest matrix. It loads the built server only through the recovery proof's entry
# points and reads one server fixture; every other server file skips it on a pull request. A main push with any server
# change still runs it (ci.yml), which catches a transitive break in those entry points right after merge.
SIDECAR_SERVER_INPUTS = ("packages/server/src/sidecar/", "packages/server/src/runtime.ts", "packages/server/src/app.ts",
                         "packages/server/src/tools/updates.ts", "packages/server/src/test/fixtures/local-reset.json",
                         "packages/server/package.json", "packages/server/tsconfig.json",
                         "packages/server/tsconfig.build.json")
JOBS = {"app": {"app", "contracts"}, "app-tooling": {"app_tooling"}, "web": {"web_server", "web_frontend", "web_sidecar"},
        "web-docker": {"docker"}, "relay": {"relay"}, "contracts": {"contracts"}}
WORKFLOWS = {
    # CI owns the App jobs and the Web contract probe's fixture handoff.
    "ci.yml": {"app", "web_sidecar", "contracts", "tooling"},
    "app-tests.yml": {"app", "contracts", "tooling"},
    "web-verify.yml": {"web_server", "web_frontend", "web_sidecar", "tooling"},
    "web-docker-smoke.yml": {"docker", "tooling"},
    "relay-verify.yml": {"relay", "tooling"},
    "relay-bridge-image.yml": {"relay", "tooling"},
    "repository-tooling.yml": {"tooling"},
    "web-docs.yml": {"tooling"},
    "fuzz-soak.yml": {"app", "tooling"},
    "release.yml": {"tooling"},
    "release-set.yml": {"tooling"},
    "nightly.yml": {"tooling"},
    "web-experimental.yml": {"tooling"},
    "production-cutover.yml": {"tooling"},
    "ios-release-build.yml": {"tooling"},
    "inspect-testflight.yml": {"tooling"},
    "recover-cutover.yml": {"tooling"},
}
SCRIPTS = {
    "changed-components.py": {"tooling"},
    "test-changed-components.py": {"tooling"},
    "check-web-server": {"web_server", "tooling"},
    "check-web-browser": {"web_frontend", "tooling"},
    "check-docker.py": {"docker", "tooling"},
    "check-relay-local.py": {"relay", "tooling"},
    "stamp-release.py": {"tooling"},
    "test-stamp-release.py": {"tooling"},
    "check-agent-compatibility.py": {"web_server", "web_sidecar", "docker", "tooling"},
    "test-check-agent-compatibility.py": {"tooling"},
    "critical-markdown-check.py": {"tooling"},
    "test-critical-markdown-check.py": {"tooling"},
    "check-committed-images.py": {"tooling"},
    "test-check-committed-images.py": {"tooling"},
    "check-previous-app.py": {"contracts", "tooling"},
    "check-release-contracts.py": {"contracts", "tooling"},
    "check": {"tooling"},
    "generate-brand-icons.py": {"web_frontend", "tooling"},
    "check-release-agent.py": {"tooling"},
    "test-check-release-agent.py": {"tooling"},
    "check-releases": {"tooling"},
    "check-hosted-runners.py": {"tooling"},
    "test-check-hosted-runners.py": {"tooling"},
    "main-ci-failure.py": {"tooling"},
    "test-main-ci-failure.py": {"tooling"},
}


def path_suites(path):
    if not isinstance(path, str) or any(part in ("", ".", "..") for part in path.split("/")) or "\0" in path:
        return SUITES
    if path.startswith(("changelog.d/", "app/changelog.d/")):
        return set()  # Release metadata validation owns this entire directory.
    component, _, local = path.partition("/")
    # Runtime resources and test fixtures can be Markdown too; never classify
    # them as documentation just because of their extension.
    if (component == "app" and local.startswith(("Talaria", "Packages/", "Config/"))):
        # The live Web fixture test runs only in PR CI's contracts step, so it selects contracts too. TalariaKit
        # (TAL-399) holds the networking and models, and its package job runs that test.
        return {"app", "contracts"} if local.startswith(("Talaria/Networking/", "Talaria/Models/", "Talaria/LiveActivities/",
                                                          "TalariaTests/APIClientSessionListTests.swift", "TalariaKit/Package.",
                                                          "TalariaKit/Sources/TalariaKit/Networking/",
                                                          "TalariaKit/Sources/TalariaKit/Models/",
                                                          "TalariaKit/Sources/TalariaKit/LiveActivities/",
                                                          "TalariaKit/Tests/TalariaKitTests/APIClientSessionListTests.swift",
                                                          "TalariaKit/Tests/TalariaKitTests/Support/")) else {"app"}
    # Server tests read these fixtures, and the server job regenerates schemas.json from the contracts.
    if path.startswith("web/sidecar/tests/fixtures/"):
        return {"web_server", "web_sidecar"}
    if path.startswith("web/sidecar/tests/"):
        return {"web_sidecar"}
    if path.startswith("relay/tests/"):
        return {"relay"}
    docs_directory = path.startswith(("docs/", "app/docs/", "web/docs/", "relay/docs/"))
    documentation = path.count("/") <= 1 or docs_directory or path.startswith((".agents/skills/", ".github/ISSUE_TEMPLATE/"))
    if ((documentation and path.endswith((".md", ".markdown", ".rst")))
            or (docs_directory and path.endswith((".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif")))
            or path in ("LICENSE", "web/NOTICE")):
        return set()
    # The release-note generator and stamp read the What's New schema; their tests share its fixture (TAL-1616).
    if path in ("contracts/whats-new.schema.json", "contracts/fixtures/whats-new.json"):
        return CONSUMERS | {"tooling"}
    if path.startswith("contracts/") or path in ("web/contract_versions.json", "relay/convex/releaseInfo.json"):
        return CONSUMERS
    if path == "releases/agent_probe.py":
        return {"web_server", "web_sidecar", "docker", "tooling"}
    if path.startswith(".github/workflows/"):
        return WORKFLOWS.get(local.removeprefix("workflows/"), SUITES)
    if path == ".github/actions/docker-plugins/action.yml":
        return {"docker", "tooling"}  # Compose/Buildx setup for the Docker smoke.
    if path == ".github/actions/setup-xcode/action.yml":
        return {"app", "tooling"}  # Xcode selection for the App build and tests.
    if path.startswith((".github/actions/", "releases/")) or path in (
            ".github/actionlint.yaml", ".github/dependabot.yml", ".github/CODEOWNERS",
            ".agy/config.json", ".codex/environments/environment.toml", ".xcodebuildmcp/config.yaml", ".gitleaksignore"):
        return {"tooling"}
    if component == "scripts":
        return SCRIPTS.get(local, SUITES)
    if component == "app":
        if local in ("ci/build-for-testing", "ci/wait-for-job", "ci/gh-api-poll", "ci/package-coverage"):
            return {"app", "tooling"}  # They build, select and sequence the App CI jobs.
        if local.startswith("ci/"):
            return {"tooling"}
        if local in ("scripts/validate-upstream-contract", "scripts/upstream-contract-probe"):
            return {"contracts", "tooling"}
        if local.startswith("scripts/"):
            return {"app_tooling", "tooling"}
        return {"app"}
    if component == "web":
        if local.startswith(("packages/frontend/", "static/dist/")):
            return {"web_frontend"}
        # The sidecar's result schemas are generated from the contracts.
        if local.startswith("packages/contracts/"):
            return {"web_server", "web_frontend", "web_sidecar", "contracts"}
        # The Agent pin is baked into the container images and extended by the Compose files: it needs the smoke too.
        if local == "sidecar/agent_dependency.json":
            return {"web_server", "web_sidecar", "contracts", "docker"}
        # The sidecar's pytest harness runs only the sidecar suite, here and in the release's Agent gate (TAL-1599).
        if local in ("sidecar/scripts/suite_runner.py", "sidecar/scripts/test.sh"):
            return {"web_sidecar", "tooling"}
        # The sidecar RPC surface and the server are one consumer of the shared contracts; the Playwright suite drives
        # the real Node server from the frontend job, so server changes run it too.
        if local.startswith(("sidecar/", *SIDECAR_SERVER_INPUTS)):
            return {"web_server", "web_frontend", "web_sidecar", "contracts"}
        # Server unit tests stay out of the build that Playwright and the contracts probe run (tsconfig.build.json).
        if local.startswith("packages/server/src/") and local.endswith(".test.ts"):
            return {"web_server"}
        if local.startswith("packages/server/"):
            return {"web_server", "web_frontend", "contracts"}
        # The lockfile and Node version feed both the workspace builds and the container image.
        if local in ("package.json", "package-lock.json", ".nvmrc"):
            return WEB_BUILD
        if local.startswith("static/"):
            return {"web_frontend", "web_server"}
        if local.startswith(("Dockerfile", "docker", ".docker", ".env.docker", "scripts/lib/")):
            return {"docker", "web_server"}
        if local == ".env.example" or local.startswith("scripts/"):
            return {"web_server"}
        return WEB_BUILD
    if component == "relay":
        # No App, Web or contracts test runs Relay code. Consumers meet Relay only through contracts/ fixtures, which
        # relay/tests/sharedContracts.test.ts holds Relay to and whose changes select every consumer above (TAL-1644).
        return {"relay"}
    return SUITES


def affected(paths):
    paths = list(paths)
    return set().union(*(path_suites(path) for path in paths)) if paths else set(SUITES)


def git(*args):
    return subprocess.check_output(["git", *args], stderr=subprocess.PIPE)


def revision(ref):
    result = git("rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}").decode().strip()
    if not re.fullmatch(r"[a-f0-9]{40}", result):
        raise ValueError("invalid commit")
    return result


def diff_refs(base, head, merge_base=False):
    base, head = revision(base), revision(head)
    if merge_base:
        base = git("merge-base", base, head).decode().strip()
    return base, head


def git_diff(base, head, merge_base=False):
    base, head = diff_refs(base, head, merge_base)
    data = git("diff", "--no-renames", "--name-only", "-z", base, head, "--")
    if data and not data.endswith(b"\0"):
        raise ValueError("invalid NUL-delimited diff")
    return [os.fsdecode(path) for path in data.split(b"\0") if path]


def check_diff(base, head, merge_base=False):
    if base:
        base, head = diff_refs(base, head, merge_base)
        command = ["git", "diff", "--check", base, head, "--"]
    else:
        command = ["git", "show", "--format=", "--check", "--diff-merges=first-parent", revision(head)]
    subprocess.run(command, check=True)


def check_results(needs):
    if needs["changes"]["result"] != "success" or needs["tooling"]["result"] != "success":
        raise ValueError("Path detection and release metadata validation must succeed")
    outputs = needs["changes"].get("outputs", {})
    for job, suites in JOBS.items():
        required = any(outputs.get(suite) != "false" for suite in suites)
        allowed = {"success"} if required else {"success", "skipped"}
        if needs[job]["result"] not in allowed:
            raise ValueError(f"Required check {job} did not pass")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base")
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--merge-base", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--check-results", action="store_true")
    parser.add_argument("--check-diff", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        subprocess.run([sys.executable, str(Path(__file__).with_name("test-changed-components.py"))], check=True)
        return
    if args.check_diff:
        check_diff(args.base, args.head, args.merge_base)
        return
    if args.check_results:
        check_results(json.loads(os.environ["CI_NEEDS"]))
        print("CI Gate passed.")
        return
    try:
        selected = set(SUITES)
        if args.base:
            base, head = diff_refs(args.base, args.head, args.merge_base)
            paths = git_diff(base, head)
            selected = affected(paths)
    except (OSError, ValueError, subprocess.CalledProcessError):
        print("Could not classify the complete diff; running all suites.", file=sys.stderr)
        selected = SUITES
    for suite in sorted(SUITES):
        print(f"{suite}={str(suite in selected).lower()}")


if __name__ == "__main__":
    main()
