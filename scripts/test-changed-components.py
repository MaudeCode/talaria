#!/usr/bin/env python3
"""Exercise routing with synthetic paths and disposable Git history."""

import importlib.util
from copy import deepcopy
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("changed-components.py")
spec = importlib.util.spec_from_file_location("routing", SCRIPT)
routing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(routing)
ALL = {"app", "app_tooling", "web_python", "web_frontend", "docker", "relay", "contracts", "tooling"}
CONSUMERS = {"app", "web_python", "web_frontend", "relay", "contracts"}


class RoutingTests(unittest.TestCase):
    def test_path_classes(self):
        cases = [
            (["changelog.d/TAL-123.json"], set()),
            (["app/changelog.d/TAL-123.json"], set()),
            (["README.md", "docs/guide.md", "app/DEVELOPMENT.md", "web/docs/guide.md", "relay/README.md"], set()),
            (["web/frontend/src/main.tsx", "web/static/dist/app.js", "changelog.d/TAL-123.json"], {"web_frontend"}),
            (["web/frontend/package-lock.json"], {"web_frontend"}),
            (["web/api/config.py", "web/tests/test_config.py"], {"web_python"}),
            (["web/api/routes.py"], {"web_python", "contracts"}),
            (["web/server.py"], {"web_python", "contracts"}),
            (["web/tests/fixtures/readme.md"], {"web_python"}),
            (["web/skills/runtime/SKILL.md"], {"web_python"}),
            (["web/frontend/src/guide.md"], {"web_frontend"}),
            (["web/Dockerfile", "web/docker-compose.yml"], {"docker", "web_python"}),
            (["web/requirements.txt"], {"web_python", "web_frontend", "docker", "contracts"}),
            (["web/pyproject.toml"], {"web_python", "web_frontend", "docker", "contracts"}),
            (["app/Talaria/Features/Chat/ChatView.swift"], {"app"}),
            (["app/Talaria/Resources/Guide.md"], {"app"}),
            (["app/Talaria/Networking/APIClient.swift"], {"app", "contracts"}),
            (["app/ci/release_notes.py"], {"tooling"}),
            (["app/scripts/test-ios"], {"app_tooling", "tooling"}),
            (["app/scripts/validate-upstream-contract"], {"contracts", "tooling"}),
            (["relay/convex/cleanup.ts", "relay/tests/crypto.test.ts"], {"relay"}),
            (["relay/convex/http.ts"], {"relay", "app", "web_python", "contracts"}),
            (["relay/package.json", "relay/pnpm-lock.yaml"], {"relay"}),
            (["contracts/versions.json"], CONSUMERS),
            (["web/api/contract_versions.json"], CONSUMERS),
            (["web/frontend/src/main.tsx", "relay/tests/crypto.test.ts"], {"web_frontend", "relay"}),
            (["scripts/check-web-python"], {"web_python", "tooling"}),
            (["scripts/check-web-browser"], {"web_frontend", "tooling"}),
            (["scripts/check-docker.py"], {"docker", "tooling"}),
            (["scripts/stamp-release.py"], {"web_python", "tooling"}),
            (["releases/publish.py"], {"tooling"}),
            ([".github/workflows/release-set.yml"], {"tooling"}),
            ([".github/workflows/web-verify.yml"], {"web_python", "web_frontend", "tooling"}),
            ([".github/workflows/relay-verify.yml"], {"relay", "tooling"}),
            ([".github/workflows/pr-ci.yml"], ALL),
            (["scripts/changed-components.py"], ALL),
            (["new-component/runtime.rs"], ALL),
            (["changelog.d/README.md", "changelog.d/malformed.json"], set()),
            ([], ALL),
            (["../web/frontend/main.tsx"], ALL),
            ([None], ALL),
            (["web/frontend/file\napp=false\n.tsx"], {"web_frontend"}),
        ]
        for paths, expected in cases:
            with self.subTest(paths=paths):
                self.assertEqual(routing.affected(paths), expected)

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

            def classify(base, head, *options):
                result = subprocess.run([os.sys.executable, str(SCRIPT), f"--base={base}", f"--head={head}", *options],
                                        cwd=root, env=env, text=True, capture_output=True, check=True)
                flags = dict(line.split("=", 1) for line in result.stdout.splitlines())
                self.assertEqual(set(flags), ALL)
                self.assertLessEqual(set(flags.values()), {"true", "false"})
                return {key for key, value in flags.items() if value == "true"}

            git("init", "-b", "main")
            (root / "web/tests").mkdir(parents=True)
            (root / "web/tests/server.py").write_text("print('synthetic')\n")
            base = commit("base")
            (root / "web/frontend").mkdir()
            git("mv", "web/tests/server.py", "web/frontend/moved.py")
            moved = commit("move backend file into frontend")
            self.assertEqual(classify(base, moved), {"web_python", "web_frontend"})
            odd = root / "web/frontend/name\napp=false\n.tsx"
            odd.write_text("synthetic")
            head = commit("frontend change")
            self.assertEqual(classify(moved, head), {"web_frontend"})
            self.assertEqual(classify(base, head), {"web_python", "web_frontend"})
            git("checkout", "-b", "diverged", base)
            (root / "app").mkdir()
            (root / "app/README.md").write_text("docs")
            other = commit("base branch advanced")
            self.assertEqual(classify(other, head, "--merge-base"), {"web_python", "web_frontend"})
            self.assertEqual(classify(head, head), ALL)
            self.assertEqual(classify("0" * 40, head), ALL)
            self.assertEqual(classify("--output=should-not-exist", head), ALL)
            self.assertFalse((root / "should-not-exist").exists())

    def test_gate_rejects_missing_or_skipped_required_checks(self):
        job_suites = {"test": {"app"}, "app-tooling": {"app_tooling"},
                      "web": {"web_python", "web_frontend"}, "web-docker": {"docker"},
                      "relay": {"relay"}, "contracts": {"contracts"}}
        for selected in (set(), {"web_frontend"}, {"web_python"}, {"app"}, {"tooling"}, ALL):
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
