"""Selected App checks include each retained Web source and stop on failure."""

import contextlib
import importlib.util
import io
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


    def test_app_web_pairs_share_one_warm_app_checkout(self):
        # The selected App is the same source for every Web, so its pairs reuse one checkout (and DerivedData)
        # instead of cold-building it per Web; the checkout is removed afterwards.
        plan = {"components": {"app": {"sourceRevision": "a" * 40}, "web": {"sourceRevision": "b" * 40}},
                "supportedWebSources": ["b" * 40, "c" * 40]}
        checkouts = []

        def run(command, **kwargs):
            checkout = Path(command[command.index("--app-checkout") + 1])
            checkouts.append(checkout)
            self.assertTrue(checkout.parent.is_dir())

        with patch.object(runner.subprocess, "run", side_effect=run):
            runner.verify_app_web(plan, Path("out"))
        self.assertEqual(len(checkouts), 2)
        self.assertEqual(len(set(checkouts)), 1)
        self.assertFalse(checkouts[0].parent.exists())

    def test_warm_checkout_is_shared_only_when_the_app_runner_avoids_clones(self):
        # A Web-only release keeps an older App revision whose own test-ios still clones the simulator for one
        # worker; reusing its checkout back-to-back would race the previous clone's teardown.
        spec = importlib.util.spec_from_file_location("previous_app", Path(__file__).resolve().parents[1] / "scripts/check-previous-app.py")
        previous = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(previous)
        runners = {"new": 'parallel_testing=NO\n(( TALARIA_TEST_WORKER_COUNT > 1 )) && parallel_testing=YES\n',
                   "old": '-parallel-testing-enabled YES \\\n'}
        for name, script in runners.items():
            with self.subTest(runner=name), patch.object(previous.subprocess, "check_output", return_value=script):
                self.assertEqual(previous.runner_avoids_clones("a" * 40), name == "new")

    def test_failing_fixture_gate_prints_its_own_output(self):
        # The component log reaches only the NAS diagnostics; a failure must show the test's own output in the job log.
        plan = {"components": {"app": {"sourceRevision": "a" * 40}, "web": {"sourceRevision": "b" * 40},
                               "relay": {"sourceRevision": "c" * 40}}, "supportedWebSources": ["b" * 40]}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "plan.json").write_text(json.dumps(plan))
            argv = ["check", "--plan", str(root / "plan.json"), "--output", str(root / "out"), "--only", "fixtures"]

            def run(command, **kwargs):
                if command[:2] == ["git", "clone"]:
                    (Path(command[-1]) / "contracts/fixtures").mkdir(parents=True)
                elif command[:3] == ["pnpm", "exec", "vitest"]:
                    kwargs["stdout"].write("AssertionError: expected 400 to be 200\n")
                    kwargs["stdout"].flush()
                    raise subprocess.CalledProcessError(1, command)

            stderr = io.StringIO()
            with patch.object(sys, "argv", argv), patch.object(runner.subprocess, "run", side_effect=run), \
                    patch.object(runner.subprocess, "check_output", return_value=b"{}"), \
                    contextlib.redirect_stderr(stderr), self.assertRaises(subprocess.CalledProcessError):
                runner.main()
            self.assertIn("AssertionError: expected 400 to be 200", stderr.getvalue())

    def test_old_app_runner_runs_one_worker_without_a_simulator_clone(self):
        # The previous App's own test-ios hardcodes parallel testing, which clones the leased simulator even for
        # one worker and races the previous clone's teardown; its disposable checkout must run without a clone.
        spec = importlib.util.spec_from_file_location("previous_app", Path(__file__).resolve().parents[1] / "scripts/check-previous-app.py")
        previous = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(previous)
        old = 'xcodebuild test \\\n        -parallel-testing-enabled YES \\\n        -parallel-testing-worker-count "$TALARIA_TEST_WORKER_COUNT" \\\n'
        cases = (("1", old, "-parallel-testing-enabled NO"), ("2", old, "-parallel-testing-enabled YES"),
                 ("1", "xcodebuild test\n", None))
        for workers, script, expected in cases:
            with self.subTest(workers=workers, expected=expected), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                ran = []

                def run(command, **kwargs):
                    if command[:2] == ["git", "clone"]:
                        app = Path(command[-1]) / "app"
                        (app / "Talaria.xcodeproj").mkdir(parents=True)
                        (app / "scripts").mkdir()
                        (app / "scripts/test-ios").write_text(script)
                    elif command[0].endswith("scripts/test-ios"):
                        ran.append(Path(command[0]).read_text())
                        raise subprocess.CalledProcessError(1, command)

                def probe(web_sha, responses, log):
                    responses.write_text("{}")

                argv = ["check", "--app-ref", "a" * 40, "--web-ref", "b" * 40, "--output", str(root / "out")]
                with patch.object(sys, "argv", argv), patch.dict(previous.os.environ, {"TALARIA_TEST_WORKER_COUNT": workers}), \
                        patch.object(previous, "commit", side_effect=lambda ref: ref), \
                        patch.object(previous, "probe_web", side_effect=probe), \
                        patch.object(previous, "runner_avoids_clones", return_value=False), \
                        patch.object(previous.subprocess, "run", side_effect=run), \
                        self.assertRaises(ValueError if expected is None else subprocess.CalledProcessError):
                    previous.main()
                if expected is None:
                    self.assertEqual(ran, [])
                else:
                    self.assertEqual(len(ran), 1)
                    self.assertIn(expected, ran[0])

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

    def test_each_web_source_is_probed_by_its_own_harness(self):
        # A retained pre-TAL-245 Web is the Python server; only its own revision's harness can start it.
        spec = importlib.util.spec_from_file_location("previous_app", Path(__file__).resolve().parents[1] / "scripts/check-previous-app.py")
        previous = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(previous)
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary) / "repo"
            harness = repo / "app/scripts/validate-upstream-contract"
            harness.parent.mkdir(parents=True)
            git = ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@example.invalid"]
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            shas = {}
            for name in ("old-web", "new-web"):
                harness.write_text("#!/bin/sh\nwhile [ $# -gt 0 ]; do [ \"$1\" = --responses-output ] && out=$2; shift; done\n"
                                   f"printf '%s' '{name}' > \"$out\"\n")
                harness.chmod(0o755)
                subprocess.run([*git, "add", "-A"], check=True)
                subprocess.run([*git, "commit", "-qm", name], check=True)
                shas[name] = subprocess.check_output([*git, "rev-parse", "HEAD"], text=True).strip()
            responses = Path(temporary) / "responses.json"
            with patch.object(previous, "ROOT", repo), (Path(temporary) / "probe.log").open("w") as log:
                previous.probe_web(shas["old-web"], responses, log)
            self.assertEqual(responses.read_text(), "old-web")


if __name__ == "__main__":
    unittest.main()
