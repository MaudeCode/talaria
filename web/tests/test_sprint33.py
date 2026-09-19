"""
Sprint 33 Tests: Shared app dialogs replace native confirm/prompt usage.

These tests verify the static assets expose the reusable confirm/input modal
and that browser-native confirm/prompt calls are no longer used in the Web UI.
"""

import pathlib
import re


REPO = pathlib.Path(__file__).parent.parent


def read(path):
    return (REPO / path).read_text(encoding="utf-8")


AUTH_SAFETY_LOCALE_KEYS = (
    "current_password_label",
    "current_password_placeholder",
    "current_password_required",
    "current_password_incorrect",
    "disable_auth_typed_confirm",
    "auth_status_password",
    "auth_status_passkey_only",
    "auth_status_unauthenticated",
    "auth_warning_badge",
    "auth_disabled_warning_message",
    "auth_acknowledged_label",
    "auth_ack_save_failed",
)


def _i18n_locale_blocks(src):
    heads = list(re.finditer(r"^  (?:(?:'([^']+)')|([A-Za-z][A-Za-z0-9_]*)):\s*\{", src, re.M))
    blocks = {}
    for i, head in enumerate(heads):
        locale = head.group(1) or head.group(2)
        end = heads[i + 1].start() if i + 1 < len(heads) else src.find("\n};", head.end())
        assert end != -1, f"could not find end of locale block {locale}"
        blocks[locale] = src[head.end():end]
    return blocks


def test_no_native_confirm_calls_remain_in_static_js():
    for path in (REPO / "static").glob("*.js"):
        src = path.read_text(encoding="utf-8")
        assert not re.search(r"\bconfirm\s*\(", src), f"native confirm() remains in {path.name}"


def test_no_native_prompt_calls_remain_in_static_js():
    for path in (REPO / "static").glob("*.js"):
        src = path.read_text(encoding="utf-8")
        assert not re.search(r"\bprompt\s*\(", src), f"native prompt() remains in {path.name}"
