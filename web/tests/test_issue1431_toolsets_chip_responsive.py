"""Tests for #1431 / PR #1433 — composer-footer toolsets chip is responsive.

The chip must:
  * Be hidden by default (CSS base rule).
  * Be shown only at wide composer-footer widths (>= 1100px container query).
  * Stay hidden on mobile (@media max-width:640px and the .cf-burger stage).
  * Have its visibility controlled by CSS, NOT by JS (single source of truth).
  * Continue to track state through _applyToolsetsChip() so /api/session/toolsets
    keeps working for scripted callers regardless of UI visibility.
"""
import re


def _src(name: str) -> str:
    with open(f"static/{name}", encoding="utf-8") as f:
        return f.read()


class TestToolsetsAPIStillWorks:
    """The /api/session/toolsets endpoint and dropdown must remain wired."""

    def test_session_toolsets_endpoint_exists(self):
        """The api/session/toolsets endpoint must still be registered."""
        # Check api/routes.py for the endpoint
        try:
            with open("api/routes.py", encoding="utf-8") as f:
                src = f.read()
        except FileNotFoundError:
            # If routes.py is named differently, search
            import os
            found = False
            for root, _, files in os.walk("api"):
                for f in files:
                    if f.endswith(".py"):
                        with open(os.path.join(root, f)) as fp:
                            if "session/toolsets" in fp.read():
                                found = True
                                break
                if found:
                    break
            assert found, "api/session/toolsets endpoint must exist somewhere in api/"
            return
        assert "session/toolsets" in src, (
            "/api/session/toolsets endpoint must still be registered "
            "(only the visual chip is hidden, not the underlying state)"
        )
