"""Regression tests for PR #1721 salvage — RTL chat layout (Settings-only, no composer button).

Salvaged from @malulian's PR #1721 per @aronprins design review (May 13 2026):
"Can you implement this as a global setting filed in Settings → Preferences?"
Implementation drops the composer button and keeps only the Settings toggle + CSS.
"""
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
INDEX = REPO_ROOT / "static" / "index.html"
STYLE = REPO_ROOT / "static" / "style.css"
PANELS = REPO_ROOT / "static" / "panels.js"
I18N = REPO_ROOT / "static" / "i18n.js"
CONFIG = REPO_ROOT / "api" / "config.py"


def test_rtl_in_config_defaults_and_writable_keys():
    src = CONFIG.read_text(encoding="utf-8")
    assert '"rtl": False' in src, "rtl must be in DEFAULTS as opt-in"
    # Must be in the writable preference key set
    assert '"rtl",' in src
