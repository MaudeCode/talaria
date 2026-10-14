"""``plugins.settings`` / ``plugins.settings_save`` edit a plugin manifest's ``config_schema`` (TAL-806).

The plugin is synthetic and lives in a disposable HERMES_HOME; nothing touches ``~/.hermes``.
"""

from __future__ import annotations

import pathlib

from conftest import SidecarProcess, assert_matches, requires_agent

MANIFEST = """\
name: fake-settings
version: 0.0.1
config_schema:
  endpoint:
    type: str
    label: Endpoint
    default: https://example.invalid
  limit:
    type: int
    default: 5
  verbose:
    type: bool
  mode:
    type: str
    choices: [fast, careful]
    default: fast
  api_key:
    type: secret
    label: API key
"""


def _seed(home: pathlib.Path) -> None:
    plugin = home / "plugins" / "fake-settings"
    plugin.mkdir(parents=True)
    (plugin / "plugin.yaml").write_text(MANIFEST)
    (plugin / "__init__.py").write_text("def register(ctx):\n    pass\n")


def _fields(sidecar: SidecarProcess, home: pathlib.Path) -> tuple[str, dict]:
    result = sidecar.result("plugins.settings", {"profile_home": str(home)})
    assert_matches("plugins.settings", result)
    assert result["supported"] is True
    (entry,) = [row for row in result["plugins"] if row["key"].endswith("fake-settings")]
    return entry["key"], {field["key"]: field for field in entry["fields"]}


@requires_agent
def test_plugin_settings_round_trip_and_keep_secrets_out_of_config(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    _seed(hermes_home)
    key, fields = _fields(handshaken, hermes_home)
    assert {name: field["type"] for name, field in fields.items()} == {"endpoint": "string", "limit": "number", "verbose": "boolean", "mode": "enum", "api_key": "secret"}
    assert fields["endpoint"]["value"] == "https://example.invalid"
    assert fields["mode"]["choices"] == ["fast", "careful"]
    assert fields["api_key"] == {**fields["api_key"], "env": "FAKE_SETTINGS_API_KEY", "has_value": False}
    assert "value" not in fields["api_key"]

    values = {"endpoint": "https://api.example.invalid", "limit": 9, "verbose": True, "mode": "careful"}
    saved = handshaken.result("plugins.settings_save", {"profile_home": str(hermes_home), "key": key, "values": values})
    assert_matches("plugins.settings_save", saved)
    assert sorted(saved["written"]) == sorted(values)
    assert {field["key"]: field.get("value") for field in saved["fields"] if field["type"] != "secret"} == values

    # The secret goes where the server sends it: the profile .env, through the Agent's locked writer.
    env, _ = handshaken.call("config.env_write", {"profile_home": str(hermes_home), "updates": {"FAKE_SETTINGS_API_KEY": "sk-synthetic-plugin"}})
    assert "error" not in env, env
    _key, fields = _fields(handshaken, hermes_home)
    assert fields["api_key"]["has_value"] is True and fields["limit"]["value"] == 9

    refused, _ = handshaken.call("plugins.settings_save", {"profile_home": str(hermes_home), "key": key, "values": {"api_key": "sk-synthetic-plugin"}})
    assert refused["error"]["code"] == -32602, refused
    wrong, _ = handshaken.call("plugins.settings_save", {"profile_home": str(hermes_home), "key": key, "values": {"mode": "reckless"}})
    assert wrong["error"]["code"] == -32602, wrong
    config = (hermes_home / "config.yaml").read_text()
    assert "sk-synthetic-plugin" not in config and "api.example.invalid" in config


@requires_agent
def test_managed_install_refuses_plugin_settings(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    _seed(hermes_home)
    key, _fields_ = _fields(handshaken, hermes_home)
    (hermes_home / ".managed").write_text("nixos\n")
    refused, _ = handshaken.call("plugins.settings_save", {"profile_home": str(hermes_home), "key": key, "values": {"limit": 3}})
    assert refused["error"]["data"]["condition"] == "plugin_settings_managed", refused
    assert "limit" not in ((hermes_home / "config.yaml").read_text() if (hermes_home / "config.yaml").exists() else "")


@requires_agent
def test_unknown_plugin_is_not_found(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    missing, _ = handshaken.call("plugins.settings_save", {"profile_home": str(hermes_home), "key": "no-such-plugin", "values": {"x": 1}})
    assert missing["error"]["data"]["condition"] == "plugin_not_found", missing
