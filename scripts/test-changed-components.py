#!/usr/bin/env python3
"""Exercise routing with synthetic paths and disposable Git history."""

import importlib.util
from copy import deepcopy
import os
import plistlib
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("changed-components.py")
spec = importlib.util.spec_from_file_location("routing", SCRIPT)
routing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(routing)
ALL = {"app", "app_tooling", "web_server", "web_frontend", "docker", "relay", "contracts", "tooling"}
CONSUMERS = {"app", "web_server", "web_frontend", "relay", "contracts"}


class RoutingTests(unittest.TestCase):
    def test_app_ui_scope(self):
        assert not routing.app_ui_required(["app/Talaria/Networking/APIClient.swift"])
        assert not routing.app_ui_required(["app/Talaria/Resources/Info.plist"], metadata_only_plists=["app/Talaria/Resources/Info.plist"])
        assert routing.app_ui_required(["app/Talaria/Resources/Info.plist"])
        assert routing.same_plist_ui(plistlib.dumps({}), plistlib.dumps({"TalariaRelease": {"version": "1.0.0"}}))
        assert not routing.same_plist_ui(plistlib.dumps({}), plistlib.dumps({"UISupportedInterfaceOrientations": ["portrait"]}))
        assert routing.app_ui_required(["app/Talaria/Features/Chat/ChatView.swift"])
        assert routing.app_ui_required(["app/Talaria/ContentView.swift"])
        assert routing.app_ui_required(["app/TalariaUITests/TalariaUITests.swift"])
        assert routing.app_ui_required(["app/TalariaLiveActivityWidget/ProviderQuotaWidgetView.swift"])
        assert routing.app_ui_required(["app/TalariaShareExtension/ShareViewController.swift"])
        assert routing.app_ui_required(["app/NewComponent/Unknown.swift"])
        assert routing.app_ui_required(["new-component/runtime.swift"])
        assert not routing.app_ui_required(["app/Talaria/TalariaApp.swift"], scene_unchanged=True)
        assert routing.app_ui_required(["app/Talaria/TalariaApp.swift"])
        assert routing.same_app_scene("init() {}\nvar body: some Scene { Main() }", "init() { log() }\nvar body: some Scene { Main() }")
        assert not routing.same_app_scene("var body: some Scene { Main() }", "var body: some Scene { Other() }")
        assert not routing.same_app_scene("unknown", "unknown")

    def test_path_classes(self):
        cases = [
            (["changelog.d/TAL-123.json"], set()),
            # The live-fixture test runs only in the contracts step, so editing it must select contracts.
            (["app/TalariaTests/APIClientSessionListTests.swift"], {"app", "contracts"}),
            # The Docker plugin action sets up Compose/Buildx for the smoke, so it runs the smoke too.
            ([".github/actions/docker-plugins/action.yml"], {"docker", "tooling"}),
            ([".github/workflows/ui-performance.yml"], {"app", "tooling"}),
            # Every script is mapped; an unmapped one would select the full suite.
            (["scripts/check-release-contracts.py"], {"contracts", "tooling"}),
            (["scripts/check", "scripts/check-regression-port.py", "scripts/test-check-regression-port.py"], {"tooling"}),
            (["scripts/generate-brand-icons.py"], {"web_frontend", "tooling"}),
            (["scripts/repair-workspace-user-turns.py"], {"web_server", "tooling"}),
            (["app/changelog.d/TAL-123.json"], set()),
            (["README.md", "docs/guide.md", "app/DEVELOPMENT.md", "web/docs/guide.md", "relay/README.md"], set()),
            (["web/packages/frontend/src/main.tsx", "web/static/dist/app.js", "changelog.d/TAL-123.json"], {"web_frontend"}),
            (["web/packages/contracts/src/router.ts"], {"web_server", "web_frontend", "contracts"}),
            (["web/packages/server/src/index.ts", "web/sidecar/talaria_sidecar/__main__.py"], {"web_server", "web_frontend", "contracts"}),
            (["web/packages/frontend/package.json"], {"web_frontend"}),
            (["web/static/brand/favicon.ico"], {"web_frontend", "web_server"}),
            (["web/sidecar/tests/test_runtime.py", "web/sidecar/scripts/replay_sidecar.py"], {"web_server", "web_frontend", "contracts"}),
            (["web/sidecar/agent_dependency.json"], {"web_server", "contracts", "docker"}),
            (["web/sidecar/talaria_sidecar/rpc.py"], {"web_server", "web_frontend", "contracts"}),
            (["web/packages/server/src/api/auth.ts"], {"web_server", "web_frontend", "contracts"}),
            (["web/docs/architecture/regression-port-cases.tsv"], {"web_server", "contracts", "tooling"}),
            (["web/packages/server/src/port/auth.port.test.ts"], {"web_server", "contracts", "tooling"}),
            (["web/package-lock.json"], {"web_server", "web_frontend", "docker", "contracts"}),
            (["web/skills/runtime/SKILL.md"], {"web_server", "web_frontend", "docker", "contracts"}),
            (["web/packages/frontend/src/guide.md"], {"web_frontend"}),
            (["web/Dockerfile", "web/docker-compose.yml", "web/scripts/lib/health_probe.sh"], {"docker", "web_server"}),
            (["web/scripts/wsl/hermes_webui_autostart.sh", "web/.env.example"], {"web_server"}),
            (["app/Talaria/Features/Chat/ChatView.swift"], {"app"}),
            (["app/Talaria/Resources/Guide.md"], {"app"}),
            (["app/Talaria/Networking/APIClient.swift"], {"app", "contracts"}),
            (["app/ci/release_notes.py"], {"tooling"}),
            (["app/scripts/test-ios"], {"app_tooling", "tooling"}),
            (["app/scripts/validate-upstream-contract"], {"contracts", "tooling"}),
            (["relay/convex/cleanup.ts", "relay/tests/crypto.test.ts"], {"relay"}),
            (["relay/convex/http.ts"], {"relay", "app", "web_server", "contracts"}),
            (["relay/convex/completions.ts"], {"relay", "app", "web_server", "contracts"}),
            (["relay/convex/subscriptions.ts"], {"relay", "app", "web_server", "contracts"}),
            (["relay/convex/new-response.ts"], {"relay", "app", "web_server", "contracts"}),
            (["relay/package.json", "relay/pnpm-lock.yaml"], {"relay"}),
            (["contracts/versions.json"], CONSUMERS),
            (["web/contract_versions.json"], CONSUMERS),
            (["web/packages/frontend/src/main.tsx", "relay/tests/crypto.test.ts"], {"web_frontend", "relay"}),
            (["scripts/check-web-server"], {"web_server", "tooling"}),
            (["scripts/check-web-browser"], {"web_frontend", "tooling"}),
            (["scripts/check-docker.py"], {"docker", "tooling"}),
            (["scripts/stamp-release.py"], {"tooling"}),
            (["scripts/check-agent-compatibility.py"], {"web_server", "docker", "tooling"}),
            (["scripts/check-release-agent.py"], {"tooling"}),
            (["releases/publish.py"], {"tooling"}),
            ([".github/workflows/release-set.yml"], {"tooling"}),
            ([".github/workflows/web-verify.yml"], {"web_server", "web_frontend", "tooling"}),
            ([".github/workflows/relay-verify.yml"], {"relay", "tooling"}),
            ([".github/workflows/pr-ci.yml"], {"app", "tooling"}),
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

    def test_documentation_image_selects_no_suites(self):
        self.assertEqual(routing.affected(["web/docs/pr-media/tal-346/after-desktop.png"]), set())
        self.assertEqual(routing.affected(["web/icon.png"]), {"web_server", "web_frontend", "docker", "contracts"})

    def test_real_diffs_include_renames_and_full_push_range(self):
        with tempfile.TemporaryDirectory(prefix="talaria-ci-routing-") as temporary:
            root = Path(temporary)
            env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}

            def git(*args):
                return subprocess.check_output(["git", "-c", "user.name=Synthetic", "-c", "user.email=test@example.invalid",
                    "-c", "commit.gpgsign=false", *args], cwd=root, env=env, text=True, stderr=subprocess.PIPE).strip()

            def commit(name):
                git("add", ".")
                git("commit", "-m", name)
                return git("rev-parse", "HEAD")

            def classify(base, head, *options, expected_ui=None):
                result = subprocess.run([os.sys.executable, str(SCRIPT), f"--base={base}", f"--head={head}", *options],
                                        cwd=root, env=env, text=True, capture_output=True, check=True)
                flags = dict(line.split("=", 1) for line in result.stdout.splitlines())
                ui = flags.pop("app_ui")
                self.assertIn(ui, {"true", "false"})
                if expected_ui is not None:
                    self.assertEqual(ui, str(expected_ui).lower())
                self.assertEqual(set(flags), ALL)
                self.assertLessEqual(set(flags.values()), {"true", "false"})
                return {key for key, value in flags.items() if value == "true"}

            git("init", "-b", "main")
            (root / "web/sidecar/tests").mkdir(parents=True)
            (root / "web/sidecar/tests/test_synthetic.py").write_text("print('synthetic')\n")
            base = commit("base")
            (root / "web/packages/frontend").mkdir(parents=True)
            git("mv", "web/sidecar/tests/test_synthetic.py", "web/packages/frontend/moved.py")
            moved = commit("move backend file into frontend")
            self.assertEqual(classify(base, moved), {"web_server", "web_frontend"})
            odd = root / "web/packages/frontend/name\napp=false\n.tsx"
            odd.write_text("synthetic")
            head = commit("frontend change")
            self.assertEqual(classify(moved, head, expected_ui=False), {"web_frontend"})
            self.assertEqual(classify(base, head), {"web_server", "web_frontend"})
            git("update-ref", "refs/remotes/origin/main", moved)
            # A parent change merged since the event's base SHA must not make
            # the child PR rerun the parent's component checks.
            self.assertEqual(classify("refs/remotes/origin/main", head, "--merge-base", expected_ui=False), {"web_frontend"})
            git("checkout", "-b", "diverged", base)
            (root / "app").mkdir()
            (root / "app/README.md").write_text("docs")
            other = commit("base branch advanced")
            self.assertEqual(classify(other, head, "--merge-base"), {"web_server", "web_frontend"})
            self.assertEqual(classify(head, head, expected_ui=True), ALL)
            self.assertEqual(classify("0" * 40, head, expected_ui=True), ALL)
            self.assertEqual(classify("--output=should-not-exist", head), ALL)
            self.assertFalse((root / "should-not-exist").exists())

            (root / "scripts").mkdir()
            (root / "scripts/new-unknown-tool.py").write_text("unknown shared tooling\n")
            unknown = commit("unknown shared tool")
            self.assertEqual(classify(other, unknown, expected_ui=True), ALL)

            def check_diff(*options):
                return subprocess.run([os.sys.executable, str(SCRIPT), "--check-diff", *options],
                                      cwd=root, env=env, text=True, capture_output=True)

            self.assertEqual(check_diff("--base", base, "--head", other).returncode, 0)
            self.assertEqual(check_diff().returncode, 0)
            (root / "app/README.md").write_text("docs with trailing spaces  \n")
            bad = commit("committed whitespace error")
            self.assertNotEqual(check_diff().returncode, 0)
            (root / "README.md").write_text("unrelated clean change\n")
            final = commit("later clean commit")
            self.assertEqual(git("status", "--porcelain"), "")
            self.assertEqual(check_diff("--base", bad, "--head", final).returncode, 0)
            result = check_diff("--base", other, "--head", final)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("trailing whitespace", result.stdout)
            self.assertNotEqual(check_diff("--base", "missing-ref").returncode, 0)

    def test_gate_rejects_missing_or_skipped_required_checks(self):
        job_suites = {"test": {"app", "contracts"}, "app-tooling": {"app_tooling"},
                      "web": {"web_server", "web_frontend"}, "web-docker": {"docker"},
                      "relay": {"relay"}, "contracts": {"contracts"}}
        for selected in (set(), {"web_frontend"}, {"web_server"}, {"app"}, {"tooling"}, ALL):
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
        needs["test"]["result"] = "skipped"
        with self.assertRaises(ValueError):
            routing.check_results(needs)
        del needs["test"]
        with self.assertRaises(KeyError):
            routing.check_results(needs)


if __name__ == "__main__":
    unittest.main()
