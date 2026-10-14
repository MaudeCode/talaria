"""``personalities.list`` (TAL-901): the personalities the pinned Agent offers for a config. The configs are synthetic."""

from __future__ import annotations

import pathlib

from conftest import SidecarProcess, load_schema, requires_agent, validate


@requires_agent
def test_lists_built_ins_then_both_config_blocks_case_folded(tmp_path: pathlib.Path) -> None:
    home = tmp_path / "home" / ".hermes"
    home.mkdir(parents=True)
    sidecar = SidecarProcess(home)
    try:
        def rows(config: dict) -> dict[str, dict]:
            result = sidecar.result("personalities.list", {"config": config})
            assert validate(result, load_schema("personalities.list")) == []
            return {row["name"]: row for row in result["personalities"]}

        listed = rows({"personalities": {"Reviewer": "You review code tersely."}})
        assert len(listed) == 15
        assert listed["reviewer"] == {"name": "reviewer", "description": "You review code tersely.", "prompt": "You review code tersely."}
        assert listed["concise"]["prompt"] == "You are a concise assistant. Keep responses brief and to the point."

        # `agent.personalities` overrides a built-in and the top-level block; a neutral name is never a personality.
        listed = rows({"personalities": {"Reviewer": "top"}, "agent": {"personalities": {
            "reviewer": {"description": "Strict", "system_prompt": "Be strict", "tone": "dry"}, "None": "ignored", "Pirate": "Plain pirate"}}})
        assert listed["reviewer"] == {"name": "reviewer", "description": "Strict", "prompt": "Be strict\nTone: dry"}
        assert listed["pirate"]["prompt"] == "Plain pirate"
        assert "none" not in listed and len(listed) == 15
    finally:
        sidecar.close()
