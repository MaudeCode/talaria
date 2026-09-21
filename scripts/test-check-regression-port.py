#!/usr/bin/env python3
"""Tests for scripts/check-regression-port.py. Run: python3 scripts/test-check-regression-port.py"""
import importlib.util
import tempfile
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location("check_regression_port", str(Path(__file__).with_name("check-regression-port.py")))
crp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(crp)


def _repo(ledger: str, tests: dict[str, str]) -> Path:
    root = Path(tempfile.mkdtemp(prefix="port-check-"))
    (root / crp.LEDGER).parent.mkdir(parents=True)
    (root / crp.LEDGER).write_text(ledger, encoding="utf-8")
    for name, body in tests.items():
        path = root / crp.TEST_ROOT / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
    return root


class CheckRegressionPort(unittest.TestCase):
    def test_clean_ledger_passes(self) -> None:
        root = _repo(
            "file\tcase\tstatus\tref\n"
            "test_issue1.py\ttest_a\tasserted\tsrc/x.test.ts\n"
            "test_issue1.py\ttest_b\tsubject\tsrc/x.test.ts\n"
            "test_issue2.py\ttest_c\tdropped\tpython internals\n",
            {"server/src/x.test.ts": "it('[py:test_issue1.py::test_a] answers 404', () => {})\n"},
        )
        self.assertEqual(crp.check(root), [])

    def test_missing_marker_unknown_marker_and_bad_rows_fail(self) -> None:
        root = _repo(
            "file\tcase\tstatus\tref\n"
            "test_issue1.py\ttest_a\tasserted\tsrc/x.test.ts\n"
            "test_issue1.py\ttest_b\tsubject\tsrc/x.test.ts\n"
            "test_issue1.py\ttest_b\tsubject\tsrc/x.test.ts\n"
            "test_issue3.py\ttest_d\tmaybe\t\n",
            {"server/src/x.test.ts": "it('[py:test_issue1.py::test_b] x', () => {})\nit('[py:test_issue9.py::test_z] y', () => {})\n"},
        )
        errors = "\n".join(crp.check(root))
        self.assertIn("asserted case test_issue1.py::test_a has no [py:...] marker", errors)
        self.assertIn("marker test_issue9.py::test_z", errors)
        self.assertIn("exists but the ledger says subject", errors)
        self.assertIn("duplicate case test_issue1.py::test_b", errors)
        self.assertIn("unknown status 'maybe'", errors)
        self.assertIn("empty ref", errors)

    def test_missing_ledger_is_an_error(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="port-check-"))
        self.assertEqual(len(crp.check(root)), 1)


if __name__ == "__main__":
    unittest.main()
