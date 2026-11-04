"""TAL-1829: ``plugins.list`` says why an Agent update turned a plugin off, from a test-owned ``plugins.disabled_by_update`` record."""

from __future__ import annotations

import pathlib

from conftest import SidecarProcess, load_schema, requires_agent, validate

CONFIG = """
plugins:
  disabled: [evicted, by-hand, manifest-spelling]
  disabled_by_update:
    evicted:
      enabled: true
      reason: "its dependencies could not be\\n  prepared, twice: synthetic timeout"
    manifest-spelling:
      enabled: false
      reason: "recorded under the manifest name"
    rejoined:
      enabled: true
      reason: "a record the Agent has not pruned yet"
"""


@requires_agent
def test_only_a_plugin_the_update_still_holds_off_carries_the_reason(tmp_path: pathlib.Path) -> None:
    home = tmp_path / "home" / ".hermes"
    for directory, plugin in (("evicted", "evicted"), ("by-hand", "by-hand"), ("rejoined", "rejoined"), ("some-dir", "manifest-spelling")):
        path = home / "plugins" / directory
        path.mkdir(parents=True)
        (path / "plugin.yaml").write_text(f"name: {plugin}\nversion: 0.0.1\ndescription: Synthetic probe\n")
        (path / "__init__.py").write_text("def register(ctx):\n    pass\n")
    (home / "config.yaml").write_text(CONFIG)
    sidecar = SidecarProcess(home)
    try:
        listed = sidecar.result("plugins.list", {"profile_home": str(home), "selected_providers": {}})
    finally:
        sidecar.close()
    assert validate(listed, load_schema("plugins.list")) == []
    rows = {row["name"]: row for row in listed["plugins"] if row["description"] == "Synthetic probe"}
    assert {name: row["enabled"] for name, row in rows.items()} == {"evicted": False, "by-hand": False, "rejoined": False, "manifest-spelling": False}
    assert rows["evicted"].get("disabled_reason") == {"kind": "update", "reason": "its dependencies could not be prepared, twice: synthetic timeout"}
    assert rows["manifest-spelling"].get("disabled_reason") == {"kind": "update", "reason": "recorded under the manifest name"}
    assert "disabled_reason" not in rows["by-hand"]
    assert "disabled_reason" not in rows["rejoined"]
