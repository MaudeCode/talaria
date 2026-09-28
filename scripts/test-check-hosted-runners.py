#!/usr/bin/env python3
"""Hosted-runner guard over synthetic workflows and the real repository."""

import importlib.util
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("check-hosted-runners.py")
spec = importlib.util.spec_from_file_location("hosted", SCRIPT)
hosted = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hosted)


class HostedRunnerTests(unittest.TestCase):
    def check(self, workflows, scope=("ci.yml",)):
        with tempfile.TemporaryDirectory(prefix="talaria-hosted-") as temporary:
            root = Path(temporary)
            (root / ".github/workflows").mkdir(parents=True)
            for name, text in workflows.items():
                (root / ".github/workflows" / name).write_text(text)
            return hosted.violations(root, scope)

    def test_hosted_labels_pass(self):
        self.assertEqual(self.check({"ci.yml": """
on: [push, pull_request]
jobs:
  linux: {runs-on: ubuntu-latest, steps: [{run: "true"}]}
  mac: {runs-on: xcode-27, steps: [{run: "true"}]}
  listed: {runs-on: [macos-latest], steps: [{run: "true"}]}
  matrix:
    strategy: {matrix: {os: [ubuntu-24.04, macos-26]}}
    runs-on: ${{ matrix.os }}
    steps: [{run: "true"}]
"""}), [])

    def test_self_hosted_labels_fail_for_any_event(self):
        found = self.check({"ci.yml": """
on: [push, pull_request]
jobs:
  plain: {runs-on: maude-mac, steps: [{run: "true"}]}
  listed: {runs-on: [self-hosted, linux], steps: [{run: "true"}]}
  pool: {runs-on: ["ghar-set-maudecode"], steps: [{run: "true"}]}
  by-event:
    runs-on: ${{ github.event_name == 'push' && 'maude-mac' || 'ubuntu-latest' }}
    steps: [{run: "true"}]
  by-matrix:
    strategy: {matrix: {os: [ubuntu-latest], include: [{os: ghar-set-maudecode}]}}
    runs-on: ${{ matrix.os }}
    steps: [{run: "true"}]
  group: {runs-on: {group: private}, steps: [{run: "true"}]}
  unresolved: {runs-on: "${{ inputs.runner }}", steps: [{run: "true"}]}
"""})
        flagged = {line.split(" job ")[1].split(" ")[0] for line in found}
        self.assertEqual(flagged, {"plain", "listed", "pool", "by-event", "by-matrix", "group", "unresolved"}, found)
        self.assertFalse(any("'push'" in line or "'ubuntu-latest'" in line for line in found), found)

    def test_reusable_workflows_are_followed(self):
        found = self.check({
            "ci.yml": "on: pull_request\njobs:\n  web: {uses: ./.github/workflows/child.yml}\n"
                      "  remote: {uses: example/repo/.github/workflows/x.yml@v1}\n",
            "child.yml": "on: workflow_call\njobs:\n  test: {runs-on: maude-mac, steps: [{run: \"true\"}]}\n",
            "outside.yml": "on: push\njobs:\n  release: {runs-on: maude-mac, steps: [{run: \"true\"}]}\n",
        })
        self.assertEqual(len(found), 2, found)
        self.assertIn("child.yml: job test can run on 'maude-mac', which is not a GitHub-hosted runner", found)
        self.assertTrue(any("cannot follow" in line for line in found))
        self.assertFalse(any("outside.yml" in line for line in found))

    def test_nas_credentials_fail(self):
        found = self.check({"ci.yml": """
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps: [{run: "true", env: {KEY: "${{ secrets.TALARIA_CI_S3_ACCESS_KEY_ID }}", URL: "${{ vars.TALARIA_S3_ENDPOINT }}"}}]
"""})
        self.assertEqual(found, ["ci.yml: references TALARIA_S3_* or TALARIA_CI_S3_* NAS credentials"])

    def test_third_party_actions_must_be_sha_pinned(self):
        with tempfile.TemporaryDirectory(prefix="talaria-hosted-") as temporary:
            root = Path(temporary)
            (root / ".github/workflows").mkdir(parents=True)
            (root / ".github/actions/wrap").mkdir(parents=True)
            (root / ".github/actions/wrap/action.yml").write_text(
                "runs:\n  using: composite\n  steps:\n    - uses: example/inner@v2\n"
                "    - uses: example/inner@0123456789abcdef0123456789abcdef01234567\n")
            (root / ".github/workflows/ci.yml").write_text("""
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/cache/restore@v6
      - uses: example/pinned@0123456789abcdef0123456789abcdef01234567
      - uses: example/tagged@v1
      - uses: example/short@0123456
      - uses: docker://alpine:3
      - uses: ./.github/actions/wrap
      - run: "true"
""")
            found = hosted.violations(root, ("ci.yml",))
        self.assertEqual(found, [
            "ci.yml: job test: example/tagged@v1 is not pinned to a full commit SHA",
            "ci.yml: job test: example/short@0123456 is not pinned to a full commit SHA",
            "ci.yml: job test: docker://alpine:3 is not pinned to a full commit SHA",
            "./.github/actions/wrap: example/inner@v2 is not pinned to a full commit SHA",
        ])

    def test_missing_scoped_workflow_fails(self):
        self.assertEqual(self.check({}), ["ci.yml: workflow not found"])

    def test_repository_scope_is_hosted(self):
        self.assertEqual(hosted.violations(), [])

    def test_only_native_jobs_use_macos(self):
        # Hosted macOS allows five concurrent jobs, so each macOS job must still show the native work that
        # needs it; moving a portable job onto macOS fails here.
        native = {("ci.yml", "app-tooling"): "test-ios-simulator-pool", ("app-tests.yml", "app-build"): "ci/build-for-testing",
                  ("app-tests.yml", "app-test"): "xcodebuild"}
        found = {}
        for name in hosted.SCOPE:
            for job_name, job in hosted.load(hosted.ROOT / ".github/workflows" / name)["jobs"].items():
                if any(label.startswith(("macos", "xcode")) for label in hosted.runner_labels(job)):
                    found[(name, job_name)] = str(job["steps"])
        self.assertEqual(set(found), set(native))
        for job, dependency in native.items():
            self.assertIn(dependency, found[job], job)


if __name__ == "__main__":
    unittest.main()
