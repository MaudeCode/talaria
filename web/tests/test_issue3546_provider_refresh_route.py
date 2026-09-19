"""Regression tests for #3546 — POST /api/models/refresh must exist and
invalidate the per-provider model cache so the "Refresh Models" button
on Settings > Providers works instead of returning 404.

The bug
-------
``static/panels.js`` sends ``POST /api/models/refresh`` from
``_refreshProviderModels``, but no route handled that path in
``api/routes.py``. Every click showed "Error: Not found" because the
server returned 404, which ``workspace.js``'s ``api()`` helper surfaced
as an error toast.

The fix
-------
``api/routes.py`` adds a ``POST /api/models/refresh`` branch that calls
``invalidate_provider_models_cache(provider_id)`` and returns
``{"ok": true, "provider": provider_id}``. The frontend success path
now also calls ``_refreshModelDropdownsAfterProviderChange()`` so the
model picker rebuilds immediately.
"""

from __future__ import annotations

from pathlib import Path


REPO = Path(__file__).resolve().parent.parent


def _read_static(name: str) -> str:
    return (REPO / "static" / name).read_text(encoding="utf-8")


def _extract_function_body(src: str, signature: str) -> str:
    """Return the source of a top-level function declaration via brace-balance."""
    idx = src.find(signature)
    if idx == -1:
        raise AssertionError(f"signature {signature!r} not found in source")
    open_idx = src.find("{", idx)
    if open_idx == -1:
        raise AssertionError(f"could not find opening brace after {signature!r}")
    depth = 0
    for i in range(open_idx, len(src)):
        c = src[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return src[idx : i + 1]
    raise AssertionError(f"unbalanced braces in {signature!r}")


class TestRefreshRouteExists:
    """The POST /api/models/refresh route must exist in routes.py and follow
    the same input validation pattern as /api/providers/delete."""

    def test_route_branch_present(self):
        src = (REPO / "api" / "routes.py").read_text(encoding="utf-8")
        assert '"/api/models/refresh"' in src, (
            "POST /api/models/refresh route missing from api/routes.py. "
            "Without it, the Refresh Models button 404s (#3546)."
        )

    def test_route_validates_provider_param(self):
        src = (REPO / "api" / "routes.py").read_text(encoding="utf-8")
        idx = src.find('"/api/models/refresh"')
        block = src[idx : idx + 500]
        assert "provider" in block and "bad(handler" in block, (
            "/api/models/refresh must validate that 'provider' is present "
            "and return 400 via bad() when missing."
        )

    def test_route_calls_invalidate_provider_models_cache(self):
        src = (REPO / "api" / "routes.py").read_text(encoding="utf-8")
        idx = src.find('"/api/models/refresh"')
        block = src[idx : idx + 500]
        assert "invalidate_provider_models_cache" in block, (
            "/api/models/refresh must call invalidate_provider_models_cache "
            "to bust the per-provider TTL cache."
        )

    def test_route_returns_ok_with_provider(self):
        src = (REPO / "api" / "routes.py").read_text(encoding="utf-8")
        idx = src.find('"/api/models/refresh"')
        block = src[idx : idx + 500]
        assert '"ok"' in block and '"provider"' in block, (
            "/api/models/refresh must return {ok: true, provider: provider_id} "
            "so the frontend can confirm the operation succeeded."
        )
