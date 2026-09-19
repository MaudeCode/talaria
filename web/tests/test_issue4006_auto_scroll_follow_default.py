"""Pin the auto_scroll_follow setting's default + hydration consistency (#4006).

The viewport-follow default is `True` (Codex/Claude-Code-style sticky bottom:
follow new output to the bottom while streaming, but a deliberate scroll-up
unpins and is respected). This pins the default in every place it is read so a
future edit can't silently flip it or, worse, default it ON in config.py while
hydrating it OFF in the browser (the classic default-mismatch bug, where an
existing user with no saved value sees the feature as disabled).
"""
import json
import pathlib
import re
import shutil
import subprocess
import textwrap

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent


def _read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


def test_auto_scroll_follow_default_is_true_in_config():
    src = _read("api/config.py")
    assert re.search(r'["\']auto_scroll_follow["\']\s*:\s*True', src), (
        "auto_scroll_follow must default to True in _SETTINGS_DEFAULTS "
        "(sticky-bottom follow; scroll-up unpins)"
    )


def test_auto_scroll_follow_in_bool_keys():
    src = _read("api/config.py")
    m = re.search(r"_SETTINGS_BOOL_KEYS\s*=\s*\{([^}]+)\}", src, re.DOTALL)
    assert m, "_SETTINGS_BOOL_KEYS not found"
    assert "auto_scroll_follow" in m.group(1), (
        "auto_scroll_follow must be in _SETTINGS_BOOL_KEYS so it round-trips as a bool"
    )
