#!/usr/bin/env python3
"""String catalog CLI contracts on disposable catalogs, without Xcode."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("check-string-catalogs")


class StringCatalogTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.path = self.root / "Nested/Localizable.xcstrings"
        self.path.parent.mkdir()
        self.catalog = {
            "sourceLanguage": "en",
            "strings": {
                "Zebra": {"comment": "Keep this comment", "shouldTranslate": False},
                "Alpha": {"localizations": {"fr": {"stringUnit": {
                    "state": "translated", "value": "Éléphant\n%@",
                }}, "en": {"stringUnit": {"state": "translated", "value": "Elephant"}}}},
                "\U00010000": {}, "\ue000": {}, "é": {},
            },
            "version": "1.0",
        }

    def write(self):
        self.path.write_text(json.dumps(self.catalog, indent=2, ensure_ascii=False,
                                        separators=(",", " : ")) + "\n", encoding="utf-8")

    def run_check(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), str(self.root), *args],
                              capture_output=True, text=True)

    def test_unsorted_reports_first_key_and_fix_without_writing(self):
        self.write()
        before = self.path.read_bytes()
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(str(self.path), result.stderr)
        self.assertIn("first out-of-place key 'Zebra', expected 'Alpha'", result.stderr)
        self.assertIn("app/ci/check-string-catalogs --fix", result.stderr)
        self.assertEqual(self.path.read_bytes(), before)

    def test_sorted_canonical_catalog_passes(self):
        self.catalog["strings"] = {key: self.catalog["strings"][key]
                                   for key in ["Alpha", "Zebra", "é", "\ue000", "\U00010000"]}
        self.write()
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_fix_sorts_preserves_entries_and_is_idempotent(self):
        self.write()
        original = json.loads(self.path.read_bytes())
        result = self.run_check("--fix")
        self.assertEqual(result.returncode, 0, result.stderr)
        fixed = self.path.read_bytes()
        parsed = json.loads(fixed)
        self.assertEqual(list(parsed["strings"]), ["Alpha", "Zebra", "é", "\ue000", "\U00010000"])
        self.assertEqual(parsed, original)
        self.assertEqual(list(parsed["strings"]["Alpha"]["localizations"]), ["fr", "en"])
        self.assertIn("Éléphant".encode(), fixed)
        self.assertEqual(self.run_check().returncode, 0)
        self.assertEqual(self.run_check("--fix").returncode, 0)
        self.assertEqual(self.path.read_bytes(), fixed)

    def test_noncanonical_formatting_fails_and_fix_normalizes_it(self):
        self.path.write_bytes(b'{"sourceLanguage":"en","strings":{"Alpha":{}},"version":"1.0"}')
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(str(self.path), result.stderr)
        self.assertIn("non-canonical serialization", result.stderr)
        self.assertIn("app/ci/check-string-catalogs --fix", result.stderr)
        self.assertEqual(self.run_check("--fix").returncode, 0)
        self.assertEqual(self.path.read_bytes(), b'{\n  "sourceLanguage" : "en",\n  "strings" : {\n'
                         b'    "Alpha" : {}\n  },\n  "version" : "1.0"\n}\n')

    def test_invalid_catalogs_are_rejected_without_rewriting(self):
        for source in (b'{"strings": {"Alpha": {}, "Alpha": {}}}', b'{"strings": []}', b'{bad json'):
            with self.subTest(source=source):
                self.path.write_bytes(source)
                result = self.run_check("--fix")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(str(self.path), result.stderr)
                self.assertEqual(self.path.read_bytes(), source)


if __name__ == "__main__":
    unittest.main()
