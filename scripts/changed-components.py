#!/usr/bin/env python3
"""Route PR and push diffs to affected suites; uncertainty runs every suite."""

import argparse
import json
import os
import plistlib
from pathlib import Path
import re
import subprocess
import sys


SUITES = {"app", "app_tooling", "web_server", "web_frontend", "docker", "relay", "contracts", "tooling"}
CONSUMERS = {"app", "web_server", "web_frontend", "relay", "contracts"}
WEB_BUILD = {"web_server", "web_frontend", "docker", "contracts"}
JOBS = {"app-build": {"app", "contracts"}, "app-test": {"app", "contracts"}, "app-tooling": {"app_tooling"}, "web": {"web_server", "web_frontend"},
        "web-docker": {"docker"}, "relay": {"relay"}, "contracts": {"contracts"}}
WORKFLOWS = {
    # PR CI owns the App jobs and the Web contract probe's fixture handoff.
    "pr-ci.yml": {"app", "contracts", "tooling"},
    "web-verify.yml": {"web_server", "web_frontend", "tooling"},
    "web-docker-smoke.yml": {"docker", "tooling"},
    "relay-verify.yml": {"relay", "tooling"},
    "repository-tooling.yml": {"tooling"},
    "web-docs.yml": {"tooling"},
    "fuzz-soak.yml": {"app", "tooling"},
    "ui-performance.yml": {"app", "tooling"},
    "release.yml": {"tooling"},
    "release-set.yml": {"tooling"},
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
    "check-agent-compatibility.py": {"web_server", "docker", "tooling"},
    "critical-markdown-check.py": {"tooling"},
    "test-critical-markdown-check.py": {"tooling"},
    "check-committed-images.py": {"tooling"},
    "test-check-committed-images.py": {"tooling"},
    "check-previous-app.py": {"contracts", "tooling"},
    "check-release-contracts.py": {"contracts", "tooling"},
    "check": {"tooling"},
    "generate-brand-icons.py": {"web_frontend", "tooling"},
    "check-release-agent.py": {"tooling"},
    "check-releases": {"tooling"},
    "s3-artifact": {"tooling"},
    "test-s3-artifact.py": {"tooling"},
}


def same_app_scene(before, after):
    # Startup diagnostics precede the Scene; changes to the rendered Scene or
    # its helpers still require the complete UI suite.
    marker = "var body: some Scene"
    return marker in before and marker in after and before.split(marker, 1)[1] == after.split(marker, 1)[1]


def app_ui_required(paths, scene_unchanged=False, metadata_only_plists=()):
    for path in paths:
        if not path.startswith("app/"):
            if path.startswith(("web/", "relay/", "contracts/", "releases/", "scripts/", "docs/", "changelog.d/", ".github/", ".agents/")) or "/" not in path and path.endswith(".md"):
                continue
            return True
        if path == "app/Talaria/TalariaApp.swift":
            if not scene_unchanged:
                return True
        elif path.startswith(("app/Talaria/Networking/", "app/Talaria/Models/", "app/Talaria/Config/",
                              "app/Talaria/Persistence/", "app/Talaria/Sync/", "app/Talaria/LiveActivities/",
                              "app/TalariaTests/", "app/ci/", "app/scripts/", "app/docs/", "app/changelog.d/",
                              "app/Talaria.xcodeproj/")):
            continue
        elif path in metadata_only_plists or (path.count("/") == 1 and path.endswith(".md")):
            continue
        else:
            return True
    return False


def same_plist_ui(before, after):
    documents = [plistlib.loads(value) for value in (before, after)]
    for document in documents:
        document.pop("TalariaRelease", None)
    return documents[0] == documents[1]


def path_suites(path):
    if not isinstance(path, str) or any(part in ("", ".", "..") for part in path.split("/")) or "\0" in path:
        return SUITES
    if path.startswith(("changelog.d/", "app/changelog.d/")):
        return set()  # Release metadata validation owns this entire directory.
    component, _, local = path.partition("/")
    # Runtime resources and test fixtures can be Markdown too; never classify
    # them as documentation just because of their extension.
    if (component == "app" and local.startswith(("Talaria", "Packages/", "Config/"))):
        # The live Web fixture test runs only in PR CI's contracts step, so it selects contracts too.
        return {"app", "contracts"} if local.startswith(("Talaria/Networking/", "Talaria/Models/", "Talaria/LiveActivities/",
                                                          "TalariaTests/APIClientSessionListTests.swift")) else {"app"}
    if path.startswith("web/sidecar/tests/"):
        return {"web_server"}
    if path.startswith("relay/tests/"):
        return {"relay"}
    docs_directory = path.startswith(("docs/", "app/docs/", "web/docs/", "relay/docs/"))
    documentation = path.count("/") <= 1 or docs_directory or path.startswith((".agents/skills/", ".github/ISSUE_TEMPLATE/"))
    if ((documentation and path.endswith((".md", ".markdown", ".rst")))
            or (docs_directory and path.endswith((".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif")))
            or path in ("LICENSE", "web/NOTICE")):
        return set()
    if path.startswith("contracts/") or path in ("web/contract_versions.json", "relay/convex/releaseInfo.json"):
        return CONSUMERS
    if path.startswith(".github/workflows/"):
        return WORKFLOWS.get(local.removeprefix("workflows/"), SUITES)
    if path == ".github/actions/docker-plugins/action.yml":
        return {"docker", "tooling"}  # Compose/Buildx setup for the Docker smoke.
    if path == ".github/actions/setup-xcode/action.yml":
        return {"app", "tooling"}  # Xcode selection for the App build and test shards.
    if path.startswith((".github/actions/", "releases/")) or path in (
            ".github/actionlint.yaml", ".github/dependabot.yml", ".github/CODEOWNERS"):
        return {"tooling"}
    if component == "scripts":
        return SCRIPTS.get(local, SUITES)
    if component == "app":
        if local in ("ci/test_shards.py", "ci/test-shard-weights.json"):
            return {"app", "tooling"}  # They choose which App tests each CI shard runs.
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
        if local.startswith("packages/contracts/"):
            return {"web_server", "web_frontend", "contracts"}
        # The Agent pin is baked into the container images and extended by the Compose files: it needs the smoke too.
        if local == "sidecar/agent_dependency.json":
            return {"web_server", "contracts", "docker"}
        # The sidecar RPC surface and the server are one consumer of the shared contracts; the Playwright suite drives
        # the real Node server from the frontend job, so server changes run it too.
        if local.startswith(("packages/server/", "sidecar/")):
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
        # HTTP handlers forward results from many Convex modules. Default new
        # modules to consumer coverage; only known maintenance code stays local.
        internal = {"convex/cleanup.ts", "convex/crons.ts", "convex/workpool.ts", "convex/convex.config.ts"}
        if local.startswith("convex/") and local not in internal:
            return {"relay", "app", "web_server", "contracts"}
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


def classify_app_ui(paths, base, head):
    scene_unchanged = False
    entry = "app/Talaria/TalariaApp.swift"
    if entry in paths:
        try:
            before, after = [git("show", f"{ref}:{entry}").decode() for ref in (base, head)]
            scene_unchanged = same_app_scene(before, after)
        except subprocess.CalledProcessError:
            pass  # Missing/unreadable entry points require the full UI suite.
    metadata_only_plists = []
    for path in paths:
        if path.startswith("app/") and path.endswith("/Resources/Info.plist"):
            try:
                before, after = [git("show", f"{ref}:{path}") for ref in (base, head)]
                if same_plist_ui(before, after):
                    metadata_only_plists.append(path)
            except (subprocess.CalledProcessError, ValueError, plistlib.InvalidFileException, AttributeError, TypeError):
                pass
    return not paths or app_ui_required(paths, scene_unchanged, metadata_only_plists)


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
    requires_ui = True
    try:
        selected = set(SUITES)
        if args.base:
            base, head = diff_refs(args.base, args.head, args.merge_base)
            paths = git_diff(base, head)
            selected = affected(paths)
            requires_ui = any(path_suites(path) == SUITES for path in paths) or classify_app_ui(paths, base, head)
    except (OSError, ValueError, subprocess.CalledProcessError):
        print("Could not classify the complete diff; running all suites.", file=sys.stderr)
        selected = SUITES
    print(f"app_ui={str(requires_ui).lower()}")
    for suite in sorted(SUITES):
        print(f"{suite}={str(suite in selected).lower()}")


if __name__ == "__main__":
    main()
