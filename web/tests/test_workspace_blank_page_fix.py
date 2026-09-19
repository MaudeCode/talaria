"""Tests for #804 — blank new-chat page loses default workspace binding

Fixes:
- syncWorkspaceDisplays() uses S._profileDefaultWorkspace as fallback when no session
- composerChip.disabled uses hasWorkspace (not hasSession) so chip is enabled on blank page
- boot.js reads default_workspace from /api/settings and sets S._profileDefaultWorkspace
- promptNewFile/promptNewFolder auto-create a session bound to default workspace
"""
import pathlib
import re

REPO = pathlib.Path(__file__).parent.parent


def read(rel):
    return (REPO / rel).read_text(encoding='utf-8')


class TestNewChatOnWorkspaceSwitchOptIn:
    """#5473 opt-in: switching to a DIFFERENT workspace starts a new chat instead
    of mutating the current session in place. Default OFF preserves shipped behavior."""

    def test_setting_registered_default_off(self):
        import api.config as c
        assert c._SETTINGS_DEFAULTS.get('new_chat_on_workspace_switch') is False, (
            "new_chat_on_workspace_switch must default to False (shipped in-place behavior)"
        )
        assert 'new_chat_on_workspace_switch' in c._SETTINGS_BOOL_KEYS, (
            "new_chat_on_workspace_switch must be a recognized boolean setting key"
        )
