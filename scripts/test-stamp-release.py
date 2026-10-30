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
GENERATOR = ("app/ci/release_notes.py", "contracts/whats-new.schema.json")
ANNOUNCED = {"entries": [{"category": "Added", "summary": "Pin chats.", "highlight": False,
                          "announcement": {"title": "Pinned chats", "description": "Keep favorites on top.", "icon": "chat"}}]}


class StampReleaseTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="talaria-stamp-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for name in ("scripts/stamp-release.py", "contracts/versions.json", RELAY, *PLISTS, *GENERATOR):
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(REPOSITORY / name, target)
        self.git("init", "-b", "main")
        self.commit("synthetic previous release")
        self.git("tag", "app-v1.0.0")
        self.write_fragment(2, ANNOUNCED)
        self.source = self.commit("TAL-2: synthetic release source")

    def write_fragment(self, number, data):
        path = self.root / f"changelog.d/TAL-{number}.json"
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(data))

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

    def announcement(self, version="1.2.3"):
        """What the release-note generator writes for this checkout, as the stamp must package it byte for byte."""
        output = self.root.parent / f"{self.root.name}-announcement.json"
        self.addCleanup(output.unlink, missing_ok=True)
        subprocess.run([sys.executable, "app/ci/release_notes.py", "announcement", "--component", "app", "--target", "HEAD",
                        "--version", version, "--output", str(output)], cwd=self.root, check=True, capture_output=True)
        return output.read_text() if output.exists() else None

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

    def test_app_packages_the_generated_announcement_in_the_app_bundle_only(self):
        expected = self.announcement()
        self.assertEqual(json.loads(expected)["rows"][0]["id"], "TAL-2-1")
        stamped = self.stamp("app", "--build-number", "7")
        self.assertEqual(stamped.returncode, 0, stamped.stderr)
        app, widget = (plistlib.loads((self.root / name).read_bytes()) for name in PLISTS)
        self.assertEqual(app["TalariaWhatsNew"], expected)
        self.assertNotIn("TalariaWhatsNew", widget)

    def test_app_without_announced_rows_or_a_baseline_packages_nothing_or_refuses(self):
        self.git("tag", "app-v1.2.3")
        self.write_fragment(3, {"skip": "Repository tooling only."})
        source = self.commit("TAL-3: skip only")
        self.assertIsNone(self.announcement("1.2.4"))
        stamped = self.stamp("app", "--build-number", "8", version="1.2.4", source=source)
        self.assertEqual(stamped.returncode, 0, stamped.stderr)
        self.assertNotIn("TalariaWhatsNew", plistlib.loads((self.root / PLISTS[0]).read_bytes()))
        self.git("checkout", "--", ".")
        for tag in ("app-v1.0.0", "app-v1.2.3"):
            self.git("tag", "-d", tag)
        before = self.snapshot()
        self.assert_refused(self.stamp("app", "--build-number", "9", version="1.2.4", source=source),
                            "What's New announcement: no preceding semantic release tag", before)

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
