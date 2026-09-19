from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
CONFIG_PY = (REPO_ROOT / "api" / "config.py").read_text(encoding="utf-8")
def _exec_norm():
    """Re-execute the _norm_model_id closure body via a synthetic def, returning the function."""
    # Extract source between `def _norm_model_id(model_id: str) -> str:` and the next `def _build_configured_model_badges`
    start_marker = "def _norm_model_id(model_id: str) -> str:"
    end_marker = "def _build_configured_model_badges"
    s = CONFIG_PY.find(start_marker)
    e = CONFIG_PY.find(end_marker, s)
    assert s != -1 and e != -1
    body = CONFIG_PY[s:e]
    # Dedent (it's nested 8 spaces inside a function)
    lines = body.splitlines()
    # Find first non-blank line indent
    indent = None
    for ln in lines:
        if ln.strip():
            indent = len(ln) - len(ln.lstrip())
            break
    dedented = "\n".join(ln[indent:] if len(ln) >= indent else ln for ln in lines)
    ns = {}
    exec(dedented, ns)
    return ns["_norm_model_id"]


def test_norm_model_id_trailing_colon_keeps_original():
    """Malformed @provider: ids with trailing colon must not collapse to empty."""
    norm = _exec_norm()
    # Trailing colon — last split segment is empty, must fall back to original
    out = norm("@custom:foo:bar:")
    assert out, f"trailing-colon collapsed to empty: {out!r}"


def test_norm_model_id_clean_multi_segment_strips_correctly():
    """Clean @custom:vendor:model strips @custom: prefix, preserving hierarchy."""
    norm = _exec_norm()
    assert norm("@custom:jingdong:GLM-5") == "jingdong:glm.5"


def test_norm_model_id_trailing_slash_keeps_original():
    """Same guard on the / branch — trailing slash must not collapse to empty."""
    norm = _exec_norm()
    out = norm("custom/jingdong/")
    assert out, f"trailing-slash collapsed to empty: {out!r}"


def test_norm_model_id_simple_inputs_unchanged():
    """Sanity: simple inputs round-trip as before."""
    norm = _exec_norm()
    assert norm("gpt-4") == "gpt.4"
    assert norm("provider/model-name") == "model.name"
    assert norm("") == ""
    assert norm(None) == ""
