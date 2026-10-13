"""Exercise the frozen launch home in a fresh process, without importing Agent code."""

import os
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.parametrize("platform", ["darwin", "win32"])
@pytest.mark.parametrize("suffix", [None, "", "-desktop", " beta.1 ", "/nested"])
@pytest.mark.parametrize("explicit", [False, True])
@pytest.mark.parametrize("local_appdata", [False, True])
def test_process_home(tmp_path, platform, suffix, explicit, local_appdata):
    env = {"PATH": os.environ.get("PATH", ""), "HOME": str(tmp_path),
           "USERPROFILE": str(tmp_path), "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
    if os.environ.get("LD_LIBRARY_PATH"):
        env["LD_LIBRARY_PATH"] = os.environ["LD_LIBRARY_PATH"]
    if local_appdata:
        env["LOCALAPPDATA"] = str(tmp_path / "local-data")
    if suffix is not None:
        env["HERMES_DATA_DIR_SUFFIX"] = suffix
    if explicit:
        env["HERMES_HOME"] = str(tmp_path / "custom")
    code = f"""
import sys
from pathlib import Path
sys.platform = {platform!r}
from talaria_sidecar.home import _PROCESS_HOME, _is_named_profile
print(_PROCESS_HOME)
assert not _is_named_profile(_PROCESS_HOME)
assert _is_named_profile(_PROCESS_HOME / 'profiles' / 'work')
"""
    result = subprocess.run([sys.executable, "-c", code], env=env, text=True, capture_output=True, check=True)
    if explicit:
        expected = tmp_path / "custom"
    elif platform == "win32":
        base = tmp_path / "local-data" if local_appdata else tmp_path / "AppData" / "Local"
        expected = base / ("hermes" + (suffix or ""))
    else:
        expected = tmp_path / (".hermes" + (suffix or ""))
    assert Path(result.stdout.rstrip("\n")) == expected
