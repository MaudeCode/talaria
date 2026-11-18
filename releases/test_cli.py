"""Workflow command boundaries with synthetic Actions context and local Git."""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import cli


class WorkflowCommandTests(unittest.TestCase):
    def test_retained_web_channels_are_checked_and_deduplicated(self):
        from test_release_set import candidate, complete

        stable = complete(candidate("a" * 40))
        stable["contracts"]["appWeb"]["web"] = [1]
        experimental = complete(candidate("b" * 40))
        experimental["components"]["web"]["tag"] = "web-exp-v2.0.0"
        experimental["contracts"]["appWeb"]["web"] = [2]
        plan = candidate("c" * 40)
        plan["contracts"]["appWeb"] = {"app": [2], "web": [1, 2]}
        published = [{"tag_name": "release-set-" + doc["releaseSet"], "published_at": date}
                     for doc, date in ((stable, "2026-01-01"), (experimental, "2026-02-01"))]
        with patch.object(cli, "published_manifest", return_value=stable):
            with self.assertRaisesRegex(ValueError, "retained web is incompatible"):
                cli.supported_web_sources(plan, experimental, published)
            plan["contracts"]["appWeb"]["app"] = [1, 2]
            self.assertEqual(cli.supported_web_sources(plan, experimental, published), ["a" * 40, "b" * 40])
            plan["contracts"]["webRelay"]["relay"] = [3]
            with self.assertRaisesRegex(ValueError, "webRelay"):
                cli.supported_web_sources(plan, experimental, published)
            # Without a plan, CI only lists them to probe (TAL-2345).
            self.assertEqual(cli.supported_web_sources(None, experimental, published), ["a" * 40, "b" * 40])

    def test_prepare_writes_the_plan_and_notes_only_for_changed_components(self):
        # prepare writes the plan beside the previous set, generates notes only for a changed component from the
        # previous set's source, reports each component to the workflow, and records no receipt (TAL-2396).
        from test_release_set import candidate, complete

        previous = complete(candidate("a" * 40))
        source = "b" * 40
        plan = candidate(source)
        plan["components"]["app"].update(tag="app-v1.1.0", version="1.1.0")
        for name in ("web", "relay"):
            plan["components"][name] = deepcopy(previous["components"][name])
        plan["changed"] = {"app": True, "web": False, "relay": False}
        request = {"sourceRevision": source, "tags": {n: c["tag"] for n, c in plan["components"].items()},
                   "relayDeploymentId": "synthetic-relay"}
        published = [{"tag_name": "release-set-" + previous["releaseSet"], "published_at": "2026-01-01"}]
        with tempfile.TemporaryDirectory() as temporary:
            output, github_output = Path(temporary) / "out", Path(temporary) / "github-output"
            with patch.object(cli, "load", side_effect=[request, deepcopy(previous)]), \
                    patch.dict(os.environ, {"GITHUB_OUTPUT": str(github_output)}, clear=True), patch("builtins.print"), \
                    patch.object(cli, "run_url", return_value="https://github.com/MaudeCode/talaria/actions/runs/1"), \
                    patch.object(cli, "require_latest_predecessor", return_value=published), \
                    patch.object(cli, "unused_release"), patch.object(cli, "resolve", return_value=plan), \
                    patch.object(cli, "git"), patch.object(cli.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as calls:
                cli.prepare(SimpleNamespace(request="request", previous="previous", dry_run=True, release_tag=None, output=output))
            self.assertEqual([call.args[0] for call in calls.call_args_list], [[
                "python3", str(cli.ROOT / "app/ci/release_notes.py"), "generate", "--component", "app", "--previous", "a" * 40,
                "--target", source, "--version", "1.1.0", "--output", str(output / "notes/app")]])
            self.assertEqual((output / "notes/web/release-notes.md").read_text(),
                             "Unchanged; reuses web-v2.0.0 and its previous immutable artifact.\n")
            self.assertEqual((output / "notes/relay/release-notes.md").read_text(),
                             "Unchanged; reuses relay-v3.0.0 and its previous immutable artifact.\n")
            written = json.loads((output / "plan.json").read_text())
            self.assertEqual((written["dryRun"], written["previousAppSource"], written["releaseTag"]), (True, "a" * 40, None))
            self.assertEqual(json.loads((output / "previous.json").read_text()), previous)
            self.assertEqual(github_output.read_text().splitlines(), [
                f"source={source}",
                "app_changed=true", f"app_source={source}", "app_version=1.1.0",
                "web_changed=false", f"web_source={'a' * 40}", "web_version=2.0.0",
                "relay_changed=false", f"relay_source={'a' * 40}", "relay_version=3.0.0",
            ])
            self.assertFalse((output / "receipts").exists())

    def test_the_release_version_names_every_changed_component(self):
        from test_release_set import candidate

        plan = candidate()
        plan["changed"] = {"app": True, "web": False, "relay": True}
        for name in ("app", "relay"):
            plan["components"][name].update(tag=f"{name}-v1.4.0", version="1.4.0")
        self.assertEqual(cli.release_tag("v1.4.0", plan), "v1.4.0")
        for tag in ("v1.4.1", "1.4.0", "v1.4.0-rc.1"):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                cli.release_tag(tag, plan)

    def test_version_history_survives_channel_switches(self):
        from release_set import require_version_advance

        tags = {"app": "app-v1.1.0", "web": "web-v2.1.0", "relay": "relay-v3.1.0"}
        previous = {"components": {name: {"tag": tag} for name, tag in tags.items()}}
        previous["components"]["web"]["tag"] = "web-exp-v0.5.0"
        published = [{"tag_name": "web-v2.0.0"}, {"tag_name": "web-exp-v0.5.0"}]
        cli.require_component_versions(tags, previous, published)
        for version in ("1.9.0", "2.0.0"):
            with self.assertRaisesRegex(ValueError, "must advance"):
                cli.require_component_versions({**tags, "web": "web-v" + version}, previous, published)
        require_version_advance("web-v2.10.0", "web-v2.9.0")
        require_version_advance("web-exp-v0.6.0", "web-v2.0.0")
        with self.assertRaises(ValueError):
            require_version_advance("web-exp-v0.5.0", "web-exp-v0.5.0")

    def test_bootstrap_requires_no_published_predecessor(self):
        old, current = "a" * 40, "b" * 40
        releases = [[{"tag_name": "release-set-" + old, "draft": False, "published_at": "2026-01-01T00:00:00Z"}],
                    [{"tag_name": "release-set-" + current, "draft": False, "published_at": "2026-02-01T00:00:00Z"},
                     {"tag_name": "release-set-" + "c" * 40, "draft": True, "published_at": None},
                     {"tag_name": "app-v9.0.0", "draft": False, "published_at": "2026-03-01T00:00:00Z"}]]
        with patch.object(cli.subprocess, "check_output", return_value=json.dumps(releases)):
            cli.require_latest_predecessor({"releaseSet": current})
            for previous in (None, {"releaseSet": old}):
                with self.assertRaisesRegex(ValueError, "latest published release set"):
                    cli.require_latest_predecessor(previous)
        with patch.object(cli.subprocess, "check_output", return_value="[[]]"):
            cli.require_latest_predecessor(None)
            with self.assertRaises(ValueError):
                cli.require_latest_predecessor({"releaseSet": old})
        with patch.object(cli.subprocess, "check_output", side_effect=subprocess.CalledProcessError(1, "gh")):
            with self.assertRaises(subprocess.CalledProcessError):
                cli.require_latest_predecessor(None)

    def test_only_an_explicit_404_proves_release_name_unused(self):
        with patch.object(cli.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout="HTTP/2.0 404 Not Found\n")):
            cli.unused_release("web-v2.0.0")
        for result in (SimpleNamespace(returncode=0, stdout="{}"),
                       SimpleNamespace(returncode=1, stdout="HTTP/2.0 403 Forbidden\n"),
                       SimpleNamespace(returncode=1, stdout="")):
            with patch.object(cli.subprocess, "run", return_value=result), self.assertRaises(ValueError):
                cli.unused_release("web-v2.0.0")

    def test_failed_command_cannot_write_a_success_receipt(self):
        with tempfile.TemporaryDirectory(prefix="talaria-gate-fixture-") as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "--quiet", str(root)], check=True)
            subprocess.run(["git", "-C", str(root), "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid",
                            "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "fixture"], check=True)
            source = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
            plan = root / "plan.json"
            plan.write_text(json.dumps({"releaseSet": source}))
            output = root / "receipt.json"
            args = argparse.Namespace(plan=plan, output=output, name="currentContracts",
                                      command=[sys.executable, "-c", "raise SystemExit(7)"])
            env = {"GITHUB_REPOSITORY": "MaudeCode/talaria", "GITHUB_RUN_ID": "1", "GITHUB_RUN_ATTEMPT": "1"}
            with patch.object(cli, "ROOT", root), patch.dict(os.environ, env):
                with self.assertRaises(subprocess.CalledProcessError):
                    cli.gate(args)
                self.assertFalse(output.exists())
                args.command = [sys.executable, "-c", "pass"]
                cli.gate(args)
                self.assertEqual(json.loads(output.read_text())["result"], "success")
                with self.assertRaises(FileExistsError):
                    cli.gate(args)

    def test_receipts_require_run_identity(self):
        with patch.dict(os.environ, {}, clear=True), self.assertRaises(ValueError):
            cli.receipt("currentContracts", "a" * 40)


if __name__ == "__main__":
    unittest.main()
