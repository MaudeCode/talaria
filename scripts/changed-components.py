#!/usr/bin/env python3
"""Route PR and push diffs to affected suites; uncertainty runs every suite."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys


SUITES = {"app", "app_tooling", "web_python", "web_frontend", "docker", "relay", "contracts", "tooling"}
CONSUMERS = {"app", "web_python", "web_frontend", "relay", "contracts"}
WEB_BUILD = {"web_python", "web_frontend", "docker", "contracts"}
JOBS = {"test": {"app"}, "app-tooling": {"app_tooling"}, "web": {"web_python", "web_frontend"},
        "web-docker": {"docker"}, "relay": {"relay"}, "contracts": {"contracts"}}
WORKFLOWS = {
    "web-verify.yml": {"web_python", "web_frontend", "tooling"},
    "web-docker-smoke.yml": {"docker", "tooling"},
    "relay-verify.yml": {"relay", "tooling"},
    "repository-tooling.yml": {"tooling"},
    "web-docs.yml": {"tooling"},
    "web-native-windows-startup.yml": {"web_python", "tooling"},
    "upstream-watch.yml": {"tooling"},
    "fuzz-soak.yml": {"app", "tooling"},
    "release.yml": {"tooling"},
    "release-set.yml": {"tooling"},
    "production-cutover.yml": {"tooling"},
    "ios-release-build.yml": {"tooling"},
}
SCRIPTS = {
    "check-web-python": {"web_python", "tooling"},
    "check-web-browser": {"web_frontend", "tooling"},
    "check-docker.py": {"docker", "tooling"},
    "check-relay-local.py": {"relay", "tooling"},
    "stamp-release.py": {"web_python", "tooling"},
    "prepare-web-migration.py": {"web_python", "tooling"},
    "check-agent-compatibility.py": {"web_python", "docker", "tooling"},
    "check-previous-app.py": {"contracts", "tooling"},
    "check-selected-contracts.py": CONSUMERS | {"tooling"},
    "check-releases": {"tooling"},
    "rehearse-monorepo.py": {"tooling"},
    "test-monorepo-import.py": {"tooling"},
    "import-web-upstream": {"tooling"},
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
        return {"app", "contracts"} if local.startswith(("Talaria/Networking/", "Talaria/Models/", "Talaria/LiveActivities/")) else {"app"}
    if path.startswith("web/tests/"):
        return {"web_python"}
    if path.startswith("relay/tests/"):
        return {"relay"}
    documentation = (path.count("/") <= 1 or path.startswith((
        "docs/", "app/docs/", "web/docs/", "relay/docs/", ".agents/skills/", ".github/ISSUE_TEMPLATE/")))
    if (documentation and path.endswith((".md", ".markdown", ".rst"))) or path in ("LICENSE", "web/NOTICE"):
        return set()
    if path.startswith("contracts/") or path in ("web/api/contract_versions.json", "relay/convex/releaseInfo.json"):
        return CONSUMERS
    if path.startswith(".github/workflows/"):
        return WORKFLOWS.get(local.removeprefix("workflows/"), SUITES)
    if path.startswith((".github/actions/", ".github/release-templates/", "releases/")) or path in (
            ".github/actionlint.yaml", ".github/dependabot.yml", ".github/CODEOWNERS", "docs/monorepo-sources.json"):
        return {"tooling"}
    if component == "scripts":
        return SCRIPTS.get(local, SUITES)
    if component == "app":
        if local.startswith("ci/"):
            return {"tooling"}
        if local in ("scripts/validate-upstream-contract", "scripts/upstream-contract-probe") or local.startswith("UPSTREAM_"):
            return {"contracts", "tooling"}
        if local.startswith("scripts/"):
            return {"app_tooling", "tooling"}
        return {"app"}
    if component == "web":
        if local.startswith(("frontend/", "static/")):
            return {"web_frontend"}
        if local.startswith(("Dockerfile", "docker", ".docker", ".env.docker")):
            return {"docker", "web_python"}
        if local in ("pyproject.toml", "setup.cfg", "setup.py", "uv.lock", "flake.nix", "flake.lock", ".env.example") or local.startswith("requirements"):
            return WEB_BUILD
        if local == "api/agent_dependency.json":
            return {"web_python", "docker", "contracts"}
        if local in ("server.py", "api/routes.py"):
            return {"web_python", "contracts"}
        if local.startswith(("api/", "scripts/", "skills/")) or local in (
                "bootstrap.py", "mcp_server.py", "pytest.ini", "start.sh", "start.ps1", "ctl.sh", "UPSTREAM_BASE_SHA"):
            return {"web_python"}
        return WEB_BUILD
    if component == "relay":
        if local in ("convex/http.ts", "convex/lib/model.ts", "convex/lib/validators.ts", "convex/lib/apnsPayload.ts"):
            return {"relay", "app", "web_python", "contracts"}
        return {"relay"}
    return SUITES


def affected(paths):
    paths = list(paths)
    return set().union(*(path_suites(path) for path in paths)) if paths else set(SUITES)


def git_diff(base, head, merge_base=False):
    def git(*args):
        return subprocess.check_output(["git", *args], stderr=subprocess.PIPE)

    def commit(ref):
        result = git("rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}").decode().strip()
        if not re.fullmatch(r"[a-f0-9]{40}", result):
            raise ValueError("invalid commit")
        return result

    base, head = commit(base), commit(head)
    if merge_base:
        base = git("merge-base", base, head).decode().strip()
    data = git("diff", "--no-renames", "--name-only", "-z", base, head, "--")
    if data and not data.endswith(b"\0"):
        raise ValueError("invalid NUL-delimited diff")
    return [os.fsdecode(path) for path in data.split(b"\0") if path]


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
    args = parser.parse_args()
    if args.self_test:
        subprocess.run([sys.executable, str(Path(__file__).with_name("test-changed-components.py"))], check=True)
        return
    if args.check_results:
        check_results(json.loads(os.environ["CI_NEEDS"]))
        print("CI Gate passed.")
        return
    try:
        selected = affected(git_diff(args.base, args.head, args.merge_base)) if args.base else set(SUITES)
    except (OSError, ValueError, subprocess.CalledProcessError):
        print("Could not classify the complete diff; running all suites.", file=sys.stderr)
        selected = SUITES
    for suite in sorted(SUITES):
        print(f"{suite}={str(suite in selected).lower()}")


if __name__ == "__main__":
    main()
