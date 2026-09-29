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
                "supportedWebSources": ["b" * 40, "c" * 40], "changed": {"app": True}}
        with patch.object(runner.subprocess, "run") as run:
            self.assertEqual(runner.verify_app_web(plan, Path("out")), ["b" * 40, "c" * 40])
            self.assertEqual(run.call_count, 2)
            for call, web in zip(run.call_args_list, ("b" * 40, "c" * 40), strict=True):
                args = call.args[0]
                self.assertEqual(args[args.index("--app-ref") + 1], "a" * 40)
                self.assertEqual(args[args.index("--web-ref") + 1], web)
                self.assertIn("--shared-contracts", args)
                self.assertTrue(call.kwargs["check"])
                # A shipping App runs its whole package suite once, against the selected Web (TAL-414).
                self.assertEqual("--package-suite" in args, web == "b" * 40)
        with patch.object(runner.subprocess, "run") as run:
            runner.verify_app_web({**plan, "changed": {"app": False}}, Path("out"))
            self.assertFalse(any("--package-suite" in call.args[0] for call in run.call_args_list))
        with patch.object(runner.subprocess, "run", side_effect=[None, subprocess.CalledProcessError(1, "fixture")]):
            with self.assertRaises(subprocess.CalledProcessError):
                runner.verify_app_web(plan, Path("out"))


    def test_app_web_pairs_share_one_warm_app_checkout(self):
        # The selected App is the same source for every Web, so its pairs reuse one checkout (and DerivedData)
        # instead of cold-building it per Web; the checkout is removed afterwards.
        plan = {"components": {"app": {"sourceRevision": "a" * 40}, "web": {"sourceRevision": "b" * 40}},
                "supportedWebSources": ["b" * 40, "c" * 40], "changed": {"app": True}}
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
        # The component log reaches only the diagnostics artifact; a failure must show the test's own output in the job log.
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

    def test_packaged_contract_classes_run_with_swift_test_and_require_the_live_pass(self):
        # From TAL-399 an App revision tests TalariaKit's classes with `swift test`; older revisions host them all.
        spec = importlib.util.spec_from_file_location("previous_app", Path(__file__).resolve().parents[1] / "scripts/check-previous-app.py")
        previous = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(previous)
        with tempfile.TemporaryDirectory() as temporary:
            app = Path(temporary)
            self.assertEqual(previous.package_classes(app, previous.TESTS), [])
            tests = app / "TalariaKit/Tests/TalariaKitTests"
            (tests / "Support").mkdir(parents=True)
            (tests / "APIClientSessionListTests.swift").write_text("final class APIClientSessionListTests: APIClientTestCase {}\n")
            (tests / "SSEClientTests.swift").write_text("@MainActor\nfinal class SSEClientTests: XCTestCase {}\n")
            (tests / "Support/APITestSupport.swift").write_text("class APIClientTestCase: XCTestCase {}\n")
            packaged = previous.package_classes(app, previous.TESTS)
            self.assertEqual(packaged, ["APIClientSessionListTests", "SSEClientTests"])
            live = f"Test Case '-[TalariaKitTests.{previous.LIVE_CLASS} {previous.LIVE_TEST}]'"
            for outcome, error in (("passed", None), ("skipped", "live Web fixtures")):
                with self.subTest(outcome=outcome):
                    commands = []

                    def run(command, **kwargs):
                        commands.append((command, kwargs["env"]["TALARIA_LIVE_CONTRACT_RESPONSES"]))
                        kwargs["stdout"].write("Test Suite 'APIClientSessionListTests' passed\nTest Suite 'SSEClientTests' passed\n"
                                               f"{live} {outcome} (0.001 seconds).\n")

                    with patch.object(previous.subprocess, "run", side_effect=run):
                        if error:
                            with self.assertRaisesRegex(ValueError, error):
                                previous.run_package_tests(app, packaged, app / "responses.json", app)
                        else:
                            previous.run_package_tests(app, packaged, app / "responses.json", app)
                    self.assertEqual(commands, [(["swift", "test", "--package-path", str(app / "TalariaKit"), "--filter",
                                                  "^TalariaKitTests\\.(APIClientSessionListTests|SSEClientTests)/"],
                                                 str(app / "responses.json"))])

    def test_fully_packaged_app_runs_no_simulator(self):
        # Once TalariaKit holds every contract class, test-ios must not run: with no class it runs every hosted test.
        spec = importlib.util.spec_from_file_location("previous_app", Path(__file__).resolve().parents[1] / "scripts/check-previous-app.py")
        previous = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(previous)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            commands = []

            def run(command, **kwargs):
                commands.append(command)
                if command[:2] == ["git", "clone"]:
                    app = Path(command[-1]) / "app"
                    (app / "Talaria.xcodeproj").mkdir(parents=True)
                    tests = app / "TalariaKit/Tests/TalariaKitTests"
                    tests.mkdir(parents=True)
                    (tests / "Contract.swift").write_text(
                        "".join(f"final class {name}: XCTestCase {{}}\n" for name in previous.TESTS))
                elif command[0] == "swift":
                    kwargs["stdout"].write("".join(f"Test Suite '{name}' passed\n" for name in previous.TESTS)
                                           + f"Test Case '-[TalariaKitTests.{previous.LIVE_CLASS} {previous.LIVE_TEST}]' passed\n")

            def probe(web_sha, responses, log):
                commands.append(["probe"])
                responses.write_text("{}")

            argv = ["check", "--app-ref", "a" * 40, "--web-ref", "b" * 40, "--output", str(root / "out"), "--package-suite"]
            with patch.object(sys, "argv", argv), patch.object(previous, "commit", side_effect=lambda ref: ref), \
                    patch.object(previous, "probe_web", side_effect=probe), \
                    patch.object(previous, "runner_avoids_clones", return_value=True), \
                    patch.object(previous.subprocess, "run", side_effect=run), \
                    patch.dict(previous.os.environ, {"IOS_SIMULATOR_ID": "synthetic-simulator"}), \
                    contextlib.redirect_stdout(io.StringIO()):
                previous.main()
            self.assertFalse(any(str(command[0]).endswith("scripts/test-ios") for command in commands))
            # No hosted class: no simulator boot and no App build either (TAL-414).
            self.assertFalse(any(command[0] in ("xcodebuild", "xcrun") for command in commands))
            # --package-suite runs every package test but the fuzz soak after the contract classes (TAL-414).
            tests = [command for command in commands if command[:2] == ["swift", "test"]]
            self.assertEqual(len(tests), 2)
            self.assertEqual(tests[1][4:], ["--skip-build", "--skip", "UntrustedInputFuzzSoakTests"])
            # The package tests build beside the Web probe (TAL-408) and run only after both finished.
            names = [" ".join(map(str, command[:2])) for command in commands]
            build = next(command for command in commands if command[:2] == ["swift", "build"])
            self.assertEqual((build[2], build[4:]), ("--package-path", ["--build-tests"]))
            self.assertTrue(build[3].endswith("source/app/TalariaKit"))
            self.assertLess(names.index("swift build"), names.index("swift test"))
            self.assertLess(names.index("probe"), names.index("swift test"))
            self.assertEqual(json.loads((root / "out/verification.json").read_text())["testClasses"], previous.TESTS)

    def test_older_app_boots_and_builds_while_the_web_is_probed(self):
        # TAL-414: with an explicit simulator an App from before TAL-399 boots it and compiles its hosted tests beside
        # the probe; its pool helper then accepts the booted device and its own test-ios runs last. Without one,
        # test-ios does everything itself, as before.
        spec = importlib.util.spec_from_file_location("previous_app", Path(__file__).resolve().parents[1] / "scripts/check-previous-app.py")
        previous = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(previous)
        shutdown_only = '    [[ "$candidate_state" == Shutdown ]] || continue\n'
        for device in ("synthetic-simulator", None):
            with self.subTest(device=device), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                events, pools = [], []

                def run(command, **kwargs):
                    if command[:2] == ["git", "clone"]:
                        app = Path(command[-1]) / "app"
                        (app / "Talaria.xcodeproj").mkdir(parents=True)
                        (app / "scripts").mkdir()
                        (app / "scripts/test-ios").write_text("xcodebuild test\n")
                        (app / "scripts/ios-simulator-pool").write_text(shutdown_only)
                    elif command[0] == "xcodebuild":
                        events.append(("build", command))
                    elif command[0].endswith("scripts/test-ios"):
                        events.append(("test-ios", command))
                        pools.append((Path(command[0]).parent / "ios-simulator-pool").read_text())
                        raise subprocess.CalledProcessError(1, command)

                class Boot:
                    def __init__(self, command, **kwargs):
                        events.append(("boot", command))

                    def wait(self):
                        return 0

                    def poll(self):
                        return 0

                def probe(web_sha, responses, log):
                    events.append(("probe", None))
                    responses.write_text("{}")

                argv = ["check", "--app-ref", "a" * 40, "--web-ref", "b" * 40, "--output", str(root / "out")]
                environment = {key: value for key, value in previous.os.environ.items() if key != "IOS_SIMULATOR_ID"}
                if device:
                    environment["IOS_SIMULATOR_ID"] = device
                with patch.object(sys, "argv", argv), patch.dict(previous.os.environ, environment, clear=True), \
                        patch.object(previous, "commit", side_effect=lambda ref: ref), \
                        patch.object(previous, "probe_web", side_effect=probe), \
                        patch.object(previous, "runner_avoids_clones", return_value=True), \
                        patch.object(previous.subprocess, "run", side_effect=run), \
                        patch.object(previous.subprocess, "Popen", side_effect=Boot), \
                        self.assertRaises(subprocess.CalledProcessError):
                    previous.main()
                names = [name for name, _ in events]
                self.assertEqual(names[-1], "test-ios")
                if device is None:
                    self.assertEqual(names, ["probe", "test-ios"])
                    self.assertEqual(pools, [shutdown_only])
                    continue
                self.assertEqual(sorted(names), ["boot", "build", "probe", "test-ios"])
                self.assertEqual(events[names.index("boot")][1], ["xcrun", "simctl", "bootstatus", device, "-b"])
                build = events[names.index("build")][1]
                for argument in ("build-for-testing", f"platform=iOS Simulator,id={device}", "APP_IDENTIFIER_SUFFIX=.xctest",
                                 "INFOPLIST_KEY_CFBundleDisplayName=base64:", "SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) TALARIA_LIVE_CONTRACT"):
                    self.assertIn(argument, build)
                self.assertTrue(build[build.index("-derivedDataPath") + 1].endswith("app/.codex-tmp/xctest/derived-data"))
                self.assertEqual(pools, ['    [[ "$candidate_state" == Shutdown || "$candidate_state" == Booted ]] || continue\n'])

    def test_only_selector_splits_native_app_runs_from_portable_fixture_suites(self):
        plan = {"components": {"app": {"sourceRevision": "a" * 40}, "web": {"sourceRevision": "b" * 40},
                               "relay": {"sourceRevision": "c" * 40}}, "supportedWebSources": ["b" * 40, "d" * 40],
                "changed": {"app": False}}
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
