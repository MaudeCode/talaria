"""Exercise the real native registry in a disposable interpreter, without providers or plugins on disk."""
import io
import json
import sys
from types import SimpleNamespace

sys.path.insert(0, sys.argv[1])
from agent import redact
from hermes_cli.plugins import PluginContext
from talaria_sidecar.methods import Registry
from talaria_sidecar.methods.redaction import register
from talaria_sidecar.rpc import RpcServer

registry = Registry(None)
register(registry)
output = io.BytesIO()
server = RpcServer(registry.methods, stdout=output)
server._dispatch({'id': 1, 'method': 'redaction.policy'})
initial = json.loads(output.getvalue())['result']
assert initial['patterns'] == []
if not hasattr(PluginContext, 'register_redaction_patterns'):
    print('Older Agent: empty plugin policy')
    raise SystemExit(0)
plugin = PluginContext(SimpleNamespace(name='synthetic-redaction'), None)
def register_pattern(ctx, params):
    assert plugin.register_redaction_patterns([r'acme_[a-z0-9]{10,}']) == 1
    ctx.emit('token', {'text': 'acme_0123456789abcdef'})
    return {'ok': True}
server.methods['synthetic.register'] = register_pattern
output.seek(0)
output.truncate()
server._dispatch({'id': 2, 'method': 'synthetic.register'})
server._dispatch({'id': 3, 'method': 'redaction.policy'})
server._dispatch({'id': 4, 'method': 'redaction.policy'})
replies = [json.loads(line) for line in output.getvalue().splitlines()]
assert replies[0].get('method') == 'redaction.policy', replies
policy = replies[0]['params']
assert policy['fingerprint'] != initial['fingerprint']
assert policy['patterns'] == [{'pattern': r'acme_[a-z0-9]{10,}', 'literal_prefix': 'acme_'}]
assert len([r for r in replies if r.get('method') == 'redaction.policy']) == 1
assert next(r for r in replies if r.get('id') == 3)['result'] == policy
assert redact.redact_sensitive_text('acme_0123456789abcdef', force=True) == 'acme_0...cdef'
