"""Config saves retain operator formatting and exact values on supported Agents."""

from __future__ import annotations

import contextlib
import json
import pathlib

import pytest

from conftest import AGENT_DIR, SidecarProcess, agent_script, requires_agent
from talaria_sidecar import SIDECAR_RPC_VERSION


@requires_agent
@pytest.mark.parametrize("fallback", [False, True])
def test_config_set_preserves_divergent_alias_values(hermes_home: pathlib.Path, fallback: bool) -> None:
    agent_script(hermes_home, r'''
import json, os
from pathlib import Path
from unittest.mock import patch
from talaria_sidecar.methods import config

path = Path(os.environ["HERMES_HOME"]) / "config.yaml"
original_import = config.importlib.import_module
def import_module(name):
    if FALLBACK and name == "hermes_cli.config":
        raise ImportError("Agent config writer unavailable")
    return original_import(name)

source = '# routing notes\nmodel: &route\n  default: "old-model" # pinned route\n  options: &options\n    limits: &limits [10, 20]\nauxiliary:\n  vision: *route\n  options: *options\n  limits: *limits\n'
for case in ("model", "unchanged", "remove_anchor", "remove_alias", "nested", "sequence", "boolean"):
    path.write_text(source)
    path.chmod(0o640)
    desired = json.loads(json.dumps(config.read_config(path)["config"]))
    if case == "model":
        desired["model"]["default"] = "new-model"
    elif case == "remove_anchor":
        del desired["model"]
    elif case == "remove_alias":
        del desired["auxiliary"]["vision"]
    elif case == "nested":
        desired["model"]["options"]["limits"][0] = 30
    elif case == "sequence":
        desired["auxiliary"]["limits"].append(30)
    elif case == "boolean":
        desired["auxiliary"]["limits"][0] = True
    with patch.object(config.importlib, "import_module", side_effect=import_module):
        assert config.write_config(path, desired)["ok"] is True
    assert config.read_config(path)["config"] == desired, case
    assert path.stat().st_mode & 0o777 == 0o640
    assert not list(path.parent.glob(".config_*.tmp"))
    if not FALLBACK:
        text = path.read_text()
        assert "# routing notes" in text
        assert "# pinned route" in text
        if case == "unchanged":
            assert "*route" in text
'''.replace("FALLBACK", repr(fallback)))


@requires_agent
def test_config_set_preserves_comments_quotes_order_and_removals(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    path = hermes_home / "config.yaml"
    path.write_text('# my provider notes\nmodel:\n  default: "test-model" # pinned for cost\n  provider: custom\n  obsolete: true\nagent:\n  max_turns: 10\nremoved: true\n')
    params = {"profile_home": str(hermes_home)}
    config = handshaken.result("config.get", params)["config"]
    del config["removed"]
    del config["model"]["obsolete"]
    config["agent"]["max_turns"] = 20
    config["new_setting"] = "café"
    handshaken.result("config.set", {**params, "config": config})
    text = path.read_text()
    assert "# my provider notes" in text
    assert '"test-model" # pinned for cost' in text
    assert text.index("model:") < text.index("agent:") < text.index("new_setting:")
    assert handshaken.result("config.get", params)["config"] == config


def backslash_corpus() -> list[str]:
    return [
        "A" * length + path + " " + "B" * 40 + suffix
        for length in range(60, 82)
        for path in ("C:\\Users\\test", "D:\\Central", "\\\\server\\share", "\\d+\\w+", "\\")
        for suffix in ("\t", "\n", "\x01")
    ]


@requires_agent
def test_config_set_round_trips_backslash_corpus(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    params = {"profile_home": str(hermes_home)}
    config = {"policy": backslash_corpus()}
    # Exercise both creation and replacement of an existing document.
    for _ in range(2):
        handshaken.result("config.set", {**params, "config": config})
        assert handshaken.result("config.get", params)["config"] == config


@requires_agent
def test_config_fallback_round_trips_backslash_corpus(hermes_home: pathlib.Path) -> None:
    (hermes_home / "desired.json").write_text(json.dumps({"policy": backslash_corpus()}))
    agent_script(hermes_home, '''
import os, json
from pathlib import Path
from unittest.mock import patch
from talaria_sidecar.methods import config

original_import = config.importlib.import_module
def without_writer(name):
    if name == "hermes_cli.config":
        raise ImportError("Agent config writer unavailable")
    return original_import(name)

path = Path(os.environ["HERMES_HOME"]) / "config.yaml"
desired = json.loads((path.parent / "desired.json").read_text())
with patch.object(config.importlib, "import_module", side_effect=without_writer):
    config.write_config(path, desired)
assert config.read_config(path)["config"] == desired
''')


@pytest.mark.parametrize("modern", [False, True])
def test_config_retarget_during_serialization_leaves_both_targets_untouched(tmp_path: pathlib.Path, monkeypatch, modern: bool) -> None:
    from types import SimpleNamespace

    from talaria_sidecar.errors import RpcError
    from talaria_sidecar.methods import config

    original, other, link = (tmp_path / name for name in ("original.yaml", "other.yaml", "config.yaml"))
    original.write_text("value: original\n")
    other.write_text("value: other\n")
    link.symlink_to(original)

    def retarget(*args, **kwargs):
        link.unlink()
        link.symlink_to(other)
        if modern:
            args[0].write_text("value: changed\n")
        return "value: changed\n"

    module = SimpleNamespace(get_managed_system=lambda home: None, atomic_config_replace=retarget) if modern else SimpleNamespace(get_managed_system=lambda home: None)
    monkeypatch.setattr(config.importlib, "import_module", lambda name: module)
    monkeypatch.setattr(config, "managed_config", dict)
    monkeypatch.setattr(config, "yaml_parser", lambda: SimpleNamespace(safe_dump=retarget, safe_load=lambda text: {"value": "changed"}))
    with pytest.raises(RpcError) as error:
        config.write_config(link, {"value": "changed"})
    assert error.value.data["condition"] == "config_changed"
    assert original.read_text() == "value: original\n"
    assert other.read_text() == "value: other\n"
    assert link.resolve() == other
    assert not list(tmp_path.glob(".config_*.tmp"))


def test_agent_writer_failure_does_not_fall_back_or_modify_target(tmp_path: pathlib.Path, monkeypatch) -> None:
    from types import SimpleNamespace

    from talaria_sidecar.methods import config

    path = tmp_path / "config.yaml"
    path.write_text("value: original\n")

    def fail(staged, desired):
        staged.write_text("partial write")
        raise OSError("writer failed")

    monkeypatch.setattr(config.importlib, "import_module", lambda name: SimpleNamespace(get_managed_system=lambda home: None, atomic_config_replace=fail))
    monkeypatch.setattr(config, "managed_config", dict)
    with pytest.raises(OSError, match="writer failed"):
        config.write_config(path, {"value": "changed"})
    assert path.read_text() == "value: original\n"
    assert not list(tmp_path.glob(".config_*.tmp"))


@pytest.mark.parametrize("modern", [False, True])
@pytest.mark.parametrize("staged", ['{"value": "wrong"}', '{"value": true}', 'invalid'])
def test_config_staged_value_mismatch_leaves_original_untouched(tmp_path: pathlib.Path, monkeypatch, modern, staged) -> None:
    from types import SimpleNamespace

    from talaria_sidecar.errors import RpcError
    from talaria_sidecar.methods import config

    path = tmp_path / "config.yaml"
    original = '{"value": "original"}'
    path.write_text(original)
    path.chmod(0o640)
    module = SimpleNamespace(get_managed_system=lambda home: None, atomic_config_replace=lambda path, desired: path.write_text(staged)) if modern else SimpleNamespace(get_managed_system=lambda home: None)
    monkeypatch.setattr(config.importlib, "import_module", lambda name: module)
    monkeypatch.setattr(config, "managed_config", dict)
    monkeypatch.setattr(config, "yaml_parser", lambda: SimpleNamespace(safe_load=json.loads, safe_dump=lambda *a, **kw: staged))
    with pytest.raises(RpcError) as error:
        config.write_config(path, {"value": 1})
    assert error.value.data["condition"] == "config_invalid"
    assert path.read_text() == original
    assert path.stat().st_mode & 0o777 == 0o640
    assert not list(tmp_path.glob(".config_*.tmp"))


@pytest.mark.parametrize("shape", ["file", "symlink", "missing"])
def test_managed_config_set_refuses_before_any_write(tmp_path, monkeypatch, shape):
    from types import SimpleNamespace

    from talaria_sidecar.errors import RpcError
    from talaria_sidecar.methods import Registry, config

    home = tmp_path / "profile"
    home.mkdir()
    target = tmp_path / "external" / "config.yaml"
    path = home / "config.yaml" if shape == "symlink" else target
    original = b'{"delegation": {"backend": "default"}}'
    if shape != "missing":
        target.parent.mkdir()
        target.write_bytes(original)
        target.chmod(0o640)
    if shape == "symlink":
        path.symlink_to(target)
    detected = []

    def detector(owning_home):
        detected.append(owning_home)
        return "nixos"  # any manager refuses alike

    def native_import(name):
        if name == "hermes_constants":
            return SimpleNamespace(get_managed_system=detector)
        raise ImportError("heavy Agent config imports are broken")

    monkeypatch.setattr(config.importlib, "import_module", native_import)
    monkeypatch.setattr(config, "yaml_parser", lambda: SimpleNamespace(safe_load=json.loads, safe_dump=lambda value, **kw: json.dumps(value)))
    registry = Registry(None)
    config.register(registry)
    params = {"profile_home": str(home), "config_path": str(path)}
    if shape != "missing":
        assert registry.methods["config.get"](None, params)["config"]["delegation"]["backend"] == "default"
    error = None
    try:
        registry.methods["config.set"](None, {**params, "config": {"delegation": {"backend": "synthetic"}}})
    except RpcError as exc:
        error = exc
    if shape == "missing":
        assert not target.parent.exists()
    else:
        assert target.read_bytes() == original
        assert target.stat().st_mode & 0o777 == 0o640
    if shape == "symlink":
        assert path.is_symlink() and path.readlink() == target
    assert not list(tmp_path.rglob(".config_*.tmp"))
    assert detected == [home]
    assert error is not None and error.data["condition"] == "config_write_refused"
    assert "managed" in str(error) and "declarative" in str(error)


@pytest.mark.parametrize("failure", [ImportError("detector unavailable"), OSError("marker unreadable")])
def test_config_policy_failure_refuses_before_creating_directories(tmp_path, monkeypatch, failure):
    from talaria_sidecar.errors import RpcError
    from talaria_sidecar.methods import config

    def unavailable(name):
        raise failure

    monkeypatch.setattr(config.importlib, "import_module", unavailable)
    path = tmp_path / "absent" / "config.yaml"
    with pytest.raises(RpcError) as error:
        config.write_config(path, {"value": "changed"})
    assert error.value.data["condition"] == "config_policy_unavailable"
    assert not path.parent.exists()


@requires_agent
def test_native_managed_config_policy(hermes_home):
    agent_script(hermes_home, '''
import os
from pathlib import Path
from unittest.mock import patch
from hermes_constants import get_managed_system
from talaria_sidecar.errors import RpcError
from talaria_sidecar.methods import Registry, config

home = Path(os.environ["HERMES_HOME"])
other = home / "profiles" / "managed"
other.mkdir(parents=True)
path = home / "external.yaml"
path.write_text("value: original\\n")
path.chmod(0o640)
original = path.read_bytes()
registry = Registry(None)
config.register(registry)
params = {"profile_home": str(other), "config_path": str(path)}
# One exact native contract covers environment, legacy/empty and named markers,
# explicit owning-profile resolution, reads, and broken heavy imports.
for env, marker, expected in [("nixos", None, "nixos"), ("1", None, "nixos"), ("", "", "nixos"), ("", "home-manager", "home-manager"), ("", "false", None), ("", None, None)]:
    os.environ["HERMES_MANAGED"] = env
    marker_path = other / ".managed"
    marker_path.unlink(missing_ok=True)
    if marker is not None:
        marker_path.write_text(marker)
    assert get_managed_system(other) == expected
    original_import = config.importlib.import_module
    def without_heavy(name):
        if name == "hermes_cli.config":
            raise ImportError("broken heavy Agent import")
        return original_import(name)
    with patch.object(config.importlib, "import_module", side_effect=without_heavy):
        if expected:
            try:
                registry.methods["config.set"](None, {**params, "config": {"value": "changed"}})
            except RpcError as error:
                assert error.data["condition"] == "config_write_refused"
            else:
                raise AssertionError("managed config write succeeded")
            assert path.read_bytes() == original
        else:
            assert registry.methods["config.set"](None, {**params, "config": {"value": "changed"}})["ok"]
            assert config.read_config(path)["config"] == {"value": "changed"}
            path.write_bytes(original)
        assert registry.methods["config.get"](None, params)["config"] == {"value": "original"}
    assert path.stat().st_mode & 0o777 == 0o640
''')


@requires_agent
@pytest.mark.parametrize("fallback", [False, True])
def test_config_set_drops_other_access(hermes_home: pathlib.Path, fallback: bool) -> None:  # agent-shim: config-drop-other-access
    agent_script(hermes_home, '''
import os
from pathlib import Path
from unittest.mock import patch
from talaria_sidecar.methods import Registry, config

home = Path(os.environ["HERMES_HOME"])
path = home / "config.yaml"
registry = Registry(None)
config.register(registry)
original_import = config.importlib.import_module
def import_module(name):
    if FALLBACK and name == "hermes_cli.config":
        raise ImportError("Agent config writer unavailable")
    return original_import(name)

# The Agent's own writers strip other access and keep group bits for shared-group homes.
for initial, expected in [(0o644, 0o640), (0o666, 0o660), (0o640, 0o640), (None, 0o600)]:
    path.unlink(missing_ok=True)
    if initial is not None:
        path.write_text("value: original\\n")
        path.chmod(initial)
    with patch.object(config.importlib, "import_module", side_effect=import_module):
        registry.methods["config.set"](None, {"profile_home": str(home), "config": {"value": "changed"}})
    assert config.read_config(path)["config"] == {"value": "changed"}
    assert path.stat().st_mode & 0o777 == expected, (oct(initial or 0), oct(path.stat().st_mode & 0o777))
'''.replace("FALLBACK", repr(fallback)))


@requires_agent
def test_config_set_refuses_managed_leaf(hermes_home: pathlib.Path, tmp_path: pathlib.Path) -> None:
    managed = tmp_path / "managed"
    managed.mkdir()
    (managed / "config.yaml").write_text("agent:\n  max_turns: 25\n")
    path = hermes_home / "config.yaml"
    original = "agent:\n  max_turns: 10\n  max_tokens: 100\n"
    path.write_text(original)
    with contextlib.closing(SidecarProcess(hermes_home, env={"HERMES_MANAGED_DIR": str(managed)})) as sidecar:
        sidecar.result("runtime.handshake", {"rpc_version": SIDECAR_RPC_VERSION})
        params = {"profile_home": str(hermes_home)}
        response, _ = sidecar.call("config.set", {**params, "config": {"agent": {"max_turns": 30, "max_tokens": 200}}})
        assert response.get("error", {}).get("data", {}).get("condition") == "config_key_managed", response
        assert "agent.max_turns" in response["error"]["message"]
        assert path.read_text() == original
        snapshot = sidecar.result("config.get", params)
        assert snapshot["managed"] == {"agent": {"max_turns": 25}}
        assert snapshot["config"]["agent"]["max_turns"] == 10
        sidecar.result("config.set", {**params, "config": {"agent": {"max_turns": 25, "max_tokens": 200}}})
        assert sidecar.result("config.get", params)["config"]["agent"] == {"max_turns": 10, "max_tokens": 200}


@requires_agent
def test_config_get_distinguishes_unavailable_managed_policy(hermes_home: pathlib.Path, tmp_path: pathlib.Path) -> None:
    managed = tmp_path / "managed"
    managed.mkdir()
    (managed / "config.yaml").write_text("talaria: [unclosed\n")
    (hermes_home / "config.yaml").write_text("talaria:\n  agent_approvals: true\n")
    with contextlib.closing(SidecarProcess(hermes_home, env={"HERMES_MANAGED_DIR": str(managed)})) as sidecar:
        sidecar.result("runtime.handshake", {"rpc_version": SIDECAR_RPC_VERSION})
        result = sidecar.result("config.get", {"profile_home": str(hermes_home)})
    assert result["config"] == {"talaria": {"agent_approvals": True}}
    assert result["managed"] is None


# TAL-2304: a config.set that enters a credential keeps it in the profile's .env under the Agent's own name.
native_refs = pytest.mark.skipif(AGENT_DIR is None or not (AGENT_DIR / "hermes_cli" / "config_secret_refs.py").is_file(),
                                 reason="Agent without config_secret_refs")
CREDENTIAL_HOME = r'''
import os
from pathlib import Path
from talaria_sidecar.errors import RpcError
from talaria_sidecar.methods import Registry, config

home = Path(os.environ["HERMES_HOME"])
path, env = home / "config.yaml", home / ".env"
url = "https://models.example.test/v1"
registry = Registry(None)
config.register(registry)
params = {"profile_home": str(home)}
def save(desired):
    return registry.methods["config.set"](None, {**params, "config": desired})
def env_lines():
    return env.read_text().splitlines() if env.exists() else []
'''


@requires_agent
@native_refs
def test_config_set_keeps_entered_credentials_in_profile_env(hermes_home: pathlib.Path) -> None:
    agent_script(hermes_home, CREDENTIAL_HOME + r'''
from hermes_cli.config_secret_refs import aux_api_key_env, endpoint_api_key_env

path.write_text("model:\n  provider: custom\n  base_url: https://models.example.test/v1\nauxiliary:\n  compression:\n    provider: custom\n    base_url: https://aux.example.test/v1\n    api_key: synthetic-inline-kept\n")
desired = config.read_config(path)["config"]
desired["model"]["api_key"] = "synthetic-model-key"
desired["auxiliary"]["vision"] = {"provider": "openrouter", "model": "synthetic", "api_key": "synthetic-vision-key"}
desired["delegation"] = {"provider": "custom", "base_url": "https://agents.example.test/v1", "api_key": "synthetic-delegation-key"}
save(desired)

names = {"model": endpoint_api_key_env(url), "vision": aux_api_key_env("vision"), "delegation": "HERMES_DELEGATION_API_KEY"}
assert names["model"] != endpoint_api_key_env("https://models-example.test/v1")
saved = config.read_config(path)["config"]
assert saved["model"]["api_key"] == "${%s}" % names["model"]
assert saved["auxiliary"]["vision"]["api_key"] == "${%s}" % names["vision"]
assert saved["delegation"]["api_key"] == "${%s}" % names["delegation"]
# An inline key the save did not change stays where the user put it.
assert saved["auxiliary"]["compression"]["api_key"] == "synthetic-inline-kept"
assert "synthetic-model-key" not in path.read_text()
assert {f"{names['model']}=synthetic-model-key", f"{names['vision']}=synthetic-vision-key", f"{names['delegation']}=synthetic-delegation-key"} <= set(env_lines())
assert env.stat().st_mode & 0o777 == 0o600
resolved = registry.methods["config.get"](None, params)["resolved"]
assert resolved["model"]["api_key"] == "synthetic-model-key"
assert resolved["auxiliary"]["vision"]["api_key"] == "synthetic-vision-key"
assert not [name for name in names.values() if name in os.environ]

# Rotating the key replaces the variable's value behind the same reference; an unrelated save moves nothing.
saved["model"]["api_key"] = "synthetic-rotated-key"
saved["agent"] = {"max_turns": 5}
save(saved)
saved = config.read_config(path)["config"]
assert saved["model"]["api_key"] == "${%s}" % names["model"]
assert saved["auxiliary"]["compression"]["api_key"] == "synthetic-inline-kept"
assert f"{names['model']}=synthetic-rotated-key" in env_lines()
assert "synthetic-model-key" not in env.read_text()
''')


@requires_agent
@native_refs
def test_config_set_refuses_credential_before_any_write(hermes_home: pathlib.Path, tmp_path: pathlib.Path) -> None:
    managed = tmp_path / "managed"
    managed.mkdir()
    (managed / ".env").write_text("AUXILIARY_VISION_API_KEY=synthetic-admin-key\n")
    agent_script(hermes_home, f"import os; os.environ['HERMES_MANAGED_DIR'] = {str(managed)!r}\n" + CREDENTIAL_HOME + r'''
from hermes_cli.config_secret_refs import endpoint_api_key_env

name = endpoint_api_key_env(url)
# Another endpoint already reads the saved route's variable and holds a different key in it; a route with no URL
# of its own (delegation re-pointed at a named provider) cannot prove it owns the variable either.
other = "fallback_providers:\n- provider: custom\n  base_url: https://other.example.test/v1\n  api_key: ${%s}\n"
env.write_text(f"{name}=synthetic-other-key\nHERMES_DELEGATION_API_KEY=synthetic-other-key\n")
for case in ("endpoint", "no_url", "managed"):
    path.write_text("model:\n  provider: custom\n  base_url: https://models.example.test/v1\n" + other % (name if case != "no_url" else "HERMES_DELEGATION_API_KEY"))
    original, original_env = path.read_bytes(), env.read_bytes()
    desired = config.read_config(path)["config"]
    if case == "no_url":
        desired["delegation"] = {"provider": "openrouter", "model": "synthetic", "api_key": "synthetic-delegation-key"}
    else:
        desired["model"]["api_key"] = "synthetic-model-key"
    if case == "managed":  # an administrator-managed variable refuses the whole save, not just its slot
        desired["fallback_providers"] = []
        desired["auxiliary"] = {"vision": {"provider": "openrouter", "model": "synthetic", "api_key": "synthetic-vision-key"}}
    try:
        save(desired)
    except RpcError as error:
        assert error.data["condition"] == "config_write_refused", (case, error.data)
    else:
        raise AssertionError(f"{case}: credential save succeeded")
    assert path.read_bytes() == original, case
    assert env.read_bytes() == original_env, case
''')


@requires_agent
def test_config_set_keeps_credentials_inline_without_native_references(hermes_home: pathlib.Path) -> None:  # agent-shim: config-secret-refs
    agent_script(hermes_home, CREDENTIAL_HOME + r'''
from unittest.mock import patch

original_import = config.importlib.import_module
def import_module(name):
    if name == "hermes_cli.config_secret_refs":
        raise ImportError("Agent before v0.23.2")
    return original_import(name)

with patch.object(config.importlib, "import_module", side_effect=import_module):
    save({"model": {"provider": "custom", "base_url": url, "api_key": "synthetic-model-key"}})
assert config.read_config(path)["config"]["model"]["api_key"] == "synthetic-model-key"
assert not env.exists()
''')
