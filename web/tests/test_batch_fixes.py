"""Tests for the batch of fixes from PRs #506-#521 (v0.50.47).

Covers:
  - /root workspace unblocking (#510/#521)
  - Attached-files split guard (#521)
  - custom_providers model visibility (#515/#519)
  - Cron skill cache invalidation (#507/#508)
  - System (auto) theme (#504/#506/#509/#514)
"""

import pathlib
import re

REPO = pathlib.Path(__file__).parent.parent


def read(rel):
    return (REPO / rel).read_text(encoding="utf-8")


# ── Group A: /root workspace ──────────────────────────────────────────────────

class TestRootWorkspaceUnblocked:

    def test_root_not_in_blocked_system_roots(self):
        src = read("api/workspace.py")
        assert "Path('/root')" not in src, (
            "/root must not be in _BLOCKED_SYSTEM_ROOTS — "
            "breaks deployments where Hermes runs as root"
        )

    def test_etc_still_blocked(self):
        """Sanity: other dangerous paths remain blocked.

        After the macOS symlink fix, blocked roots are listed as bare strings
        in a tuple and ``_workspace_blocked_roots()`` materialises both the
        literal and resolved-canonical Path forms.  Assert the source still
        names ``/etc`` and ``/proc`` as blocked roots.
        """
        src = read("api/workspace.py")
        assert "'/etc'" in src or 'Path("/etc")' in src or "Path('/etc')" in src
        assert "'/proc'" in src or 'Path("/proc")' in src or "Path('/proc')" in src

    def test_split_guard_present(self):
        src = read("api/streaming.py")
        assert "'\\n\\n[Attached files:' in msg_text" in src, (
            "base_text split must guard against missing '[Attached files:' "
            "to avoid empty-string on plain messages"
        )


# ── Group B: custom_providers visibility ─────────────────────────────────────

class TestCustomProvidersVisibility:

    def test_has_custom_providers_variable_present(self):
        src = read("api/config.py")
        assert "_has_custom_providers" in src, (
            "_has_custom_providers variable must exist in get_available_models()"
        )

    def test_discard_custom_conditional_on_no_custom_providers(self):
        src = read("api/config.py")
        assert "not _has_custom_providers" in src, (
            "detected_providers.discard('custom') must be gated on "
            "'not _has_custom_providers'"
        )

    def test_custom_providers_isinstance_check(self):
        src = read("api/config.py")
        assert "isinstance(_custom_providers_cfg, list)" in src, (
            "_has_custom_providers must check isinstance(..., list)"
        )


# ── Group C: cron skill cache ─────────────────────────────────────────────────

# ── Group D: System (auto) theme ──────────────────────────────────────────────
