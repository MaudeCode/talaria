"""Nightly source selection (TAL-1569) over a synthetic local Git history."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from nightly import TAG, select


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
        # Nothing green after the last Nightly: the run does nothing.
        self.assertEqual(select(self.root, [previous]), {"changed": "false"})
        self.assertEqual(select(self.root, []), {"changed": "false"})


if __name__ == "__main__":
    unittest.main()
