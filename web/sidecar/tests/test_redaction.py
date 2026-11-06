"""The policy observer's RPC ordering, independent of Agent imports."""
import io
import json
import sys
import types

import pytest

from talaria_sidecar.methods import Registry
from talaria_sidecar.methods.redaction import register
from talaria_sidecar.rpc import RpcServer


@pytest.mark.parametrize('exit_path', ['result', 'stream', 'snapshot', 'error'])
def test_policy_precedes_the_first_affected_rpc_output(monkeypatch, exit_path):
    module = types.SimpleNamespace(_PREFIX_RE=object(), _plugin_patterns=lambda: module.patterns,
                                   _extract_literal_prefix=lambda p: 'acme_', patterns=[])
    monkeypatch.setitem(sys.modules, 'agent.redact', module)
    registry = Registry(None)
    register(registry)
    output = io.BytesIO()

    def handler(ctx, params):
        module.patterns.append('acme_[a-z0-9]+')
        module._PREFIX_RE = object()
        if exit_path == 'snapshot':
            ctx.server.redaction_policy.snapshot()
        if exit_path in ('stream', 'snapshot'):
            ctx.emit('token', {'text': 'acme_0123456789abcdef'})
        if exit_path == 'error':
            raise ValueError('synthetic failure')
        return {'ok': True}

    server = RpcServer({**registry.methods, 'register': handler}, stdout=output)
    server._dispatch({'id': 1, 'method': 'redaction.policy'})
    empty = json.loads(output.getvalue())['result']
    assert empty['patterns'] == []
    output.seek(0)
    output.truncate()
    server._dispatch({'id': 2, 'method': 'register'})
    server._dispatch({'id': 3, 'method': 'redaction.policy'})
    server._dispatch({'id': 4, 'method': 'redaction.policy'})
    replies = [json.loads(line) for line in output.getvalue().splitlines()]
    assert replies[0].get('method') == 'redaction.policy'
    assert replies[0]['params']['patterns'] == [{'pattern': 'acme_[a-z0-9]+', 'literal_prefix': 'acme_'}]
    assert replies[0]['params']['fingerprint'] != empty['fingerprint']
    assert len([r for r in replies if r.get('method') == 'redaction.policy']) == 1
    assert next(r for r in replies if r.get('id') == 3)['result'] == replies[0]['params']


def test_policy_without_an_imported_agent_or_registry_is_empty(monkeypatch):
    monkeypatch.delitem(sys.modules, 'agent.redact', raising=False)
    registry = Registry(None)
    register(registry)
    output = io.BytesIO()
    server = RpcServer(registry.methods, stdout=output)
    for module in (None, types.SimpleNamespace(_PREFIX_RE=object())):
        if module is not None:
            monkeypatch.setitem(sys.modules, 'agent.redact', module)
        output.seek(0)
        output.truncate()
        server._dispatch({'id': 1, 'method': 'redaction.policy'})
        assert json.loads(output.getvalue())['result']['patterns'] == []
