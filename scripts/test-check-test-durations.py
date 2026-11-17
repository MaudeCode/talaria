#!/usr/bin/env python3
"""Tests for scripts/check-test-durations.py (TAL-2403).

Run: python3 scripts/test-check-test-durations.py
"""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location("check_test_durations", str(Path(__file__).with_name("check-test-durations.py")))
ctd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ctd)

JUNIT = """<testsuites><testsuite name="s">
<testcase classname="src/a.test.ts" name="outer &gt; slow and listed" time="45"/>
<testcase classname="tests.test_x" name="test_param[mode]" time="40"/>
<testcase classname="session.spec.ts" name="group › fast" time="2"/>
{extra}
</testsuite></testsuites>"""

XCRESULT = {"testNodes": [{"nodeType": "Test Plan", "name": "Plan", "children": [
    {"nodeType": "Unit test bundle", "name": "TalariaTests", "children": [
        {"nodeType": "Test Suite", "name": "ChatTests", "children": [
            {"nodeType": "Test Case", "name": "testListed()", "durationInSeconds": 90.0},
            {"nodeType": "Test Case", "name": "testFast()", "durationInSeconds": 1.0},
            {"nodeType": "Test Case", "name": "testNew()", "durationInSeconds": "{seconds}"},
        ]}]}]}]}

BUDGET = {"budgetSeconds": 30, "overBudget": {
    "src/a.test.ts::slow and listed": "TAL-2405",
    "tests.test_x::test_param": "TAL-2405",
    "ChatTests::testListed": "TAL-2405",
}}


class BudgetTests(unittest.TestCase):
    def run_check(self, name, text):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp, name)
            path.write_text(text)
            return ctd.main([str(path)], BUDGET)

    def test_an_unlisted_test_over_the_budget_fails_and_listed_ones_pass(self):
        for name, within, over in [
            ("junit.xml", JUNIT.format(extra=""), JUNIT.format(extra='<testcase classname="src/b.test.ts" name="new" time="31"/>')),
            ("tests.json", json.dumps(XCRESULT).replace('"{seconds}"', "29"), json.dumps(XCRESULT).replace('"{seconds}"', "31")),
        ]:
            with self.subTest(name):
                self.assertEqual(self.run_check(name, within), 0)
                self.assertEqual(self.run_check(name, over), 1)

    def test_a_report_with_no_test_cases_fails(self):
        self.assertEqual(self.run_check("junit.xml", "<testsuites/>"), 1)
        self.assertEqual(ctd.main([], BUDGET), 1)

    def test_the_committed_budget_lists_each_test_with_its_ticket(self):
        budget = json.loads(ctd.BUDGET.read_text())
        self.assertEqual(budget["budgetSeconds"], 30)
        for key, reason in budget["overBudget"].items():
            self.assertIn("::", key)
            self.assertRegex(reason, r"^TAL-\d+")


if __name__ == "__main__":
    unittest.main()
