"""On-demand plugin loading against stand-in Agent modules: the auth registry snapshot is taken before any plugin loads."""

from __future__ import annotations

import sys
import types
from pathlib import Path

from talaria_sidecar.methods import providers as sidecar_providers


def test_the_auth_registry_snapshot_precedes_a_named_profiles_plugin(monkeypatch, tmp_path) -> None:
    order = []
    agent_providers = types.ModuleType("providers")
    agent_providers.list_providers = lambda: []
    agent_providers._import_plugin_dir = lambda root, kind: order.append(("plugin", "hermes_cli.auth" in sys.modules))
    package = types.ModuleType("hermes_cli")
    package.__path__ = []
    auth = types.ModuleType("hermes_cli.auth")
    monkeypatch.setitem(sys.modules, "providers", agent_providers)
    monkeypatch.setitem(sys.modules, "hermes_cli", package)
    monkeypatch.delitem(sys.modules, "hermes_cli.auth", raising=False)

    class Finder:  # Imports hermes_cli.auth the way Agent 0.21.3 builds its snapshot: on first import.
        def find_spec(self, name, path=None, target=None):
            if name != "hermes_cli.auth":
                return None
            import importlib.util

            class Loader:
                def create_module(self, spec):
                    order.append(("auth", None))
                    return auth

                def exec_module(self, module):
                    pass

            return importlib.util.spec_from_loader(name, Loader())

    broken = []

    class BrokenFinder:  # An auth layer that fails to import has no confirmed snapshot.
        def find_spec(self, name, path=None, target=None):
            if name == "hermes_cli.auth" and not broken:
                broken.append(name)
                raise ImportError("auth layer failed to import")
            return None

    monkeypatch.setattr(sys, "meta_path", [BrokenFinder(), Finder(), *sys.meta_path])
    monkeypatch.setattr(sidecar_providers, "_LOAD_ATTEMPTED", set())
    plugin = Path(tmp_path) / "profiles" / "other" / "plugins" / "fake-other"
    sidecar_providers._load_plugin(plugin)
    assert order == []  # the plugin stays unloaded rather than entering a later snapshot
    sidecar_providers._load_plugin(plugin)  # a later listing retries once the auth layer imports
    assert order == [("auth", None), ("plugin", True)]
