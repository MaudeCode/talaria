from __future__ import annotations

from pathlib import Path
import re
import shutil
import subprocess

import pytest

from tests.test_sprint16 import render_md


REPO = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")


# ── Behavior tests via the Python mirror ─────────────────────────────────────


def test_glued_bold_after_period_lifts_to_own_paragraph():
    """Sentence-glued **Heading** with period before it must be lifted to its own paragraph."""
    src = "Para text.**Bold heading**\n\nNext para."
    out = render_md(src)
    assert "<p>Para text.</p>" in out, f"Period sentence not isolated: {out!r}"
    assert "<p><strong>Bold heading</strong></p>" in out, (
        f"Lifted bold not in its own paragraph: {out!r}"
    )


def test_glued_bold_after_question_mark_lifts():
    """Glued-bold after `?` should also lift — common in LLM reasoning mode."""
    src = "Why does this happen?**The answer**\n\nNext para."
    out = render_md(src)
    assert "<p>Why does this happen?</p>" in out, out
    assert "<p><strong>The answer</strong></p>" in out, out


def test_glued_bold_after_exclamation_lifts():
    """Glued-bold after `!` should also lift — emphatic transition."""
    src = "Found it!**Section title**\n\nMore text."
    out = render_md(src)
    assert "<p>Found it!</p>" in out, out
    assert "<p><strong>Section title</strong></p>" in out, out


# ── Preserve-emphasis cases (no false positives) ─────────────────────────────


def test_mid_paragraph_bold_unchanged():
    """Bold mid-sentence with no period before and no `\\n\\n` after must NOT be lifted."""
    src = "This is **important** to know."
    out = render_md(src)
    assert "<p>This is <strong>important</strong> to know.</p>" in out, out


def test_trailing_bold_without_period_unchanged():
    """Bold at end of paragraph WITHOUT a sentence-terminator before it must stay inline."""
    src = "Some text **emphasis** here."
    out = render_md(src)
    assert "<strong>emphasis</strong>" in out
    assert "<p><strong>emphasis</strong></p>" not in out


def test_trailing_bold_with_period_after_bold_unchanged():
    """`text **important**.\\n\\n` (period AFTER bold) must NOT trigger the lift —
    the regex requires period IMMEDIATELY before the `**`."""
    src = "This is **important**.\n\nNext."
    out = render_md(src)
    assert "<p>This is <strong>important</strong>.</p>" in out, out
    assert "<p><strong>important</strong></p>" not in out


def test_glued_bold_without_blank_line_unchanged():
    """`text.**Bold**\\nMore text` (single newline, no blank line) must NOT be lifted —
    the regex requires `\\n\\n` after."""
    src = "Para.**Bold**\nMore text on next line."
    out = render_md(src)
    assert "<strong>Bold</strong>" in out
    assert "<p><strong>Bold</strong></p>" not in out


def test_long_bold_phrase_not_lifted():
    """Bold runs longer than 80 chars are likely emphasis prose, not headings — don't lift."""
    long_bold = "x" * 100
    src = f"Para.**{long_bold}**\n\nNext."
    out = render_md(src)
    assert f"<strong>{long_bold}</strong>" in out
    assert f"<p><strong>{long_bold}</strong></p>" not in out


def test_intentional_block_final_bold_with_no_glue_unchanged():
    """`text **bold**\\n\\n` (space before `**`, no glued period) must NOT be lifted."""
    src = "Para text **bold**\n\nNext."
    out = render_md(src)
    assert "<p>Para text <strong>bold</strong></p>" in out, out


# ── Multi-occurrence + paragraph chain ───────────────────────────────────────


def test_chain_of_glued_headings_all_lifted():
    """Chained glued-heading paragraphs should all lift — common LLM thinking-mode shape."""
    src = (
        "First text.**Heading A**\n\n"
        "Second text.**Heading B**\n\n"
        "Third text.\n"
    )
    out = render_md(src)
    assert "<p>First text.</p>" in out, out
    assert "<p><strong>Heading A</strong></p>" in out, out
    assert "<p>Second text.</p>" in out, out
    assert "<p><strong>Heading B</strong></p>" in out, out
    assert "<p>Third text.</p>" in out, out


# ── Source-level structural check on ui.js ───────────────────────────────────


# ── Node-driver tests (run against the actual JS) ────────────────────────────


_DRIVER_SRC = r"""
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
global.window = {};
global.document = { createElement: () => ({ innerHTML: '', textContent: '' }) };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const _IMAGE_EXTS=/\.(png|jpg|jpeg|gif|webp|bmp|ico|avif)$/i;
const _SVG_EXTS=/\.svg$/i;
const _AUDIO_EXTS=/\.(mp3|ogg|wav|m4a|aac|flac|wma|opus|webm)$/i;
const _VIDEO_EXTS=/\.(mp4|webm|mkv|mov|avi|ogv|m4v)$/i;

function extractFunc(name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\(');
  const start = src.search(re);
  if (start < 0) throw new Error(name + ' not found');
  let i = src.indexOf('{', start);
  let depth = 1; i++;
  while (depth > 0 && i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(start, i);
}
eval(extractFunc('_matchBacktickFenceLine'));
eval(extractFunc('_isBacktickFenceClose'));
eval(extractFunc('renderMd'));

let buf = '';
process.stdin.on('data', c => { buf += c; });
process.stdin.on('end', () => { process.stdout.write(renderMd(buf)); });
"""


@pytest.fixture(scope="module")
def driver_path(tmp_path_factory):
    if NODE is None:
        pytest.skip("node not on PATH")
    p = tmp_path_factory.mktemp("renderer1446_driver") / "driver.js"
    p.write_text(_DRIVER_SRC, encoding="utf-8")
    return str(p)
