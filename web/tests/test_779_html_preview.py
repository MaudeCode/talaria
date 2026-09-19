"""Tests for inline HTML preview in workspace panel (issue #779)."""
import pytest


def _get_routes_content():
    return open("api/routes.py", encoding="utf-8").read()


def _get_workspace_js():
    return open("static/workspace.js", encoding="utf-8").read()


def _get_index_html():
    return open("static/index.html", encoding="utf-8").read()


def test_inline_preview_param_in_file_raw():
    """?inline=1 must bypass Content-Disposition: attachment for text/html."""
    content = _get_routes_content()
    assert "inline_preview" in content, (
        "_handle_file_raw must read the inline query parameter"
    )
    assert "html_inline_ok" in content, (
        "_handle_file_raw must allow HTML inline when inline_preview=True"
    )


def test_mime_map_includes_html_and_htm():
    """MIME_MAP must map .html/.htm to text/html — without this, _handle_file_raw
    falls back to application/octet-stream and browsers refuse to render the
    response inside the preview iframe (issue #779 follow-up: PR #1070)."""
    from api.config import MIME_MAP
    assert MIME_MAP.get(".html") == "text/html", (
        "MIME_MAP['.html'] must be 'text/html' for the workspace HTML preview iframe"
    )
    assert MIME_MAP.get(".htm") == "text/html", (
        "MIME_MAP['.htm'] must be 'text/html' for the workspace HTML preview iframe"
    )


def test_inline_html_response_sets_csp_sandbox():
    """Defense-in-depth: ?inline=1 HTML responses must set Content-Security-Policy:
    sandbox so the same origin isolation applies even when the URL is opened
    directly in a top-level tab (not just inside the workspace panel iframe).

    Without this, a user tricked into clicking a chat link like
    /api/file/raw?path=evil.html&inline=1 would render the HTML in the WebUI's
    origin without any sandbox, giving the page full access to cookies and
    localStorage. The CSP sandbox directive (no allow-same-origin) downgrades
    the document to a unique opaque origin server-side.
    """
    content = _get_routes_content()
    # Find the html_inline_ok block in _handle_file_raw
    idx = content.find("html_inline_ok")
    assert idx != -1, "html_inline_ok block not found"
    block = content[idx:idx + 2500]
    assert "Content-Security-Policy" in block, (
        "_handle_file_raw must set Content-Security-Policy header on inline HTML responses"
    )
    assert "sandbox" in block, (
        "CSP must include the sandbox directive"
    )
    # Must NOT have allow-same-origin in the sandbox directive
    csp_sections = [line for line in block.splitlines() if "sandbox" in line and "Policy" in line]
    for line in csp_sections:
        # The line setting the CSP header — make sure it doesn't grant same-origin
        if "send_header" in line:
            assert "allow-same-origin" not in line, (
                "CSP sandbox must NOT include allow-same-origin — that would defeat the isolation"
            )


def test_file_raw_inline_responses_use_sandbox_csp():
    """The explicit inline-open contract should sandbox non-download raw files."""
    content = _get_routes_content()
    idx = content.find("def _handle_file_raw")
    assert idx != -1, "_handle_file_raw not found"
    block = content[idx:idx + 2200]
    assert "sandbox_csp" in block
    assert "inline_preview" in block
    assert "disposition == \"inline\"" in block
    assert "csp=sandbox_csp" in block or "csp=csp" in block
