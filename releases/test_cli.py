"""Workflow command boundaries with synthetic Actions context and local Git."""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import cli


class WorkflowCommandTests(unittest.TestCase):
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
