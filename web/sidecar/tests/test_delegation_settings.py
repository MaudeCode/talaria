"""The Agent's delegation registry, backend selection and lossless route editing (``aux.delegation*``) on the
installed release, with synthetic registered providers that never execute."""

from __future__ import annotations

from conftest import SidecarProcess, agent_script, requires_agent


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
