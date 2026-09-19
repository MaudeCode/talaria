import pathlib
import re
import html as _html

REPO_ROOT = pathlib.Path(__file__).parent.parent
# ── Helpers ───────────────────────────────────────────────────────────────────

def esc(s):
    return _html.escape(str(s), quote=True)


def inline_md(t):
    """
    Python mirror of the fixed inlineMd() function — includes:
    - _code_stash (protects backtick spans from bold/italic AND from image pass)
    - image pass (NEW for #487 — runs while code stash is active, before link pass)
    - _img_stash (protects rendered img tags from autolink touching src=)
    - _link_stash (protects links from autolink)
    - autolink
    - code stash restore (after autolink, so code content is never autolinked)

    Correct operation order:
      1. code stash        — \x00C  protects `...` from bold and image pass
      2. bold/italic       — runs on plain text only
      3. image pass        — runs while code content is still stashed (so ![x](url)
                             inside backticks stays protected as a \x00C token)
      4. img stash         — \x00I  protects <img src="url"> from autolink
      5. link stash        — \x00L  protects [label](url) links from autolink
      6. autolink          — only matches URLs not already in a stash token
      7. link stash restore
      8. img stash restore
      9. code stash restore — restores <code> tags last
    """
    # 1. Code stash — must be first to protect code content from all subsequent passes
    code_stash = []
    def stash_code(m):
        code_stash.append(f'<code>{esc(m.group(1))}</code>')
        return f'\x00C{len(code_stash)-1}\x00'
    t = re.sub(r'`([^`\n]+)`', stash_code, t)

    # 2. Bold/italic (code content is safely stashed)
    t = re.sub(r'\*\*\*(.+?)\*\*\*', lambda m: f'<strong><em>{esc(m.group(1))}</em></strong>', t)
    t = re.sub(r'\*\*(.+?)\*\*',     lambda m: f'<strong>{esc(m.group(1))}</strong>', t)
    t = re.sub(r'\*([^*\n]+)\*',     lambda m: f'<em>{esc(m.group(1))}</em>', t)

    # 3. Image pass (NEW — runs while code is still stashed, so ![x](url) inside
    #    backticks is protected as a \x00C token and won't match here)
    def render_image(m):
        alt, url = m.group(1), m.group(2)
        safe_url = url.replace('"', '%22')
        return (f'<img src="{safe_url}" alt="{esc(alt)}" '
                f'class="msg-media-img" loading="lazy" '
                f'onclick="this.classList.toggle(\'msg-media-img--full\')">')
    t = re.sub(r'!\[([^\]]*)\]\((https?://[^\)]+)\)', render_image, t)

    # 4. Img stash — protect rendered <img> tags so autolink never touches src= values
    img_stash = []
    def stash_img(m):
        img_stash.append(m.group(0))
        return f'\x00I{len(img_stash)-1}\x00'
    t = re.sub(r'<img\b[^>]*>', stash_img, t)

    # 5. Link stash
    link_stash = []
    def stash_link(m):
        lb, u = m.group(1), m.group(2)
        link_stash.append(f'<a href="{u.replace(chr(34), "%22")}" target="_blank" rel="noopener">{esc(lb)}</a>')
        return f'\x00L{len(link_stash)-1}\x00'
    t = re.sub(r'\[([^\]]+)\]\((https?://[^\)]+)\)', stash_link, t)

    # 6. Autolink (img and link URLs are both stashed — safe)
    def autolink(m):
        url = m.group(1)
        trail = url[-1] if url[-1] in '.,;:!?)' else ''
        clean = url[:-1] if trail else url
        return f'<a href="{clean}" target="_blank" rel="noopener">{esc(clean)}</a>{trail}'
    t = re.sub(r'(https?://[^\s<>"\')\]]+)', autolink, t)

    # 7. Restore link stash
    t = re.sub(r'\x00L(\d+)\x00', lambda m: link_stash[int(m.group(1))], t)

    # 8. Restore img stash
    t = re.sub(r'\x00I(\d+)\x00', lambda m: img_stash[int(m.group(1))], t)

    # 9. Restore code stash (last — code content was never touched by any pass)
    t = re.sub(r'\x00C(\d+)\x00', lambda m: code_stash[int(m.group(1))], t)
    return t


def render_table(md):
    """Python mirror of the table pass, using inline_md() per cell."""
    lines = md.strip().split('\n')
    if len(lines) < 2:
        return md

    def is_sep(r):
        return bool(re.match(r'^\|[\s|:-]+\|$', r.strip()))

    if not is_sep(lines[1]):
        return md

    def parse_header(r):
        cells = r.strip().lstrip('|').rstrip('|').split('|')
        return ''.join(f'<th>{inline_md(c.strip())}</th>' for c in cells)

    def parse_row(r):
        cells = r.strip().lstrip('|').rstrip('|').split('|')
        return ''.join(f'<td>{inline_md(c.strip())}</td>' for c in cells)

    header = f'<tr>{parse_header(lines[0])}</tr>'
    body = ''.join(f'<tr>{parse_row(r)}</tr>' for r in lines[2:])
    return f'<table><thead>{header}</thead><tbody>{body}</tbody></table>'


# ═════════════════════════════════════════════════════════════════════════════
# ISSUE #486 — CSS: code inside table cells
# ═════════════════════════════════════════════════════════════════════════════

# ═════════════════════════════════════════════════════════════════════════════
# ISSUE #487 — JS renderer: markdown image syntax
# ═════════════════════════════════════════════════════════════════════════════

# ═════════════════════════════════════════════════════════════════════════════
# Cross-cutting: code + image together inside tables (the edge case Nathan flagged)
# ═════════════════════════════════════════════════════════════════════════════

class TestEdgeCasesCodeAndImageInTables:
    """Combination edge cases: code blocks and images mixed inside table cells."""

    def test_code_and_image_in_same_table_row(self):
        """Table row with code in one cell and image in another renders both correctly."""
        md = ("| Code | Preview |\n"
              "|---|---|\n"
              "| `print('hello')` | ![screenshot](https://example.com/shot.png) |")
        result = render_table(md)
        assert "<code>print(&#x27;hello&#x27;)</code>" in result or "<code>print('hello')</code>" in result, (
            f"Code cell should render as <code>. Got: {result}"
        )
        assert '<img ' in result, "Image cell should render as <img>"

    def test_code_in_cell_with_image_in_next_cell(self):
        """Multiple columns: code stays code, image stays image, no cross-contamination."""
        md = ("| Step | Example |\n"
              "|---|---|\n"
              "| Run `npm install` | ![demo](https://example.com/demo.gif) |")
        result = render_table(md)
        assert '<code>npm install</code>' in result
        assert '<img ' in result
        assert '<a ' not in result  # image must not become a link

    def test_bold_code_in_cell_and_image_in_cell(self):
        """**`code`** in one cell and image in another — no esc() mangling."""
        md = ("| Command | Result |\n"
              "|---|---|\n"
              "| **`git status`** | ![result](https://example.com/r.png) |")
        result = render_table(md)
        assert '&lt;code&gt;' not in result, (
            "Bold+code in table cell must not produce escaped code tags"
        )
        assert '<code>git status</code>' in result
        assert '<img ' in result

    def test_link_code_image_all_in_table(self):
        """Table with code, link, and image cells all render correctly."""
        url = 'https://github.com/issues/486'
        img_url = 'https://example.com/img.png'
        md = (f"| Code | Link | Image |\n"
              f"|---|---|---|\n"
              f"| `var x = 1` | [#486]({url}) | ![img]({img_url}) |")
        result = render_table(md)
        assert '<code>var x = 1</code>' in result
        assert f'href="{url}"' in result
        assert '<img ' in result
        # No double-linking
        assert result.count('<a ') == 1

    def test_image_url_with_query_string_in_table(self):
        """Image URL with & in query string inside table cell — & not mangled."""
        url = 'https://example.com/img?w=100&h=200'
        md = f"| Image |\n|---|\n| ![sized]({url}) |"
        result = render_table(md)
        assert f'src="{url}"' in result, (
            f"& in image URL must not be escaped. Got: {result}"
        )

    def test_image_adjacent_to_code_no_interference(self):
        """Image immediately followed by code span in same cell — no token cross-talk."""
        t = '![x](https://x.com/x.png) `code`'
        result = inline_md(t)
        assert '<img ' in result
        assert '<code>code</code>' in result

    def test_image_inside_code_span_not_rendered(self):
        """An image syntax inside a backtick span must NOT render as an img tag."""
        t = '`![not an image](https://example.com/img.png)`'
        result = inline_md(t)
        # The whole thing is inside backticks — should be literal code, not an img
        assert '<img ' not in result, (
            f"Image syntax inside code span must not render as <img>. Got: {result}"
        )
        # Should render as a code element with the raw text inside
        assert '<code>' in result
