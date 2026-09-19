"""Selected App checks include each retained Web source and stop on failure."""

import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("contract_runner", Path(__file__).resolve().parents[1] / "scripts/check-release-contracts.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class ContractRunnerTests(unittest.TestCase):
    def test_current_and_retained_web_refs_use_actual_app_tests(self):
        plan = {"components": {"app": {"sourceRevision": "a" * 40}, "web": {"sourceRevision": "b" * 40}},
                "supportedWebSources": ["b" * 40, "c" * 40]}
        with patch.object(runner.subprocess, "run") as run:
            self.assertEqual(runner.verify_app_web(plan, Path("out")), ["b" * 40, "c" * 40])
            self.assertEqual(run.call_count, 2)
            for call, web in zip(run.call_args_list, ("b" * 40, "c" * 40), strict=True):
                args = call.args[0]
                self.assertEqual(args[args.index("--app-ref") + 1], "a" * 40)
                self.assertEqual(args[args.index("--web-ref") + 1], web)
                self.assertIn("--shared-contracts", args)
                self.assertTrue(call.kwargs["check"])
        with patch.object(runner.subprocess, "run", side_effect=[None, subprocess.CalledProcessError(1, "fixture")]):
            with self.assertRaises(subprocess.CalledProcessError):
                runner.verify_app_web(plan, Path("out"))


if __name__ == "__main__":
    unittest.main()
