"""#3571 saved-prompts library — structural + mobile-visibility guards.

The saved-prompts composer affordance is a desktop-only feature: per Nathan
(2026-06-09) it must be hidden on mobile (too much for the narrow composer).
These tests pin the mobile-hide rule and the core wiring so a future refactor
can't silently regress either.
"""
import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def read(rel: str) -> str:
    return (REPO / rel).read_text(encoding="utf-8")


def test_saved_prompts_backend_caps_present():
    """The POST /api/prompts route must cap text length and total count so
    saved_prompts.json can't grow unbounded."""
    routes = read("api/routes.py")
    assert "text too long" in routes, "POST /api/prompts must cap text length"
    assert re.search(r"len\(prompts\)\s*>=\s*\d+", routes), (
        "POST /api/prompts must cap the total number of saved prompts"
    )
