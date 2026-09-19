"""Tests for #823 — _profileDefaultWorkspace persists after newSession() (#804 follow-up)

Root cause: newSession() consumed S._profileDefaultWorkspace for the one-shot
profile-switch semantic (setting it to null after the first new session). This
caused the blank-page default workspace display to regress after any session
was created and then deleted.

Fix: introduce S._profileSwitchWorkspace as the dedicated one-shot flag for
profile-switch semantics; S._profileDefaultWorkspace is now persistent.
"""
import pathlib
import re

REPO = pathlib.Path(__file__).parent.parent


def read(rel):
    return (REPO / rel).read_text(encoding='utf-8')


class TestProfileActiveDefaultWorkspaceApi:
    """GET /api/profile/active must expose profile-scoped default_workspace (#5169)."""

    def test_profile_active_includes_default_workspace(self, monkeypatch):
        import api.profiles as profiles
        import api.routes as routes

        expected_ws = "/tmp/my-profile-workspace"

        monkeypatch.setattr(profiles, "get_active_profile_name", lambda: "work")
        monkeypatch.setattr(profiles, "get_active_hermes_home", lambda: "/home/.hermes/profiles/work")
        monkeypatch.setattr(profiles, "_is_root_profile", lambda _n: False)
        monkeypatch.setattr(routes, "get_profile_default_workspace", lambda: expected_ws)
        monkeypatch.setattr(
            routes,
            "j",
            lambda _handler, payload, status=200: {"status": status, "payload": payload},
        )

        from types import SimpleNamespace
        from urllib.parse import urlparse

        response = routes.handle_get(SimpleNamespace(), urlparse("/api/profile/active"))

        assert response["payload"]["default_workspace"] == expected_ws
        assert response["payload"]["name"] == "work"
