"""Anchor fallback ownership guards for the settled activity scene.

The Stable Assistant Turn Anchor should own settled activity when a message has
`_anchor_activity_scene`. Raw `content[]` ordering and legacy settled tool-card
rebuilds are still required for historical/non-anchor transcripts, but they must
exit before competing with anchor-owned turns.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import textwrap
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
UI_JS_PATH = ROOT / "static" / "ui.js"
PHASE0_DOC_PATH = (
    ROOT / "docs" / "architecture" / "stable-assistant-turn-anchor-phase0.md"
)


def _read_required_text(path: Path, label: str) -> str:
    assert path.exists(), f"{label} not found at {path}"
    return path.read_text(encoding="utf-8")


def _ui_js() -> str:
    return _read_required_text(UI_JS_PATH, "static/ui.js")


def _phase0_doc() -> str:
    return _read_required_text(
        PHASE0_DOC_PATH,
        "Stable Assistant Turn Anchors Phase 0 inventory",
    )


def _run_node_script(script: str) -> str:
    node = shutil.which("node")
    if not node:
        pytest.skip("node executable is required for JavaScript behavior checks")
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".js", encoding="utf-8", delete=False) as handle:
            handle.write(script)
            script_path = handle.name
        try:
            result = subprocess.run(
                [node, script_path],
                cwd=ROOT,
                text=True,
                capture_output=True,
                timeout=10,
            )
        finally:
            Path(script_path).unlink(missing_ok=True)
    except subprocess.TimeoutExpired as exc:
        pytest.fail(
            "node behavior check timed out"
            f"\nstdout:\n{exc.stdout or '<empty>'}"
            f"\nstderr:\n{exc.stderr or '<empty>'}",
        )
    if result.returncode:
        pytest.fail(
            "node behavior check failed"
            f"\nexit code: {result.returncode}"
            f"\nstdout:\n{result.stdout or '<empty>'}"
            f"\nstderr:\n{result.stderr or '<empty>'}",
        )
    stdout_lines = [line for line in result.stdout.splitlines() if line.strip()]
    return stdout_lines[-1] if stdout_lines else ""


def _is_js_identifier_char(char: str) -> bool:
    return char.isalnum() or char in {"_", "$"}


def _previous_significant_js_token(src: str, idx: int) -> str:
    idx -= 1
    while idx >= 0 and src[idx].isspace():
        idx -= 1
    if idx < 0:
        return ""
    if _is_js_identifier_char(src[idx]):
        end = idx + 1
        while idx >= 0 and _is_js_identifier_char(src[idx]):
            idx -= 1
        return src[idx + 1 : end]
    return src[idx]


def _looks_like_js_regex_literal_start(src: str, idx: int) -> bool:
    if src[idx] != "/" or src.startswith(("//", "/*"), idx):
        return False
    previous = _previous_significant_js_token(src, idx)
    if previous in {"return", "throw", "case", "delete", "typeof", "void", "yield"}:
        return True
    return previous in {
        "",
        "(",
        "[",
        "{",
        "=",
        ":",
        ",",
        ";",
        "!",
        "?",
        "&",
        "|",
        "+",
        "-",
        "*",
        "%",
        "^",
        "~",
        "<",
        ">",
    }


def _skip_js_regex_literal(src: str, idx: int) -> int:
    assert src[idx] == "/", f"expected regex literal at {idx}"
    idx += 1
    in_class = False
    while idx < len(src):
        if src[idx] == "\\":
            idx += 2
            continue
        if src[idx] == "[":
            in_class = True
        elif src[idx] == "]":
            in_class = False
        elif src[idx] == "/" and not in_class:
            idx += 1
            while idx < len(src) and src[idx].isalpha():
                idx += 1
            return idx
        idx += 1
    raise AssertionError("JavaScript regex literal did not close")


def _skip_js_string_or_comment(src: str, idx: int) -> int:
    if src.startswith("//", idx):
        end = src.find("\n", idx + 2)
        return len(src) if end == -1 else end + 1
    if src.startswith("/*", idx):
        end = src.find("*/", idx + 2)
        assert end != -1, "JavaScript block comment did not close"
        return end + 2
    if _looks_like_js_regex_literal_start(src, idx):
        return _skip_js_regex_literal(src, idx)
    quote = src[idx]
    if quote == "`":
        return _skip_js_template_literal(src, idx)
    if quote not in {"'", '"'}:
        return idx
    idx += 1
    while idx < len(src):
        if src[idx] == "\\":
            idx += 2
            continue
        if src[idx] == quote:
            return idx + 1
        idx += 1
    raise AssertionError(f"JavaScript string literal {quote!r} did not close")


def _skip_js_template_literal(src: str, idx: int) -> int:
    assert src[idx] == "`", f"expected template literal at {idx}"
    idx += 1
    while idx < len(src):
        if src[idx] == "\\":
            idx += 2
            continue
        if src[idx] == "`":
            return idx + 1
        if src.startswith("${", idx):
            expression_close = _matching_delimiter(src, idx + 1, "{", "}")
            idx = expression_close + 1
            continue
        idx += 1
    raise AssertionError("JavaScript template literal did not close")


def _matching_delimiter(src: str, open_idx: int, opener: str, closer: str) -> int:
    assert src[open_idx] == opener, f"expected {opener!r} at {open_idx}"
    depth = 0
    idx = open_idx
    while idx < len(src):
        next_idx = _skip_js_string_or_comment(src, idx)
        if next_idx != idx:
            idx = next_idx
            continue
        if src[idx] == opener:
            depth += 1
        elif src[idx] == closer:
            depth -= 1
            if depth == 0:
                return idx
        idx += 1
    raise AssertionError(f"{opener}{closer} delimiter did not close")


def _skip_js_whitespace(src: str, idx: int) -> int:
    while idx < len(src) and src[idx].isspace():
        idx += 1
    return idx


def _find_function_declaration(src: str, name: str) -> tuple[int, int]:
    idx = 0
    while idx < len(src):
        next_idx = _skip_js_string_or_comment(src, idx)
        if next_idx != idx:
            idx = next_idx
            continue
        if not src.startswith("function", idx):
            idx += 1
            continue
        before = src[idx - 1] if idx else ""
        after_keyword = idx + len("function")
        after = src[after_keyword] if after_keyword < len(src) else ""
        if _is_js_identifier_char(before) or _is_js_identifier_char(after):
            idx += 1
            continue
        name_start = _skip_js_whitespace(src, after_keyword)
        name_end = name_start + len(name)
        if src[name_start:name_end] != name:
            idx += 1
            continue
        after_name = src[name_end] if name_end < len(src) else ""
        if _is_js_identifier_char(after_name):
            idx += 1
            continue
        params_open = _skip_js_whitespace(src, name_end)
        if params_open < len(src) and src[params_open] == "(":
            return idx, params_open
        idx += 1
    raise AssertionError(f"{name} not found")


def _function_source(src: str, name: str) -> str:
    start, params_open = _find_function_declaration(src, name)
    params_close = _matching_delimiter(src, params_open, "(", ")")
    brace = src.find("{", params_close)
    assert brace != -1, f"{name} body not found"
    close = _matching_delimiter(src, brace, "{", "}")
    return src[start : close + 1]


def _function_body(src: str, name: str) -> str:
    _, params_open = _find_function_declaration(src, name)
    params_close = _matching_delimiter(src, params_open, "(", ")")
    brace = src.find("{", params_close)
    assert brace != -1, f"{name} body not found"
    close = _matching_delimiter(src, brace, "{", "}")
    return src[brace + 1 : close]


def test_phase0_doc_records_settled_fallback_ownership_matrix():
    doc = _phase0_doc()

    assert "### Settled Fallback Ownership Matrix" in doc
    assert "_anchor_activity_scene` is the semantic" in doc
    assert "| Settled Compact Worklog activity |" in doc
    assert "| Settled Transparent Stream activity |" in doc
    assert "| Historical / non-anchor transcripts |" in doc
    assert "This matrix is the current settled-render contract" in doc
    assert "compatibility-only rebuilds" in doc
    assert "explicit raw transcript indexes" in doc


def test_function_extractor_handles_nested_template_literal_interpolation():
    source = """
    function sample(){
      const text=`outer ${condition ? `inner ${value}` : { fallback: true }}`;
      if(anchorOwnedAssistantRawIdxs.has(rawIdx)) return;
    }
    function afterSample(){ return false; }
    """

    body = _function_body(source, "sample")

    assert "if(anchorOwnedAssistantRawIdxs.has(rawIdx)) return;" in body
    assert "function afterSample" not in body


def test_function_extractor_matches_exact_declarations_outside_comments():
    source = """
    // function sample(){ return 'comment'; }
    function samplePrefix(){ return 'prefix'; }
    function sample(){
      const hasBrace = /\\{[^}]+\\}/.test(text);
      return hasBrace ? 'target' : 'fallback';
    }
    function afterSample(){ return false; }
    """

    body = _function_body(source, "sample")

    assert "return hasBrace ? 'target' : 'fallback';" in body
    assert "return 'comment';" not in body
    assert "return 'prefix';" not in body
    assert "function afterSample" not in body


def test_function_extractor_ignores_destructured_parameter_braces():
    source = """
    function sample({ fallback = true }){
      if(anchorOwnedAssistantRawIdxs.has(rawIdx)) return;
    }
    """

    body = _function_body(source, "sample")

    assert body.lstrip().startswith("if(anchorOwnedAssistantRawIdxs.has(rawIdx))")
    assert "fallback = true" not in body


def test_function_extractor_skips_regex_after_binary_operator():
    source = """
    function sample(){
      const matcher = fallback || /\\{[^}]+\\}/;
      if(anchorOwnedAssistantRawIdxs.has(rawIdx)) return;
    }
    """

    body = _function_body(source, "sample")

    assert "const matcher = fallback || /\\{[^}]+\\}/;" in body
    assert "if(anchorOwnedAssistantRawIdxs.has(rawIdx)) return;" in body
