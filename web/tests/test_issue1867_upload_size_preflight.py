from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
UI_JS = ROOT / "static" / "ui.js"
I18N_JS = ROOT / "static" / "i18n.js"
CONFIG_PY = ROOT / "api" / "config.py"
UPLOAD_PY = ROOT / "api" / "upload.py"


def _function_body(src: str, name: str) -> str:
    marker = f"function {name}"
    start = src.index(marker)
    signature_end = src.index(")", start)
    brace = src.index("{", signature_end)
    depth = 0
    for idx in range(brace, len(src)):
        if src[idx] == "{":
            depth += 1
        elif src[idx] == "}":
            depth -= 1
            if depth == 0:
                return src[brace : idx + 1]
    raise AssertionError(f"{name} function body not found")


def test_archive_extraction_limit_tracks_upload_limit():
    """Archive extraction guard should scale with the configured upload limit."""
    upload = UPLOAD_PY.read_text(encoding="utf-8")

    assert "_MAX_EXTRACTED_BYTES = 10 * MAX_UPLOAD_BYTES" in upload
