import pathlib


REPO = pathlib.Path(__file__).parent.parent


def read(path):
    return (REPO / path).read_text(encoding="utf-8")


def test_bootstrap_script_contains_official_installer_and_windows_guard():
    src = read("bootstrap.py")
    assert (
        "https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh"
        in src
    )
    # Native Windows is now experimental-supported (#1952), not hard-blocked:
    # ensure_supported_platform() warns instead of raising, but auto-install
    # (which shells out to /bin/bash) still guards native Windows explicitly.
    assert "Native Windows bootstrap is experimental" in src
    assert "Auto-install is not supported on native Windows" in src
