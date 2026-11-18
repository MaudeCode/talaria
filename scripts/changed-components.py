#!/usr/bin/env python3
"""Route PR and push diffs to affected suites; uncertainty runs every suite."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys



SUITES = {"app", "app_tooling", "web_server", "web_frontend", "web_sidecar", "docker", "relay", "contracts", "tooling"}
CONSUMERS = {"app", "web_server", "web_frontend", "web_sidecar", "relay", "contracts"}
# The sidecar job builds the server too, so the workspace build inputs select it (TAL-1161).
IMAGE_WORKSPACE_BUILD_INPUTS = tuple(f"packages/{name}/{file}" for name in ("contracts", "server")
                                     for file in ("package.json", "tsconfig.json", "tsconfig.build.json"))
WEB_BUILD = {"web_server", "web_frontend", "web_sidecar", "docker", "contracts"}
# web_sidecar is the Agent-release pytest matrix. It loads the built server only through the recovery proof's entry
# points and reads one server fixture; every other server file skips it on a pull request. A main push with any server
# change still runs it (ci.yml), which catches a transitive break in those entry points right after merge.
SIDECAR_SERVER_INPUTS = ("packages/server/src/sidecar/", "packages/server/src/runtime.ts", "packages/server/src/app.ts",
                         "packages/server/src/tools/updates.ts", "packages/server/src/test/fixtures/local-reset.json",
                         "packages/server/package.json", "packages/server/tsconfig.json",
                         "packages/server/tsconfig.build.json")
# Web and TalariaKit's package tests read every root fixture; Sidecar, the App's hosted tests and Relay read only these
# (TAL-1674). test_fixture_readers_are_routed rescans the readers so the lists cannot fall behind them. The
# release-note generator and stamp tests share the What's New fixture (TAL-1616).
FIXTURE_READERS = {
    "web_sidecar": {"mcp-cost-policy.json", "mcp-events.json", "native-cron-refusal.json", "plan-allowance.json",
                    "talaria-tool-names.json", "tool-presentations.json", "web-native-notices.json", "web-native-todos.json", "web-native-work.json", "web-reactions.json"},
    "tooling": {"whats-new.json"},
    "app": {"connectors.json", "decision-review.json", "delegation-status.json", "execution-modes.json",
            "model-confirmation.json", "proposal.json", "running-subagent.json", "settings-model-picker.json", "show.json",
            "terminal-view.json", "vault-prompts.json", "web-native-work.json"},
    "relay": {"app-registration.json", "feedback-attachment-limits.json", "feedback-report.json",
              "feedback-report-agent.json", "notification-alerts.json", "publisher-session-started.json", "publisher-snapshot.json",
              "relay-approval-alert.json", "relay-snapshot.json"},
}
JOBS = {"app": {"app", "contracts"}, "app-tooling": {"app_tooling"}, "web": {"web_server", "web_frontend", "web_sidecar"},
        "web-docker": {"docker"}, "relay": {"relay"}, "contracts": {"contracts"}}
WORKFLOWS = {
    # CI owns the App jobs and the Web contract probe's fixture handoff.
    "ci.yml": {"app", "app_tooling", "web_sidecar", "contracts", "tooling"},
    "app-tests.yml": {"app", "contracts", "tooling"},
    "app-test-diagnostics.yml": {"tooling"},
    "web-verify.yml": {"web_server", "web_frontend", "web_sidecar", "tooling"},
    "web-docker-smoke.yml": {"docker", "tooling"},
    "relay-verify.yml": {"relay", "tooling"},
    "relay-bridge-image.yml": {"relay", "tooling"},
    "repository-tooling.yml": {"tooling"},
    "web-docs.yml": {"tooling"},
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
    "app_test_plan.py": {"tooling"},
    # The browser plan also selects check-web-browser's filters and receipts (TAL-2391).
    "web_browser_plan.py": {"web_frontend", "tooling"},
    "check-ui-rules.mjs": {"app_tooling", "web_frontend", "tooling"},
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
    # Test defect rules and the per-test run-time budget (TAL-2403).
    "test-rules.json": {"tooling"},
    "test-rules-baseline.json": {"tooling"},
    "check-test-durations.py": {"tooling"},
    "test-check-test-durations.py": {"tooling"},
    "test-durations.json": {"tooling"},
    "test-check-committed-images.py": {"tooling"},
    "check-previous-app.py": {"contracts", "tooling"},
    "check-release-contracts.py": {"contracts", "tooling"},
    "check": {"tooling"},
    "generate-brand-icons.py": {"web_frontend", "tooling"},
    # The release gate and the PR sidecar matrix and join (TAL-1776).
    "check-release-agent.py": {"web_sidecar", "tooling"},
    "test-check-release-agent.py": {"tooling"},
    "check-releases": {"tooling"},
    "check-hosted-runners.py": {"tooling"},
    "test-check-hosted-runners.py": {"tooling"},
    "main-ci-failure.py": {"tooling"},
    "test-main-ci-failure.py": {"tooling"},
    "test-ci-concurrency.py": {"tooling"},
    "install-git-hooks": {"tooling"},
    "test-pre-push-hook.py": {"tooling"},
}


# scripts/check-hosted-runners.py holds these Web image inputs to digest pins and no piped installs.
IMAGE_PIN_INPUTS = ("Dockerfile", "docker_init.bash")


def path_suites(path):
    if not isinstance(path, str) or any(part in ("", ".", "..") for part in path.split("/")) or "\0" in path:
        return SUITES
    if path.startswith(("changelog.d/", "app/changelog.d/")):
        return set()  # Release metadata validation owns this entire directory.
    component, _, local = path.partition("/")
    # Runtime resources and test fixtures can be Markdown too; never classify
    # them as documentation just because of their extension.
    if (component == "app" and local.startswith(("Talaria", "Packages/", "Config/"))):
        if local.startswith("Talaria/Resources/") and local.endswith(".xcstrings"):
            return {"app", "app_tooling"}  # Compile the catalogs and enforce their canonical ordering.
        # The Web server's provider icon test holds its table and web/static/brand/providers to the App's (TAL-1858).
        icons = {"web_server"} if (local == "Talaria/Models/ProviderIconRegistry.swift"
                                     or local.startswith("Talaria/Resources/ProviderIcons.xcassets/")) else set()
        # The live Web fixture test runs only in PR CI's contracts step, so it selects contracts too. TalariaKit
        # (TAL-399) holds the networking and models, and its package job runs that test.
        ui_rules = {"app_tooling"} if local.startswith("Talaria/Features/") and local.endswith(".swift") else set()
        return ui_rules | icons | ({"app", "contracts"} if local.startswith(("Talaria/Networking/", "Talaria/Models/", "Talaria/LiveActivities/",
                                                          "TalariaTests/APIClientSessionListTests.swift", "TalariaKit/Package.",
                                                          "TalariaKit/Sources/TalariaKit/Networking/",
                                                          "TalariaKit/Sources/TalariaKit/Models/",
                                                          "TalariaKit/Sources/TalariaKit/LiveActivities/",
                                                          "TalariaKit/Tests/TalariaKitTests/APIClientSessionListTests.swift",
                                                          "TalariaKit/Tests/TalariaKitTests/Support/")) else {"app"})
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
    # The release-note generator and stamp read the What's New schema (TAL-1616); Relay never does (TAL-2174).
    if path == "contracts/whats-new.schema.json":
        return CONSUMERS - {"relay"} | {"tooling"}
    # Only Web's drift check reads the OpenAPI document; the contracts probe covers what the App decodes (TAL-1674).
    if path == "contracts/web-api.openapi.json":
        return {"web_server", "contracts"}
    if path.startswith("contracts/fixtures/"):
        name = path.removeprefix("contracts/fixtures/")
        return {"web_server", "web_frontend", "contracts"} | {suite for suite, names in FIXTURE_READERS.items() if name in names}
    if path.startswith("contracts/") or path in ("web/contract_versions.json", "relay/convex/releaseInfo.json"):
        return CONSUMERS
    if path == "releases/agent_probe.py":
        return {"web_server", "web_sidecar", "docker", "tooling"}
    if path == "releases/cli.py":
        return {"contracts", "tooling"}  # The Web contract probe lists the retained Web releases with it (TAL-2345).
    if path.startswith(".github/workflows/"):
        return WORKFLOWS.get(local.removeprefix("workflows/"), SUITES)
    if path == ".github/actions/docker-plugins/action.yml":
        return {"docker", "tooling"}  # Compose/Buildx setup for the Docker smoke.
    if path == ".github/actions/app-package-tests/action.yml":
        return WORKFLOWS["app-tests.yml"]  # The package tests' steps, called only from app-tests.yml.
    if path == ".github/actions/web-browser/action.yml":
        return {"web_frontend", "tooling"}  # The Playwright job's steps, called only from web-verify.yml.
    if path == ".github/actions/setup-bash/action.yml":
        return {"app", "app_tooling", "tooling"}  # bash 5 for the App's scripts in the macOS App and App tooling jobs.
    if path == ".github/actions/setup-xcode/action.yml":
        return {"app", "tooling"}  # Xcode selection for the App build and tests.
    if path.startswith((".github/actions/", ".githooks/", "releases/")) or path in (
            ".github/actionlint.yaml", ".github/dependabot.yml", ".github/CODEOWNERS",
            ".agy/config.json", ".codex/environments/environment.toml", ".xcodebuildmcp/config.yaml", ".gitleaksignore"):
        return {"tooling"}
    if component == "scripts":
        return SCRIPTS.get(local, SUITES)
    if component == "app":
        if local == "ci/ui-rules.json":
            return {"app_tooling", "web_frontend", "tooling"}  # The shared checker tests load the App rule set too.
        if local in ("ci/ui-rules-baseline.json", "ci/check-string-catalogs", "ci/check_string_catalogs_test.py", "ci/release_notes.py"):
            return {"app_tooling", "tooling"}
        if local in ("ci/build-for-testing", "ci/check-swift-warnings", "ci/wait-for-job", "ci/gh-api-poll", "ci/package-coverage"):
            return {"app", "tooling"}  # They build, select and sequence the App CI jobs.
        if local.startswith("ci/"):
            return {"tooling"}
        if local in ("scripts/validate-upstream-contract", "scripts/upstream-contract-probe"):
            return {"contracts", "tooling"}
        if local in ("scripts/prepare-ui-simulator", "scripts/ready-simulator-documents",
                     "scripts/ready-simulator-notifications", "scripts/seed-simulator-photo"):
            return {"app", "tooling"}  # Hosted preparation needs proof on real CI simulators.
        if local.startswith("scripts/"):
            return {"app_tooling", "tooling"}
        return {"app"}
    if component == "web":
        # The lockfile, Node version and the image's workspace builds feed both the workspace builds and the
        # container image, which compiles them for both release platforms (TAL-2345).
        if local in ("package.json", "package-lock.json", ".nvmrc", *IMAGE_WORKSPACE_BUILD_INPUTS):
            return WEB_BUILD
        if local.startswith(("packages/frontend/", "static/dist/")):
            return {"web_frontend"}
        # Contracts unit tests stay out of the package build (tsconfig.build.json); the server job's checks shard runs them.
        if local.startswith("packages/contracts/src/") and local.endswith(".test.ts"):
            return {"web_server"}
        # The sidecar's result schemas are generated from the contracts.
        if local.startswith("packages/contracts/"):
            return {"web_server", "web_frontend", "web_sidecar", "contracts"}
        # The Agent pin is baked into the container images and extended by the Compose files: it needs the smoke too.
        if local == "sidecar/agent_dependency.json":
            return {"web_server", "web_sidecar", "contracts", "docker"}
        # The sidecar's pytest harness runs only the sidecar suite, here and in the release's Agent gate (TAL-1599).
        if local in ("sidecar/scripts/suite_runner.py", "sidecar/scripts/test.sh"):
            return {"web_sidecar", "tooling"}
        # Server unit tests stay out of the build that Playwright and the contracts probe run (tsconfig.build.json).
        if local.startswith("packages/server/src/") and local.endswith(".test.ts"):
            return {"web_server"}
        # The sidecar RPC surface and the server are one consumer of the shared contracts; the Playwright suite drives
        # the real Node server from the frontend job, so server changes run it too.
        if local.startswith(("sidecar/", *SIDECAR_SERVER_INPUTS)):
            return {"web_server", "web_frontend", "web_sidecar", "contracts"}
        if local.startswith("packages/server/"):
            return {"web_server", "web_frontend", "contracts"}
        # Only the contracts/server and frontend lint steps read the shared lint config.
        if local == ".oxlintrc.json":
            return {"web_server", "web_frontend"}
        if local.startswith("static/"):
            return {"web_frontend", "web_server"}
        if local.startswith(("Dockerfile", "docker", ".docker", ".env.docker", "scripts/lib/")):
            # The tooling job's image pin check reads the Dockerfile and entrypoint (TAL-2215).
            return {"docker", "web_server"} | ({"tooling"} if local in IMAGE_PIN_INPUTS else set())
        if local == ".env.example" or local.startswith("scripts/"):
            return {"web_server"}
        return WEB_BUILD
    if component == "relay":
        # No App, Web or contracts test runs Relay code. Consumers meet Relay only through contracts/ fixtures, which
        # relay/tests/sharedContracts.test.ts holds Relay to and whose changes select every consumer above (TAL-1644).
        return {"relay", "tooling"} if path == "relay/bridge/Dockerfile" else {"relay"}
    return SUITES


def affected(paths, deleted_workflows=frozenset(), overrides=None):
    """A deleted workflow can no longer run, so it needs only the tooling checks rather than an unknown path's full run."""
    paths = list(paths)
    if not paths:
        return set(SUITES)
    overrides = overrides or {}
    return set().union(*({"tooling"} if path in deleted_workflows else overrides.get(path, path_suites(path)) for path in paths))


# The Web artifact stamps What's New from release fragments through these (TAL-1616), yet none selects a web_* suite, so
# changelog-only PRs skip the Web tests. Experimental still publishes when they change (TAL-1986).
WEB_ARTIFACT_INPUTS = ("scripts/stamp-release.py", "app/ci/release_notes.py", "contracts/whats-new.schema.json")


def web_artifact(paths, names_web):
    """Whether a diff changes the packed Web artifact; `names_web(path)` reads a changed release fragment.
    An empty diff (a rerun at the published revision) changes nothing."""
    paths = list(paths)
    return bool(paths) and (bool(affected(paths) & JOBS["web"]) or any(path in WEB_ARTIFACT_INPUTS for path in paths)
            or any(names_web(path) for path in paths if path.startswith(("changelog.d/", "app/changelog.d/"))))


def fragment_names_web(path, *revisions):
    """Whether any revision's copy of a release fragment has a web entry; an unreadable copy counts as one."""
    for ref in revisions:
        try:
            data = git("show", f"{ref}:{path}")
        except subprocess.CalledProcessError:
            continue  # Added or deleted: only the other side has it.
        try:
            if any("web" in entry.get("components", ["app"]) for entry in json.loads(data).get("entries", [])):
                return True
        except (ValueError, AttributeError, TypeError):
            return True
    return False


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
    return changed_paths(base, head)


def changed_paths(base, head):
    """The paths a diff changes; head None compares with the working tree, untracked files included."""
    data = git("diff", "--no-renames", "--name-only", "-z", base, *([head] if head else []), "--")
    if head is None:
        data += git("ls-files", "-z", "--others", "--exclude-standard")
    if data and not data.endswith(b"\0"):
        raise ValueError("invalid NUL-delimited diff")
    return sorted({os.fsdecode(path) for path in data.split(b"\0") if path})


def git_deleted_workflows(base, head):
    data = git("diff", "--no-renames", "--name-only", "--diff-filter=D", "-z", base, *([head] if head else []), "--",
               ".github/workflows/")
    return {os.fsdecode(path) for path in data.split(b"\0") if path}


def workflow_overrides(base, head, paths):
    path = ".github/workflows/ci.yml"
    if path not in paths:
        return {}
    try:
        before = git("show", f"{base}:{path}").decode()
        after = git("show", f"{head}:{path}").decode() if head else Path(path).read_text()
    except (OSError, subprocess.CalledProcessError):
        return {}
    # A change confined to one of these jobs, including adding or removing it, cannot affect the App build or Web
    # fixture handoff. release-freeze only sets a commit status (TAL-2516).
    for name, suites in (("app-tooling", {"app_tooling", "tooling"}), ("release-freeze", {"tooling"})):
        job = re.compile(rf"^  {name}:\n(?:[ \t]*\n| {{4}}[^\n]*(?:\n|\Z))*", re.MULTILINE)
        if (job.search(before) or job.search(after)) and job.sub("", before) == job.sub("", after):
            return {path: suites}
    return {}


def check_diff(base, head, merge_base=False):
    if base:
        base, head = diff_refs(base, head, merge_base)
        command = ["git", "diff", "--check", base, head, "--"]
    else:
        command = ["git", "show", "--format=", "--check", "--diff-merges=first-parent", revision(head)]
    subprocess.run(command, check=True)


WEB_CHECKS = {"web_server", "web_frontend"}
# Ignored files the Web lint and typecheck read: the workspace builds the hook runs first and generated assets. Their
# pre-scripts regenerate these from tracked sources on every run, so they are outputs, not inputs.
WEB_CHECK_OUTPUTS = ("web/packages/frontend/src/paraglide/", "web/packages/frontend/src/routeTree.gen.ts",
                     "web/packages/frontend/.tanstack/")
# npm ci records the installed dependency tree here; without it the dependencies cannot be identified.
WEB_DEPENDENCIES = "web/node_modules/.package-lock.json"


def web_check_fingerprint():
    """Hash everything the pre-push hook's Web lint and typecheck read (TAL-2393): the working-tree contents of every
    tracked or untracked path routed to a Web suite, the ignored build outputs and generated files beside them, the
    installed dependencies, the Node toolchain, and the hook and this router. Raises when an input cannot be read."""
    os.chdir(git("rev-parse", "--show-toplevel").decode().strip())
    listed = git("ls-files", "-z", "--cached", "--others", "--exclude-standard")
    ignored = git("ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", "web/packages", "web/static",
                  ":!:**/node_modules/**")
    paths = {path for path in map(os.fsdecode, listed.split(b"\0")) if path and path_suites(path) & WEB_CHECKS}
    paths |= {path for path in map(os.fsdecode, ignored.split(b"\0")) if path and not path.startswith(WEB_CHECK_OUTPUTS)}
    digest = hashlib.sha256()
    for tool in ("node", "npm"):
        digest.update(f"{tool}\0{shutil.which(tool)}\0".encode() + subprocess.check_output([tool, "--version"], cwd="web"))
    digest.update(f"NODE_OPTIONS\0{os.environ.get('NODE_OPTIONS', '')}\0".encode())
    digest.update(Path(WEB_DEPENDENCIES).read_bytes())
    for path in sorted(paths | {".githooks/pre-push", "scripts/changed-components.py"}):
        file = Path(path)
        # A deleted tracked file is a state of its own; a symlink is its target, not what it points to.
        content = (b"link\0" + os.fsencode(os.readlink(file)) if file.is_symlink()
                   else file.read_bytes() if file.exists() else b"missing")
        digest.update(f"\0{path}\0{len(content)}\0".encode() + content)
    return digest.hexdigest()


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
    parser.add_argument("--check-results", action="store_true")
    parser.add_argument("--check-diff", action="store_true")
    parser.add_argument("--web-artifact", action="store_true", help="Print whether the diff changes the packed Web artifact.")
    parser.add_argument("--web-check-fingerprint", action="store_true",
                        help="Print a hash of every input of the pre-push hook's Web lint and typecheck.")
    parser.add_argument("--local", action="store_true",
                        help="Compare the working tree, untracked files included, with its merge-base with --base (default origin/main).")
    parser.add_argument("--app-plan", nargs="?", const="outputs", choices=("outputs", "json", "text"),
                        help="Also plan the App tests (TAL-2390): Actions outputs (default), the plan's JSON or a readable plan.")
    parser.add_argument("--browser-plan", action="store_true",
                        help="Also print the pull request's Playwright plan (TAL-2391): none, the changed specs or full.")
    parser.add_argument("--tested-worktree", action="store_true",
                        help="Read test identifiers from the checked-out working tree (CI's tested checkout) rather than --head.")
    args = parser.parse_args()
    os.chdir(git("rev-parse", "--show-toplevel").decode().strip())
    if args.app_plan or args.browser_plan:
        # The App and browser test plans beside this router (TAL-2390, TAL-2391); loaded only when asked, so the router
        # runs on its own.
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        global app_test_plan, web_browser_plan
        import app_test_plan
        import web_browser_plan
    if args.check_diff:
        check_diff(args.base, args.head, args.merge_base)
        return
    if args.web_check_fingerprint:
        print(web_check_fingerprint())
        return
    if args.check_results:
        check_results(json.loads(os.environ["CI_NEEDS"]))
        print("CI Gate passed.")
        return
    if args.web_artifact:
        try:
            base, head = diff_refs(args.base, args.head)
            changed = web_artifact(git_diff(base, head), lambda path: fragment_names_web(path, base, head))
        except (OSError, ValueError, subprocess.CalledProcessError):
            print("Could not classify the complete diff; the Web artifact counts as changed.", file=sys.stderr)
            changed = True
        print(f"web_artifact={str(changed).lower()}")
        return
    selected, app_plan, browser_plan = set(SUITES), None, None
    try:
        if args.local:
            base = git("merge-base", revision(args.base or "origin/main"), "HEAD").decode().strip()
            head = None
        elif args.base:
            base, head = diff_refs(args.base, args.head, args.merge_base)
        if args.local or args.base:
            paths = changed_paths(base, head)
            deleted = git_deleted_workflows(base, head)
            selected = affected(paths, deleted, workflow_overrides(base, head, paths))
            if args.app_plan and paths:
                tree = app_test_plan.Tree(None if head is None or args.tested_worktree else head)
                app_plan = app_test_plan.plan(paths, base, head, tree, selected, path_suites, deleted)
            if args.browser_plan and paths:
                tree = app_test_plan.Tree(None if head is None or args.tested_worktree else head, web_browser_plan.FRONTEND)
                browser_plan = web_browser_plan.plan(paths, tree, path_suites)
    except (OSError, ValueError, subprocess.CalledProcessError):
        print("Could not classify the complete diff; running all suites.", file=sys.stderr)
        selected, app_plan, browser_plan = set(SUITES), None, None
    if args.app_plan and app_plan is None:
        app_plan = app_test_plan.full_plan("Every suite runs: no diff, or one that could not be classified.")
    if args.app_plan == "json":
        print(json.dumps(app_plan, indent=2))
        return
    if args.app_plan == "text":
        print(app_test_plan.describe(app_plan))
        return
    for suite in sorted(SUITES):
        print(f"{suite}={str(suite in selected).lower()}")
    if args.browser_plan:
        browser_plan = browser_plan or web_browser_plan.full("No diff, or one that could not be classified.")
        print(web_browser_plan.describe(browser_plan), file=sys.stderr)
        print(f"web_browser={browser_plan['mode']}")
        print(f"web_browser_specs={json.dumps(browser_plan['specs'], separators=(',', ':'))}")
    if args.app_plan:
        print(app_test_plan.describe(app_plan), file=sys.stderr)
        for target, name in ((app_test_plan.PACKAGE, "app_package"), (app_test_plan.HOSTED, "app_hosted")):
            print(f"{name}={app_plan['lanes'][target]['mode']}")
        print(f"app_plan={json.dumps(app_plan, separators=(',', ':'))}")


if __name__ == "__main__":
    main()
