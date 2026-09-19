"""Regression tests for #3959 — Model selector shows duplicate entries for
colon-suffixed model IDs (e.g. :free, :thinking, :discounted).

The normalizer was using parts[-1] (last colon segment) which collapsed all
:free models to the same key 'free'.  Fix: strip only the @provider: prefix
(first colon after @), preserving the rest including colon-suffixed suffixes.
"""
import shutil
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
CONFIG_PY = (REPO_ROOT / "api" / "config.py").read_text(encoding="utf-8")
NODE = shutil.which("node")


def _exec_nested_fn(start_marker: str, end_marker: str, fn_name: str):
    s = CONFIG_PY.find(start_marker)
    e = CONFIG_PY.find(end_marker, s)
    assert s != -1 and e != -1
    body = CONFIG_PY[s:e]
    lines = body.splitlines()
    indent = None
    for ln in lines:
        if ln.strip():
            indent = len(ln) - len(ln.lstrip())
            break
    dedented = "\n".join(ln[indent:] if len(ln) >= indent else ln for ln in lines)
    ns = {}
    exec(dedented, ns)
    return ns[fn_name]


def _exec_norm():
    """Re-execute the _norm_model_id closure body via a synthetic def."""
    return _exec_nested_fn(
        "def _norm_model_id(model_id: str) -> str:",
        "def _build_configured_model_badges",
        "_norm_model_id",
    )


def _exec_static_norm():
    """Re-execute the _norm_static_model_id helper via a synthetic def."""
    return _exec_nested_fn(
        "def _norm_static_model_id(model_id: str) -> str:",
        "norm_lookup: dict[str, list[str]] = {}",
        "_norm_static_model_id",
    )


def test_colon_suffix_model_preserves_suffix():
    """@custom:llm-proxy:kilo/nvidia/nemotron-3-ultra-550b-a55b:free must
    NOT collapse to just 'free'."""
    norm = _exec_norm()
    result = norm("@custom:llm-proxy:kilo/nvidia/nemotron-3-ultra-550b-a55b:free")
    assert "free" in result, f"Expected 'free' in result, got {result!r}"
    assert result != "free", f"Suffix-only collapse is the bug: {result!r}"


def test_free_vs_thinking_produce_different_keys():
    """:free and :thinking variants of the same model must normalize to
    different keys to avoid duplicate selector entries."""
    norm = _exec_norm()
    base = "@custom:llm-proxy:kilo/nvidia/nemotron-3-ultra-550b-a55b"
    key_free = norm(f"{base}:free")
    key_thinking = norm(f"{base}:thinking")
    assert key_free != key_thinking, (
        f":free and :thinking collapsed to same key: "
        f"free={key_free!r}, thinking={key_thinking!r}"
    )


def test_plain_model_id_still_normalizes():
    """Simple model IDs without @ prefix must still normalize correctly."""
    norm = _exec_norm()
    assert norm("gpt-4") == "gpt.4"
    assert norm("") == ""
    assert norm(None) == ""


def test_provider_prefix_only_model():
    """@custom:vendor:model (no colon suffix) still strips prefix."""
    norm = _exec_norm()
    result = norm("@custom:jingdong:GLM-5")
    assert result == "jingdong:glm.5"


def test_colon_before_slash_prefix_matches_backend_paths():
    """The non-@ colon-before-slash strip must match both backend helpers."""
    norm = _exec_norm()
    static_norm = _exec_static_norm()
    model_id = "custom:llm-proxy/opencode_go/deepseek-v4-pro"
    assert norm(model_id) == "deepseek.v4.pro"
    assert static_norm(model_id) == "deepseek.v4.pro"
