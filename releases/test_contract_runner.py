"""Selected App checks include each retained Web source and stop on failure."""

import importlib.util
import json
import sys
import tempfile
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


    def test_only_selector_splits_native_app_runs_from_portable_fixture_suites(self):
        plan = {"components": {"app": {"sourceRevision": "a" * 40}, "web": {"sourceRevision": "b" * 40},
                               "relay": {"sourceRevision": "c" * 40}}, "supportedWebSources": ["b" * 40, "d" * 40]}
        for only, native, portable in (("app", True, False), ("fixtures", False, True), (None, True, True)):
            with self.subTest(only=only), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                (root / "plan.json").write_text(json.dumps(plan))
                argv = ["check", "--plan", str(root / "plan.json"), "--output", str(root / "out")] + (["--only", only] if only else [])
                commands = []

                def run(command, **kwargs):
                    commands.append(command)
                    if command[:2] == ["git", "clone"]:
                        (Path(command[-1]) / "contracts/fixtures").mkdir(parents=True)

                with patch.object(sys, "argv", argv), patch.object(runner.subprocess, "run", side_effect=run), \
                        patch.object(runner.subprocess, "check_output", return_value=b"{}"):
                    runner.main()
                self.assertEqual(any("check-previous-app.py" in str(command[1]) for command in commands), native)
                self.assertEqual(any(command[:2] == ["pnpm", "install"] for command in commands), portable)
                record = json.loads((root / "out/verification.json").read_text())
                self.assertEqual(record["supportedWebSources"], ["b" * 40, "d" * 40])
                self.assertEqual(record["result"], "success")


class AgentRunnerTests(unittest.TestCase):
    def test_selected_checkout_stays_in_shared_scratch_and_is_removed(self):
        spec = importlib.util.spec_from_file_location("agent_runner", Path(__file__).resolve().parents[1] / "scripts/check-release-agent.py")
        agent = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(agent)
        pin = {"x-talaria": {"version": "1.0.0"}, "services": {"hermes-agent": {"image": "synthetic"}}}
        for fail in (False, True):
            with self.subTest(fail=fail), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                plan = root / "plan.json"
                plan.write_text(json.dumps({"components": {"web": {"sourceRevision": "a" * 40}},
                                            "agent": {"version": "1.0.0", "image": "synthetic"}}))
                checkouts = []

                def run(command, **kwargs):
                    if command[0] == "python3":
                        checkout = kwargs["cwd"]
                        self.assertTrue(checkout.is_relative_to(root / ".codex-tmp"))
                        self.assertTrue(checkout.parent.is_dir())
                        checkouts.append(checkout)
                        if fail:
                            raise subprocess.CalledProcessError(1, command)

                with patch.object(agent, "ROOT", root), patch.object(sys, "argv", ["check", "--plan", str(plan)]), \
                        patch.object(agent.subprocess, "check_output", return_value=json.dumps(pin).encode()), \
                        patch.object(agent.subprocess, "run", side_effect=run):
                    if fail:
                        with self.assertRaises(subprocess.CalledProcessError):
                            agent.main()
                    else:
                        agent.main()
                self.assertEqual(len(checkouts), 1)
                self.assertFalse(checkouts[0].parent.exists())


if __name__ == "__main__":
    unittest.main()
