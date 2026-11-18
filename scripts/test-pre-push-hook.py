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
SERVER_BUILD = "web: npm run build -w packages/server"
SERVER = [
    "web: npm run lint -w packages/contracts",
    "web: npm run typecheck -w packages/contracts",
    "web: npm run lint -w packages/server",
    "web: npm run typecheck -w packages/server",
]
FRONTEND = [
    "web: npm run lint -w packages/frontend",
    "web: npm run typecheck -w packages/frontend",
]
RELAY = ["relay: pnpm typecheck"]
TOOLING = ["self-test"]
WEB_CHECKS = [*SERVER, *FRONTEND]
WEB = [CONTRACTS_BUILD, SERVER_BUILD, *WEB_CHECKS]
APP = ["repo: node scripts/check-ui-rules.mjs --config app/ci/ui-rules.json"]
EVERY_CHECK = [*APP, *WEB, *RELAY, *TOOLING]

STUB_TOOL = """#!/bin/sh
if [ "$1" = --version ]; then
  echo "$STUB_VERSION"
  exit
fi
entry="${PWD##*/}: ${0##*/} $*"
[ "${0##*/}" != node ] || entry="repo: node $*"
echo "$entry" >>"$STUB_LOG"
if [ "$entry" = "web: npm run build -w packages/server" ]; then
  mkdir -p packages/server/dist
  echo "$STUB_BUILD_OUTPUT" >packages/server/dist/index.d.ts
fi
if [ "$entry" = "$STUB_EDIT" ]; then
  echo "edited while the check ran" >>packages/server/src/x.ts
fi
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
        self.env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1", STUB_LOG=str(self.log), STUB_FAIL="",
                        STUB_EDIT="", STUB_VERSION="v24.0.0", STUB_BUILD_OUTPUT="server build")
        stubs = self.root / "bin"
        stubs.mkdir()
        for tool in ("npm", "pnpm", "node"):
            (stubs / tool).write_text(STUB_TOOL)
            (stubs / tool).chmod(0o755)
        self.env["PATH"] = f"{stubs}{os.pathsep}{self.env['PATH']}"

        self.git("init", "--quiet", "--bare", str(self.root / "remote.git"), cwd=self.root)
        self.git("init", "--quiet", "-b", "main", str(self.work), cwd=self.root)
        for path in (".githooks/pre-push", "scripts/changed-components.py", "scripts/install-git-hooks", "web/.gitignore"):
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
        # npm ci records the installed dependency tree here; web/.gitignore ignores it.
        self.write("web/node_modules/.package-lock.json")

    def git(self, *args, cwd=None):
        return subprocess.run(["git", *args], cwd=cwd or self.work, env=self.env, text=True, capture_output=True, check=True).stdout

    def write(self, path, cwd=None, text="synthetic\n"):
        file = (cwd or self.work) / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text)

    def commit(self, path, text="synthetic\n"):
        self.write(path, text=text)
        self.git("add", "--", path)  # Leave dirty and untracked files uncommitted.
        self.git("commit", "--quiet", "-m", path)

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
            ("web/packages/frontend/src/x.ts", [CONTRACTS_BUILD, SERVER_BUILD, *FRONTEND]),
            # The router sends server and contracts changes to the frontend job too: the frontend typechecks their source.
            ("web/packages/server/src/x.ts", WEB),
            ("web/packages/contracts/src/x.ts", WEB),
            ("relay/convex/x.ts", RELAY),
            ("scripts/check", TOOLING),
            ("unknown/x.txt", EVERY_CHECK),
            # App paths run the UI rules check without an App build.
            ("docs/x.md", []),
            ("app/Talaria/x.swift", APP),
            ("app/ci/ui-rules.json", [*APP, CONTRACTS_BUILD, SERVER_BUILD, *FRONTEND, *TOOLING]),
            ("app/AGENTS.md", APP),
            ("scripts/check-ui-rules.mjs", [*APP, CONTRACTS_BUILD, SERVER_BUILD, *FRONTEND, *TOOLING]),
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

    def push_app_fix(self, branch):
        """A review fix that touches only the App, on a branch whose Web changes still select the Web checks."""
        self.commit("app/Talaria/fix.swift", text=self.git("rev-parse", "HEAD"))
        return self.push(branch)

    def test_an_app_only_follow_up_reuses_the_web_checks_that_passed_on_the_same_inputs(self):
        self.commit_on_new_branch("feature", "web/packages/server/src/x.ts")
        first = self.push("feature")
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(self.checks(), WEB)
        self.assertRegex(first.stderr, r"npm run lint -w packages/frontend ok \(\d+s\)")

        second = self.push_app_fix("feature")
        self.assertEqual(second.returncode, 0, second.stderr)
        # Branch-wide routing still selects Web, and the builds still run because later checks read their outputs.
        self.assertEqual(self.checks(), [*APP, CONTRACTS_BUILD, SERVER_BUILD])
        for check in WEB_CHECKS:
            self.assertIn(f"pre-push: {check.removeprefix('web: ')} reused", second.stderr)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.git("ls-remote", "origin", "refs/heads/feature").split()[0] + "\n")

    def test_any_change_to_what_the_web_checks_read_runs_them_again(self):
        generated = "web/packages/frontend/src/theme/fonts/generated/font.woff2"
        self.write(generated)
        self.commit_on_new_branch("feature", "web/packages/server/src/x.ts")
        self.assertEqual(self.push("feature").returncode, 0)
        receipts = self.work / ".git/pre-push-receipts"
        every_check = [*APP, *WEB]
        cases = [
            ("committed source", lambda: self.commit("web/packages/frontend/src/y.ts"), every_check),
            ("committed config", lambda: self.commit("web/.oxlintrc.json"), every_check),
            ("dirty tracked file", lambda: self.write("web/packages/server/src/x.ts", text="dirty\n"), every_check),
            ("dirty shared contract", lambda: self.write("contracts/fixtures/x.json"), every_check),
            ("untracked file", lambda: self.write("web/packages/frontend/src/untracked.ts"), every_check),
            ("installed dependencies", lambda: self.write("web/node_modules/.package-lock.json", text="upgraded\n"),
             every_check),
            ("toolchain", lambda: self.env.update(STUB_VERSION="v24.1.0"), every_check),
            ("build output", lambda: self.env.update(STUB_BUILD_OUTPUT="different server build"), every_check),
            ("removed generated file", lambda: (self.work / generated).unlink(), every_check),
            ("invalid receipts", lambda: [receipt.write_text("invalid\n") for receipt in receipts.iterdir()], every_check),
        ]
        for name, change, expected in cases:
            with self.subTest(name):
                change()
                result = self.push_app_fix("feature")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.checks(), expected)
        # Each rerun's pass is reusable again, so no case above ran the checks for a reason of its own.
        self.push_app_fix("feature")
        self.assertEqual(self.checks(), [*APP, CONTRACTS_BUILD, SERVER_BUILD])

    def test_a_failed_check_never_authorizes_a_later_push(self):
        self.commit_on_new_branch("feature", "web/packages/server/src/x.ts")
        self.assertEqual(self.push("feature").returncode, 0)
        failing = "web: npm run lint -w packages/frontend"
        self.env["STUB_FAIL"] = failing
        self.write("web/packages/frontend/src/x.ts", text="broken\n")
        for attempt in ("first", "same inputs again"):
            with self.subTest(attempt):
                result = self.push_app_fix("feature")
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.checks()[-1], failing)
                self.assertNotEqual(self.git("rev-parse", "HEAD"),
                                    self.git("ls-remote", "origin", "refs/heads/feature").split()[0] + "\n")

    def test_a_check_whose_inputs_changed_while_it_ran_runs_again(self):
        edited = "web: npm run lint -w packages/frontend"
        self.env["STUB_EDIT"] = edited
        self.commit_on_new_branch("feature", "web/packages/server/src/x.ts")
        self.assertEqual(self.push("feature").returncode, 0)
        self.env["STUB_EDIT"] = ""
        self.push_app_fix("feature")
        self.assertIn(edited, self.checks())

    def test_deleting_a_branch_or_pushing_a_tag_runs_no_checks(self):
        self.commit_on_new_branch("feature", "web/packages/server/src/x.ts")
        self.git("tag", "v0.0.1")
        self.assertEqual(self.push("v0.0.1").returncode, 0)
        self.assertEqual(self.checks(), [])

        self.git("push", "--quiet", "origin", "feature")
        self.assertEqual(self.push(":feature").returncode, 0)
        self.assertEqual(self.checks(), [])
        self.assertFalse(self.on_remote("refs/heads/feature"))

    def test_a_branch_other_than_head_is_rejected_because_the_checkout_cannot_prove_it(self):
        self.commit_on_new_branch("feature", "web/packages/server/src/x.ts")
        self.git("switch", "--quiet", "main")
        result = self.push("feature")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("feature", result.stderr)
        self.assertEqual(self.checks(), [])
        self.assertFalse(self.on_remote("refs/heads/feature"))


if __name__ == "__main__":
    unittest.main()
