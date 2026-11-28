#!/usr/bin/env python3
"""Exercise routing with synthetic paths and disposable Git history."""

from collections import Counter
from contextlib import redirect_stdout
import importlib.util
from copy import deepcopy
import io
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).with_name("changed-components.py")
spec = importlib.util.spec_from_file_location("routing", SCRIPT)
routing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(routing)
spec = importlib.util.spec_from_file_location("web_browser_plan", SCRIPT.with_name("web_browser_plan.py"))
browser = importlib.util.module_from_spec(spec)
spec.loader.exec_module(browser)
# By name, as routing imports it: a module loaded from a spec outside sys.modules breaks its dataclasses on Python 3.14.
sys.path.insert(0, str(SCRIPT.parent))
import app_test_plan as app_plan  # noqa: E402
MAX_SPECS = browser.MAX_SPECS
ALL = {"app", "app_tooling", "web_server", "web_frontend", "web_sidecar", "web_agent_image", "docker", "relay",
       "contracts", "tooling"}
CONSUMERS = {"app", "web_server", "web_frontend", "web_sidecar", "relay", "contracts"}
FIXTURE_SUITES = {"web_server", "web_frontend", "contracts"}


class RoutingTests(unittest.TestCase):
    def test_path_classes(self):
        cases = [
            (["changelog.d/TAL-123.json"], set()),
            # A documentation image selects nothing; a shipped icon reaches every Web build.
            (["web/docs/pr-media/tal-346/after-desktop.png"], set()),
            (["web/icon.png"], {"web_server", "web_frontend", "web_sidecar", "docker", "contracts"}),
            # The live-fixture test runs only in the contracts step, so editing it must select contracts.
            (["app/TalariaTests/APIClientSessionListTests.swift"], {"app", "contracts"}),
            (["app/TalariaKit/Tests/TalariaKitTests/APIClientSessionListTests.swift"], {"app", "contracts"}),
            # TalariaKit's networking, models and resolved dependencies feed the live contract test (TAL-399).
            (["app/TalariaKit/Sources/TalariaKit/Networking/SSEClient.swift"], {"app", "contracts"}),
            (["app/TalariaKit/Package.swift", "app/TalariaKit/Package.resolved"], {"app", "contracts"}),
            (["app/TalariaKit/Sources/TalariaKit/Persistence/CacheStore.swift"], {"app"}),
            (["app/TalariaKit/Tests/TalariaKitTests/ChatDraftStoreTests.swift"], {"app"}),
            # The Docker plugin action sets up Compose/Buildx for the smoke, so it runs the smoke too.
            ([".github/actions/docker-plugins/action.yml"], {"docker", "tooling"}),
            # Every script is mapped; an unmapped one would select the full suite.
            (["scripts/check-release-contracts.py"], {"contracts", "tooling"}),
            (["scripts/check"], {"tooling"}),
            (["scripts/check-ui-rules.mjs"], {"app_tooling", "web_frontend", "tooling"}),
            (["app/ci/ui-rules.json"], {"app_tooling", "web_frontend", "tooling"}),
            (["app/ci/ui-rules-baseline.json"], {"app_tooling", "tooling"}),
            (["web/packages/frontend/scripts/ui-rules.json"], {"web_frontend"}),
            ([".githooks/pre-push", "scripts/install-git-hooks", "scripts/test-pre-push-hook.py"], {"tooling"}),
            # The phone test server and its test run in the tooling job (TAL-2621).
            (["scripts/phone-test-server", "scripts/test-phone-test-server.py"], {"tooling"}),
            # Its scenarios too (TAL-2622).
            (["scripts/phone-test-scenarios/example.json"], {"tooling"}),
            ([".github/workflows/relay-bridge-image.yml"], {"relay", "tooling"}),
            (["scripts/generate-brand-icons.py"], {"web_frontend", "tooling"}),
            (["app/changelog.d/TAL-123.json"], set()),
            (["README.md", "docs/guide.md", "app/DEVELOPMENT.md", "web/docs/guide.md", "relay/README.md"], set()),
            (["web/packages/frontend/src/main.tsx", "web/static/dist/app.js", "changelog.d/TAL-123.json"], {"web_frontend"}),
            (["web/packages/contracts/src/routes/settings.ts"], {"web_server", "web_frontend", "contracts"}),
            (["web/packages/contracts/src/router.ts"], {"web_server", "web_frontend", "web_sidecar", "contracts"}),
            (["web/packages/contracts/src/x.ts"], {"web_server", "web_frontend", "web_sidecar", "contracts"}),
            (["web/packages/contracts/src/openapi.test.ts"], {"web_server"}),
            (["web/packages/contracts/src/sidecar/fixtures.test.ts"], {"web_server"}),
            (["web/packages/server/src/index.ts", "web/sidecar/talaria_sidecar/__main__.py"],
             {"web_server", "web_frontend", "web_sidecar", "contracts"}),
            # Server-only changes skip the sidecar matrix (TAL-1161); only the server files the suite loads select it.
            (["web/packages/server/src/sessions/service.ts"], {"web_server", "web_frontend", "contracts"}),
            (["web/packages/server/src/sidecar/client.ts"], {"web_server", "web_frontend", "web_sidecar", "contracts"}),
            (["web/packages/server/src/runtime.ts"], {"web_server", "web_frontend", "web_sidecar", "contracts"}),
            (["web/packages/server/src/app.ts"], {"web_server", "web_frontend", "web_sidecar", "contracts"}),
            (["web/packages/server/src/tools/updates.ts"], {"web_server", "web_frontend", "web_sidecar", "contracts"}),
            (["web/packages/server/src/test/fixtures/local-reset.json"],
             {"web_server", "web_frontend", "web_sidecar", "contracts"}),
            # Only the server's unit tests read most server fixtures; the Playwright suite reads the ones it names.
            (["web/packages/server/src/test/fixtures/gateway-owner-events.json"], {"web_server"}),
            (["web/packages/server/src/test/fixtures/compaction-carrier.json"], {"web_server", "web_frontend"}),
            # The test harness is test support: the contracts probe runs a binary that never imports it (TAL-2601).
            (["web/packages/server/src/test/harness.ts"], {"web_server", "web_frontend"}),
            (["web/packages/server/package.json"], {"web_server", "web_frontend", "web_sidecar", "docker", "contracts"}),
            (["web/packages/server/tsconfig.build.json"], {"web_server", "web_frontend", "web_sidecar", "docker", "contracts"}),
            (["web/sidecar/talaria_sidecar/x.py"], {"web_server", "web_frontend", "web_sidecar", "contracts"}),
            (["web/sidecar/tests/test_x.py"], {"web_sidecar"}),
            # Server tests read the sidecar fixtures, and the server job checks schemas.json against the contracts.
            (["web/sidecar/tests/fixtures/schemas.json"], {"web_server", "web_sidecar"}),
            (["web/sidecar/tests/fixtures/usage_account_available.json"], {"web_server", "web_sidecar"}),
            # Only sidecar tests run the peer scripts beside those fixtures.
            (["web/sidecar/tests/fixtures/gateway_session_peer.py"], {"web_sidecar"}),
            (["web/packages/frontend/package.json"], {"web_frontend"}),
            (["web/.oxlintrc.json"], {"web_server", "web_frontend"}),
            (["web/static/brand/favicon.ico"], {"web_frontend", "web_server"}),
            (["web/sidecar/scripts/suite_runner.py", "web/sidecar/scripts/test.sh"], {"web_sidecar", "tooling"}),
            (["web/sidecar/tests/test_runtime.py", "web/sidecar/scripts/replay_sidecar.py"],
             {"web_server", "web_frontend", "web_sidecar", "contracts"}),
            (["web/sidecar/agent_dependency.json"], {"web_server", "web_sidecar", "contracts", "docker", "web_agent_image"}),
            (["web/sidecar/talaria_sidecar/rpc.py"], {"web_server", "web_frontend", "web_sidecar", "contracts"}),
            (["web/packages/server/src/api/auth.ts"], {"web_server", "web_frontend", "contracts"}),
            # Server unit tests are excluded from the built server the frontend and contracts jobs drive.
            (["web/packages/server/src/port/auth.port.test.ts"], {"web_server"}),
            (["web/packages/server/src/sessions/workers.test.ts", "changelog.d/TAL-975.json"], {"web_server"}),
            # A server unit test under src/sidecar/ is still only a server test (TAL-2453).
            (["web/packages/server/src/sidecar/client.test.ts"], {"web_server"}),
            (["web/package-lock.json"], {"web_server", "web_frontend", "web_sidecar", "docker", "contracts"}),
            # The image compiles the contracts and server workspaces for both release platforms (TAL-2345).
            (["web/packages/contracts/package.json"], {"web_server", "web_frontend", "web_sidecar", "docker", "contracts"}),
            (["web/packages/contracts/tsconfig.build.json"], {"web_server", "web_frontend", "web_sidecar", "docker", "contracts"}),
            (["web/skills/runtime/SKILL.md"], {"web_server", "web_frontend", "web_sidecar", "docker", "contracts"}),
            (["web/packages/frontend/src/guide.md"], {"web_frontend"}),
            (["web/docker-compose.yml", "web/scripts/lib/health_probe.sh"], {"docker", "web_server"}),
            # The tooling job checks the release images' digest pins (TAL-2215).
            (["web/Dockerfile"], {"docker", "web_server", "tooling"}),
            (["web/docker_init.bash"], {"docker", "web_server", "tooling"}),
            (["relay/bridge/Dockerfile"], {"relay", "tooling"}),
            (["web/.env.example"], {"web_server"}),
            (["app/Talaria/Features/Chat/ChatView.swift"], {"app", "app_tooling"}),
            (["app/Talaria/Resources/Guide.md"], {"app"}),
            (["app/Talaria/Resources/Localizable.xcstrings"], {"app", "app_tooling"}),
            (["app/Talaria/Resources/Nested/InfoPlist.xcstrings"], {"app", "app_tooling"}),
            (["app/Talaria/Networking/APIClient.swift"], {"app", "contracts"}),
            # The Web server's provider icon test reads the App's icon registry and SVGs (TAL-1858).
            (["app/Talaria/Models/ProviderIconRegistry.swift"], {"app", "contracts", "web_server"}),
            (["app/Talaria/Resources/ProviderIcons.xcassets/ProviderIconOpenAI.imageset/icon.svg"], {"app", "web_server"}),
            (["app/ci/release_notes.py"], {"app_tooling", "tooling"}),
            (["app/ci/check-string-catalogs"], {"app_tooling", "tooling"}),
            (["app/ci/check_string_catalogs_test.py"], {"app_tooling", "tooling"}),
            (["app/scripts/test-ios"], {"app_tooling", "tooling"}),
            (["app/scripts/prepare-ui-simulator", "app/scripts/ready-simulator-documents",
              "app/scripts/ready-simulator-notifications", "app/scripts/seed-simulator-photo"], {"app", "tooling"}),
            (["app/scripts/test-prepare-ui-simulator"], {"app_tooling", "tooling"}),
            (["app/scripts/validate-upstream-contract"], {"contracts", "tooling"}),
            (["relay/convex/cleanup.ts", "relay/tests/crypto.test.ts"], {"relay"}),
            (["relay/convex/http.ts"], {"relay"}),
            (["relay/convex/completions.ts"], {"relay"}),
            (["relay/convex/subscriptions.ts"], {"relay"}),
            (["relay/convex/new-response.ts"], {"relay"}),
            (["relay/package.json", "relay/pnpm-lock.yaml"], {"relay"}),
            (["relay/convex/releaseInfo.json"], CONSUMERS),
            (["contracts/versions.json"], CONSUMERS),
            # Only Web's drift check reads the OpenAPI document (TAL-1674).
            (["contracts/web-api.openapi.json"], {"web_server", "contracts"}),
            (["contracts/fixtures/web-session.json"], FIXTURE_SUITES | {"app"}),
            (["contracts/fixtures/delegation-status.json"], FIXTURE_SUITES | {"app"}),
            (["contracts/fixtures/delivered-html-media.json"], FIXTURE_SUITES | {"app"}),
            (["contracts/fixtures/mcp-events.json"], FIXTURE_SUITES | {"web_sidecar"}),
            (["contracts/fixtures/plan-allowance.json"], FIXTURE_SUITES | {"web_sidecar"}),
            (["contracts/fixtures/vault-prompts.json"], FIXTURE_SUITES | {"app"}),
            (["contracts/fixtures/feedback-report.json"], FIXTURE_SUITES | {"relay"}),
            (["contracts/fixtures/feedback-report-agent.json"], FIXTURE_SUITES | {"relay"}),
            (["contracts/fixtures/notification-alerts.json"], {"web_server", "relay"}),
            (["contracts/fixtures/relay-pairing.json"], {"relay"}),
            (["contracts/fixtures/relay-waiting-badge-push.json"], {"relay"}),
            (["contracts/fixtures/relay-waiting-badge-snapshot.json"], {"relay", "contracts"}),
            (["contracts/fixtures/relay-approval-alert.json"], {"relay", "web_server", "contracts"}),
            # Relay never reads the What's New schema (TAL-2174).
            (["contracts/whats-new.schema.json"], CONSUMERS - {"relay"} | {"tooling"}),
            # Relay and the App's hosted tests never read the What's New fixture (TAL-1981).
            (["contracts/fixtures/whats-new.json"], FIXTURE_SUITES | {"tooling"}),
            (["web/contract_versions.json"], CONSUMERS),
            (["web/packages/frontend/src/main.tsx", "relay/tests/crypto.test.ts"], {"web_frontend", "relay"}),
            (["scripts/check-web-server"], {"web_server", "tooling"}),
            (["scripts/check-web-browser"], {"web_frontend", "tooling"}),
            # The browser plan and the Playwright job's steps change what the e2e jobs run (TAL-2391).
            (["scripts/web_browser_plan.py"], {"web_frontend", "tooling"}),
            ([".github/actions/web-browser/action.yml"], {"web_frontend", "tooling"}),
            (["scripts/check-docker.py"], {"docker", "tooling"}),
            (["scripts/stamp-release.py", "scripts/test-stamp-release.py"], {"tooling"}),
            (["scripts/check-agent-compatibility.py"], {"web_server", "web_sidecar", "docker", "tooling", "web_agent_image"}),
            (["releases/agent_probe.py"], {"web_server", "web_sidecar", "docker", "tooling"}),
            (["scripts/check-release-agent.py"], {"web_sidecar", "tooling"}),
            (["scripts/test-check-agent-compatibility.py"], {"tooling"}),
            # The support record selects the sidecar suite on every supported Agent release.
            (["web/sidecar/agent_support.json"], {"web_server", "web_frontend", "web_sidecar", "contracts", "web_agent_image"}),
            (["releases/publish.py"], {"tooling"}),
            (["releases/cli.py"], {"contracts", "tooling"}),
            ([".github/workflows/release-set.yml"], {"tooling"}),
            ([".github/workflows/nightly.yml", "releases/README.md", "changelog.d/TAL-1615.json"], {"tooling"}),
            ([".github/workflows/unknown.yml"], ALL),
            ([".github/workflows/web-experimental.yml"], {"tooling"}),
            ([".agy/config.json", ".codex/environments/environment.toml",
              ".xcodebuildmcp/config.yaml", ".gitleaksignore"], {"tooling"}),
            ([".github/workflows/web-verify.yml"], {"web_server", "web_frontend", "web_sidecar", "tooling"}),
            ([".github/workflows/relay-verify.yml"], {"relay", "tooling"}),
            ([".github/workflows/ci.yml"], {"app", "app_tooling", "web_sidecar", "contracts", "tooling"}),
            ([".github/workflows/app-tests.yml"], {"app", "contracts", "tooling"}),
            ([".github/actions/setup-xcode/action.yml"], {"app", "tooling"}),
            ([".github/actions/setup-bash/action.yml"], {"app", "app_tooling", "tooling"}),
            ([".github/actions/app-package-tests/action.yml"], {"app", "contracts", "tooling"}),
            (["app/ci/build-for-testing", "app/ci/check-swift-warnings", "app/ci/wait-for-job", "app/ci/gh-api-poll"], {"app", "tooling"}),
            (["app/ci/package-coverage"], {"app", "tooling"}),
            (["app/ci/wait_for_job_test.sh"], {"tooling"}),
            (["scripts/check-hosted-runners.py", "scripts/test-check-hosted-runners.py"], {"tooling"}),
            (["scripts/check-ephemeral-defaults.py", "scripts/test-check-ephemeral-defaults.py"], {"tooling"}),
            (["scripts/changed-components.py"], {"tooling"}),
            (["scripts/new-unknown-tool.py"], ALL),
            (["new-component/runtime.rs"], ALL),
            (["changelog.d/README.md", "changelog.d/malformed.json"], set()),
            ([], ALL),
            (["../web/packages/frontend/main.tsx"], ALL),
            ([None], ALL),
            (["web/packages/frontend/file\napp=false\n.tsx"], {"web_frontend"}),
        ]
        for paths, expected in cases:
            with self.subTest(paths=paths):
                self.assertEqual(routing.affected(paths), expected)

    def test_fixture_readers_are_routed(self):
        root = SCRIPT.resolve().parent.parent
        tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode().split("\0")
        # The App's hosted tests compile every App-project Swift file outside the package, plus the TalariaKit test
        # files the Xcode project lists by path; the package's own tests run in the contracts job.
        project = (root / "app/Talaria.xcodeproj/project.pbxproj").read_text()
        readers = {
            "web_sidecar": [path for path in tracked if path.startswith("web/sidecar/") and path.endswith(".py")],
            "app": [path for path in tracked if path.startswith("app/") and not path.startswith("app/TalariaKit/")
                    and path.endswith(".swift")]
                   + ["app/" + path for path in re.findall(r'path = "?\.\./(TalariaKit/[^";]+\.swift)', project)],
            "relay": [path for path in tracked if path.startswith("relay/") and path.endswith(".ts")],
        }
        for suite, paths in readers.items():
            read = set()
            for path in paths:
                text = (root / path).read_text()
                read |= set(re.findall(r"contracts/fixtures/([\w.-]+\.json)", text))
                read |= set(re.findall(r"['\"]contracts['\"]\s*/\s*['\"]fixtures['\"]\s*/\s*['\"]([\w.-]+\.json)['\"]", text))
                read |= {f"{name}.json" for name in re.findall(r"\b(?:sharedContractF|f)ixture\(\"([\w.-]+)\"\)", text)}
            with self.subTest(suite=suite):
                self.assertEqual(read, routing.FIXTURE_READERS[suite])

    def test_server_fixture_readers_are_routed(self):
        root = SCRIPT.resolve().parent.parent
        e2e = subprocess.check_output(["git", "ls-files", "-z", "web/packages/frontend/e2e"], cwd=root).decode().split("\0")
        read = {name for path in e2e if path for name in re.findall(r"server/src/test/fixtures/([\w.-]+\.json)", (root / path).read_text())}
        self.assertEqual(read, routing.E2E_SERVER_FIXTURES)

    def test_server_binaries_skip_test_support(self):
        src = SCRIPT.resolve().parent.parent / "web/packages/server/src"
        seen, queue = set(), sorted((src / "bin").glob("talaria-web*.ts"))
        queue = [path for path in queue if not path.name.endswith(".test.ts")]
        while queue:
            path = queue.pop()
            if path in seen:
                continue
            seen.add(path)
            for spec in re.findall(r"""\b(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]""", path.read_text()):
                target = (path.parent / spec).resolve()
                queue += [c for c in (target.with_suffix(".ts"), target.with_suffix(".tsx"), target / "index.ts") if c.is_file()][:1]
        self.assertIn(src / "runtime.ts", seen)
        self.assertEqual({str(path.relative_to(src)) for path in seen if path.is_relative_to(src / "test")}, set())

    def test_tracked_paths_have_explicit_routes(self):
        root = SCRIPT.resolve().parent.parent
        paths = subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode().split("\0")
        full_suite = set()
        for path in filter(None, paths):
            selected = routing.path_suites(path)
            self.assertLessEqual(selected, ALL, path)
            if selected == ALL:
                full_suite.add(path)
        # These checkout controls affect every component. New unknown paths must be reviewed and classified.
        self.assertEqual(full_suite, {".gitattributes", ".gitignore"})

    def test_experimental_publishes_every_web_artifact_input(self):
        """TAL-1986: release fragments and the What's New stamp change the packed artifact without selecting a web_*
        suite, so Experimental publishes for them while a changelog-only PR still skips the Web tests."""
        with tempfile.TemporaryDirectory(prefix="talaria-web-artifact-") as temporary:
            root = Path(temporary)
            env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}

            def git(*args):
                return subprocess.check_output(["git", "-c", "user.name=Synthetic", "-c", "user.email=test@example.invalid",
                    "-c", "commit.gpgsign=false", *args], cwd=root, env=env, text=True, stderr=subprocess.PIPE).strip()

            def commit(files):
                for name, text in files.items():
                    (root / name).parent.mkdir(parents=True, exist_ok=True)
                    if text is None:
                        git("rm", "-q", name)
                    else:
                        (root / name).write_text(text)
                git("add", ".")
                git("commit", "--allow-empty", "-m", "synthetic")
                return git("rev-parse", "HEAD")

            def publishes(base, head):
                result = subprocess.run([os.sys.executable, str(SCRIPT), "--web-artifact", f"--base={base}", f"--head={head}"],
                                        cwd=root, env=env, text=True, capture_output=True)
                self.assertIn(result.stdout, ("web_artifact=true\n", "web_artifact=false\n"), result.stderr)
                return result.stdout == "web_artifact=true\n"

            def fragment(*components):
                return '{"entries": [{"category": "Added", "summary": "x", "highlight": false%s}]}' % (
                    f', "components": {list(components)!r}'.replace("'", '"') if components else "")

            git("init", "-q", "-b", "main")
            base = commit({"README.md": "base\n"})
            cases = [
                ({"changelog.d/TAL-1.json": fragment("web")}, True),
                ({"app/changelog.d/TAL-2.json": fragment("app", "web")}, True),
                ({"changelog.d/TAL-3.json": fragment("app", "relay")}, False),
                ({"changelog.d/TAL-4.json": fragment()}, False),  # Entries default to the App.
                ({"changelog.d/TAL-5.json": '{"skip": "CI only"}'}, False),
                ({"changelog.d/TAL-6.json": "not json"}, True),
                ({"changelog.d/TAL-1.json": None}, True),  # Removing web rows changes the artifact too.
                ({"changelog.d/TAL-2.json": fragment("web"), "app/changelog.d/TAL-2.json": None}, True),
                ({"scripts/stamp-release.py": "stamp\n"}, True),
                ({"app/ci/release_notes.py": "notes\n"}, True),
                ({"contracts/whats-new.schema.json": "{}\n"}, True),
                ({"web/packages/frontend/main.tsx": "ui\n"}, True),
                ({"relay/convex/x.ts": "relay\n", "docs/guide.md": "docs\n"}, False),
            ]
            for files, expected in cases:
                before = git("rev-parse", "HEAD")
                after = commit(files)
                with self.subTest(files=files):
                    self.assertEqual(publishes(before, after), expected)
                    paths = list(files)
                    if not any(path.startswith(("web/", "contracts/")) for path in paths):
                        self.assertFalse(routing.affected(paths) & {"web_server", "web_frontend", "web_sidecar"})
            # The range since the published revision carries an earlier Web change that a red CI run never shipped.
            self.assertTrue(publishes(base, after))
            self.assertFalse(publishes(after, after))
            self.assertTrue(publishes("", after))
            self.assertTrue(publishes("0" * 40, after))

    def test_gate_rejects_missing_or_skipped_required_checks(self):
        job_suites = {"app": {"app", "contracts"}, "app-tooling": {"app_tooling"},
                      "web": {"web_server", "web_frontend", "web_sidecar"}, "web-docker": {"docker"},
                      "web-agent-image": {"web_agent_image"},
                      "relay": {"relay"}, "contracts": {"contracts"}}
        for mask in range(1 << len(ALL)):
            selected = {suite for index, suite in enumerate(sorted(ALL)) if mask & (1 << index)}
            needs = {"changes": {"result": "success", "outputs": {key: str(key in selected).lower() for key in ALL}},
                     "tooling": {"result": "success"}}
            needs.update({job: {"result": "success" if suites & selected else "skipped"} for job, suites in job_suites.items()})
            routing.check_results(needs)
            for job in needs:
                for result in ("failure", "cancelled"):
                    broken = deepcopy(needs)
                    broken[job]["result"] = result
                    with self.subTest(selected=selected, failed_job=job, result=result), self.assertRaises(ValueError):
                        routing.check_results(broken)
            for job, suites in job_suites.items():
                if suites & selected:
                    broken = deepcopy(needs)
                    broken[job]["result"] = "skipped"
                    with self.assertRaises(ValueError):
                        routing.check_results(broken)
        # Missing classifier outputs must require the full set, never silently skip.
        needs["changes"]["outputs"] = {}
        needs["app"]["result"] = "skipped"
        with self.assertRaises(ValueError):
            routing.check_results(needs)
        del needs["app"]
        with self.assertRaises(KeyError):
            routing.check_results(needs)



PROJECT = """// !$*UTF8*$!
{
	objects = {
		GROUPROOT = {
			isa = PBXGroup;
			children = (
				GROUPTESTS /* TalariaTests */,
			);
			sourceTree = "<group>";
		};
		GROUPTESTS /* TalariaTests */ = {
			isa = PBXGroup;
			children = (
%(children)s
			);
			path = TalariaTests;
			sourceTree = "<group>";
		};
%(objects)s
		PHASE /* Sources */ = {
			isa = PBXSourcesBuildPhase;
			files = (
%(files)s
			);
		};
		TARGET /* TalariaTests */ = {
			isa = PBXNativeTarget;
			buildPhases = (
				PHASE /* Sources */,
			);
			name = TalariaTests;
		};
	};
}
"""
HOSTED_SOURCES = ["Hosted.swift", "AlphaHostedTests.swift", "BetaHostedTests.swift", "MathTests.swift", "Observer.swift",
                  "../TalariaKit/Tests/TalariaKitTests/Support/SharedFixture.swift"]
SOURCES = {
    "app/TalariaKit/Tests/TalariaKitTests/LeafTests.swift": """import XCTest

final class LeafTests: XCTestCase {
    private var value = 1

    override func setUp() {
        value = 2
    }

    func testOne() {
        XCTAssertEqual(value, 2)
    }

    func testTwo() {
        XCTAssertEqual(value + 1, 3)
    }
}
""",
    "app/TalariaKit/Tests/TalariaKitTests/BaseCase.swift": """import XCTest

class BaseCase: XCTestCase {
    override func setUp() {
        super.setUp()
    }
}

final class DerivedTests: BaseCase {
    func testDerived() {}
}
""",
    "app/TalariaKit/Tests/TalariaKitTests/Support/SharedFixture.swift": """enum SharedFixture {
    static func make() -> Int {
        1
    }

    static func unused() -> Int {
        2
    }
}
""",
    "app/TalariaKit/Tests/TalariaKitTests/UsesFixtureTests.swift": """import XCTest

final class UsesFixtureTests: XCTestCase {
    func testMakes() {
        XCTAssertEqual(SharedFixture.make(), 1)
    }

    func testIndependent() {
        let table = \"\"\"
            | a |
            \"\"\"
        XCTAssertFalse(table.isEmpty)
    }
}
""",
    "app/TalariaKit/Tests/TalariaKitTests/MathTests.swift": """import XCTest

final class MathTests: XCTestCase {
    func testFormats() {
        XCTAssertEqual(Formatter().format(), "x")
    }
}
""",
    "app/TalariaTests/Hosted.swift": """enum Hosted {
    static func titleMenu() -> Int {
        1
    }

    static func other() -> Int {
        2
    }
}

extension Hosted {
    static func viaMenu() -> Int {
        titleMenu() + 1
    }
}
""",
    "app/TalariaTests/AlphaHostedTests.swift": """import XCTest

final class AlphaHostedTests: XCTestCase {
    func testUsesMenu() {
        XCTAssertEqual(Hosted.titleMenu(), 1)
    }

    func testPlain() {
        XCTAssertEqual(Hosted.other(), 2)
    }

    func testFixture() {
        XCTAssertEqual(SharedFixture.make(), 1)
    }
}
""",
    "app/TalariaTests/BetaHostedTests.swift": """import XCTest

final class BetaHostedTests: XCTestCase {
    func testThroughHelper() {
        XCTAssertEqual(Hosted.viaMenu(), 2)
    }
}
""",
    # XCTest calls it through the bundle's principal class; no test names it.
    "app/TalariaTests/Observer.swift": """import XCTest

final class Observer: NSObject, XCTestObservation {
    func testBundleWillStart(_ testBundle: Bundle) {
        _ = 1
    }
}
""",
    "app/TalariaTests/MathTests.swift": """import XCTest

final class MathTests: XCTestCase {
    func testRenders() {
        XCTAssertEqual(Formatter().format(), "x")
    }
}
""",
    "app/TalariaKit/Sources/TalariaKit/Formatter.swift": """public struct Formatter {
    public init() {}

    public func format() -> String {
        "x"
    }
}
""",
    "app/TalariaKit/Sources/TalariaKit/Consumer.swift": """struct Consumer {
    let text = Formatter().format()
}
""",
    "app/TalariaKit/Sources/TalariaKit/Unmapped.swift": "struct Unmapped {}\n",
    "app/Talaria/View.swift": "struct View {}\n",
    "app/ci/test-ownership.json": json.dumps({"version": 1, "readers": {}, "rules": [{
        "name": "formatter", "paths": ["app/TalariaKit/Sources/TalariaKit/Formatter.swift"],
        "consumers": ["app/TalariaKit/Sources/TalariaKit/Consumer.swift"],
        "tests": ["TalariaKitTests/MathTests", "TalariaTests/MathTests"], "review": "synthetic"}]}),
    "README.md": "Synthetic.\n",
}


CONTRACT_PROOF = ["TalariaKitTests/APIClientSessionListTests/testLiveUpstreamContractResponsesDecodeWhenSupplied",
                  "TalariaKitTests/SharedContractTests"]


class RealDiffTests(unittest.TestCase):
    """Routing over real Git history in a disposable repository."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="talaria-ci-routing-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
        self.git("init", "-b", "main")

    def git(self, *args):
        return subprocess.check_output(["git", "-c", "user.name=Synthetic", "-c", "user.email=test@example.invalid",
            "-c", "commit.gpgsign=false", *args], cwd=self.root, env=self.env, text=True, stderr=subprocess.PIPE).strip()

    def write(self, path, text):
        (self.root / path).parent.mkdir(parents=True, exist_ok=True)
        (self.root / path).write_text(text)

    def commit(self, name):
        self.git("add", ".")
        self.git("commit", "-m", name)
        return self.git("rev-parse", "HEAD")

    def classify(self, base, head, *options):
        result = subprocess.run([os.sys.executable, str(SCRIPT), f"--base={base}", f"--head={head}", *options],
                                cwd=self.root, env=self.env, text=True, capture_output=True, check=True)
        flags = dict(line.split("=", 1) for line in result.stdout.splitlines())
        self.assertEqual(set(flags), ALL)
        self.assertLessEqual(set(flags.values()), {"true", "false"})
        return {key for key, value in flags.items() if value == "true"}

    def check_diff(self, *options):
        return subprocess.run([os.sys.executable, str(SCRIPT), "--check-diff", *options],
                              cwd=self.root, env=self.env, text=True, capture_output=True)

    def test_diffs_include_renames_and_the_full_push_range(self):
        self.write("web/sidecar/tests/test_synthetic.py", "print('synthetic')\n")
        base = self.commit("base")
        (self.root / "web/packages/frontend").mkdir(parents=True)
        self.git("mv", "web/sidecar/tests/test_synthetic.py", "web/packages/frontend/moved.py")
        moved = self.commit("move backend file into frontend")
        self.assertEqual(self.classify(base, moved), {"web_sidecar", "web_frontend"})
        self.write("web/packages/frontend/name\napp=false\n.tsx", "synthetic")
        head = self.commit("frontend change")
        self.assertEqual(self.classify(moved, head), {"web_frontend"})
        self.assertEqual(self.classify(base, head), {"web_sidecar", "web_frontend"})
        self.git("update-ref", "refs/remotes/origin/main", moved)
        # A parent change merged since the event's base SHA must not make
        # the child PR rerun the parent's component checks.
        self.assertEqual(self.classify("refs/remotes/origin/main", head, "--merge-base"), {"web_frontend"})
        self.git("checkout", "-b", "diverged", base)
        self.write("app/README.md", "docs")
        other = self.commit("base branch advanced")
        self.assertEqual(self.classify(other, head, "--merge-base"), {"web_sidecar", "web_frontend"})
        self.assertEqual(self.classify(head, head), ALL)
        self.assertEqual(self.classify("0" * 40, head), ALL)
        self.assertEqual(self.classify("--output=should-not-exist", head), ALL)
        self.assertFalse((self.root / "should-not-exist").exists())
        self.write("scripts/new-unknown-tool.py", "unknown shared tooling\n")
        unknown = self.commit("unknown shared tool")
        self.assertEqual(self.classify(other, unknown), ALL)

    def test_a_new_workflow_runs_everything_and_a_deleted_one_only_tooling(self):
        # A new unknown workflow can run anything, but a deleted one can no longer run.
        self.write("README.md", "base\n")
        before_workflow = self.commit("base")
        self.write(".github/workflows/retired.yml", "on: workflow_dispatch\n")
        with_workflow = self.commit("add a workflow")
        self.assertEqual(self.classify(before_workflow, with_workflow), ALL)
        self.git("rm", ".github/workflows/retired.yml")
        without_workflow = self.commit("delete the workflow")
        self.assertEqual(self.classify(with_workflow, without_workflow), {"tooling"})

    def test_a_ci_workflow_change_selects_the_suites_of_the_jobs_it_changes(self):
        # A ci.yml change runs the suites of the jobs and keys it changes (TAL-2461). Column-0 comments, concurrency and
        # the jobs every pull request run executes in full (path detection, the gate and the failure report)
        # need only the tooling checks, as does a removed job, which only stops running. Path detection's outputs feed
        # every job, so unmapped outputs keep the whole ci.yml route, as do triggers, permissions and unknown jobs.
        original = ("# Header.\nname: CI\non: push\nconcurrency:\n  group: ci\njobs:\n  changes:\n    runs-on: ubuntu-latest\n"
                    "    outputs:\n      app: x\n    steps:\n      - run: classify\n"
                    "  app-tooling:\n    runs-on: macos-latest\n    steps:\n      - run: old-check\n"
                    "  app:\n    uses: ./.github/workflows/app-tests.yml\n"
                    "  report:\n    if: always()\n    steps:\n      - run: watch\n")
        ci = routing.WORKFLOWS["ci.yml"]
        cases = [
            ("a header comment", ("# Header.", "# Another header."), {"tooling"}),
            ("concurrency", ("group: ci", "group: ci-main"), {"tooling"}),
            ("path detection's steps", ("run: classify", "run: classify --since"), {"tooling"}),
            ("the failure report", ("if: always()", "if: '!cancelled()'"), {"tooling"}),
            ("the App tooling job", ("old-check", "catalog-check"), {"app_tooling", "tooling"}),
            ("the App job", ("app-tests.yml", "app-tests.yml\n    with: {mode: build}"), {"app", "contracts", "tooling"}),
            ("path detection's outputs", ("app: x", "app: y"), ci),
            ("the Agent image outputs", ("      app: x", "      app: x\n      web_agent_image: y\n"
                                          "      web_agent_image_base: z"), {"web_agent_image", "tooling"}),
            ("the Agent image call", ("  report:", "  web-agent-image:\n    uses: ./.github/workflows/web-verify.yml\n"
                                      "  report:"), {"web_agent_image", "tooling"}),
            ("the trigger", ("on: push", "on: pull_request"), ci),
            ("a job's name", ("  app-tooling:", "  renamed-tooling:"), ci),
            ("an added job", ("  report:", "  extra:\n    runs-on: ubuntu-latest\n  report:"), ci),
            ("a removed job", ("  report:\n    if: always()\n    steps:\n      - run: watch\n", ""), {"tooling"}),
            ("permissions", ("jobs:", "permissions:\n  contents: write\njobs:"), ci),
        ]
        workflow = ".github/workflows/ci.yml"
        self.write(workflow, original)
        base = self.commit("fixture CI workflow")
        for name, (old, new), expected in cases:
            with self.subTest(name):
                self.write(workflow, original.replace(old, new, 1))
                self.assertEqual(self.classify(base, self.commit(name)), expected)

    def test_a_web_workflow_part_change_selects_only_its_suite_and_tooling(self):
        workflow = ".github/workflows/web-verify.yml"
        original = ("on:\n  workflow_call:\n    inputs:\n      server:\n        type: boolean\n"
                    "jobs:\n  server:\n    runs-on: ubuntu-latest\n"
                    "  sidecar:\n    runs-on: ubuntu-latest\n    env:\n      TALARIA_SIDECAR_WORKERS: '4'\n")
        self.write(workflow, original)
        base = self.commit("fixture Web workflow")
        cases = [
            ("cap sidecar workers", original.replace("'4'", "'2'"), "web_sidecar"),
            ("add image check", original.replace("jobs:", "      agent_image_base:\n        type: string\njobs:") +
             "  agent-image:\n    runs-on: ubuntu-latest\n", "web_agent_image"),
        ]
        for name, contents, suite in cases:
            with self.subTest(name=name):
                self.write(workflow, contents)
                self.assertEqual(self.classify(base, self.commit(name)), {suite, "tooling"})

    def test_check_diff_rejects_whitespace_errors_in_the_checked_range(self):
        self.write("README.md", "base\n")
        base = self.commit("base")
        self.write("app/README.md", "docs")
        other = self.commit("clean change")
        self.assertEqual(self.check_diff("--base", base, "--head", other).returncode, 0)
        self.assertEqual(self.check_diff().returncode, 0)
        self.write("app/README.md", "docs with trailing spaces  \n")
        bad = self.commit("committed whitespace error")
        self.assertNotEqual(self.check_diff().returncode, 0)
        self.write("README.md", "unrelated clean change\n")
        final = self.commit("later clean commit")
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertEqual(self.check_diff("--base", bad, "--head", final).returncode, 0)
        result = self.check_diff("--base", other, "--head", final)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("trailing whitespace", result.stdout)
        self.assertNotEqual(self.check_diff("--base", "missing-ref").returncode, 0)


class AppPlanTests(unittest.TestCase):
    """The App test plan on a synthetic App with both test targets, a shared helper compiled into both, a base test
    class, a hosted support enum and a reviewed production rule (TAL-2390)."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="talaria-app-plan-")
        self.root = Path(self.directory.name)
        self.env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
        files = {f"app/Talaria.xcodeproj/project.pbxproj": self.project(HOSTED_SOURCES), **SOURCES}
        for path, text in files.items():
            self.write(path, text)
        self.git("init", "-b", "main")
        self.base = self.commit("base")

    def tearDown(self):
        self.directory.cleanup()

    @staticmethod
    def project(sources):
        children, objects, files = [], [], []
        for index, source in enumerate(sources):
            name = source.rsplit("/", 1)[-1]
            children.append(f"\t\t\t\tFILE{index} /* {name} */,")
            files.append(f"\t\t\t\tBUILD{index} /* {name} in Sources */,")
            objects.append(f'\t\tFILE{index} /* {name} */ = {{isa = PBXFileReference; path = "{source}"; sourceTree = "<group>"; }};')
            objects.append(f"\t\tBUILD{index} /* {name} in Sources */ = {{isa = PBXBuildFile; fileRef = FILE{index} /* {name} */; }};")
        return PROJECT % {"children": "\n".join(children), "objects": "\n".join(objects), "files": "\n".join(files)}

    def write(self, path, text):
        (self.root / path).parent.mkdir(parents=True, exist_ok=True)
        (self.root / path).write_text(text)

    def edit(self, path, old, new):
        text = (self.root / path).read_text()
        self.assertIn(old, text)
        self.write(path, text.replace(old, new, 1))

    def git(self, *args):
        return subprocess.check_output(["git", "-c", "user.name=Synthetic", "-c", "user.email=test@example.invalid",
                                        "-c", "commit.gpgsign=false", *args], cwd=self.root, env=self.env, text=True).strip()

    def commit(self, name):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", name)
        return self.git("rev-parse", "HEAD")

    def plan(self, *options):
        result = subprocess.run([os.sys.executable, str(SCRIPT), *options, "--app-plan", "json"], cwd=self.root,
                                env=self.env, text=True, capture_output=True, check=True)
        return json.loads(result.stdout)

    def committed(self):
        return self.plan(f"--base={self.base}", f"--head={self.commit('change')}", "--merge-base")

    def lanes(self, plan):
        return {target: (lane["mode"], lane["identifiers"]) for target, lane in plan["lanes"].items()}

    def test_changes_select_the_tests_that_reach_them(self):
        empty = ("empty", [])
        cases = [
            ("a leaf test method runs alone",
             [("app/TalariaKit/Tests/TalariaKitTests/LeafTests.swift", "XCTAssertEqual(value, 2)", "XCTAssertEqual(value, 2, \"two\")")],
             {"TalariaKitTests": ("explicit", ["TalariaKitTests/LeafTests/testOne"]), "TalariaTests": empty}),
            ("a test class's setup runs the whole class",
             [("app/TalariaKit/Tests/TalariaKitTests/LeafTests.swift", "value = 2", "value = 1 + 1")],
             {"TalariaKitTests": ("explicit", ["TalariaKitTests/LeafTests"]), "TalariaTests": empty}),
            ("a base class's setup runs its subclasses, not the testless base",
             [("app/TalariaKit/Tests/TalariaKitTests/BaseCase.swift", "super.setUp()", "super.setUp(); _ = 1")],
             {"TalariaKitTests": ("explicit", ["TalariaKitTests/DerivedTests"]), "TalariaTests": empty}),
            # The router counts the package's Support files as contract inputs, so the live contract proof runs too.
            ("a package helper compiled into the hosted target reaches both targets' callers",
             [("app/TalariaKit/Tests/TalariaKitTests/Support/SharedFixture.swift", "        1\n", "        0 + 1\n")],
             {"TalariaKitTests": ("explicit", [*CONTRACT_PROOF, "TalariaKitTests/UsesFixtureTests/testMakes"]),
              "TalariaTests": ("explicit", ["TalariaTests/AlphaHostedTests/testFixture"])}),
            ("a hosted helper reaches direct and transitive callers only",
             [("app/TalariaTests/Hosted.swift", "        1\n", "        0 + 1\n")],
             {"TalariaKitTests": empty, "TalariaTests": ("explicit", ["TalariaTests/AlphaHostedTests/testUsesMenu",
                                                                      "TalariaTests/BetaHostedTests/testThroughHelper"])}),
            ("a reviewed production rule runs its tests in both targets, qualified by target",
             [("app/TalariaKit/Sources/TalariaKit/Formatter.swift", '"x"', '"x" + ""')],
             {"TalariaKitTests": ("explicit", ["TalariaKitTests/MathTests"]), "TalariaTests": ("explicit", ["TalariaTests/MathTests"])}),
            ("an unmapped TalariaKit source runs both targets",
             [("app/TalariaKit/Sources/TalariaKit/Unmapped.swift", "{}", "{ let x = 1 }")],
             {"TalariaKitTests": ("full", ["TalariaKitTests"]), "TalariaTests": ("full", ["TalariaTests"])}),
            ("an App source runs only the hosted target",
             [("app/Talaria/View.swift", "{}", "{ let x = 1 }")],
             {"TalariaKitTests": empty, "TalariaTests": ("full", ["TalariaTests"])}),
            ("whitespace inside a string literal is a change",
             [("app/TalariaKit/Tests/TalariaKitTests/UsesFixtureTests.swift", "            | a |\n", "                | a |\n")],
             {"TalariaKitTests": ("explicit", ["TalariaKitTests/UsesFixtureTests/testIndependent"]), "TalariaTests": empty}),
            ("support XCTest invokes for every test runs its target in full",
             [("app/TalariaTests/Observer.swift", "_ = 1", "_ = 2")],
             {"TalariaKitTests": empty, "TalariaTests": ("full", ["TalariaTests"])}),
            ("comments change nothing", [("app/TalariaTests/Hosted.swift", "        1\n", "        1 // one\n")],
             {"TalariaKitTests": empty, "TalariaTests": empty}),
            ("documentation selects no App test", [("README.md", "Synthetic.", "Synthetic docs.")],
             {"TalariaKitTests": empty, "TalariaTests": empty}),
            ("a mixed diff runs the union",
             [("app/TalariaKit/Tests/TalariaKitTests/LeafTests.swift", "XCTAssertEqual(value + 1, 3)", "XCTAssertEqual(value + 1, 3, \"three\")"),
              ("app/TalariaTests/Hosted.swift", "        2\n", "        0 + 2\n")],
             {"TalariaKitTests": ("explicit", ["TalariaKitTests/LeafTests/testTwo"]),
              "TalariaTests": ("explicit", ["TalariaTests/AlphaHostedTests/testPlain"])}),
        ]
        for name, edits, expected in cases:
            with self.subTest(name):
                self.git("reset", "-q", "--hard", self.base)
                for path, old, new in edits:
                    self.edit(path, old, new)
                self.assertEqual(self.lanes(self.committed()), expected)

    def test_a_private_declaration_reaches_tests_only_through_its_own_file(self):
        # Swift lets only its own file name a private declaration: a member named like a shared helper's selects only
        # the tests that reach it in that file, or through a declaration the file exposes (TAL-2610).
        gamma, delta = "app/TalariaTests/GammaHostedTests.swift", "app/TalariaTests/DeltaHostedTests.swift"
        self.write(gamma, """import XCTest

final class GammaHostedTests: XCTestCase {
    func testProbe() {
        XCTAssertEqual(Probe().titleMenu(), 3)
    }

    func testPlain() {
        XCTAssertEqual(Shared.value(), 4)
    }
}

private struct Probe {
    func titleMenu() -> Int {
        3
    }
}

enum Shared {
    static func value() -> Int {
        inner()
    }

    private static func inner() -> Int {
        4
    }
}
""")
        self.write(delta, """import XCTest

final class DeltaHostedTests: XCTestCase {
    func testValue() {
        XCTAssertEqual(Shared.value(), 4)
    }
}
""")
        self.write("app/Talaria.xcodeproj/project.pbxproj",
                   self.project([*HOSTED_SOURCES, "GammaHostedTests.swift", "DeltaHostedTests.swift"]))
        self.base = self.commit("private helpers")
        cases = [
            ("a private type's member reaches its file's callers only", "        3\n", "        1 + 2\n",
             ["TalariaTests/GammaHostedTests/testProbe"]),
            ("a private member reaches other files through what its file exposes", "        4\n", "        2 + 2\n",
             ["TalariaTests/DeltaHostedTests/testValue", "TalariaTests/GammaHostedTests/testPlain"]),
        ]
        for name, old, new, expected in cases:
            with self.subTest(name):
                self.git("reset", "-q", "--hard", self.base)
                self.edit(gamma, old, new)
                self.assertEqual(self.lanes(self.committed()),
                                 {"TalariaKitTests": ("empty", []), "TalariaTests": ("explicit", expected)})

    def test_a_many_line_change_scans_each_name_set_once(self):
        # Every changed line inside one helper seeds the same names, so the reach fixpoint runs once for them (TAL-2473).
        self.edit("app/TalariaTests/Hosted.swift", "        1\n", "        0 +\n            0 +\n            0 +\n            1\n")
        head = self.commit("change")
        options = [f"--base={self.base}", f"--head={head}", "--merge-base", "--app-plan", "json"]
        expected = self.plan(*options[:-2])
        sys.path.insert(0, str(SCRIPT.parent))
        self.addCleanup(sys.path.remove, str(SCRIPT.parent))
        import app_test_plan
        scans, reach = [], app_test_plan.Universe.reach

        def counted(universe, names):
            scans.append((universe.target, frozenset(names)))
            return reach(universe, names)

        output, directory = io.StringIO(), os.getcwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, directory)
        with mock.patch.object(app_test_plan.Universe, "reach", counted), mock.patch.object(sys, "argv", [str(SCRIPT), *options]), \
                mock.patch.dict(os.environ, self.env), redirect_stdout(output):
            routing.main()
        self.assertEqual(json.loads(output.getvalue()), expected)
        self.assertIn(("TalariaTests", frozenset({"titleMenu"})), scans)
        self.assertEqual([scan for scan, count in Counter(scans).items() if count > 1], [])

    def test_added_and_changed_test_methods_are_listed_to_repeat(self):
        # Only a method whose own lines changed repeats (TAL-2402); setup and helpers widen the selection, not the repeats.
        leaf = "app/TalariaKit/Tests/TalariaKitTests/LeafTests.swift"
        alpha = "app/TalariaTests/AlphaHostedTests.swift"
        cases = [
            ("an edited method", [(leaf, "XCTAssertEqual(value, 2)", "XCTAssertEqual(value, 2, \"two\")")],
             {"TalariaKitTests": ["TalariaKitTests/LeafTests/testOne"], "TalariaTests": []}),
            ("an added method", [(alpha, "    func testPlain() {", "    func testAdded() {\n        XCTAssertTrue(true)\n    }\n\n    func testPlain() {")],
             {"TalariaKitTests": [], "TalariaTests": ["TalariaTests/AlphaHostedTests/testAdded"]}),
            ("a line removed from a method", [(alpha, "        XCTAssertEqual(SharedFixture.make(), 1)\n", "")],
             {"TalariaKitTests": [], "TalariaTests": ["TalariaTests/AlphaHostedTests/testFixture"]}),
            ("class setup", [(leaf, "value = 2", "value = 1 + 1")], {"TalariaKitTests": [], "TalariaTests": []}),
            ("a helper", [("app/TalariaTests/Hosted.swift", "        1\n", "        0 + 1\n")], {"TalariaKitTests": [], "TalariaTests": []}),
            ("a method beside a change that runs its target in full",
             [("app/Talaria/View.swift", "{}", "{ let x = 1 }"), (alpha, "XCTAssertEqual(Hosted.other(), 2)", "XCTAssertEqual(Hosted.other(), 1 + 1)")],
             {"TalariaKitTests": [], "TalariaTests": ["TalariaTests/AlphaHostedTests/testPlain"]}),
        ]
        for name, edits, expected in cases:
            with self.subTest(name):
                self.git("reset", "-q", "--hard", self.base)
                for path, old, new in edits:
                    self.edit(path, old, new)
                plan = self.committed()
                self.assertEqual({target: lane["repeat"] for target, lane in plan["lanes"].items()}, expected)

    def test_a_main_push_plans_the_same_tests_without_repeats(self):
        # Its pull request already repeated what it added or changed (TAL-2402); main runs each test once (TAL-2544).
        self.edit("app/TalariaTests/AlphaHostedTests.swift", "XCTAssertEqual(Hosted.other(), 2)", "XCTAssertEqual(Hosted.other(), 1 + 1)")
        head = self.commit("change")
        pull = self.plan(f"--base={self.base}", f"--head={head}", "--merge-base")
        push = self.plan(f"--base={self.base}", f"--head={head}", "--no-repeat")
        self.assertEqual(pull["lanes"]["TalariaTests"]["repeat"], ["TalariaTests/AlphaHostedTests/testPlain"])
        self.assertEqual(self.lanes(push), self.lanes(pull))
        self.assertEqual({target: lane["repeat"] for target, lane in push["lanes"].items()},
                         {"TalariaKitTests": [], "TalariaTests": []})

    def test_local_changes_plan_exactly_as_the_committed_diff(self):
        # Staged, unstaged and untracked changes together: the local dry run and CI's committed diff agree.
        self.edit("app/TalariaKit/Tests/TalariaKitTests/LeafTests.swift", "XCTAssertEqual(value, 2)", "XCTAssertEqual(value, 2, \"two\")")
        self.git("add", "app/TalariaKit/Tests/TalariaKitTests/LeafTests.swift")
        self.edit("app/TalariaTests/Hosted.swift", "        1\n", "        0 + 1\n")
        self.write("app/TalariaKit/Tests/TalariaKitTests/NewTests.swift",
                   "import XCTest\n\nfinal class NewTests: XCTestCase {\n    func testNew() {}\n}\n")
        local = self.plan("--local", f"--base={self.base}")
        committed = self.committed()
        self.assertEqual(local["lanes"], committed["lanes"])
        self.assertEqual(self.lanes(local)["TalariaKitTests"],
                         ("explicit", ["TalariaKitTests/LeafTests/testOne", "TalariaKitTests/NewTests"]))

    def test_renames_and_deletions_run_only_tests_present_at_the_tested_revision(self):
        self.edit("app/TalariaKit/Tests/TalariaKitTests/LeafTests.swift", "func testTwo()", "func testSecond()")
        (self.root / "app/TalariaKit/Tests/TalariaKitTests/UsesFixtureTests.swift").unlink()
        self.git("mv", "app/TalariaKit/Tests/TalariaKitTests/MathTests.swift", "app/TalariaKit/Tests/TalariaKitTests/FormatTests.swift")
        self.edit("app/TalariaKit/Tests/TalariaKitTests/FormatTests.swift", "class MathTests", "class FormatTests")
        self.assertEqual(self.lanes(self.committed())["TalariaKitTests"],
                         ("explicit", ["TalariaKitTests/FormatTests", "TalariaKitTests/LeafTests/testSecond"]))

    def test_uncertainty_runs_the_affected_targets_in_full_with_its_reason(self):
        cases = [
            # A new consumer the rule's review never saw makes the rule stale.
            ("app/TalariaKit/Sources/TalariaKit/Late.swift", "struct Late { let x = Formatter() }\n",
             "app/TalariaKit/Sources/TalariaKit/Formatter.swift", '"x"', '"y"', "rule formatter is stale"),
            # A test file the scanner cannot read.
            ("app/TalariaTests/Broken.swift", "final class Broken: XCTestCase { func testX() { \n",
             "app/TalariaTests/Hosted.swift", "        1\n", "        0 + 1\n", "unbalanced braces"),
        ]
        base = self.base
        for added, text, path, old, new, reason in cases:
            with self.subTest(reason):
                self.git("reset", "-q", "--hard", base)
                self.git("clean", "-qfd")
                self.base = base
                self.write(added, text)
                if added.startswith("app/TalariaTests/"):
                    self.write("app/Talaria.xcodeproj/project.pbxproj", self.project([*HOSTED_SOURCES, "Broken.swift"]))
                    self.commit("project")
                    self.base = self.git("rev-parse", "HEAD")
                self.edit(path, old, new)
                plan = self.committed()
                full = [target for target, lane in plan["lanes"].items() if lane["mode"] == "full"]
                self.assertIn("TalariaTests", full)
                self.assertTrue(any(reason in why for lane in plan["lanes"].values() for why in lane["reasons"]), plan)
        # A base that cannot be read: every suite and both targets in full.
        unavailable = self.plan("--base=0123456789012345678901234567890123456789", "--head=HEAD")
        self.assertEqual({lane["mode"] for lane in unavailable["lanes"].values()}, {"full"})

    def test_a_selected_contracts_suite_keeps_the_live_contract_proof(self):
        self.write("contracts/fixtures/web-session.json", "{}\n")
        self.base = self.commit("fixture")
        self.write("web/packages/server/src/x.ts", "export const x = 1;\n")
        self.assertEqual(self.lanes(self.committed()), {
            "TalariaKitTests": ("explicit", CONTRACT_PROOF),
            "TalariaTests": ("empty", [])})

    def test_ci_outputs_carry_each_lane_and_the_plan(self):
        self.edit("app/Talaria/View.swift", "{}", "{ let x = 1 }")
        head = self.commit("view")
        result = subprocess.run([os.sys.executable, str(SCRIPT), f"--base={self.base}", f"--head={head}", "--merge-base",
                                 "--app-plan"], cwd=self.root, env=self.env, text=True, capture_output=True, check=True)
        outputs = dict(line.split("=", 1) for line in result.stdout.splitlines())
        self.assertEqual((outputs["app"], outputs["app_package"], outputs["app_hosted"], outputs["app_hosted_repeat"]),
                         ("true", "empty", "full", "false"))
        self.assertEqual(json.loads(outputs["app_plan"])["lanes"]["TalariaTests"]["mode"], "full")
        self.assertIn("app/Talaria/View.swift: no reviewed rule bounds its consumers.", result.stderr)


FRONTEND = "web/packages/frontend/"
BROWSER_SOURCES = {
    "src/main.tsx": "export const x = 1\n",
    "src/test/fixtures.ts": "export const session = {}\n",
    "src/i18n/runtime.test.ts": "import { x } from '../main'\n",
    "src/lib/shared.test.ts": "export const shared = 1\n",
    "playwright.config.ts": "export default { testDir: './e2e', globalSetup: './e2e/global-setup.ts' }\n",
    "e2e/global-setup.ts": "export default async () => {}\n",
    "e2e/fixtures.ts": "export { session } from '../src/test/fixtures'\n",
    "e2e/approval-card.spec.ts": "import { session } from './fixtures'\n",
    "e2e/composer.spec.ts": "import { test } from '@playwright/test'\n",
    "e2e/shared.spec.ts": "export const s = 1\n",
    "e2e/uses-shared.spec.ts": "import { s } from './shared.spec'\n",
    "e2e/uses-unit.spec.ts": "import { shared } from '../src/lib/shared.test.js'\n",
}


class NativeDuoTests(unittest.TestCase):
    """The hosted tests only a native iPhone Duo runs, and the Duo shard's share of a lane (TAL-1456)."""

    SOURCES = {"app/TalariaTests/BarTests.swift": """import XCTest
final class BarTests: XCTestCase {
    func testReadsTheBar() { XCTAssertEqual(window.traitCollection.verticalBarEdge, .leading) }
    func testKnown() { XCTAssertEqual(window.traitCollection.verticalBarEdge, .trailing) }
    func testPlain() { XCTAssertTrue(true) }
}
""", "app/TalariaTests/ArrangedTests.swift": """import XCTest
final class ArrangedTests: XCTestCase {
    private func arranged() throws {
        guard #available(iOS 27.1, *) else { throw XCTSkip("Needs iOS 27.1") }
    }
    func testArranged() throws { try arranged() }
    func testOlderRuntime() throws { guard #available(iOS 27.0, *) else { throw XCTSkip("Needs iOS 27") } }
    func testNoSkip() { guard #available(iOS 27.1, *) else { return } }
}
"""}

    def setUp(self):
        self.universe = app_plan.Universe("TalariaTests", self.SOURCES)
        known = {"TalariaTests/BarTests/testKnown": "TAL-1"}
        patcher = mock.patch.object(app_plan, "DUO_KNOWN_FAILURES", known)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_a_test_reading_the_bar_or_skipping_below_the_duo_runtime_needs_the_duo(self):
        self.assertEqual(sorted(app_plan.native_duo(self.universe)), [
            "TalariaTests/ArrangedTests/testArranged", "TalariaTests/BarTests/testKnown", "TalariaTests/BarTests/testReadsTheBar"])

    def test_the_duo_shard_takes_the_lanes_native_tests_and_leaves_out_known_failures(self):
        cases = [
            ("a full lane", ["TalariaTests"], ["TalariaTests/ArrangedTests/testArranged", "TalariaTests/BarTests/testReadsTheBar"],
             {"TalariaTests/BarTests/testKnown": "TAL-1"}),
            ("a class", ["TalariaTests/ArrangedTests"], ["TalariaTests/ArrangedTests/testArranged"], {}),
            ("a native method", ["TalariaTests/BarTests/testReadsTheBar"], ["TalariaTests/BarTests/testReadsTheBar"], {}),
            ("only a known failure", ["TalariaTests/BarTests/testKnown"], [], {"TalariaTests/BarTests/testKnown": "TAL-1"}),
            ("an unrelated test", ["TalariaTests/BarTests/testPlain", "TalariaTests/ArrangedTests/testNoSkip"], [], {}),
        ]
        for name, lane, planned, left_out in cases:
            with self.subTest(name):
                self.assertEqual(app_plan.duo_selection(self.universe, lane), (planned, left_out))

    def test_a_known_failure_the_tree_no_longer_has_is_stale(self):
        with mock.patch.object(app_plan, "DUO_KNOWN_FAILURES", {"TalariaTests/BarTests/testGone": "TAL-1"}), \
                self.assertRaisesRegex(app_plan.Uncertain, "testGone .TAL-1. is not in the tested tree"):
            app_plan.duo_selection(self.universe, ["TalariaTests/BarTests"])


class BrowserPlanTests(unittest.TestCase):
    """The pull request's Playwright plan on a synthetic frontend package (TAL-2391)."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="talaria-browser-plan-")
        self.root = Path(self.directory.name)
        self.env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
        for path, text in BROWSER_SOURCES.items():
            self.write(FRONTEND + path, text)
        self.write("web/packages/server/src/x.ts", "export const y = 1\n")
        self.git("init", "-b", "main")
        self.base = self.commit("base")

    def tearDown(self):
        self.directory.cleanup()

    write = AppPlanTests.write
    git = AppPlanTests.git
    commit = AppPlanTests.commit

    def plan(self, *options):
        if not options:
            options = (f"--base={self.base}", f"--head={self.commit('change')}", "--merge-base")
        result = subprocess.run([os.sys.executable, str(SCRIPT), *options, "--browser-plan"], cwd=self.root,
                                env=self.env, text=True, capture_output=True, check=True)
        outputs = dict(line.split("=", 1) for line in result.stdout.splitlines())
        return outputs["web_frontend"], outputs["web_browser"], json.loads(outputs["web_browser_specs"]), result.stderr

    def test_changes_choose_no_browser_job_their_specs_or_every_shard(self):
        imported = "is imported by " + FRONTEND
        cases = [
            ("a Vitest test alone starts no browser job", {"src/i18n/runtime.test.ts": "// edited\n"}, ("none", []), None),
            ("a spec alone runs that file", {"e2e/approval-card.spec.ts": "// edited\n"},
             ("specs", ["e2e/approval-card.spec.ts"]), None),
            ("a mixed diff runs the union", {"src/i18n/runtime.test.ts": "// edited\n", "e2e/composer.spec.ts": "// edited\n",
                                             "e2e/approval-card.spec.ts": "// edited\n", "../../../changelog.d/TAL-1.json": "{}\n"},
             ("specs", ["e2e/approval-card.spec.ts", "e2e/composer.spec.ts"]), None),
            ("a spec name with regular-expression characters", {"e2e/a+b (1)[x].spec.ts": "// new\n"},
             ("specs", ["e2e/a+b (1)[x].spec.ts"]), None),
            ("a spec another spec imports is shared", {"e2e/shared.spec.ts": "// edited\n"}, ("full", []),
             imported + "e2e/uses-shared.spec.ts"),
            ("a Vitest file a spec imports is a browser input", {"src/lib/shared.test.ts": "// edited\n"}, ("full", []),
             imported + "e2e/uses-unit.spec.ts"),
            ("an e2e helper", {"e2e/fixtures.ts": "// edited\n"}, ("full", []), "e2e/fixtures.ts reaches the browser suite"),
            ("global setup", {"e2e/global-setup.ts": "// edited\n"}, ("full", []), "reaches the browser suite"),
            ("the Playwright config", {"playwright.config.ts": "// edited\n"}, ("full", []), "reaches the browser suite"),
            ("test support the specs load", {"src/test/fixtures.ts": "// edited\n"}, ("full", []), "reaches the browser suite"),
            ("application code", {"src/main.tsx": "// edited\n"}, ("full", []), "reaches the browser suite"),
            ("server code", {"../server/src/x.ts": "// edited\n"}, ("full", []), "reaches the browser suite"),
            (f"more than {MAX_SPECS} specs", {f"e2e/new-{index}.spec.ts": "// new\n" for index in range(MAX_SPECS + 1)},
             ("full", []), "changed specs"),
        ]
        for name, edits, expected, reason in cases:
            with self.subTest(name):
                self.git("reset", "-q", "--hard", self.base)
                self.git("clean", "-qfd")
                for path, text in edits.items():
                    self.write(FRONTEND + path, text)
                frontend, mode, specs, log = self.plan()
                self.assertEqual((frontend, mode, specs), ("true", *expected))
                if reason:
                    self.assertIn(reason, log)

    def test_renamed_and_deleted_specs_run_only_what_the_tested_revision_has(self):
        self.git("mv", FRONTEND + "e2e/approval-card.spec.ts", FRONTEND + "e2e/approval-panel.spec.ts")
        self.assertEqual(self.plan()[1:3], ("specs", ["e2e/approval-panel.spec.ts"]))
        self.git("rm", "-q", FRONTEND + "e2e/composer.spec.ts")
        self.base = self.git("rev-parse", "HEAD")
        self.assertEqual(self.plan()[1:3], ("none", []))

    def test_uncertainty_runs_every_shard(self):
        # A computed import in the browser suite could load any spec.
        self.write(FRONTEND + "e2e/fixtures.ts", "export const load = (name) => import(name)\n")
        self.base = self.commit("computed")
        self.write(FRONTEND + "e2e/approval-card.spec.ts", "// edited\n")
        frontend, mode, _, log = self.plan()
        self.assertEqual(mode, "full")
        self.assertIn("loads a module by a computed name", log)
        # A base that cannot be read, and a run with no diff, plan every shard too.
        self.assertEqual(self.plan("--base=0123456789012345678901234567890123456789", "--head=HEAD")[1], "full")
        self.assertEqual(self.plan("--base=HEAD", "--head=HEAD")[1], "full")

    def test_local_changes_plan_as_the_committed_diff(self):
        self.write(FRONTEND + "e2e/approval-card.spec.ts", "// staged\n")
        self.git("add", "-A")
        self.write(FRONTEND + "e2e/composer.spec.ts", "// unstaged\n")
        self.write(FRONTEND + "e2e/added.spec.ts", "// untracked\n")
        local = self.plan("--local", f"--base={self.base}")
        self.assertEqual(local[1:3], ("specs", ["e2e/added.spec.ts", "e2e/approval-card.spec.ts", "e2e/composer.spec.ts"]))
        self.assertEqual(self.plan()[1:3], local[1:3])

    def test_filters_match_exactly_the_selected_files(self):
        for path in ("e2e/a+b (1)[x].spec.ts", "e2e/xa+b (1)[x].spec.ts", "e2e/sub/e2e/a.spec.ts", "e2e/a.spec.ts",
                     "e2e/fixtures.ts"):
            self.write(path, "")
        root = os.path.realpath(self.root)
        selected = ["e2e/a+b (1)[x].spec.ts", "e2e/a.spec.ts"]
        filters = browser.filters(self.root, selected)
        files = [f"{root}/{path}" for path in ("e2e/a+b (1)[x].spec.ts", "e2e/xa+b (1)[x].spec.ts", "e2e/sub/e2e/a.spec.ts",
                                               "e2e/a.spec.ts")]
        # Playwright reads /pattern/ with no flags as one case-sensitive regular expression over the absolute path.
        matched = [[file for file in files if re.search(pattern[1:-1], file)] for pattern in filters]
        self.assertEqual(matched, [[files[0]], [files[3]]])
        for specs in ([], ["e2e/missing.spec.ts"], ["e2e/fixtures.ts"], ["e2e/../e2e/a.spec.ts"], ["e2e/a.spec.ts"] * 2):
            with self.subTest(specs=specs), self.assertRaises(ValueError):
                browser.filters(self.root, specs)

    def test_receipts_require_every_selected_spec_on_every_project_and_nothing_else(self):
        def report(*suites):
            path = self.root / "report.xml"
            path.write_text("<testsuites>" + "".join(
                f'<testsuite name="{name}" hostname="{project}" tests="{tests}" skipped="{skipped}"/>'
                for name, project, tests, skipped in suites) + "</testsuites>")
            return path
        specs = ["e2e/approval-card.spec.ts"]
        # A test the mobile project skips still reports its case.
        self.assertEqual(browser.receipts(report(("approval-card.spec.ts", "desktop", 2, 0),
                                                 ("approval-card.spec.ts", "mobile", 2, 2)), specs), 4)
        failures = [
            ("a missing project", [("approval-card.spec.ts", "desktop", 2, 0)], "ran no test on mobile"),
            ("no case on a project", [("approval-card.spec.ts", "desktop", 2, 0), ("approval-card.spec.ts", "mobile", 0, 0)],
             "ran no test on mobile"),
            ("an unselected file", [("approval-card.spec.ts", "desktop", 1, 0), ("approval-card.spec.ts", "mobile", 1, 0),
                                    ("composer.spec.ts", "desktop", 1, 0)], "composer.spec.ts on desktop was not selected"),
            ("no case at all", [], "ran no test on desktop"),
        ]
        for name, suites, message in failures:
            with self.subTest(name), self.assertRaisesRegex(ValueError, re.escape(message)):
                browser.receipts(report(*suites), specs)


if __name__ == "__main__":
    unittest.main()
