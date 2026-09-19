"""#3455 — _splitThinkFromContent persist-path regression tests.

The think-block extraction runs at PERSIST time (inflight state + SSE `done`
finalization), moving inline <think>…</think> reasoning out of m.content into
m.reasoning. Because it rewrites persisted assistant content, the critical
invariant is that it NEVER loses real content: content before/after a think
block survives, partial/unclosed blocks are left intact for the live renderer,
and lookalike tags in code are not falsely extracted.

Drives the live JS via Node (same harness style as the #3368/#1188 suites) so
the test exercises the shipped function, not a Python re-implementation.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
def _extract_block(src: str, marker: str) -> str:
    """Extract a brace-balanced JS block starting at `marker` (a `const x=[` or
    `function name(`)."""
    start = src.index(marker)
    # find first opening bracket of the block ( '[' for the array, '{' for the fn )
    i = start
    while src[i] not in "[{":
        i += 1
    opener = src[i]
    closer = "]" if opener == "[" else "}"
    depth = 0
    j = i
    while j < len(src):
        if src[j] == opener:
            depth += 1
        elif src[j] == closer:
            depth -= 1
            if depth == 0:
                return src[start:j + 1]
        j += 1
    raise AssertionError(f"unbalanced block for {marker!r}")


_DRIVER = """
%s
%s
%s
%s
%s
%s
%s
%s
const args = JSON.parse(process.argv[2]);
process.stdout.write(JSON.stringify(_splitThinkFromContent(args.raw, args.existing || '')));
"""


def _split(driver, raw, existing=""):
    out = subprocess.run(
        ["node", driver, json.dumps({"raw": raw, "existing": existing})],
        capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)


# ── Backend parity: api/streaming._split_thinking_from_content ──────────────
# #3455 review (Codex): the split must also run server-side before s.save() so
# the PERSISTED session file is compacted (the client-only split left the saved
# file bloated). The backend helper must match the JS semantics exactly.

class TestBackendThinkSplitParity:
    def _sp(self, raw, existing=""):
        from api.streaming import _split_thinking_from_content
        return _split_thinking_from_content(raw, existing)

    def test_plain_untouched(self):
        assert self._sp("Hello world") == ("Hello world", "")

    def test_leading_extracted(self):
        assert self._sp("<think>r</think>The answer") == ("The answer", "r")

    def test_mid_body_code_block_preserved(self):
        raw = "```html\n<think>visible literal</think>\n```"
        content, reasoning = self._sp(raw)
        assert content == raw
        assert reasoning == ""

    def test_unclosed_hidden_into_reasoning(self):
        assert self._sp("<think>still...") == ("", "still...")

    def test_existing_reasoning_merged(self):
        assert self._sp("<think>new</think>ans", "prior") == ("ans", "prior\n\nnew")

    def test_multiple_blocks_extracted(self):
        assert self._sp("<think>a</think><think>b</think>end") == ("end", "a\n\nb")

    def test_substring_reasoning_is_not_dropped(self):
        assert self._sp("<think>plan</think>answer", "planning the approach carefully") == (
            "answer",
            "planning the approach carefully\n\nplan",
        )

    def test_empty(self):
        assert self._sp("") == ("", "")

    def test_none_content(self):
        # Defensive: non-string content must not crash.
        content, reasoning = self._sp(None)
        assert content in (None, "")
        assert reasoning == ""

    # ── #3633 deep-review (Codex catch): code-awareness + unclosed-position ──
    def test_inline_backtick_code_span_preserved(self):
        """A <think> literal inside an inline single-backtick code span is code,
        not a thinking trace — it must stay visible (the earlier full-scan only
        protected triple fences)."""
        raw = "Use the `<think>foo</think>` tag in your prompt."
        assert self._sp(raw) == (raw, "")

    def test_indented_code_block_preserved(self):
        """A <think> literal inside a >=4-space indented code block must stay
        visible."""
        raw = "Example:\n\n    <think>foo</think>\n\ndone"
        assert self._sp(raw) == (raw, "")

    def test_mid_body_unclosed_stays_visible(self):
        """An unclosed <think> AFTER visible content (a literal typed tag) must
        NOT truncate the following prose on the persist path."""
        assert self._sp("answer<think>still thinking") == (
            "answer<think>still thinking",
            "",
        )

    def test_leading_unclosed_still_extracted(self):
        """A LEADING unclosed block (cut off mid-thought) is still reasoning."""
        assert self._sp("<think>still thinking") == ("", "still thinking")

    def test_indented_fence_1_3_spaces_preserved(self):
        """A fenced code block indented 1-3 spaces is still a fence (valid
        Markdown), so a literal think tag inside it stays visible."""
        backtick = "text\n  ```\n  <think>lit</think>\n  ```\nend"
        assert self._sp(backtick) == (backtick, "")
        tilde = "text\n   ~~~html\n   <think>lit</think>\n   ~~~\nend"
        assert self._sp(tilde) == (tilde, "")

    def test_leading_whitespace_preserved_when_no_thinking_removed(self):
        """#3633 Codex catch: content is only lstripped when a LEADING thinking
        block/prefix was actually removed. A reply that legitimately starts with
        an indented code block or blank lines (and has no leading thinking
        wrapper) keeps its leading whitespace."""
        assert self._sp("    indented code\nmore") == ("    indented code\nmore", "")
        assert self._sp("\n\n  hi") == ("\n\n  hi", "")
        # ...but a leading thinking block still strips the whitespace after it.
        assert self._sp("<think>r</think>   answer") == ("answer", "r")
