"""Model-provider plugins installed in a profile's home (TAL-288), driven against the pinned Agent.

Every plugin here is synthetic: an external-process profile whose CLI is a disposable stub that is never spawned, one
whose CLI is missing, and one the profile disabled. Nothing touches ``~/.hermes`` or a real account.
"""

from __future__ import annotations

import json
import pathlib
import textwrap

import pytest

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


def _seed(home: pathlib.Path, cli: pathlib.Path, isolation: str) -> None:
    plugins = home / "plugins"
    # `hermes plugins install` layout: flat, one directory per plugin.
    _plugin(plugins, "fake-sub", "fake-sub-provider", name="fake-sub", display="Fake Subscription", command=str(cli), models=("fake-opus", "claude-sonnet-4-6"))
    # Hand-installed layout: under plugins/model-providers/.
    _plugin(plugins / "model-providers", "fake-missing", "fake-missing-provider", name="fake-missing", display="Fake Missing CLI",
            command="talaria-test-cli-that-does-not-exist", models=("fake-missing-1",))
    _plugin(plugins, "fake-off", "fake-off-provider", name="fake-off", display="Fake Disabled", command=str(cli), models=("fake-off-1",))
    _plugin(plugins, "fake-broken", "fake-broken-provider", name="fake-broken", display="Fake Broken", command=str(cli), models=())
    (plugins / "fake-broken" / "__init__.py").write_text("raise RuntimeError('synthetic broken plugin')\n")
    (home / "config.yaml").write_text(f"plugins:\n  isolation: {isolation}\n  disabled:\n    - fake-off-provider\n")


@requires_agent
@pytest.mark.parametrize("isolation", ["in_process", "host"])
def test_installed_plugin_providers_report_identity_setup_and_models(tmp_path: pathlib.Path, isolation: str) -> None:
    home = tmp_path / "home" / ".hermes"
    home.mkdir(parents=True)
    cli = tmp_path / "bin" / "fake-sub-cli"
    cli.parent.mkdir()
    cli.write_text("#!/bin/sh\nexit 97\n")  # Listing must never run it.
    cli.chmod(0o755)
    _seed(home, cli, isolation)
    other = home / "profiles" / "other"
    other.mkdir(parents=True)
    (other / "config.yaml").write_text(f"plugins:\n  isolation: {isolation}\n")
    # A named profile's own plugin, which the launch-profile discovery never sees, and one that claims the default
    # profile's provider id.
    _plugin(other / "plugins", "fake-other", "fake-other-provider", name="fake-other", display="Fake Other", command=str(cli), models=("other-1",))
    _plugin(other / "plugins", "fake-sub", "fake-sub-copy-provider", name="fake-sub", display="Hijacked", command=str(cli), models=("hijacked",))
    sidecar = SidecarProcess(home)
    try:
        result = sidecar.result("plugins.providers", {"profile_home": str(home)})
        assert validate(result, load_schema("plugins.providers")) == []
        rows = {row["name"]: row for row in result["providers"]}
        # Only this profile's enabled plugins: bundled providers are built-ins, the disabled plugin is excluded.
        assert sorted(rows) == ["fake-broken-provider", "fake-missing", "fake-sub"], rows
        assert rows["fake-broken-provider"]["setup"] == "not_loaded"
        assert rows["fake-sub"]["display_name"] == "Fake Subscription"
        assert rows["fake-sub"]["auth_type"] == "external_process"
        assert rows["fake-sub"]["setup"] == "ready"
        assert rows["fake-missing"]["setup"] == "missing_cli"
        # Sanitized: no command paths or home paths reach the server.
        assert str(tmp_path) not in json.dumps(result)

        models = sidecar.result("providers.model_ids", {"profile_home": str(home), "provider": "fake-sub"})
        assert models["model_ids"] == ["fake-opus", "claude-sonnet-4-6"]

        # Another profile never sees this profile's plugins, and its own plugin loads on demand.
        named = {row["name"]: row["setup"] for row in sidecar.result("plugins.providers", {"profile_home": str(other)})["providers"]}
        named_models = sidecar.result("providers.model_ids", {"profile_home": str(other), "provider": "fake-sub"})["model_ids"]
        # A row reads ready exactly when the Agent can run that provider in that profile. Agent 0.21.3 cannot run a
        # plugin loaded after its import-time discovery, so it reads as unavailable there.
        runtime, _ = sidecar.call("providers.resolve_runtime", {"profile_home": str(other), "requested": "fake-other"})
        assert named.pop("fake-other") == ("ready" if "result" in runtime else "unavailable"), runtime
        # The other profile's plugin with the default profile's provider id is either its own provider (an Agent with
        # per-home provider layers) or stays unloaded (one process-wide registry). Either way it never receives the
        # default profile's models, and the checks below prove the default profile's provider is unchanged.
        assert (named, named_models) in (
            ({"fake-sub": "ready"}, ["hijacked"]),
            ({"fake-sub-copy-provider": "not_loaded"}, []),
        ), (named, named_models)
        assert sidecar.result("providers.model_ids", {"profile_home": str(other), "provider": "fake-other"})["model_ids"] == ["other-1"]
        assert sidecar.result("providers.model_ids", {"profile_home": str(home), "provider": "fake-other"})["model_ids"] == []
        assert sidecar.result("plugins.providers", {"profile_home": str(home)})["providers"] == result["providers"]
        assert sidecar.result("providers.model_ids", {"profile_home": str(home), "provider": "fake-sub"})["model_ids"] == ["fake-opus", "claude-sonnet-4-6"]
    finally:
        sidecar.close()


@requires_agent
@pytest.mark.parametrize("isolation", ["in_process", "host"])
@pytest.mark.parametrize("layout", [(), ("model-providers",)], ids=["flat", "model-providers"])
def test_a_named_profiles_plugin_reads_the_same_whichever_profile_lists_first(tmp_path: pathlib.Path, layout: tuple, isolation: str) -> None:
    """A fresh sidecar whose first plugin listing is a named profile's reports that plugin as a launch-first one does."""
    home = tmp_path / "home" / ".hermes"
    home.mkdir(parents=True)
    (home / "config.yaml").write_text(f"plugins:\n  isolation: {isolation}\n")
    cli = tmp_path / "bin" / "fake-cli"
    cli.parent.mkdir()
    cli.write_text("#!/bin/sh\nexit 97\n")  # Listing must never run it.
    cli.chmod(0o755)
    other = home / "profiles" / "other"
    other.mkdir(parents=True)
    (other / "config.yaml").write_text(f"plugins:\n  isolation: {isolation}\n")
    _plugin(other.joinpath("plugins", *layout), "fake-other", "fake-other-provider", name="fake-other", display="Fake Other", command=str(cli), models=("other-1",))
    seen = []
    for order in ((home, other), (other, home)):
        sidecar = SidecarProcess(home)
        try:
            for profile in order:
                rows = {row["name"]: row["setup"] for row in sidecar.result("plugins.providers", {"profile_home": str(profile)})["providers"]}
            seen.append(rows if order[-1] == other else {row["name"]: row["setup"] for row in sidecar.result("plugins.providers", {"profile_home": str(other)})["providers"]})
            runtime, _ = sidecar.call("providers.resolve_runtime", {"profile_home": str(other), "requested": "fake-other"})
            assert seen[-1]["fake-other"] == ("ready" if "result" in runtime else "unavailable"), runtime
        finally:
            sidecar.close()
    assert seen[0] == seen[1], seen
