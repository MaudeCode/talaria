"""Config saves retain operator formatting and exact values on supported Agents."""

from __future__ import annotations

import json
import pathlib
import subprocess

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SidecarProcess, isolated_env, requires_agent


def agent_script(home: pathlib.Path, code: str) -> None:
    result = subprocess.run(
        [AGENT_PYTHON, "-c", "import sys; sys.path.insert(0, sys.argv[1]);\n" + code, str(AGENT_DIR)],
        env=isolated_env(home), capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr


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
    capability = subprocess.check_output(
        [AGENT_PYTHON, "-c", "import sys; sys.path.insert(0, sys.argv[1]); from hermes_cli import config; print(hasattr(config, 'atomic_config_replace'))", str(AGENT_DIR)],
        env=isolated_env(hermes_home), text=True,
    ).strip()
    if capability != "True":
        pytest.skip("Agent predates the comment-preserving config writer")
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
    monkeypatch.setattr(config, "yaml_parser", lambda: SimpleNamespace(safe_load=json.loads, safe_dump=lambda *a, **kw: staged))
    with pytest.raises(RpcError) as error:
        config.write_config(path, {"value": 1})
    assert error.value.data["condition"] == "config_invalid"
    assert path.read_text() == original
    assert path.stat().st_mode & 0o777 == 0o640
    assert not list(tmp_path.glob(".config_*.tmp"))


@pytest.mark.parametrize("managed", ["nixos", "home-manager", "guix"])
@pytest.mark.parametrize("shape", ["file", "symlink", "missing"])
def test_managed_config_set_refuses_before_any_write(tmp_path, monkeypatch, managed, shape):
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
        return managed

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
def test_native_delegation_settings_and_lossless_routes(hermes_home):
    """One real native API contract, with no provider execution or network access."""
    agent_script(hermes_home, r'''
import importlib, json, os, socket
from pathlib import Path
from unittest.mock import patch
from talaria_sidecar.methods import delegation
from talaria_sidecar.methods.config import read_config, write_config
from talaria_sidecar.errors import InvalidParams, RpcError
try:
    from agent.delegation_provider import DelegationProvider
    from agent.delegation_registry import register_provider
except ImportError:
    assert not delegation.registry({})['supported']
    sys.exit(0)

home = Path(os.environ['HERMES_HOME'])
home.mkdir(parents=True, exist_ok=True)
class Synthetic(DelegationProvider):
    name = 'synthetic_backend'
    def route_task(self, task, config):
        raise AssertionError('No task may execute')
class Unavailable(Synthetic):
    name = 'unavailable_backend'
    def is_available(self):
        return False
register_provider(Synthetic())
register_provider(Unavailable())
with patch.object(socket.socket, 'connect', side_effect=AssertionError('No network')):
    state = delegation.registry({})
    assert state['configured'] == state['effective'] == 'default', state
    assert state['fixed_model_active']
    assert delegation.registry({'delegation': {'backend': 'synthetic_backend'}})['effective'] == 'synthetic_backend'
    for name in ('missing_backend', 'unavailable_backend'):
        state = delegation.registry({'delegation': {'backend': name}})
        assert state['configured'] == name and state['effective'] is None and state['blocked_reason'], state
    original_import = __import__
    def old_import(name, *args, **kwargs):
        if name == 'agent.delegation_backends':
            raise ImportError('older Agent')
        return original_import(name, *args, **kwargs)
    with patch('builtins.__import__', side_effect=old_import):
        assert not delegation.registry({})['supported']

    stored = {'options': [{'name': 'old', 'description': 'research', 'provider': 'openai', 'model': 'synthetic', 'api_key': 'private-synthetic', 'request_overrides': {'headers': {'Authorization': 'private-header'}}, 'label': 'old label', 'service_tier': 'normal'}, {'name': 'deleted', 'model': 'other'}], 'default': 'old'}
    block = delegation.clean_routes('model_map', {'options': [{'name': 'renamed', 'original_name': 'old', 'description': 'research', 'provider': 'openai', 'model': 'synthetic'}], 'default': 'renamed'}, stored)
    row = block['options'][0]
    assert len(block['options']) == 1 and row['api_key'] == 'private-synthetic'
    assert row['request_overrides'] == stored['options'][0]['request_overrides']
    assert row['service_tier'] == 'normal' and row['label'] == 'old label'
    assert 'fallback_providers' not in row
    explicit = delegation.clean_routes('model_map', {'options': [{**row, 'fallback_providers': [], 'api_key_clear': True}], 'default': None}, block)['options'][0]
    assert explicit['fallback_providers'] == [] and 'api_key' not in explicit
    omitted = delegation.clean_routes('model_map', {'options': [{**row, 'service_tier': ''}], 'default': None}, block)['options'][0]
    assert 'service_tier' not in omitted
    created = delegation.clean_routes('model_map', {'options': [{**row, 'name': 'new'}, row], 'default': 'new'}, block)
    assert [item['name'] for item in created['options']] == ['new', 'renamed'] and created['default'] == 'new'
    assert delegation.clean_routes('model_map', {'options': [], 'default': None}, block) == {'options': []}
    for entry in ({**row, 'service_tier': 'invalid'}, {**row, 'reasoning_effort': 'invalid'}):
        try:
            delegation.clean_routes('model_map', {'options': [entry]}, {})
        except InvalidParams:
            pass
        else:
            raise AssertionError('invalid route accepted')
    try:
        delegation.clean_routes('profile_routes', {'profiles': [{'name': 'does-not-exist'}]}, {})
    except InvalidParams:
        pass
    else:
        raise AssertionError('unknown profile accepted')
    known = delegation.registry({})['profiles']
    assert known
    assert delegation.clean_routes('profile_routes', {'profiles': [{'name': known[0]}], 'default': known[0]}, {})['default'] == known[0]

    class Methods:
        def __init__(self): self.handlers = {}
        def method(self, name):
            def register(fn): self.handlers[name] = fn; return fn
            return register
    methods = Methods()
    delegation.register(methods)
    path = home / 'config.yaml'
    write_config(path, {'delegation': {'provider': 'openai', 'model': 'synthetic'}})
    params = {'profile_home': str(home), 'config_path': str(path), 'backend': 'synthetic_backend'}
    assert methods.handlers['aux.delegation_backend'](None, params)['ok']
    assert read_config(path)['config']['delegation']['backend'] == 'synthetic_backend'
    before = path.read_bytes()
    with patch.dict(os.environ, {'HERMES_MANAGED': 'nixos'}):
        try:
            methods.handlers['aux.delegation_backend'](None, {**params, 'backend': 'default'})
        except RpcError as error:
            assert error.data['condition'] == 'config_write_refused'
        else:
            raise AssertionError('managed backend changed')
    assert path.read_bytes() == before
''')

    sidecar = SidecarProcess(hermes_home)
    try:
        state = sidecar.result("aux.delegation", {"profile_home": str(hermes_home), "config": {"delegation": {"backend": "missing_backend"}}})
        assert state["configured"] == "missing_backend" and state["effective"] is None
        assert state["blocked_reason"]
        if state["supported"]:
            result = sidecar.result("aux.delegation_routes", {"profile_home": str(hermes_home), "backend": "model_map", "block": {"options": [], "default": None}, "current": {"options": [{"name": "removed"}]}})
            assert result == {"block": {"options": []}}
            assert sidecar.result("aux.delegation_backend", {"profile_home": str(hermes_home), "config_path": str(hermes_home / "config.yaml"), "backend": "default"}) == {"ok": True}
    finally:
        sidecar.close()
