"""Exercise the frozen launch home in a fresh process, without importing Agent code."""

import os
import sys

import pytest


@pytest.mark.parametrize("platform, env, expected", [
    pytest.param("win32", {"HERMES_HOME": "custom", "HERMES_DATA_DIR_SUFFIX": "-desktop", "LOCALAPPDATA": "local-data"}, "custom", id="explicit"),
    pytest.param("darwin", {}, ".hermes", id="darwin"),
    pytest.param("darwin", {"HERMES_DATA_DIR_SUFFIX": "-desktop"}, ".hermes-desktop", id="darwin-suffix"),
    pytest.param("win32", {"LOCALAPPDATA": "local-data"}, "local-data/hermes", id="win32-local-appdata"),
    pytest.param("win32", {}, "AppData/Local/hermes", id="win32-default"),
    # The Agent appends its suffix literally, whitespace and all.
    pytest.param("win32", {"LOCALAPPDATA": "local-data", "HERMES_DATA_DIR_SUFFIX": " beta.1 "}, "local-data/hermes beta.1 ", id="win32-suffix"),
])
def test_process_home(tmp_path, monkeypatch, platform, env, expected):
    from talaria_sidecar import home
    paths = {"HERMES_HOME", "LOCALAPPDATA"}
    environ = {"PATH": os.environ.get("PATH", ""), "HOME": str(tmp_path), "USERPROFILE": str(tmp_path),
               **{name: str(tmp_path / value) if name in paths else value for name, value in env.items()}}
    monkeypatch.setattr(os, 'environ', environ)
    monkeypatch.setattr(sys, 'platform', platform)
    actual = home._process_home()
    assert actual == tmp_path / expected
    monkeypatch.setattr(home, '_PROCESS_HOME', actual)
    assert not home._is_named_profile(actual)
    assert home._is_named_profile(actual / 'profiles' / 'work')


def test_standalone_runtime_reads_update_marker_from_resolved_home(tmp_path):
    import time

    from conftest import SidecarProcess
    from talaria_sidecar.runtime import _MARKER_SAFE_OPEN_AVAILABLE

    hermes_home = tmp_path / ".hermes-desktop"
    hermes_home.mkdir()
    (hermes_home / ".hermes-update-in-progress").write_text(f"{os.getpid()}\n{time.time()}\n")
    proc = SidecarProcess(
        hermes_home,
        env={"HERMES_HOME": "", "HERMES_DATA_DIR_SUFFIX": "-desktop"},
        python=sys.executable,
        agent_dir=tmp_path / "missing-agent",
    )
    try:
        expected = "active" if _MARKER_SAFE_OPEN_AVAILABLE else "unknown"
        assert proc.result("runtime.status")["update_state"] == expected
    finally:
        proc.close()
