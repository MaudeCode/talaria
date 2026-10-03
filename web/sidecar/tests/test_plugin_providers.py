"""Model-provider plugins installed in a profile's home (TAL-288), driven against the pinned Agent.

Every plugin here is synthetic: an external-process profile whose CLI is a disposable stub that is never spawned, one
whose CLI is missing, and one the profile disabled. Nothing touches ``~/.hermes`` or a real account.
"""

from __future__ import annotations

import json
import pathlib
import textwrap

from conftest import SidecarProcess, load_schema, requires_agent, validate

PROFILE = textwrap.dedent(
    """
    from providers import register_provider
    from providers.base import ProviderProfile

    {var} = ProviderProfile(
        name={name!r}, display_name={display!r}, auth_type="external_process", base_url="acp://{name}",
        process_command={command!r}, fallback_models={models!r},
    )
    register_provider({var})
    """
)


def _plugin(root: pathlib.Path, directory: str, manifest_name: str, *, name: str, display: str, command: str, models: tuple) -> None:
    path = root / directory
    path.mkdir(parents=True)
    (path / "plugin.yaml").write_text(f"name: {manifest_name}\nkind: model-provider\nversion: 0.0.1\n")
    (path / "__init__.py").write_text(PROFILE.format(var=name.replace("-", "_"), name=name, display=display, command=command, models=models))


def _seed(home: pathlib.Path, cli: pathlib.Path) -> None:
    plugins = home / "plugins"
    # `hermes plugins install` layout: flat, one directory per plugin.
    _plugin(plugins, "fake-sub", "fake-sub-provider", name="fake-sub", display="Fake Subscription", command=str(cli), models=("fake-opus", "claude-sonnet-4-6"))
    # Hand-installed layout: under plugins/model-providers/.
    _plugin(plugins / "model-providers", "fake-missing", "fake-missing-provider", name="fake-missing", display="Fake Missing CLI",
            command="talaria-test-cli-that-does-not-exist", models=("fake-missing-1",))
    _plugin(plugins, "fake-off", "fake-off-provider", name="fake-off", display="Fake Disabled", command=str(cli), models=("fake-off-1",))
    (home / "config.yaml").write_text("plugins:\n  disabled:\n    - fake-off-provider\n")


@requires_agent
def test_installed_plugin_providers_report_identity_setup_and_models(tmp_path: pathlib.Path) -> None:
    home = tmp_path / "home" / ".hermes"
    home.mkdir(parents=True)
    cli = tmp_path / "bin" / "fake-sub-cli"
    cli.parent.mkdir()
    cli.write_text("#!/bin/sh\nexit 97\n")  # Listing must never run it.
    cli.chmod(0o755)
    _seed(home, cli)
    other = home / "profiles" / "other"
    other.mkdir(parents=True)
    # A named profile's own plugin, which the launch-profile discovery never sees, and one that claims the default
    # profile's provider id.
    _plugin(other / "plugins", "fake-other", "fake-other-provider", name="fake-other", display="Fake Other", command=str(cli), models=("other-1",))
    _plugin(other / "plugins", "fake-sub-copy", "fake-sub-copy-provider", name="fake-sub", display="Hijacked", command=str(cli), models=("hijacked",))
    sidecar = SidecarProcess(home)
    try:
        result = sidecar.result("plugins.providers", {"profile_home": str(home)})
        assert validate(result, load_schema("plugins.providers")) == []
        rows = {row["name"]: row for row in result["providers"]}
        # Only this profile's enabled plugins: bundled providers are built-ins, the disabled plugin is excluded.
        assert sorted(rows) == ["fake-missing", "fake-sub"], rows
        assert rows["fake-sub"]["display_name"] == "Fake Subscription"
        assert rows["fake-sub"]["auth_type"] == "external_process"
        assert rows["fake-sub"]["setup"] == "ready"
        assert rows["fake-missing"]["setup"] == "missing_cli"
        # Sanitized: no command paths or home paths reach the server.
        assert str(tmp_path) not in json.dumps(result)

        models = sidecar.result("providers.model_ids", {"profile_home": str(home), "provider": "fake-sub"})
        assert models["model_ids"] == ["fake-opus", "claude-sonnet-4-6"]

        # Another profile never sees this profile's plugins, although the Agent's provider registry is process-wide. Its
        # own plugin loads on demand; one claiming a taken provider id stays unloaded and cannot displace it.
        named = {row["name"]: row["setup"] for row in sidecar.result("plugins.providers", {"profile_home": str(other)})["providers"]}
        assert named == {"fake-other": "ready", "fake-sub-copy-provider": "not_loaded"}, named
        assert sidecar.result("providers.model_ids", {"profile_home": str(other), "provider": "fake-sub"})["model_ids"] == []
        assert sidecar.result("providers.model_ids", {"profile_home": str(other), "provider": "fake-other"})["model_ids"] == ["other-1"]
        assert sidecar.result("providers.model_ids", {"profile_home": str(home), "provider": "fake-other"})["model_ids"] == []
        assert sidecar.result("plugins.providers", {"profile_home": str(home)})["providers"] == result["providers"]
        assert sidecar.result("providers.model_ids", {"profile_home": str(home), "provider": "fake-sub"})["model_ids"] == ["fake-opus", "claude-sonnet-4-6"]
    finally:
        sidecar.close()
