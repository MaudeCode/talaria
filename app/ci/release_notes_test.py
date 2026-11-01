#!/usr/bin/env python3
"""Offline CLI checks in disposable, deterministic Git repositories."""

import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile


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
        self.write(".gitignore", "out/\n")
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

    def test_app_relocation_preserves_history_and_rejects_fragment_edits(self):
        self.write("Talaria/App.swift", "// unchanged app\n")
        self.commit("fixture app")
        base = self.git("rev-parse", "HEAD")
        (self.root / "app").mkdir()
        self.git("mv", "changelog.d", "app/changelog.d")
        self.git("mv", "Talaria", "app/Talaria")
        self.write("app/changelog.d/TAL-2.json", '{"skip":"Source relocation only"}')
        self.commit("TAL-2: move app")
        self.cli("validate", "--base", base)
        self.generate("--previous", base)
        notes = json.loads((self.root / "out/release-notes.json").read_text())
        self.assertEqual(notes["releases"][0]["sections"], [])
        # Running from app/ must still resolve committed paths from the Git root.
        result = subprocess.run([sys.executable, str(SCRIPT), "validate", "--base", base],
                                cwd=self.root / "app", env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        # Shared release fragments can move back to the monorepo root without
        # changing their historical identities or breaking app/ invocations.
        moved_base = self.git("rev-parse", "HEAD")
        self.git("mv", "app/changelog.d", "changelog.d")
        self.write("changelog.d/TAL-3.json", '{"skip":"Shared release metadata"}')
        self.commit("TAL-3: share fragments")
        self.cli("validate", "--base", moved_base)
        self.write("changelog.d/TAL-1.json", '{"skip":"Rewritten history"}')
        self.cli("validate", "--base", base, error="out-of-range")

    def test_component_notes_share_fragments_without_changing_app_catalog_shape(self):
        entries = [
            {"category": "Added", "summary": "App detail", "highlight": False},
            {"category": "Fixed", "summary": "Web update", "highlight": False, "components": ["web"]},
            {"category": "Changed", "summary": "Shared compatibility", "highlight": True,
             "components": ["app", "web", "relay"]},
        ]
        self.write("changelog.d/TAL-2.json", json.dumps({"entries": entries}))
        self.commit("TAL-2: component releases")
        for component, expected in (
            ("app", {"App detail", "Shared compatibility"}),
            ("web", {"Web update", "Shared compatibility"}),
            ("relay", {"Shared compatibility"}),
        ):
            self.generate("--previous", "v1.0.0", "--component", component)
            catalog = json.loads((self.root / "out/release-notes.json").read_text())
            rendered = [entry for section in catalog["releases"][0]["sections"] for entry in section["entries"]]
            self.assertEqual({entry["summary"] for entry in rendered}, expected)
            self.assertTrue(all("components" not in entry for entry in rendered))

    def test_component_selection_rejects_empty_unknown_and_duplicate_owners(self):
        for components in ([], ["unknown"], ["web", "web"], "web"):
            self.write("changelog.d/TAL-2.json", json.dumps({"entries": [
                {"category": "Fixed", "summary": "Fixture", "highlight": False, "components": components}
            ]}))
            self.cli("validate", error="components")

    def test_app_tag_preview_uses_its_namespace_and_legacy_history(self):
        self.git("tag", "app-v1.0.10")
        self.git("tag", "web-v9.0.0")
        self.git("tag", "relay-v9.0.0")
        self.add_fragment(2)
        self.commit("TAL-2: app update")
        self.assertIn("app-v1.0.10..", self.generate().stdout)

    def mock_github(self, responses):
        binary = self.root / "bin/gh"
        binary.parent.mkdir(exist_ok=True)
        binary.write_text(
            f"#!{sys.executable}\n"
            "import json, sys\n"
            "from pathlib import Path\n"
            "assert sys.argv[1] == 'api'\n"
            "responses = json.loads(Path(__file__).with_name('responses.json').read_text())\n"
            "response = responses[sys.argv[2]]\n"
            "if isinstance(response, dict) and 'zip' in response:\n"
            "    assert len(sys.argv) == 3\n"
            "    sys.stdout.buffer.write(bytes.fromhex(response['zip']))\n"
            "else:\n"
            "    assert sys.argv[3:] == ['--paginate', '--slurp']\n"
            "    print(json.dumps(response))\n"
        )
        binary.chmod(0o755)
        binary.with_name("responses.json").write_text(json.dumps(responses))
        self.env["PATH"] = str(binary.parent) + os.pathsep + os.environ["PATH"]

    def published_responses(self, runs, jobs):
        root = "repos/fixture/app/actions"
        # Separate pages exercise CLI pagination without network access.
        responses = {f"{root}/workflows/release.yml/runs?status=success&per_page=100":
                     [{"workflow_runs": [run]} for run in runs]}
        for run_id, job in jobs.items():
            responses[f"{root}/runs/{run_id}/jobs?per_page=100"] = [
                {"jobs": []}, {"jobs": [job]}]
        return responses

    def published_baseline(self, error=None):
        return self.cli("previous-published", "--target", "HEAD", "--version", "1.1.0",
                        "--repo", "fixture/app", error=error).stdout.strip()

    def test_bootstrap_must_advance_all_known_legacy_publications(self):
        sha = self.git("rev-parse", "HEAD")
        self.add_fragment(2)
        self.commit("TAL-2: higher publication")
        newer = self.git("rev-parse", "HEAD")
        self.git("tag", "v1.2.0")
        runs = [
            {"id": 1, "event": "push", "head_branch": "v1.0.0", "head_sha": sha, "conclusion": "success"},
            {"id": 2, "event": "push", "head_branch": "v1.2.0", "head_sha": newer, "conclusion": "success"},
        ]
        jobs = {number: {"name": "Publish iOS app", "conclusion": "success", "completed_at": date}
                for number, date in ((1, "2026-02-01T00:00:00Z"), (2, "2026-01-01T00:00:00Z"))}
        responses = self.published_responses(runs, jobs)
        self.mock_github(responses)
        self.assertEqual(self.published_baseline(), sha)  # Historical note regeneration remains valid.
        for version in ("1.1.0", "1.2.0"):
            self.cli("previous-published", "--target", "HEAD", "--version", version,
                     "--repo", "fixture/app", "--require-latest", error="must advance")
        selected = self.cli("previous-published", "--target", "HEAD", "--version", "1.3.0",
                            "--repo", "fixture/app", "--require-latest").stdout.strip()
        self.assertEqual(selected, newer)
        runs[1].update(event="workflow_dispatch", head_branch="main")
        responses = self.published_responses(runs, jobs)
        responses["repos/fixture/app/actions/runs/2/artifacts?per_page=100"] = [
            {"artifacts": [{"id": 20, "name": "release-notes-1.2.0", "expired": False}]}]
        self.mock_github(responses)
        self.cli("previous-published", "--target", "HEAD", "--version", "1.1.0",
                 "--repo", "fixture/app", "--require-latest", error="must advance")

    def test_new_version_on_same_commit_generates_empty_notes_without_a_dummy_commit(self):
        baseline = self.git("rev-parse", "HEAD")
        self.git("tag", "v1.1.0")
        run = {"id": 1, "event": "push", "head_branch": "v1.0.0", "head_sha": baseline, "conclusion": "success"}
        jobs = {1: {"name": "Publish iOS app", "conclusion": "success", "completed_at": "2026-01-02T00:00:00Z"}}
        self.mock_github(self.published_responses([run], jobs))
        self.generate("--previous", self.published_baseline())
        catalog = json.loads((self.root / "out/release-notes.json").read_text())
        self.assertEqual(catalog["sourceCommit"], baseline)
        self.assertEqual(catalog["releases"][0]["version"], "1.1.0")
        self.assertEqual(catalog["releases"][0]["sections"], [])
        self.assertEqual(catalog["releases"][0]["highlights"], [])
        self.assertIn("No app-facing release notes were recorded", (self.root / "out/release-notes.md").read_text())
        self.generate()  # Offline tag selection must handle the same range too.

    def test_published_baseline_preserves_notes_before_failed_tags(self):
        baseline = self.git("rev-parse", "HEAD")
        self.add_fragment(2, "Important change before failed tag")
        self.commit("TAL-2: important change")
        self.git("tag", "v1.0.1")
        failed = self.git("rev-parse", "HEAD")
        self.add_fragment(3, "Later change")
        self.commit("TAL-3: later change")
        runs = [
            {"id": 3, "event": "push", "head_branch": "v1.0.1", "head_sha": failed, "conclusion": "failure"},
            {"id": 2, "event": "workflow_dispatch", "head_branch": "main", "head_sha": failed, "conclusion": "success"},
            {"id": 1, "event": "push", "head_branch": "v1.0.0", "head_sha": baseline, "conclusion": "success"},
        ]
        jobs = {
            2: {"name": "Publish iOS app", "conclusion": "skipped", "completed_at": "2026-01-03T00:00:00Z"},
            1: {"name": "Publish iOS app", "conclusion": "success", "completed_at": "2026-01-02T00:00:00Z"},
        }
        self.mock_github(self.published_responses(runs, jobs))
        selected = self.published_baseline()
        self.assertEqual(selected, baseline)
        self.generate("--previous", selected)
        notes = (self.root / "out/release-notes.md").read_text()
        self.assertIn("Important change before failed tag", notes)
        self.assertIn("Later change", notes)

    def test_published_baseline_skips_unmerged_releases_and_unneeded_old_manual_history(self):
        baseline = self.git("rev-parse", "HEAD")
        self.git("switch", "-c", "unmerged")
        self.write("side.md", "Side release")
        self.commit("Side release")
        side = self.git("rev-parse", "HEAD")
        self.git("tag", "v1.0.5")
        self.git("switch", "main")
        self.add_fragment(2)
        self.commit("TAL-2: release")
        runs = [
            {"id": 1, "event": "push", "head_branch": "v1.0.0", "head_sha": baseline, "conclusion": "success"},
            {"id": 2, "event": "push", "head_branch": "v1.0.5", "head_sha": side, "conclusion": "success"},
            {"id": 3, "event": "workflow_dispatch", "head_branch": "main", "head_sha": baseline, "conclusion": "success"},
        ]
        jobs = {number: {"name": "Publish iOS app", "conclusion": "success", "completed_at": date}
                for number, date in ((1, "2026-01-02T00:00:00Z"), (2, "2026-01-03T00:00:00Z"), (3, "2026-01-01T00:00:00Z"))}
        # No artifact response for the old manual run: it must never be needed.
        self.mock_github(self.published_responses(runs, jobs))
        self.assertEqual(self.published_baseline(), baseline)

    def test_manual_publication_uses_artifact_source_not_workflow_head(self):
        baseline = self.git("rev-parse", "HEAD")
        self.add_fragment(2)
        self.commit("TAL-2: new release")
        target = self.git("rev-parse", "HEAD")
        run = {"id": 2, "event": "workflow_dispatch", "head_branch": "main", "head_sha": target, "conclusion": "success"}
        jobs = {2: {"name": "Publish iOS app", "conclusion": "success", "completed_at": "2026-01-02T00:00:00Z"}}
        responses = self.published_responses([run], jobs)
        artifact_path = "repos/fixture/app/actions/runs/2/artifacts?per_page=100"
        responses[artifact_path] = [{"artifacts": [{"id": 20, "name": "release-notes-1.0.0", "expired": False}]}]
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr("release-notes.json", json.dumps({"schemaVersion": 1, "sourceCommit": baseline, "releases": [{"version": "1.0.0"}]}))
        responses["repos/fixture/app/actions/artifacts/20/zip"] = {"zip": archive.getvalue().hex()}
        self.mock_github(responses)
        self.assertEqual(self.published_baseline(), baseline)
        responses[artifact_path][0]["artifacts"][0]["expired"] = True
        self.mock_github(responses)
        self.published_baseline(error="lacks retained release-note provenance")

    def test_published_baseline_fails_closed_without_history_or_after_retag(self):
        self.mock_github(self.published_responses([], {}))
        self.published_baseline(error="no successful published release baseline")
        baseline = self.git("rev-parse", "HEAD")
        self.add_fragment(2)
        self.commit("TAL-2: new release")
        self.git("tag", "-f", "v1.0.0")
        run = {"id": 1, "event": "push", "head_branch": "v1.0.0", "head_sha": baseline, "conclusion": "success"}
        jobs = {1: {"name": "Publish iOS app", "conclusion": "success", "completed_at": "2026-01-02T00:00:00Z"}}
        self.mock_github(self.published_responses([run], jobs))
        self.published_baseline(error="no longer matches")

    def test_adjacent_tags_order_highlights_multiple_entries_and_determinism(self):
        self.add_fragment(10, "Reconnect safely", "Fixed")
        self.write("changelog.d/TAL-2.json", json.dumps({"entries": [
            {"category": "Added", "summary": "New boards", "highlight": True, "announce": False}]}))
        data = {"entries": [
            {"category": "Security", "summary": "Protect tokens", "highlight": True, "announce": False},
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
            (json.dumps({"entries": [{"category": "Fixed", "summary": "Broken " + chr(0xD800) + " text", "highlight": False}]}), "surrogates"),
            (json.dumps({"skip": "Broken " + chr(0xDC00) + " text"}), "surrogates"),
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
        self.write("NOTICE", "Repository metadata\n")
        self.write(".codex/environments/environment.toml", "# Local agent tooling\n")
        self.write(".xcodebuildmcp/config.yaml", "# Local test runner settings\n")
        self.write("TalariaKit/Tests/TalariaKitTests/FixtureTests.swift", "// Package test\n")
        self.write("Talaria/Config/UITestFixture+Example.swift", "#if DEBUG\n#endif\n")
        self.commit("TAL-2: documentation")
        self.cli("validate", "--base", "v1.0.0", error="missing release metadata")
        self.generate(error="missing release fragments")
        self.write("changelog.d/TAL-2.json", '{"skip":"Documentation only"}')
        self.commit("TAL-2: describe skip")
        self.cli("validate", "--base", "v1.0.0")
        self.generate()
        self.assertEqual(json.loads((self.root / "out/release-notes.json").read_text())["releases"][0]["sections"], [])
        self.assertNotIn("###", (self.root / "out/release-notes.md").read_text())

    def test_pr_metadata_is_scoped_to_head_while_the_merge_tree_is_validated(self):
        baseline = self.git("rev-parse", "HEAD")
        self.git("switch", "-c", "pull-request")
        self.write("README.md", "Repository change")
        self.write("changelog.d/TAL-2.json", '{"skip":"Repository documentation only"}')
        self.commit("TAL-2: documentation")
        pr_head = self.git("rev-parse", "HEAD")
        self.git("switch", "main")
        self.write("Talaria/Feature.swift", "// A main-branch change before metadata enforcement")
        self.commit("TAL-3: unrelated main change")
        self.git("merge", "--no-ff", "pull-request", "-m", "Synthetic PR merge")
        self.cli("validate", "--base", baseline, error="require user-facing entries")
        self.cli("validate", "--base", baseline, "--target", pr_head)
        # Checking the PR delta must still reject malformed files in the merge tree.
        self.write("changelog.d/TAL-3.json", "malformed")
        self.cli("validate", "--base", baseline, "--target", pr_head, error="TAL-3.json")

    def project(self, tests=True, extra_test=False, setting="5.0"):
        objects = ["\t\tAAAAAAAAAAAAAAAAAAAAAAA1 /* App.swift in Sources */ = {isa = PBXBuildFile; };"]
        if extra_test:
            objects.append("\t\tBBBBBBBBBBBBBBBBBBBBBBB3 /* MoreTests.swift in Sources */ = {isa = PBXBuildFile; };")
        if tests:
            objects += [
                "\t\tBBBBBBBBBBBBBBBBBBBBBBB1 /* AppTests.swift in Sources */ = {isa = PBXBuildFile; };",
                "\t\tBBBBBBBBBBBBBBBBBBBBBBB2 /* TalariaTests */ = {",
                "\t\t\tisa = PBXNativeTarget;",
                "\t\t\tbuildPhases = (",
                "\t\t\t\tCCCCCCCCCCCCCCCCCCCCCCC1 /* Sources */,",
                "\t\t\t);",
                "\t\t};",
                "\t\tCCCCCCCCCCCCCCCCCCCCCCC1 /* Sources */ = {",
                "\t\t\tfiles = (",
                "\t\t\t\tBBBBBBBBBBBBBBBBBBBBBBB1 /* AppTests.swift in Sources */,",
                *(["\t\t\t\tBBBBBBBBBBBBBBBBBBBBBBB3 /* MoreTests.swift in Sources */,"] if extra_test else []),
                "\t\t\t);",
                "\t\t};",
            ]
        objects += [
            "\t\tDDDDDDDDDDDDDDDDDDDDDDD1 /* Project object */ = {",
            "\t\t\tTargetAttributes = {",
            *(["\t\t\t\tBBBBBBBBBBBBBBBBBBBBBBB2 = {", "\t\t\t\t\tCreatedOnToolsVersion = 27.0;", "\t\t\t\t};"] if tests else []),
            "\t\t\t};",
            "\t\t\ttargets = (",
            *(["\t\t\t\tBBBBBBBBBBBBBBBBBBBBBBB2 /* TalariaTests */,"] if tests else []),
            "\t\t\t);",
            f"\t\t\tSWIFT_VERSION = {setting};",
            "\t\t};",
        ]
        self.write("Talaria.xcodeproj/project.pbxproj", "// !$*UTF8*$!\n{\n\tobjects = {\n" + "\n".join(objects) + "\n\t};\n}\n")

    def scheme(self, tests=True, launch="Debug"):
        testable = '      <TestableReference>\n         <BuildableReference BlueprintName = "TalariaTests"/>\n      </TestableReference>\n'
        self.write("Talaria.xcodeproj/xcshareddata/xcschemes/Talaria.xcscheme",
                   f'<Scheme>\n   <TestAction>\n{testable if tests else ""}   </TestAction>\n   <LaunchAction buildConfiguration = "{launch}"/>\n</Scheme>\n')

    def test_project_and_scheme_edits_to_tests_alone_can_skip(self):
        self.project()
        self.scheme()
        self.write("Talaria/App.swift", "// app\n")
        self.write("TalariaTests/AppTests.swift", "// test\n")
        self.add_fragment(2)
        self.commit("TAL-2: app with tests")
        base = self.git("rev-parse", "HEAD")
        self.project(extra_test=True)
        self.write("TalariaTests/MoreTests.swift", "// test\n")
        self.write("changelog.d/TAL-3.json", '{"skip":"Tests only"}')
        self.commit("TAL-3: add a test")
        self.cli("validate", "--base", base)
        self.git("rm", "-rq", "TalariaTests")
        self.project(tests=False)
        self.scheme(tests=False)
        self.commit("TAL-3: remove the test target")
        self.cli("validate", "--base", base)
        self.project(tests=False, setting="6.0")
        self.commit("TAL-3: change a build setting")
        self.cli("validate", "--base", base, error="require user-facing entries")
        self.project(tests=False)
        self.scheme(tests=False, launch="Release")
        self.commit("TAL-3: change how the App launches")
        self.cli("validate", "--base", base, error="require user-facing entries")

    def test_a_project_edit_to_an_app_file_named_like_a_test_needs_entries(self):
        project = "Talaria.xcodeproj/project.pbxproj"
        def write(app_member):
            line = "\t\tAAAAAAAAAAAAAAAAAAAAAAA1 /* Shared.swift in Sources */ = {isa = PBXBuildFile; };\n" if app_member else ""
            self.write(project, "{\n\tobjects = {\n" + line + "\t};\n}\n")
        write(True)
        self.write("Talaria/Shared.swift", "// app\n")
        self.write("TalariaTests/Shared.swift", "// test\n")
        self.add_fragment(2)
        self.commit("TAL-2: shared names")
        base = self.git("rev-parse", "HEAD")
        write(False)
        self.write("changelog.d/TAL-3.json", '{"skip":"Tests only"}')
        self.commit("TAL-3: drop the App's Shared.swift from its sources")
        self.cli("validate", "--base", base, error="require user-facing entries")

    def test_changes_inside_debug_blocks_can_skip(self):
        self.write("Talaria/Feature.swift", "func load() {\n    #if DEBUG\n    fixture()\n    #else\n    live()\n    #endif\n}\n")
        self.write("Talaria/Config/Host.swift", "#if DEBUG\nstruct Host {}\n#endif\n")
        self.add_fragment(2)
        self.commit("TAL-2: feature")
        base = self.git("rev-parse", "HEAD")
        self.write("Talaria/Feature.swift", "func load() {\n    #if DEBUG\n    otherFixture()\n    #else\n    live()\n    #endif\n}\n")
        self.git("rm", "-q", "Talaria/Config/Host.swift")
        self.write("changelog.d/TAL-3.json", '{"skip":"DEBUG only"}')
        self.commit("TAL-3: change the DEBUG branch")
        self.cli("validate", "--base", base)
        self.write("Talaria/Feature.swift", "func load() {\n    #if DEBUG\n    otherFixture()\n    #else\n    cached()\n    #endif\n}\n")
        self.commit("TAL-3: change the shipped branch")
        self.cli("validate", "--base", base, error="require user-facing entries")

    def test_xcconfig_comments_and_export_options_can_skip(self):
        self.write("Config/Dev.xcconfig", "// Development app\nPRODUCT_NAME = Dev\n")
        self.write("Config/DevExportOptions.plist", "<plist/>\n")
        self.add_fragment(2)
        self.commit("TAL-2: config")
        base = self.git("rev-parse", "HEAD")
        self.write("Config/Dev.xcconfig", "// Development app, installed beside production\n\nPRODUCT_NAME = Dev\n")
        self.git("rm", "-q", "Config/DevExportOptions.plist")
        self.write("changelog.d/TAL-3.json", '{"skip":"Comments and export settings only"}')
        self.commit("TAL-3: tidy config")
        self.cli("validate", "--base", base)
        self.write("Config/Dev.xcconfig", "// Development app, installed beside production\n\nPRODUCT_NAME = Other\n")
        self.commit("TAL-3: change a build setting")
        self.cli("validate", "--base", base, error="require user-facing entries")

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
        self.generate("--previous", "v1.0.99", error="ancestor")
        self.generate("--version", "01.1.0", error="X.Y.Z")

    def test_no_previous_tag_requires_explicit_baseline(self):
        self.git("tag", "-d", "v1.0.0")
        baseline = self.git("rev-parse", "HEAD")
        self.add_fragment(2)
        self.commit("TAL-2: release")
        self.generate(error="no preceding semantic release tag")
        self.generate("--previous", baseline)

    def test_markdown_escapes_authored_text_but_json_preserves_it(self):
        summary = "# Use <script> & [links](url) with *literal* text 😀"
        self.add_fragment(2, summary)
        self.commit("TAL-2: plain text")
        self.generate()
        markdown = (self.root / "out/release-notes.md").read_text()
        self.assertIn("- \\# Use", markdown)
        self.assertIn("&lt;script&gt; &amp; \\[links\\]", markdown)
        release = json.loads((self.root / "out/release-notes.json").read_text())["releases"][0]
        self.assertEqual(release["sections"][0]["entries"][0]["summary"], summary)

    def announce(self, component, version="1.1.0", *args, **kwargs):
        output = self.root / f"out/{component}.json"
        output.unlink(missing_ok=True)
        self.cli("announcement", "--component", component, "--target", "HEAD", "--version", version,
                 "--output", str(output), *args, **kwargs)
        return output

    def write_shared_fragments(self):
        self.git("tag", "web-v1.0.0", "v1.0.0")
        for key, data in WHATS_NEW["fragments"].items():
            self.write(f"changelog.d/{key}.json", json.dumps(data))
        self.commit(f"{', '.join(WHATS_NEW['fragments'])}: shared fixture")

    def test_announcements_are_opt_in_component_scoped_ordered_capped_and_reproducible(self):
        self.write_shared_fragments()
        self.cli("validate", "--base", "v1.0.0")
        source = self.git("rev-parse", "HEAD")
        for component in ("app", "web"):
            with self.subTest(component=component):
                output = self.announce(component)
                expected = {**WHATS_NEW[component], "sourceCommit": source}
                self.assertEqual(json.loads(output.read_text()), expected)
                first = output.read_bytes()
                self.assertEqual(self.announce(component).read_bytes(), first)
        # Release notes keep their historical shape: authored announcements never reach them.
        self.generate("--component", "web")
        self.assertNotIn("announcement", (self.root / "out/release-notes.json").read_text())

    def test_releases_without_opted_in_rows_have_no_announcement(self):
        self.git("tag", "web-v1.0.0", "v1.0.0")
        self.add_fragment(2, "Highlighted but not announced", highlight=True)
        self.write("changelog.d/TAL-3.json", json.dumps({"entries": [
            {"category": "Added", "summary": "Relay only", "highlight": False, "components": ["relay"]}]}))
        self.write("changelog.d/TAL-4.json", '{"skip": "Repository tooling only"}')
        self.commit("TAL-2, TAL-3, TAL-4: unannounced")
        for component in ("app", "web"):
            with self.subTest(component=component):
                self.assertFalse(self.announce(component).exists())
        self.git("tag", "v1.1.0")
        self.write("changelog.d/TAL-5.json", '{"skip": "Repository tooling only"}')
        self.commit("TAL-5: skip only")
        self.assertFalse(self.announce("app", "1.2.0").exists())

    def test_announcement_covers_only_the_installed_release_after_skipped_versions(self):
        announced = {"title": "Older change", "description": "Shipped in a release this install skipped.", "icon": "sparkles"}
        self.write("changelog.d/TAL-2.json", json.dumps({"entries": [
            {"category": "Added", "summary": "Older", "highlight": False, "announcement": announced}]}))
        self.commit("TAL-2: older")
        self.git("tag", "v1.1.0")
        self.write("changelog.d/TAL-3.json", json.dumps({"entries": [
            {"category": "Added", "summary": "Current", "highlight": False,
             "announcement": {**announced, "title": "Current change"}}]}))
        self.commit("TAL-3: current")
        rows = json.loads(self.announce("app", "1.2.0").read_text())["rows"]
        self.assertEqual([row["id"] for row in rows], ["TAL-3-1"])
        # An Experimental Web build carries its release version and is ranged from the Stable tag below its core.
        self.git("tag", "web-v1.1.0", "v1.1.0")
        self.write("changelog.d/TAL-3.json", json.dumps({"entries": [
            {"category": "Added", "summary": "Current", "highlight": False, "components": ["web"],
             "announcement": {**announced, "title": "Current change"}}]}))
        self.commit("TAL-3: retarget before release")
        version = f"1.2.0-exp.{self.git('rev-parse', 'HEAD')[:12]}"
        experimental = json.loads(self.announce("web", version).read_text())
        self.assertEqual((experimental["id"], experimental["version"], experimental["rows"][0]["id"]),
                         (f"web-{version}", version, "TAL-3-1"))
        self.announce("web", "1.2.0-exp." + "f" * 12, error="its source")
        self.announce("app", version, error="X.Y.Z")
        self.announce("relay", error="invalid choice")

    def test_authored_announcements_are_validated(self):
        valid = {"title": "Pinned chats", "description": "Keep favorites on top.", "icon": "chat"}
        cases = [
            ({**valid, "title": "x" * 41}, "at most 40"),
            ({**valid, "title": "\U0001F389" + "x" * 39}, "at most 40"),
            ({**valid, "description": "Line\nbreak"}, "single line"),
            ({**valid, "description": " padded"}, "surrounding whitespace"),
            ({**valid, "icon": "rocket"}, "icon must be one of"),
            ({**valid, "extra": True}, "title, description, and icon"),
            ({"title": "Pinned chats", "icon": "chat"}, "title, description, and icon"),
            ("Pinned chats", "title, description, and icon"),
        ]
        for announcement, error in cases:
            with self.subTest(announcement=announcement):
                self.write("changelog.d/TAL-2.json", json.dumps({"entries": [
                    {"category": "Added", "summary": "Text", "highlight": False, "announcement": announcement}]}))
                self.cli("validate", error=error)
        self.write("changelog.d/TAL-2.json", json.dumps({"entries": [
            {"category": "Added", "summary": "Text", "highlight": False, "components": ["relay"], "announcement": valid}]}))
        self.cli("validate", error="announcement needs an app or web component")


    def test_new_highlighted_app_and_web_entries_must_decide_whether_to_announce(self):
        valid = {"title": "Pinned chats", "description": "Keep favorites on top.", "icon": "chat"}
        # Merged history predates the rule and keeps validating, with or without a base.
        self.add_fragment(2, "Historical highlight", highlight=True)
        self.commit("TAL-2: historical highlight")
        self.git("tag", "before")
        self.cli("validate", "--base", "v1.0.0", error="changelog.d/TAL-2.json: a highlighted app or web entry")
        self.cli("validate", "--base", "before")
        undecided = [
            {"category": "Added", "summary": "App by default", "highlight": True},
            {"category": "Added", "summary": "Web", "highlight": True, "components": ["web"]},
            {"category": "Added", "summary": "Shared", "highlight": True, "components": ["relay", "app"]},
        ]
        for entry in undecided:
            with self.subTest(entry=entry):
                self.write("changelog.d/TAL-3.json", json.dumps({"entries": [entry]}))
                self.cli("validate")
                self.cli("validate", "--base", "before",
                         error='changelog.d/TAL-3.json: a highlighted app or web entry needs an "announcement" or "announce": false')
                for decision in ({"announcement": valid}, {"announce": False}):
                    self.write("changelog.d/TAL-3.json", json.dumps({"entries": [{**entry, **decision}]}))
                    self.cli("validate", "--base", "before")
        for entry in ({"category": "Added", "summary": "Detail", "highlight": False},
                      {"category": "Added", "summary": "Relay", "highlight": True, "components": ["relay"]}):
            with self.subTest(entry=entry):
                self.write("changelog.d/TAL-3.json", json.dumps({"entries": [entry]}))
                self.cli("validate", "--base", "before")
        highlighted = {"category": "Added", "summary": "Text", "highlight": True}
        for decision, error in (({"announce": True}, '"announce" must be false'),
                                ({"announce": "no"}, '"announce" must be false'),
                                ({"announce": 0}, '"announce" must be false'),
                                ({"announce": False, "announcement": valid}, 'either an "announcement" or "announce": false')):
            with self.subTest(decision=decision):
                self.write("changelog.d/TAL-3.json", json.dumps({"entries": [{**highlighted, **decision}]}))
                self.cli("validate", error=error)
        self.write("changelog.d/TAL-3.json", json.dumps({"entries": [{**highlighted, "announce": False}]}))
        self.commit("TAL-3: decided not to announce")
        self.generate()
        self.assertNotIn("announce", (self.root / "out/release-notes.json").read_text())


WHATS_NEW = json.loads((SCRIPT.parents[2] / "contracts/fixtures/whats-new.json").read_text())


if __name__ == "__main__":
    unittest.main()
