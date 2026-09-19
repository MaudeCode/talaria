import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_messages_zero_skips_effective_model_resolution():
    src = (ROOT / "api" / "routes.py").read_text(encoding="utf-8")

    assert re.search(
        r"effective_model\s*=\s*\(\s*"
        r"_resolve_effective_session_model_for_display\(s\)\s*"
        r"if resolve_model\s*else None\s*\)",
        src,
    ), "messages=0 metadata requests must not resolve the model catalog"
    assert 'resolve_model_default = "1" if load_messages else "0"' in src


def test_settings_exposes_default_model_provider_for_lazy_boot_catalog():
    src = (ROOT / "api" / "config.py").read_text(encoding="utf-8")

    assert 'settings["default_model_provider"]' in src
    assert 'model_cfg = get_config().get("model", {})' in src
