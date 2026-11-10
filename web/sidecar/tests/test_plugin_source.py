"""TAL-2132: ``plugins.list`` says which category each plugin belongs to and whether the profile installed it or the Agent ships it."""

from __future__ import annotations

import pathlib

from conftest import SidecarProcess, load_schema, requires_agent, validate


@requires_agent
def test_rows_carry_category_and_source(tmp_path: pathlib.Path) -> None:
    home = tmp_path / "home" / ".hermes"
    path = home / "plugins" / "team-notes"
    path.mkdir(parents=True)
    (path / "plugin.yaml").write_text("name: team-notes\nversion: 0.0.1\ndescription: Synthetic probe\n")
    (path / "__init__.py").write_text("def register(ctx):\n    pass\n")
    sidecar = SidecarProcess(home)
    try:
        listed = sidecar.result("plugins.list", {"profile_home": str(home), "selected_providers": {}})
    finally:
        sidecar.close()
    assert validate(listed, load_schema("plugins.list")) == []
    installed = [row for row in listed["plugins"] if row["description"] == "Synthetic probe"]
    assert [(row["name"], row.get("category"), row.get("source")) for row in installed] == [("team-notes", "", "installed")]
    bundled = [row for row in listed["plugins"] if row["description"] != "Synthetic probe"]
    assert bundled, "the pinned Agent ships plugins"
    assert {row.get("source") for row in bundled} == {"bundled"}
    for row in bundled:
        assert row.get("category") == (row["key"].split("/", 1)[0] if "/" in row["key"] else "")
    assert any(row["category"] for row in bundled)
