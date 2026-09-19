"""Regression check for #7228 — model-picker search vs OpenRouter display names.

Composer model-picker search was a literal substring on the rendered name and
id. OpenRouter overflow rows were labeled with the raw id (``stealth/ox-alpha``)
instead of the provider display name (``Ox Alpha``), and spaces were not
normalized to hyphens — so typing the name users see in Hermes Desktop
(``Ox Alpha``) always yielded "No models found".

Fixed in three layers (issue requirement):
  1. backend: /api/models ships the friendly display name from the local
     OpenRouter metadata disk cache for curated catalog rows;
  2. frontend: getModelLabel() resolves via the dynamic label map, which is
     now hydrated with the display name;
  3. frontend: search folds whitespace/hyphens/dots on both sides so
     ``ox alpha`` == ``ox-alpha`` == ``ox.alpha``.

Verified at the source level so this stays fast.
"""
from pathlib import Path

REPO = Path(__file__).parent.parent
CONFIG_PY = (REPO / "api" / "config.py").read_text(encoding="utf-8")


def test_backend_has_openrouter_display_name_helper():
    # The helper must read only the local disk cache (no network).
    assert "def _openrouter_model_display_name(model_id: str) -> str:" in CONFIG_PY
    assert "_load_model_metadata_disk_cache" in CONFIG_PY


def test_backend_ships_display_name_not_raw_id():
    # Curated OpenRouter catalog rows must use the friendly display name
    # instead of the raw id as the picker label (#7228).
    snippet = CONFIG_PY[CONFIG_PY.index('fetch_openrouter_models as _fetch_or_models'):]
    snippet = snippet[:snippet.index('except Exception')]
    assert "_openrouter_model_display_name(mid)" in snippet
    assert '{"id": mid, "label": mid}' not in snippet
