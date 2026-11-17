#!/usr/bin/env python3
"""ci/hosted-test-shard on deterministic timing, capacity and receipt fixtures; no simulator (TAL-1550, TAL-2390)."""

import importlib.machinery
import importlib.util
import json
import os
import random
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "hosted-test-shard"
loader = importlib.machinery.SourceFileLoader("hosted_test_shard", str(SCRIPT))
spec = importlib.util.spec_from_loader(loader.name, loader)
shard = importlib.util.module_from_spec(spec)
loader.exec_module(shard)

# The measured timeline, so widths trade off as they do on hosted runners: about 640 s of build, download, launch and
# reports around every shard's tests.
TABLE = {"fallback": {"class": 10.0, "method": 1.0}, "timeline": shard.weights()["timeline"],
         "classes": {"Heavy1": 300.0, "Heavy2": 300.0, "Heavy3": 300.0, "Heavy4": 300.0, "Light": 100.0, "Notify": 5.0,
                     "Split": 20.0, **{f"Cheap{index}": 1.0 for index in range(20)}},
         "methods": {"Split/testA": 4.0, "Split/testB": 6.0, "Heavy1/testSlow": 290.0}}


def lane(*names):
    return {"mode": "explicit", "identifiers": [f"TalariaTests/{name}" for name in names]}


def planned(result):
    return [identifier for entry in result["shards"] for identifier in entry["planned"]]


class PlanTests(unittest.TestCase):
    def test_width_follows_the_predicted_finish(self):
        cases = [
            ("a single flaky method repeats on one runner", lane("Heavy1/testSlow"), {"repetitions": 5}, 1),
            ("many cheap classes stay on one shard", lane(*(f"Cheap{index}" for index in range(20))), {}, 1),
            ("two heavy classes take two shards", lane("Heavy1", "Heavy2"), {}, 2),
            ("three take three", lane("Heavy1", "Heavy2", "Heavy3"), {}, 3),
            ("four take four", lane("Heavy1", "Heavy2", "Heavy3", "Heavy4"), {}, 4),
            # A selected package job holds one slot until about 300 s; the fourth shard still finishes sooner.
            ("a package job delays but keeps four", lane("Heavy1", "Heavy2", "Heavy3", "Heavy4"), {"package_job": True}, 4),
            ("repetitions never spread", lane("Heavy1", "Heavy2", "Heavy3", "Heavy4"), {"repetitions": 2}, 1),
        ]
        for name, selection, options, width in cases:
            with self.subTest(name):
                result = shard.plan(selection, table=TABLE, **options)
                self.assertEqual(result["width"], width)
                # Every selected identifier runs once, in exactly one nonempty shard.
                self.assertEqual(sorted(planned(result)), sorted(selection["identifiers"]))
                self.assertTrue(all(entry["planned"] for entry in result["shards"]))

    def test_the_fewest_shards_within_ten_percent_of_the_fastest(self):
        # One shard finishes 1,000 + x s after the build starts and two finish 1,000 s after: x = 100 is exactly 10%.
        timeline = {"artifact": 600, "download": 0, "startup": 0, "launch": 0, "post": 0}
        table = {**TABLE, "timeline": timeline, "classes": {"Big": 400.0, "Edge": 100.0, "Over": 101.0}}
        self.assertEqual(shard.plan(lane("Big", "Edge"), table=table)["width"], 1)
        self.assertEqual(shard.plan(lane("Big", "Over"), table=table)["width"], 2)

    def test_heaviest_first_on_the_least_loaded_shard_whatever_the_input_order(self):
        names = ["Heavy1", "Heavy2", "Heavy3", "Split/testA", "Split/testB", "Notify", *(f"Cheap{index}" for index in range(6))]
        first = shard.plan(lane(*names), table=TABLE)
        for seed in range(5):
            shuffled = names[:]
            random.Random(seed).shuffle(shuffled)
            self.assertEqual(shard.plan(lane(*shuffled), table=TABLE)["shards"], first["shards"])
        # Methods of one class share its setup and stay together; the heaviest groups lead their shards.
        homes = {identifier.split("/")[1]: entry["shard"] for entry in first["shards"] for identifier in entry["planned"]}
        self.assertEqual(homes["Split"], [entry["shard"] for entry in first["shards"]
                                          if "TalariaTests/Split/testB" in entry["planned"]][0])
        self.assertEqual(len({homes["Heavy1"], homes["Heavy2"], homes["Heavy3"]}), 3)

    def test_missing_timings_use_the_documented_fallback_and_say_so(self):
        self.assertEqual(shard.plan(lane("Unmeasured", "Heavy1"), table=TABLE)["fallbacks"], ["Unmeasured"])
        self.assertEqual(shard.plan(lane("Unmeasured"), table=TABLE)["shards"][0]["estimate"], 10.0)
        # Split's own setup time (20 s of suite beyond its measured methods) plus the fallback method.
        self.assertEqual(shard.plan(lane("Split/testNew"), table=TABLE)["shards"][0]["estimate"], 11.0)

    def test_only_a_shard_running_notification_tests_waits_for_the_notification_server(self):
        # Shard 1 died waiting for a server none of its tests call (TAL-2352); a catch-all shard may run any class.
        table = {**TABLE, "classes": {**TABLE["classes"], "NotificationAnswerTests": 300.0}}
        result = shard.plan(lane("Heavy1", "NotificationAnswerTests"), table=table)
        options = {tuple(entry["planned"]): shard.prepare_options(entry) for entry in result["shards"]}
        self.assertEqual(options, {("TalariaTests/Heavy1",): ["--without-notifications"],
                                   ("TalariaTests/NotificationAnswerTests",): []})
        full = shard.plan({"mode": "full", "identifiers": ["TalariaTests"]}, table=TABLE, classes=["Heavy1", "Heavy2"])
        self.assertEqual([shard.prepare_options(entry) for entry in full["shards"]], [["--without-notifications"], []])

    def test_selection_arguments(self):
        selected = shard.plan(lane("Heavy1/testSlow"), table=TABLE, repetitions=3)["shards"][0]
        self.assertEqual(shard.selection(selected), ["-only-testing:TalariaTests/Heavy1/testSlow", "-test-iterations", "3",
                                                     "-run-tests-until-failure"])
        # A full run's last shard runs everything the others do not, so a class the scanner missed still runs.
        full = shard.plan({"mode": "full", "identifiers": ["TalariaTests"]}, table=TABLE, classes=["Heavy1", "Heavy2", "Notify"])
        self.assertEqual([shard.selection(entry) for entry in full["shards"]],
                         [["-only-testing:TalariaTests/Heavy1", "-only-testing:TalariaTests/Notify"],
                          ["-only-testing:TalariaTests", "-skip-testing:TalariaTests/Heavy1", "-skip-testing:TalariaTests/Notify"]])
        self.assertTrue(full["shards"][-1]["catch_all"] and not full["partial"])

    def test_an_empty_lane_has_no_shards(self):
        with self.assertRaisesRegex(ValueError, "empty lane"):
            shard.plan({"mode": "empty", "identifiers": []}, table=TABLE)

    def test_a_full_plan_runs_every_hosted_class_of_this_checkout(self):
        classes = shard.discover()
        result = shard.plan({"mode": "full", "identifiers": ["TalariaTests"]})
        self.assertEqual(sorted(name.split("/")[1] for name in planned(result)), classes)
        self.assertIn("SessionListHostedTests", classes)
        self.assertEqual(result["width"], 4)


class CapacityTests(unittest.TestCase):
    def setUp(self):
        self.policy = shard.CONTENTION_POLICY

    def tearDown(self):
        shard.CONTENTION_POLICY = self.policy

    def observation(self, status, age=0, competing=1):
        return {"status": status, "observed_at": int(time.time()) - age,
                "competing": [{"run": index, "pull_request": index, "job": "App build"} for index in range(competing)]}

    def test_the_cap_applies_only_to_fresh_verified_demand(self):
        # Four shards finish about 940 s after the build starts, three about 1,040 s: a quiet pool takes four.
        heavy = lane("Heavy1", "Heavy2", "Heavy3", "Light")
        cases = [("quiet", "enforce", self.observation("quiet", competing=0), 4),
                 ("contended", "enforce", self.observation("contended"), 3),
                 ("every slot wanted", "enforce", self.observation("contended", competing=5), 3),
                 ("stale", "enforce", self.observation("contended", age=shard.STALE_SECONDS + 1), 4),
                 ("unavailable", "enforce", {"status": "unavailable", "reason": "HTTPError"}, 4),
                 ("none", "enforce", None, 4),
                 ("observed only", "observe", self.observation("contended"), 4)]
        for name, policy, observed, width in cases:
            with self.subTest(name):
                shard.CONTENTION_POLICY = policy
                result = shard.plan(heavy, capacity=observed, table=TABLE)
                self.assertEqual(result["width"], width)
                self.assertEqual(sorted(planned(result)), sorted(heavy["identifiers"]))
        self.assertEqual(result["capacity"]["would_cap"], 3)

    def test_a_full_suite_at_reduced_width_keeps_every_class_and_proves_it(self):
        shard.CONTENTION_POLICY = "enforce"
        classes = ["Heavy1", "Heavy2", "Heavy3", "Light", "Notify"]
        result = shard.plan({"mode": "full", "identifiers": ["TalariaTests"]}, capacity=self.observation("contended"),
                            table=TABLE, classes=classes)
        self.assertEqual(result["width"], 3)
        ran = {entry["shard"]: [f"{name}/testA" for name in entry["planned"]] for entry in result["shards"]}
        ran[3].append("TalariaTests/Unlisted/testNew")  # A class the scanner missed runs in the catch-all shard.
        lines = shard.check(result, ran)
        self.assertIn("- The catch-all shard also ran unplanned TalariaTests/Unlisted", lines)
        self.assertIn("full suite", lines[-1])

    def test_the_lookup_reads_only_other_live_pull_requests_queued_macos_jobs(self):
        responses = {
            "repos/o/r/actions/workflows/ci.yml/runs?event=pull_request&status=queued&per_page=30": {"workflow_runs": [
                {"id": 10, "head_sha": "a1", "pull_requests": [{"number": 1}]},
                {"id": 11, "head_sha": "a2", "pull_requests": [{"number": 1}]},  # PR 1's newer head supersedes run 10.
                {"id": 12, "head_sha": "b1", "pull_requests": [{"number": 2}]},
                {"id": 99, "head_sha": "self", "pull_requests": [{"number": 3}]}]},  # This run, or a rerun of it.
            "repos/o/r/actions/workflows/ci.yml/runs?event=pull_request&status=in_progress&per_page=30": {"workflow_runs": []},
            "repos/o/r/actions/runs/11/jobs?filter=latest&per_page=100": {"jobs": [
                {"name": "App / App build", "status": "queued", "labels": ["xcode-27"], "created_at": "t"}]},
            "repos/o/r/actions/runs/12/jobs?filter=latest&per_page=100": {"jobs": [
                {"name": "CI Gate", "status": "queued", "labels": ["ubuntu-latest"]},
                {"name": "App / App build", "status": "in_progress", "labels": ["xcode-27"]}]},
        }
        with tempfile.TemporaryDirectory() as directory:
            gh = Path(directory) / "gh"
            (Path(directory) / "responses.json").write_text(json.dumps(responses))
            gh.write_text("#!/usr/bin/env python3\nimport json, sys\nfrom pathlib import Path\n"
                          "responses = json.loads((Path(sys.argv[0]).parent / 'responses.json').read_text())\n"
                          "path = sys.argv[-1]\nif path not in responses: sys.exit(f'404 {path}')\n"
                          "print(json.dumps(responses[path]))\n")
            gh.chmod(0o755)
            env = {**os.environ, "PATH": f"{directory}:{os.environ['PATH']}"}
            observed = json.loads(subprocess.check_output([str(SCRIPT), "capacity"], env={
                **env, "GITHUB_REPOSITORY": "o/r", "GITHUB_RUN_ID": "99"}, text=True))
            self.assertEqual((observed["status"], [(item["run"], item["pull_request"]) for item in observed["competing"]]),
                             ("contended", [(11, 1)]))
            unavailable = json.loads(subprocess.check_output([str(SCRIPT), "capacity"], env={
                **env, "GITHUB_REPOSITORY": "missing/r", "GITHUB_RUN_ID": "99"}, text=True))
            self.assertEqual(unavailable["status"], "unavailable")


class ReceiptTests(unittest.TestCase):
    PLAN = {"partial": True, "shards": [
        {"shard": 1, "target": "TalariaTests", "planned": ["TalariaTests/A", "TalariaTests/B/testOne"], "catch_all": False, "repetitions": 1},
        {"shard": 2, "target": "TalariaTests", "planned": ["TalariaTests/C"], "catch_all": False, "repetitions": 1}]}
    RAN = {1: ["TalariaTests/A/testX", "TalariaTests/A/testY", "TalariaTests/B/testOne"], 2: ["TalariaTests/C/testZ"]}

    def test_receipts_must_match_the_plan_exactly(self):
        lines = shard.check(self.PLAN, self.RAN)
        self.assertIn("partial", lines[-1])
        broken = {
            "ran nothing for planned TalariaTests/B/testOne": {**self.RAN, 1: ["TalariaTests/A/testX"]},
            "TalariaTests/A/testX ran 2 times in shard 1": {**self.RAN, 1: [*self.RAN[1], "TalariaTests/A/testX"]},
            "ran in shard 1 and shard 2": {**self.RAN, 2: ["TalariaTests/C/testZ", "TalariaTests/A/testX"]},
            "outside TalariaTests": {**self.RAN, 2: ["TalariaKitTests/C/testZ"]},
            "ran unplanned TalariaTests/B/testTwo": {**self.RAN, 1: [*self.RAN[1], "TalariaTests/B/testTwo"]},
            "shard 2 ran no tests": {**self.RAN, 2: []},
            "expected receipts for shards [1, 2]": {1: self.RAN[1]},
        }
        for message, ran in broken.items():
            with self.subTest(message), self.assertRaisesRegex(ValueError, message.replace("[", r"\[").replace("]", r"\]")):
                shard.check(self.PLAN, ran)

    def test_a_focused_run_may_repeat_up_to_its_attempts(self):
        plan = {"shards": [{**self.PLAN["shards"][0], "planned": ["TalariaTests/B/testOne"], "repetitions": 3}]}
        shard.check(plan, {1: ["TalariaTests/B/testOne"] * 3})
        with self.assertRaisesRegex(ValueError, "4 times"):
            shard.check(plan, {1: ["TalariaTests/B/testOne"] * 4})

    def test_cases_and_attempts_come_from_the_result_bundle_or_the_package_log(self):
        def case(identifier, results):
            return {"nodeType": "Test Case", "nodeIdentifier": identifier, "result": results[-1],
                    "children": [{"nodeType": "Repetition", "result": result} for result in results] if len(results) > 1 else []}
        bundle = {"testNodes": [{"nodeType": "Test Plan", "children": [{"nodeType": "Unit test bundle", "name": "TalariaTests",
                  "children": [{"nodeType": "Test Suite", "name": "B", "children": [
                      case("B/testOne()", ["Passed", "Passed", "Failed"]), case("B/testTwo()", ["Passed"])]}]}]}]}
        log = ("Test Case '-[TalariaKitTests.D testX]' started.\n"
               "Test Case '-[TalariaKitTests.D testX]' passed (0.003 seconds).\n"
               "Test Case '-[TalariaKitTests.D testY]' failed (0.010 seconds).\n")
        with tempfile.TemporaryDirectory() as directory:
            results, output = Path(directory) / "results.json", Path(directory) / "package.log"
            results.write_text(json.dumps(bundle))
            output.write_text(log)
            self.assertEqual(shard.cases(results), ["TalariaTests/B/testOne"] * 3 + ["TalariaTests/B/testTwo"])
            self.assertEqual(shard.attempts(results), {"TalariaTests/B/testOne": (3, 3), "TalariaTests/B/testTwo": (1, None)})
            self.assertEqual(shard.cases(output), ["TalariaKitTests/D/testX", "TalariaKitTests/D/testY"])

    def test_a_package_lane_checks_and_filters_as_one_shard(self):
        plan = {"lanes": {"TalariaKitTests": {"mode": "explicit", "identifiers": ["TalariaKitTests/D", "TalariaKitTests/E/testF"]}}}
        self.assertEqual(shard.swift_filter(plan), r"^TalariaKitTests\.D/|^TalariaKitTests\.E/testF$")
        shard.check(plan, {1: ["TalariaKitTests/D/testX", "TalariaKitTests/E/testF"]})
        with self.assertRaisesRegex(ValueError, "ran nothing for planned TalariaKitTests/E/testF"):
            shard.check(plan, {1: ["TalariaKitTests/D/testX"]})


class FocusTests(unittest.TestCase):
    def test_a_focused_request_is_validated_against_the_checkout(self):
        method = "TalariaTests/SessionListHostedTests/testDeepLinkedChatKeepsNavigationStackAndToolbarMounted"
        result = shard.focus("5", [method])
        self.assertEqual((result["target"], result["repetitions"], result["lanes"]["TalariaTests"]["identifiers"]),
                         ("TalariaTests", 5, [method]))
        self.assertEqual(result["lanes"]["TalariaKitTests"]["mode"], "empty")
        invalid = {
            "no test method testTypo": ("1", ["TalariaTests/SessionListHostedTests/testTypo"]),
            "no test class SessionListHostedTest": ("1", ["TalariaTests/SessionListHostedTest"]),
            "from 1 to 100": ("101", [method]),
            "not '0'": ("0", [method]),
            "one of TalariaKitTests, TalariaTests": ("1", [method, "TalariaKitTests/SharedContractTests"]),
            "at least one": ("1", []),
        }
        for message, (repetitions, identifiers) in invalid.items():
            with self.subTest(message), self.assertRaisesRegex(ValueError, message):
                shard.focus(repetitions, identifiers)


class WorkflowTests(unittest.TestCase):
    def test_the_workflow_runs_one_job_per_planned_shard(self):
        workflow = (HERE.parents[1] / ".github/workflows/app-tests.yml").read_text()
        self.assertIn("include: ${{ fromJSON(needs.build-started.outputs.shards) }}", workflow)
        self.assertEqual(shard.MAX_SHARDS, 4)


if __name__ == "__main__":
    unittest.main()
