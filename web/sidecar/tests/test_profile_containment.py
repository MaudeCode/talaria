"""TAL-579: ``profiles/*`` entries that resolve outside the profiles root are never listed or entered as profiles."""

from __future__ import annotations

import pathlib

from conftest import SidecarProcess, requires_agent
from talaria_sidecar import SIDECAR_RPC_VERSION


@requires_agent
def test_profile_scans_skip_entries_that_escape_the_profiles_root(hermes_home: pathlib.Path, tmp_path: pathlib.Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "config.yaml").write_text("model: outside-model\n")
    profiles = hermes_home / "profiles"
    (profiles / "work").mkdir(parents=True)
    (profiles / "rogue").symlink_to(outside)
    (profiles / "inside").symlink_to(profiles / "work")
    sidecar = SidecarProcess(hermes_home)
    try:
        assert sidecar.result("runtime.handshake", {"rpc_version": SIDECAR_RPC_VERSION})["compatible"]
        rows = sidecar.result("profiles.list", {"base_home": str(hermes_home)})["profiles"]
        assert [row["name"] for row in rows] == ["default", "inside", "work"]
        recovered, _ = sidecar.call("process.recover", {"base_home": str(hermes_home)})
        assert recovered.get("result") == {"homes": 3}, recovered
    finally:
        sidecar.close()
