#!/usr/bin/env python3
"""Drive .githooks/pre-push through real pushes in a disposable repository with stubbed npm and pnpm (TAL-1779).

The router is the real scripts/changed-components.py, so these prove which checks a diff selects end to end.

Run: python3 scripts/test-pre-push-hook.py
"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]
CONTRACTS_BUILD = "web: npm run build -w packages/contracts"
SERVER = [
    "web: npm run lint -w packages/contracts",
    "web: npm run typecheck -w packages/contracts",
    "web: npm run lint -w packages/server",
    "web: npm run typecheck -w packages/server",
]
FRONTEND = [
    "web: npm run build -w packages/server",
    "web: npm run lint -w packages/frontend",
    "web: npm run typecheck -w packages/frontend",
]
RELAY = ["relay: pnpm typecheck"]
TOOLING = ["self-test"]
WEB = [CONTRACTS_BUILD, *SERVER, *FRONTEND]
EVERY_CHECK = [*WEB, *RELAY, *TOOLING]

STUB_TOOL = """#!/bin/sh
entry="${PWD##*/}: ${0##*/} $*"
echo "$entry" >>"$STUB_LOG"
if [ "$entry" = "$STUB_FAIL" ]; then
  echo "stub check output"
  exit 1
fi
"""
STUB_SELF_TEST = """import os
with open(os.environ["STUB_LOG"], "a") as log:
    log.write("self-test\\n")
"""


class PrePushHookTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.work = self.root / "work"
        self.log = self.root / "checks.log"
        self.env = {name: value for name, value in os.environ.items() if not name.startswith("GIT_")}
        self.env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1", STUB_LOG=str(self.log), STUB_FAIL="")
        stubs = self.root / "bin"
        stubs.mkdir()
        for tool in ("npm", "pnpm"):
            (stubs / tool).write_text(STUB_TOOL)
            (stubs / tool).chmod(0o755)
        self.env["PATH"] = f"{stubs}{os.pathsep}{self.env['PATH']}"

        self.git("init", "--quiet", "--bare", str(self.root / "remote.git"), cwd=self.root)
        self.git("init", "--quiet", "-b", "main", str(self.work), cwd=self.root)
        for path in (".githooks/pre-push", "scripts/changed-components.py", "scripts/install-git-hooks"):
            (self.work / path).parent.mkdir(exist_ok=True)
            shutil.copy(REPO / path, self.work / path)
        (self.work / "scripts/test-changed-components.py").write_text(STUB_SELF_TEST)
        for path in ("web/.keep", "relay/.keep"):
            self.write(path)
        for setting in (("user.name", "Synthetic"), ("user.email", "test@example.invalid"), ("commit.gpgsign", "false")):
            self.git("config", *setting)
        self.git("add", ".")
        self.git("commit", "--quiet", "-m", "base")
        self.git("remote", "add", "origin", str(self.root / "remote.git"))
        self.git("push", "--quiet", "origin", "main")
        subprocess.run(["scripts/install-git-hooks"], cwd=self.work, env=self.env, check=True)

    def git(self, *args, cwd=None):
        return subprocess.run(["git", *args], cwd=cwd or self.work, env=self.env, text=True, capture_output=True, check=True).stdout

    def write(self, path, cwd=None):
        file = (cwd or self.work) / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text("synthetic\n")

    def commit_on_new_branch(self, branch, path, cwd=None):
        self.git("switch", "--quiet", "-c", branch, "main", cwd=cwd)
        self.write(path, cwd)
        self.git("add", ".", cwd=cwd)
        self.git("commit", "--quiet", "-m", path, cwd=cwd)

    def push(self, *refspecs, cwd=None):
        self.log.write_text("")
        return subprocess.run(["git", "push", "origin", *refspecs], cwd=cwd or self.work, env=self.env, text=True, capture_output=True)

    def checks(self):
        return self.log.read_text().splitlines()

    def on_remote(self, ref):
        return self.git("ls-remote", "origin", ref) != ""

    def test_a_diff_runs_only_the_checks_its_components_select(self):
        cases = [
            ("web/packages/frontend/src/x.ts", [CONTRACTS_BUILD, *FRONTEND]),
            # The router sends server and contracts changes to the frontend job too: the frontend typechecks their source.
            ("web/packages/server/src/x.ts", WEB),
            ("web/packages/contracts/src/x.ts", WEB),
            ("relay/convex/x.ts", RELAY),
            ("scripts/check", TOOLING),
            ("unknown/x.txt", EVERY_CHECK),
            # No suite for documentation, and no App build in the hook.
            ("docs/x.md", []),
            ("app/Talaria/x.swift", []),
        ]
        for index, (path, expected) in enumerate(cases):
            with self.subTest(path):
                self.commit_on_new_branch(f"case-{index}", path)
                result = self.push(f"case-{index}")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.checks(), expected)

    def test_an_unreadable_diff_runs_every_check(self):
        self.commit_on_new_branch("feature", "docs/x.md")
        self.git("update-ref", "-d", "refs/remotes/origin/main")
        result = self.push("feature")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.checks(), EVERY_CHECK)

    def test_each_check_reports_its_duration(self):
        self.commit_on_new_branch("feature", "relay/convex/x.ts")
        self.assertRegex(self.push("feature").stderr, r"pnpm typecheck\b.*\(\d+s\)")

    def test_a_failing_check_rejects_the_push_from_any_worktree(self):
        failing = "web: npm run lint -w packages/frontend"
        self.env["STUB_FAIL"] = failing
        linked = self.root / "linked"
        self.git("worktree", "add", "--quiet", "--detach", str(linked), "main")
        for checkout, branch in ((self.work, "from-main-checkout"), (linked, "from-linked-worktree")):
            with self.subTest(branch):
                self.commit_on_new_branch(branch, "web/packages/frontend/src/x.ts", cwd=checkout)
                result = self.push(branch, cwd=checkout)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("stub check output", result.stderr)
                # The first failure stops the run, and nothing reaches the remote.
                self.assertEqual(self.checks()[-1], failing)
                self.assertFalse(self.on_remote(f"refs/heads/{branch}"))

    def test_deleting_a_branch_or_pushing_a_tag_runs_no_checks(self):
        self.commit_on_new_branch("feature", "web/packages/frontend/src/x.ts")
        self.git("tag", "v0.0.1")
        self.assertEqual(self.push("v0.0.1").returncode, 0)
        self.assertEqual(self.checks(), [])

        self.git("push", "--quiet", "origin", "feature")
        self.assertEqual(self.push(":feature").returncode, 0)
        self.assertEqual(self.checks(), [])
        self.assertFalse(self.on_remote("refs/heads/feature"))

    def test_a_branch_other_than_head_is_rejected_because_the_checkout_cannot_prove_it(self):
        self.commit_on_new_branch("feature", "web/packages/frontend/src/x.ts")
        self.git("switch", "--quiet", "main")
        result = self.push("feature")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("feature", result.stderr)
        self.assertEqual(self.checks(), [])
        self.assertFalse(self.on_remote("refs/heads/feature"))


if __name__ == "__main__":
    unittest.main()
