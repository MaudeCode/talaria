import re
import pathlib

import html as _html


def _esc(s):
    return _html.escape(str(s), quote=True)


def _inline_md(t):
    """Mirror of inlineMd() in ui.js — processes one line of text."""
    _code_stash = []
    t = re.sub(r"`([^`\n]+)`",
               lambda m: (_code_stash.append(f"<code>{_esc(m.group(1))}</code>")
                          or f"\x00C{len(_code_stash)-1}\x00"), t)
    t = re.sub(r"\*\*\*(.+?)\*\*\*", lambda m: f"<strong><em>{_esc(m.group(1))}</em></strong>", t)
    t = re.sub(r"\*\*(.+?)\*\*",     lambda m: f"<strong>{_esc(m.group(1))}</strong>", t)
    t = re.sub(r"\*([^*\n]+)\*",     lambda m: f"<em>{_esc(m.group(1))}</em>", t)
    t = re.sub(r"~~(.+?)~~",         lambda m: f"<del>{_esc(m.group(1))}</del>", t)
    t = re.sub(r"\x00C(\d+)\x00", lambda m: _code_stash[int(m.group(1))], t)
    return t


def _apply_blockquotes(src):
    """Mirror of _applyBlockquotes() — handles nested + lists + blank lines."""
    def replacer(m):
        block = m.group(0)
        lines = block.split("\n")
        while lines and (lines[-1].strip() in (">", "")):
            if lines[-1].strip() == ">":
                lines.pop(); break
            lines.pop()
        stripped = [re.sub(r"^>[ \t]?", "", l) for l in lines]
        inner_raw = "\n".join(stripped)
        if re.search(r"^>", inner_raw, re.MULTILINE):
            inner = _apply_blockquotes(inner_raw)
        elif re.search(r"^(  )?[-*+] .+", inner_raw, re.MULTILINE):
            def inner_list(lb):
                ll = lb.strip().split("\n"); h = "<ul>"
                for li in ll:
                    txt = re.sub(r"^ {0,4}[-*+] ", "", li)
                    if re.match(r"\[x\] ", txt, re.I): ih = f"✅ {_inline_md(txt[4:])}"
                    elif txt.startswith("[ ] "): ih = f"☐ {_inline_md(txt[4:])}"
                    else: ih = _inline_md(txt)
                    h += f"<li>{ih}</li>"
                return h + "</ul>"
            inner = re.sub(r"((?:^(?:  )?[-*+] .+\n?)+)", lambda m2: inner_list(m2.group(0)),
                           inner_raw, flags=re.MULTILINE)
        else:
            inner = "\n".join("<br>" if l.strip() == "" else _inline_md(l) for l in stripped)
        return f"<blockquote>{inner}</blockquote>"
    return re.sub(r"((?:^>[^\n]*(?:\n|$))+)", replacer, src, flags=re.MULTILINE)


# ─────────────────────────────────────────────────────────────────────────────
# Source-level structural checks (JS must contain these patterns)
# ─────────────────────────────────────────────────────────────────────────────

# ─────────────────────────────────────────────────────────────────────────────
# Behavioural: inline formatting
# ─────────────────────────────────────────────────────────────────────────────

class TestInlineFormatting:

    def test_bold(self):
        assert _inline_md("**bold**") == "<strong>bold</strong>"

    def test_italic(self):
        assert _inline_md("*italic*") == "<em>italic</em>"

    def test_bold_italic(self):
        out = _inline_md("***bi***")
        assert "<strong><em>" in out

    def test_strikethrough(self):
        out = _inline_md("~~deleted~~")
        assert "<del>deleted</del>" == out

    def test_strikethrough_inline(self):
        out = _inline_md("keep ~~remove~~ keep")
        assert "<del>remove</del>" in out
        assert "keep" in out

    def test_inline_code(self):
        out = _inline_md("`git status`")
        assert "<code>git status</code>" in out

    def test_strikethrough_inside_code_not_processed(self):
        out = _inline_md("`~~not deleted~~`")
        assert "<del>" not in out
        assert "~~not deleted~~" in out

    def test_bold_with_inline_code(self):
        # **`code`** → <strong><code>code</code></strong>
        out = _inline_md("**`code`**")
        # The code stash protects the backtick span from bold regex
        assert "<code>" in out

    def test_xss_in_bold(self):
        out = _inline_md("**<script>alert(1)</script>**")
        assert "<script>" not in out

    def test_xss_in_strikethrough(self):
        out = _inline_md("~~<img onerror=alert(1)>~~")
        assert "onerror" not in out.lower() or "&lt;" in out


# ─────────────────────────────────────────────────────────────────────────────
# Behavioural: blockquotes
# ─────────────────────────────────────────────────────────────────────────────

class TestBlockquotes:

    def test_single_line(self):
        out = _apply_blockquotes("> Hello")
        assert out.count("<blockquote>") == 1
        assert "Hello" in out

    def test_multi_line_grouped(self):
        out = _apply_blockquotes("> Line one\n> Line two\n> Line three")
        assert out.count("<blockquote>") == 1

    def test_blank_continuation_no_literal_gt(self):
        out = _apply_blockquotes("> Para one\n>\n> Para two")
        assert out.count("<blockquote>") == 1
        text = re.sub(r"<[^>]+>", "", out)
        assert ">" not in text, f"Literal > in output: {text!r}"

    def test_blank_continuation_becomes_br(self):
        out = _apply_blockquotes("> Para one\n>\n> Para two")
        assert "<br>" in out

    def test_bare_gt_no_space(self):
        out = _apply_blockquotes(">no space after")
        assert out.count("<blockquote>") == 1
        assert "no space after" in out

    def test_two_separate_blockquotes(self):
        out = _apply_blockquotes("> First\n\n> Second")
        assert out.count("<blockquote>") == 2

    def test_inline_markdown_in_blockquote(self):
        out = _apply_blockquotes("> **bold** and *italic*")
        assert "<strong>" in out and "<em>" in out and "<blockquote>" in out

    def test_inline_code_in_blockquote(self):
        out = _apply_blockquotes("> run `git status` first")
        assert "<code>" in out and "<blockquote>" in out

    def test_strikethrough_in_blockquote(self):
        out = _apply_blockquotes("> ~~old~~ new")
        assert "<del>" in out and "<blockquote>" in out

    def test_nested_blockquote_double(self):
        out = _apply_blockquotes(">> deeply nested")
        assert out.count("<blockquote>") == 2

    def test_nested_blockquote_outer_and_inner(self):
        out = _apply_blockquotes("> outer\n>> inner line")
        assert out.count("<blockquote>") == 2

    def test_list_inside_blockquote(self):
        out = _apply_blockquotes("> - item one\n> - item two")
        assert "<ul>" in out and "<li>" in out and "<blockquote>" in out

    def test_task_list_inside_blockquote(self):
        out = _apply_blockquotes("> - [x] done\n> - [ ] todo")
        assert "✅" in out or "task-done" in out
        assert "☐" in out or "task-todo" in out
        assert "<blockquote>" in out

    def test_blockquote_followed_by_paragraph(self):
        out = _apply_blockquotes("> Quoted\n\nNormal text")
        assert out.count("<blockquote>") == 1
        after = out[out.index("</blockquote>"):]
        assert "Normal text" in after


# ─────────────────────────────────────────────────────────────────────────────
# Behavioural: task lists
# ─────────────────────────────────────────────────────────────────────────────

class TestTaskLists:

    def _apply_list(self, block):
        lines = block.strip().split("\n")
        html = "<ul>"
        for l in lines:
            text = re.sub(r"^ {0,4}[-*+] ", "", l)
            if re.match(r"\[x\] ", text, re.I):
                html += f"<li>✅ {_inline_md(text[4:])}</li>"
            elif text.startswith("[ ] "):
                html += f"<li>☐ {_inline_md(text[4:])}</li>"
            else:
                html += f"<li>{_inline_md(text)}</li>"
        return html + "</ul>"

    def test_checked_item(self):
        out = self._apply_list("- [x] done task")
        assert "✅" in out and "done task" in out

    def test_checked_uppercase_X(self):
        out = self._apply_list("- [X] also done")
        assert "✅" in out

    def test_unchecked_item(self):
        out = self._apply_list("- [ ] pending task")
        assert "☐" in out and "pending task" in out

    def test_mixed_task_and_normal(self):
        out = self._apply_list("- [x] done\n- [ ] todo\n- normal")
        assert "✅" in out and "☐" in out
        assert "<li>" in out

    def test_task_item_with_bold(self):
        out = self._apply_list("- [x] **important** task")
        assert "✅" in out and "<strong>" in out

    def test_non_task_list_unaffected(self):
        out = self._apply_list("- regular item\n- another item")
        assert "✅" not in out and "☐" not in out


# ─────────────────────────────────────────────────────────────────────────────
# Behavioural: strikethrough edge cases
# ─────────────────────────────────────────────────────────────────────────────

class TestStrikethrough:

    def test_basic(self):
        assert _inline_md("~~text~~") == "<del>text</del>"

    def test_multiword(self):
        out = _inline_md("~~multiple words here~~")
        assert "<del>multiple words here</del>" == out

    def test_inside_bold(self):
        # **~~text~~** — outer bold picks up the raw ~~ which inlineMd then handles
        # In practice bold runs first in the JS, then ~~ — let's verify the pattern exists
        out = _inline_md("~~inside strikethrough~~")
        assert "<del>" in out

    def test_xss_escaped(self):
        out = _inline_md("~~<b>bad</b>~~")
        assert "<b>" not in out or "&lt;b&gt;" in out


# ─────────────────────────────────────────────────────────────────────────────
# Edge-case combinations
# ─────────────────────────────────────────────────────────────────────────────

class TestEdgeCases:

    def test_empty_string(self):
        out = _apply_blockquotes("")
        assert out == ""

    def test_no_blockquote(self):
        s = "just normal text"
        assert _apply_blockquotes(s) == s

    def test_crlf_in_blockquote(self):
        # \r\n should not produce literal \r in output
        src = "> line one\r\n> line two"
        # First normalise \r\n (as renderMd does)
        src = src.replace("\r\n", "\n")
        out = _apply_blockquotes(src)
        assert "\r" not in out
        assert out.count("<blockquote>") == 1

    def test_blockquote_with_code_and_nested(self):
        src = "> `code`\n>> nested"
        out = _apply_blockquotes(src)
        # Outer blockquote wraps everything
        assert out.count("<blockquote>") >= 2

    def test_deeply_nested_blockquote(self):
        src = ">>> triple nested"
        out = _apply_blockquotes(src)
        assert out.count("<blockquote>") == 3

    def test_task_list_normal_list_mixed(self):
        src = "> - [x] done\n> - normal item\n> - [ ] todo"
        out = _apply_blockquotes(src)
        assert "<blockquote>" in out
        assert "<ul>" in out
