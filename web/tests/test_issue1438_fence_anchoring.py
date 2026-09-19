from __future__ import annotations

import re
from pathlib import Path

import pytest

from tests.test_sprint16 import render_md  # Python mirror of renderMd()


def _strip_pre_blocks(out: str) -> str:
    """Remove all <pre>...</pre> blocks for assertions about the surrounding text."""
    return re.sub(r"<pre[\s\S]*?</pre>", "", out)


# ── 1. THE BUG: Cygnus's exact repro ──────────────────────────────────────────


def test_inner_triple_backtick_inside_regex_does_not_terminate_outer_fence():
    """Cygnus's exact input — a regex literal with ``` in a lookbehind."""
    text = (
        "Here's the regex:\n\n"
        "```regex\n"
        "(?<!\\n)(?<!(?:^|\\n)[ \\t]*(?:```[^\\n]*|%%[ \\t]*(?:\\n|$)))\n"
        "```\n\n"
        "uses **bold** for emphasis."
    )
    out = render_md(text)

    # ── Structural property: exactly one fence captured the right extent.
    assert out.count("<pre>") == 1, f"expected 1 <pre>, got {out.count('<pre>')}"
    assert out.count("</pre>") == 1

    # ── The inner ``` is preserved as literal text inside the code block.
    #    Before the fix, the `</code></pre>` would appear MID-content and the
    #    inner ``` would NOT survive (the regex ate it as a delimiter).
    pre_block = re.search(r"<pre[\s\S]*?</pre>", out)
    assert pre_block, "no <pre> block found"
    assert "```[^" in pre_block.group(0), (
        "inner triple backtick should be preserved as literal inside the code block"
    )
    assert "%%" in pre_block.group(0), "tail of regex must survive inside code block"

    # ── No orphaned ``` outside any <pre> block.
    #    Before the fix, the trailing ``` (which used to be a closing fence)
    #    leaked into the surrounding markdown stream as literal text.
    outside = _strip_pre_blocks(out)
    assert "```" not in outside, f"orphaned ``` leaked outside <pre>: {outside!r}"

    # ── Bold renders correctly AFTER the fence.
    assert "<strong>bold</strong>" in out, "bold must survive intact"
    # Strong tags balanced.
    assert out.count("<strong>") == out.count("</strong>")


# ── 2. Inline triple-backtick in running text must NOT open a fence ────────────


def test_inline_triple_backtick_in_paragraph_does_not_open_fence():
    """A ``` in the middle of a sentence must not be treated as a fence opener."""
    text = "Plain text with ``` in the middle of a sentence."
    out = render_md(text)
    assert "<pre>" not in out
    # The literal ``` survives somewhere in the rendered output.
    assert "```" in out


def test_three_backticks_at_end_of_sentence_no_fence():
    """``` immediately after text on the same line — not a fence."""
    text = "End with``` not a fence"
    out = render_md(text)
    assert "<pre>" not in out


def test_unmatched_partial_fence_does_not_eat_message():
    """Partial/streaming input with no closing fence — must not match anything.

    Before the fix, an inner ``` could pair with itself and produce a bogus <pre>.
    With anchoring, no match occurs and content stays as plain text.
    """
    text = "```python\nincomplete code, no close yet"
    out = render_md(text)
    assert "<pre>" not in out
    assert "incomplete code" in out


# ── 3. Existing happy paths must keep working ─────────────────────────────────


def test_simple_python_fence_renders():
    text = "```python\nprint('hi')\n```"
    out = render_md(text)
    assert "<pre>" in out
    # esc() may HTML-encode quotes; either form is fine.
    assert "print(&#x27;hi&#x27;)" in out or "print('hi')" in out
    # Language tag preserved.
    assert 'class="pre-header">python' in out


def test_fence_after_paragraph_no_blank_line_required():
    """CommonMark allows a fence directly after text — `\\n` is enough."""
    text = "Some text\n```\nx = 1\n```"
    out = render_md(text)
    assert "<pre>" in out
    assert "x = 1" in out


def test_fence_at_end_of_input_no_trailing_newline():
    """Closing fence at the very end of input (no newline after)."""
    text = "Intro\n\n```\nfoo\n```"
    out = render_md(text)
    assert out.count("<pre>") == 1
    assert "foo" in out


def test_two_adjacent_fenced_blocks_render_independently():
    text = "```\nA\n```\n\n```\nB\n```"
    out = render_md(text)
    assert out.count("<pre>") == 2
    assert "A" in out and "B" in out


def test_three_space_indented_fence_still_recognised():
    """CommonMark allows up to 3 spaces of indent on fence lines."""
    text = "   ```\nfoo\n   ```"
    out = render_md(text)
    assert "<pre>" in out
    assert "foo" in out


def test_four_space_indent_is_not_a_fence():
    """4+ spaces is an indented code block in CommonMark, not a fence.

    With the line-anchored regex, this no longer matches the fence regex, so
    no <pre> with bogus content. We don't implement strict CommonMark
    indented-code-block behaviour — just verify we don't false-positive.
    """
    text = "    ```py\n    foo\n    ```"
    out = render_md(text)
    assert "<pre>" not in out


# ── 4. Bold/italic/inline-code outside a fence still work after the fix ───────


def test_bold_after_fence_renders_correctly():
    text = "```\ncode\n```\n\nThen **bold** text."
    out = render_md(text)
    assert "<pre>" in out
    assert "<strong>bold</strong>" in out


def test_italic_after_fence_renders_correctly():
    text = "```\ncode\n```\n\nThen *italic* text."
    out = render_md(text)
    assert "<pre>" in out
    assert "<em>italic</em>" in out


def test_inline_code_after_fence():
    text = "```\nblock\n```\n\nThen `inline` code."
    out = render_md(text)
    assert "<pre>" in out
    assert "<code>inline</code>" in out


# ── 5. SOURCE-LEVEL guards (catch regression of any of the 3 patched sites) ───


# ── 6. Diff/patch fence with inner ``` in content ─────────────────────────────
