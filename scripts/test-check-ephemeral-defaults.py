#!/usr/bin/env python3
"""Ephemeral-defaults guard over synthetic test files and the real repository."""

import importlib.util
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("check-ephemeral-defaults.py")
spec = importlib.util.spec_from_file_location("ephemeral", SCRIPT)
ephemeral = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ephemeral)


class EphemeralDefaultsTests(unittest.TestCase):
    def check(self, files):
        with tempfile.TemporaryDirectory(prefix="talaria-ephemeral-") as temporary:
            root = Path(temporary)
            for name, text in files.items():
                path = root / ephemeral.TESTS / "TalariaKitTests" / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text)
            return ephemeral.violations(root)

    def test_a_direct_suite_fails(self):
        # The app-group call after it must not excuse the one-line call before it.
        found = self.check({"StoreTests.swift": """
let defaults = try XCTUnwrap(UserDefaults(suiteName: "StoreTests.\\(UUID())"))
let other = UserDefaults(suiteName: ProviderQuotaWidgetSnapshotStore.appGroupIdentifier)
"""})
        self.assertEqual(len(found), 1)
        self.assertTrue(found[0].startswith("app/TalariaKit/Tests/TalariaKitTests/StoreTests.swift:2:"), found)

    def test_the_helper_and_app_group_suites_pass(self):
        self.assertEqual(self.check({
            "Support/EphemeralDefaults.swift": 'let defaults = UserDefaults(suiteName: suite)!\n',
            "WidgetTests.swift": 'let shared = UserDefaults(\n    suiteName: TalariaShareDraft.appGroupIdentifier\n)\n',
        }), [])

    def test_the_repository_passes(self):
        self.assertEqual(ephemeral.violations(), [])


if __name__ == "__main__":
    unittest.main()
