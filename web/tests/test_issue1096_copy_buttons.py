"""Tests for #1096 — copy buttons work via Permissions-Policy + fallback."""
import re


def _src(name: str) -> str:
    with open(f"static/{name}", encoding="utf-8") as f:
        return f.read()


def _py_src() -> str:
    with open("api/helpers.py", encoding="utf-8") as f:
        return f.read()


class TestClipboardPermissions:
    """Permissions-Policy must allow clipboard-write for the origin."""

    def test_permissions_policy_includes_clipboard_write(self):
        """Permissions-Policy header must include clipboard-write=(self)."""
        src = _py_src()
        # Match the Permissions-Policy value string (may span lines)
        m = re.search(r"Permissions-Policy',\s*'(.*?)'", src, re.DOTALL)
        assert m, "Permissions-Policy header value must exist"
        assert "clipboard-write=(self)" in m.group(1), \
            "Permissions-Policy must include clipboard-write=(self)"
