"""Regression tests for #1539 — removing a provider in Settings must invalidate
every dropdown surface that caches /api/models, so the removed provider
disappears immediately without a server restart or page reload.

The bug
-------
Pre-fix, ``_removeProviderKey()`` in ``static/panels.js`` only called
``loadProvidersPanel()`` after deletion. That refreshed the providers card
list but left these JS-side caches stale:

  * ``_slashModelCache`` / ``_slashModelCachePromise`` (``static/commands.js``) —
    cache for the ``/model`` slash-command suggestions.
  * ``_dynamicModelLabels`` / ``window._configuredModelBadges`` (``static/ui.js``) —
    populated by ``populateModelDropdown()`` on boot and on profile switch.

Layered server-side cache via ``api/config.invalidate_models_cache`` was
already flushed (``set_provider_key`` calls it on both add + remove), so the
next ``/api/models`` request would return the correct list — but no consumer
was triggering one.

The fix
-------
``static/commands.js`` exposes an ``_invalidateSlashModelCache()`` helper on
``window``. ``static/panels.js`` calls it from a shared
``_refreshModelDropdownsAfterProviderChange()`` helper after both the save
and the remove paths, plus invokes ``populateModelDropdown()`` to rebuild
the composer / Settings dropdowns and ``_configuredModelBadges`` map.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest


REPO = Path(__file__).resolve().parent.parent


def _read_static(name: str) -> str:
    return (REPO / "static" / name).read_text(encoding="utf-8")


def _extract_function_body(src: str, signature: str) -> str:
    """Return the source of a top-level ``async function NAME(...)`` /
    ``function NAME(...)`` declaration via brace-balance — robust to nested
    blocks (try/catch/await) and not dependent on indentation.
    """
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


class TestServerSideInvariantPreserved:
    """Server-side ``invalidate_models_cache()`` is the load-bearing invariant
    that lets the next /api/models request return correct data; #1539 was a
    pure frontend bug, but pin the server-side wiring so a refactor of
    ``set_provider_key`` cannot silently regress it."""

    def test_set_provider_key_invalidates_cache(self):
        src = (REPO / "api" / "providers.py").read_text(encoding="utf-8")
        # set_provider_key is the canonical write path — both add and remove
        # flow through it (remove_provider_key calls set_provider_key(pid, None)).
        m = re.search(
            r"def set_provider_key\([^)]*\).*?(?=\ndef |\Z)",
            src,
            re.DOTALL,
        )
        assert m, "set_provider_key not found in api/providers.py"
        body = m.group(0)
        assert "invalidate_models_cache()" in body, (
            "set_provider_key must call invalidate_models_cache() so the "
            "server-side TTL cache is flushed on every add/remove. Without "
            "this, even a perfectly-cached frontend would receive stale data."
        )
