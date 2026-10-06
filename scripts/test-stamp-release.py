#!/usr/bin/env python3
"""Stamp App and Relay artifacts in disposable Git checkouts; never touches this checkout."""

import json
import os
import plistlib
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

REPOSITORY = Path(__file__).resolve().parent.parent
PLISTS = ("app/Talaria/Resources/Info.plist", "app/TalariaLiveActivityWidget/Resources/Info.plist")
RELAY = "relay/convex/releaseInfo.json"


class StampReleaseTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="talaria-stamp-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for name in ("scripts/stamp-release.py", "contracts/versions.json", RELAY, *PLISTS):
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(REPOSITORY / name, target)
        self.git("init", "-b", "main")
        self.source = self.commit("synthetic release source")

    def git(self, *args):
        return subprocess.check_output([
            "git", "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid",
            "-c", "commit.gpgsign=false", *args,
        ], cwd=self.root, env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"},
            text=True, stderr=subprocess.PIPE).strip()

    def commit(self, message):
        self.git("add", ".")
        self.git("commit", "-m", message)
        return self.git("rev-parse", "HEAD")

    def stamp(self, component, *options, version="1.2.3", source=None):
        return subprocess.run([sys.executable, "scripts/stamp-release.py", component, "--version", version,
                               "--source-revision", source or self.source, *options],
                              cwd=self.root, capture_output=True, text=True, check=False)

    def snapshot(self):
        return {name: (self.root / name).read_bytes() for name in (RELAY, *PLISTS)}

    def assert_refused(self, result, message, before):
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn(message, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertEqual(self.snapshot(), before)

    def test_app_stamps_both_bundles_once(self):
        stamped = self.stamp("app", "--build-number", "42")
        self.assertEqual(stamped.returncode, 0, stamped.stderr)
        metadata = json.loads(stamped.stdout)
        self.assertEqual((metadata["version"], metadata["buildNumber"], metadata["sourceRevision"]),
                         ("1.2.3", 42, self.source))
        for name in PLISTS:
            info = plistlib.loads((self.root / name).read_bytes())
            self.assertEqual(info["TalariaRelease"], metadata)
            self.assertEqual((info["CFBundleShortVersionString"], info["CFBundleVersion"]), ("1.2.3", "42"))
        source = self.commit("stamped artifact")
        # A second stamp would silently relabel a shipped build.
        before = self.snapshot()
        self.assert_refused(self.stamp("app", "--build-number", "43", source=source), "already stamped App", before)

    def test_app_refuses_a_partially_stamped_artifact_without_writing_either_bundle(self):
        widget = self.root / PLISTS[1]
        info = plistlib.loads(widget.read_bytes())
        info["TalariaRelease"] = {"sourceRevision": "a" * 40}
        widget.write_bytes(plistlib.dumps(info))
        source = self.commit("widget stamped by an earlier run")
        before = self.snapshot()
        self.assert_refused(self.stamp("app", "--build-number", "42", source=source), "already stamped App", before)

    def test_app_requires_a_positive_build_number(self):
        before = self.snapshot()
        for options in ((), ("--build-number", "0"), ("--build-number", "-1")):
            with self.subTest(options=options):
                self.assert_refused(self.stamp("app", *options), "positive build number", before)

    def test_relay_stamps_once_with_a_deployment_identity(self):
        before = self.snapshot()
        for options in ((), ("--deployment-id", "Prod"), ("--deployment-id", "1prod"), ("--deployment-id", "prod/../x")):
            with self.subTest(options=options):
                self.assert_refused(self.stamp("relay", *options), "Relay requires a deployment ID", before)
        stamped = self.stamp("relay", "--deployment-id", "synthetic-relay")
        self.assertEqual(stamped.returncode, 0, stamped.stderr)
        release = json.loads((self.root / RELAY).read_text())
        self.assertEqual((release["sourceRevision"], release["deploymentId"]), (self.source, "synthetic-relay"))
        source = self.commit("stamped relay")
        before = self.snapshot()
        self.assert_refused(self.stamp("relay", "--deployment-id", "synthetic-relay", source=source),
                            "already stamped Relay", before)

    def test_only_a_clean_checkout_of_the_named_source_with_a_release_version_is_stamped(self):
        before = self.snapshot()
        self.assert_refused(self.stamp("app", "--build-number", "1", source="0" * 40), "must match", before)
        for version in ("1.2", "v1.2.3", "01.2.3", "1.2.3-beta"):
            with self.subTest(version=version):
                self.assert_refused(self.stamp("app", "--build-number", "1", version=version), "X.Y.Z", before)
        (self.root / "untracked.txt").write_text("not part of the release source\n")
        self.assert_refused(self.stamp("app", "--build-number", "1"), "clean checkout", before)
        (self.root / "untracked.txt").unlink()
        (self.root / "contracts/versions.json").write_text("{}\n")
        self.assert_refused(self.stamp("relay", "--deployment-id", "synthetic-relay"), "clean checkout", before)


if __name__ == "__main__":
    unittest.main()
