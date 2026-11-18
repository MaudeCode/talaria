"""Nightly source selection (TAL-1569) over a synthetic local Git history."""

import contextlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from nightly import TAG, select, verify


class NightlyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="talaria-nightly-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.git("init", "-b", "main")
        self.git("tag", "app-v1.21.0", self.commit("README.md"))
        self.git("tag", "app-v1.9.9")

    def git(self, *args):
        return subprocess.check_output([
            "git", "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid",
            "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", *args,
        ], cwd=self.root, env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"},
            text=True, stderr=subprocess.PIPE).strip()

    def commit(self, path):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f"{path} {len(self.git('log', '--oneline').splitlines()) if (self.root / '.git/refs/heads/main').exists() else 0}\n")
        self.git("add", ".")
        self.git("commit", "-m", path)
        return self.git("rev-parse", "HEAD")

    def test_a_first_run_with_nothing_green_does_nothing(self):
        self.assertEqual(select(self.root, []), {"changed": "false", "source": ""})

    def test_the_first_run_selects_the_newest_green_commit_and_uploads_the_app(self):
        first = self.git("rev-parse", "HEAD")
        newest = self.commit("docs/guide.md")
        self.git("checkout", "-q", "-b", "side", first)
        side = self.commit("app/Talaria/Side.swift")
        self.git("checkout", "-q", "main")
        self.assertEqual(select(self.root, [first, "e" * 40, side, newest]),
                         {"changed": "true", "source": newest, "app": "true", "app_version": "1.21.1"})

    def test_a_later_run_uploads_only_when_the_app_changed_since_the_last_nightly(self):
        self.git("tag", TAG)
        previous = self.git("rev-parse", "HEAD")
        docs = self.commit("docs/guide.md")
        self.assertEqual(select(self.root, [previous, docs]), {"changed": "true", "source": docs, "app": "false", "app_version": "1.21.1"})
        app = self.commit("app/Talaria/View.swift")
        self.assertEqual(select(self.root, [docs, app])["app"], "true")
        # Nothing green after the last Nightly: only Web's tag is refreshed against the recorded source.
        self.assertEqual(select(self.root, [previous]), {"changed": "false", "source": previous})
        self.assertEqual(select(self.root, []), {"changed": "false", "source": previous})

    def test_verify_checks_the_nightly_identity_and_writes_the_app_notes_since_the_last_app_release(self):
        self.write_fragment()
        source = self.commit("app/Talaria/View.swift")
        ipa = self.root / "export/Talaria.ipa"
        ipa.parent.mkdir()
        ipa.write_bytes(b"synthetic")
        notes = self.root / "notes/testflight.txt"
        identity = {"version": "1.21.1", "buildNumber": 7, "sourceRevision": source, "releaseSet": source}
        with contextlib.chdir(self.root), patch("nightly.verify_ipa", return_value="f" * 64) as verified:
            verify(ipa, "1.21.1", 7, source, notes)
        verified.assert_called_once_with(ipa, identity, keys=tuple(identity))
        self.assertEqual(notes.read_text(), "Changes since app-v1.21.0\n\nAdded\n- Nightly feature\n")
        notes.unlink()
        with contextlib.chdir(self.root), patch("nightly.verify_ipa", side_effect=ValueError("IPA identity differs from the release plan")):
            with self.assertRaisesRegex(ValueError, "identity differs"):
                verify(ipa, "1.21.1", 7, source, notes)
        self.assertFalse(notes.exists(), "no notes, so nothing uploads, for an IPA that fails its identity check")

    def write_fragment(self):
        fragment = self.root / "changelog.d/TAL-5.json"
        fragment.parent.mkdir()
        fragment.write_text(json.dumps({"entries": [
            {"category": "Added", "summary": "Nightly feature", "highlight": False, "announce": False}]}))


if __name__ == "__main__":
    unittest.main()
