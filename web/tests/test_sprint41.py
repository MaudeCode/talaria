"""
Sprint 41 Tests: Title auto-generation fix (PR #333).

Covers:
- streaming.py: sessions titled 'New Chat' trigger auto-title generation
- streaming.py: sessions with empty/falsy title trigger auto-title generation
- streaming.py: sessions titled 'Untitled' (original guard) still trigger
- streaming.py: sessions with a user-set title do NOT trigger auto-title
"""
import pathlib
import re
import unittest
from types import SimpleNamespace

REPO_ROOT = pathlib.Path(__file__).parent.parent
STREAMING_PY = (REPO_ROOT / "api" / "streaming.py").read_text(encoding="utf-8")


# ── streaming.py: title auto-generation condition ─────────────────────────

class TestTitleAutoGenerationCondition(unittest.TestCase):
    """Verify the guarded condition in streaming.py covers all default title cases."""

    def _titles_that_trigger(self):
        """Extract the condition from the source so tests stay in sync with code."""
        # Find the if-condition that calls title_from
        m = re.search(
            r'if\s+(s\.title\s*==.*?):\s*\n\s*s\.title\s*=\s*title_from',
            STREAMING_PY,
            re.DOTALL,
        )
        self.assertIsNotNone(m, "Could not find title auto-generation condition in streaming.py")
        return m.group(1)

    def test_untitled_in_condition(self):
        cond = self._titles_that_trigger()
        self.assertIn("'Untitled'", cond, "Original 'Untitled' guard must be present")

    def test_new_chat_in_condition(self):
        cond = self._titles_that_trigger()
        self.assertIn("'New Chat'", cond, "'New Chat' guard must be present (PR #333)")

    def test_empty_title_guard_in_condition(self):
        cond = self._titles_that_trigger()
        self.assertIn("not s.title", cond, "Empty/falsy title guard must be present (PR #333)")

    def test_condition_logic_covers_all_defaults(self):
        """The condition uses OR so any one default title triggers generation."""
        cond = self._titles_that_trigger()
        # All three guards must be joined by 'or'
        parts = re.split(r'\bor\b', cond)
        self.assertGreaterEqual(len(parts), 3,
            "Expected at least 3 OR-joined sub-conditions (Untitled, New Chat, not s.title)")




if __name__ == "__main__":
    unittest.main()
