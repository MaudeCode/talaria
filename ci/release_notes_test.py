#!/usr/bin/env python3
"""Offline CLI checks in disposable, deterministic Git repositories."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("release_notes.py").resolve()


class ReleaseNotesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = {
            "PATH": os.environ["PATH"],
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_AUTHOR_NAME": "Fixture", "GIT_COMMITTER_NAME": "Fixture",
            "GIT_AUTHOR_EMAIL": "fixture@example.invalid", "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
            "GIT_AUTHOR_DATE": "2026-01-02T03:04:05+00:00", "GIT_COMMITTER_DATE": "2026-01-02T03:04:05+00:00",
        }
        self.git("init", "-b", "main")
        self.write("CHANGELOG.md", "# Handwritten history\n\nUnchanged.\n")
        self.add_fragment(1, "Old release")
        self.commit("TAL-1: old release")
        self.git("tag", "v1.0.0")

    def run_command(self, *args):
        return subprocess.run(args, cwd=self.root, env=self.env, capture_output=True, text=True)

    def git(self, *args):
        result = self.run_command("git", *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def write(self, name, value):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)

    def add_fragment(self, number, summary="A new capability", category="Added", highlight=False):
        self.write(f"changelog.d/TAL-{number}.json", json.dumps({"entries": [
            {"category": category, "summary": summary, "highlight": highlight}
        ]}))

    def commit(self, message):
        self.git("add", ".")
        self.git("commit", "-m", message)

    def cli(self, *args, error=None):
        result = self.run_command(sys.executable, str(SCRIPT), *args)
        if error:
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(error, result.stderr)
        else:
            self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def generate(self, *args, **kwargs):
        return self.cli("generate", "--target", "HEAD", "--version", "1.1.0", "--output", "out", *args, **kwargs)

    def test_adjacent_tags_order_highlights_multiple_entries_and_determinism(self):
        self.add_fragment(10, "Reconnect safely", "Fixed")
        self.add_fragment(2, "New boards", highlight=True)
        data = {"entries": [
            {"category": "Security", "summary": "Protect tokens", "highlight": True},
            {"category": "Changed", "summary": "Clearer settings", "highlight": False},
        ]}
        self.write("changelog.d/TAL-3.json", json.dumps(data))
        self.write("changelog.d/TAL-4.json", '{"skip": "Repository tooling only"}')
        self.commit("TAL-2, TAL-3, TAL-4, TAL-10: describe outcomes")
        self.git("tag", "v1.1.0")
        self.cli("validate", "--base", "v1.0.0")
        self.generate()
        markdown = (self.root / "out/release-notes.md").read_text()
        self.assertEqual(markdown, "## [1.1.0] - 2026-01-02\n\n### Featured\n\n- New boards\n- Protect tokens\n\n### Added\n\n- New boards\n\n### Changed\n\n- Clearer settings\n\n### Fixed\n\n- Reconnect safely\n\n### Security\n\n- Protect tokens\n")
        catalog_bytes = (self.root / "out/release-notes.json").read_bytes()
        catalog = json.loads(catalog_bytes)
        self.assertEqual(catalog["schemaVersion"], 1)
        release = catalog["releases"][0]
        self.assertEqual(release["version"], "1.1.0")
        self.assertEqual([entry["ticket"] for entry in release["highlights"]], ["TAL-2", "TAL-3"])
        self.assertNotIn("Old release", markdown)
        self.assertNotIn("Repository tooling only", markdown)
        self.assertEqual((self.root / "CHANGELOG.md").read_text(), "# Handwritten history\n\nUnchanged.\n")
        # Working-tree changes cannot contaminate a release generated from Git.
        self.write("changelog.d/TAL-2.json", "malformed")
        self.generate("--previous", "v1.0.0")
        self.assertEqual((self.root / "out/release-notes.json").read_bytes(), catalog_bytes)
        self.add_fragment(20, "Next release only")
        self.commit("TAL-20: next capability")
        # Restore the deliberately malformed file for a valid target tree.
        self.git("checkout", "v1.1.0", "--", "changelog.d/TAL-2.json")
        self.commit("Restore fixture")
        self.cli("generate", "--target", "HEAD", "--version", "1.2.0", "--output", "out")
        next_notes = (self.root / "out/release-notes.md").read_text()
        self.assertIn("Next release only", next_notes)
        self.assertNotIn("New boards", next_notes)

    def test_schema_failures_are_actionable(self):
        cases = [
            ('{', "Expecting"),
            ('{"skip":"first", "skip":"second"}', "duplicate JSON key"),
            ('{"entries":[]}', "non-empty"),
            ('{"skip":" "}', "skip reason"),
            ('{"skip":"reason", "entries":[]}', "OR"),
            ('{"entries":[{"category":"Other","summary":"Text","highlight":false}]}', "unsupported category"),
            ('{"entries":[{"category":"Fixed","summary":"","highlight":false}]}', "summary"),
            ('{"entries":[{"category":"Fixed","summary":"Text","highlight":1}]}', "highlight"),
            ('{"entries":[{"category":"Fixed","summary":"Text"}]}', "requires only"),
            ('{"entries":[{"category":"Fixed","summary":"Line\\nbreak","highlight":false}]}', "single line"),
        ]
        for source, error in cases:
            with self.subTest(source=source):
                self.write("changelog.d/TAL-2.json", source)
                result = self.cli("validate", error=error)
                self.assertIn("changelog.d/TAL-2.json", result.stderr)
        (self.root / "changelog.d/TAL-2.json").unlink()
        self.write("changelog.d/wrong.json", '{"skip":"Docs"}')
        self.cli("validate", error="TAL-<number>.json")

    def test_generator_validates_committed_schema_and_numeric_entry_order(self):
        self.add_fragment(10, "Later ticket")
        self.add_fragment(2, "Earlier ticket")
        self.commit("TAL-2, TAL-10: additions")
        self.generate()
        notes = (self.root / "out/release-notes.md").read_text()
        self.assertLess(notes.index("Earlier ticket"), notes.index("Later ticket"))
        self.write("changelog.d/TAL-10.json", '{"skip":"first", "skip":"second"}')
        self.commit("TAL-10: invalid metadata")
        self.generate(error="duplicate JSON key")

    def test_missing_metadata_and_repository_skip(self):
        self.write("README.md", "Documentation\n")
        self.write(".codex/environments/environment.toml", "# Local agent tooling\n")
        self.write(".xcodebuildmcp/config.yaml", "# Local test runner settings\n")
        self.commit("TAL-2: documentation")
        self.cli("validate", "--base", "v1.0.0", error="missing release metadata")
        self.generate(error="missing release fragments")
        self.write("changelog.d/TAL-2.json", '{"skip":"Documentation only"}')
        self.commit("TAL-2: describe skip")
        self.cli("validate", "--base", "v1.0.0")
        self.generate()
        self.assertEqual(json.loads((self.root / "out/release-notes.json").read_text())["releases"][0]["sections"], [])
        self.assertNotIn("###", (self.root / "out/release-notes.md").read_text())

    def test_app_changes_cannot_use_only_skip_or_another_tickets_metadata(self):
        self.write("Talaria/Feature.swift", "// fixture\n")
        self.write("changelog.d/TAL-2.json", '{"skip":"Docs only"}')
        self.commit("TAL-2: change app")
        self.cli("validate", "--base", "v1.0.0", error="require user-facing entries")
        self.add_fragment(3)
        self.commit("TAL-3, TAL-4: more changes")
        self.cli("validate", "--base", "v1.0.0", error="TAL-4")

    def test_existing_fragments_cannot_be_changed_deleted_or_renamed(self):
        for action in ("change", "delete", "rename"):
            with self.subTest(action=action):
                self.git("reset", "--hard", "v1.0.0")
                if action == "change":
                    self.add_fragment(1, "Rewritten history")
                elif action == "delete":
                    (self.root / "changelog.d/TAL-1.json").unlink()
                else:
                    (self.root / "changelog.d/TAL-1.json").rename(self.root / "changelog.d/TAL-2.json")
                self.commit("TAL-2: invalid old fragment")
                self.cli("validate", "--base", "v1.0.0", error="out-of-range fragment")
                self.generate(error="out-of-range fragment")

    def test_previous_tag_uses_numeric_version_and_reachable_history(self):
        self.git("tag", "v1.0.9")
        self.git("tag", "v1.0.10")
        self.git("tag", "v1.0.99-beta")
        self.git("switch", "-c", "unmerged")
        self.write("branch.md", "Unmerged\n")
        self.commit("Unmerged")
        self.git("tag", "v1.0.99")
        self.git("switch", "main")
        self.add_fragment(2)
        self.commit("TAL-2: release")
        self.assertIn("v1.0.10..", self.generate().stdout)
        self.generate("--previous", "v1.0.99", error="strict ancestor")
        self.generate("--previous", "HEAD", error="strict ancestor")
        self.generate("--version", "01.1.0", error="X.Y.Z")

    def test_no_previous_tag_requires_explicit_baseline(self):
        self.git("tag", "-d", "v1.0.0")
        baseline = self.git("rev-parse", "HEAD")
        self.add_fragment(2)
        self.commit("TAL-2: release")
        self.generate(error="no preceding semantic release tag")
        self.generate("--previous", baseline)

    def test_markdown_escapes_authored_text_but_json_preserves_it(self):
        summary = "# Use <script> & [links](url) with *literal* text"
        self.add_fragment(2, summary)
        self.commit("TAL-2: plain text")
        self.generate()
        markdown = (self.root / "out/release-notes.md").read_text()
        self.assertIn("- \\# Use", markdown)
        self.assertIn("&lt;script&gt; &amp; \\[links\\]", markdown)
        release = json.loads((self.root / "out/release-notes.json").read_text())["releases"][0]
        self.assertEqual(release["sections"][0]["entries"][0]["summary"], summary)


if __name__ == "__main__":
    unittest.main()
