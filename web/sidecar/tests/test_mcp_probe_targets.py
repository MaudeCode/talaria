"""The server's MCP health probe sends the url/headers the Agent would connect with (TAL-1565): ``${VAR}`` rendered
from the requested profile's own .env, never another profile's, an unset reference left as its placeholder, and a
literal header untouched."""

from __future__ import annotations

import pathlib

from conftest import SidecarProcess, requires_agent

SERVERS = {
    "remote": {"url": "https://mcp.invalid/${TALARIA_PROBE_PATH}", "headers": {"Authorization": "Bearer ${TALARIA_PROBE_KEY}", "X-Literal": "literal-value", "X-Unset": "${TALARIA_PROBE_UNSET}", "X-Number": 7}},
    "local": {"command": "never-spawn", "env": {"KEY": "${TALARIA_PROBE_KEY}"}},
}


@requires_agent
def test_probe_targets_render_each_profiles_own_env_references(tmp_path) -> None:
    launch = tmp_path / "home" / ".hermes"
    named = launch / "profiles" / "b"
    named.mkdir(parents=True)
    (launch / ".env").write_text("TALARIA_PROBE_KEY=synthetic-launch-key\nTALARIA_PROBE_PATH=launch\n", encoding="utf-8")
    (named / ".env").write_text("TALARIA_PROBE_KEY=synthetic-named-key\nTALARIA_PROBE_PATH=named\n", encoding="utf-8")
    sidecar = SidecarProcess(launch)
    try:
        def targets(home: pathlib.Path) -> list[dict]:
            return sidecar.result("mcp.probe_targets", {"profile_home": str(home), "servers": SERVERS})["targets"]

        assert targets(named) == [{"name": "remote", "url": "https://mcp.invalid/named", "headers": {"Authorization": "Bearer synthetic-named-key", "X-Literal": "literal-value", "X-Unset": "${TALARIA_PROBE_UNSET}"}}]
        assert targets(launch) == [{"name": "remote", "url": "https://mcp.invalid/launch", "headers": {"Authorization": "Bearer synthetic-launch-key", "X-Literal": "literal-value", "X-Unset": "${TALARIA_PROBE_UNSET}"}}]
        # A changed credential is read on the next call, not from an earlier render.
        (named / ".env").write_text("TALARIA_PROBE_KEY=synthetic-rotated-key\nTALARIA_PROBE_PATH=named\n", encoding="utf-8")
        assert targets(named)[0]["headers"]["Authorization"] == "Bearer synthetic-rotated-key"
    finally:
        sidecar.close()
