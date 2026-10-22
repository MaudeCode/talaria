"""Native compatibility probe; all files and child hosts belong to the caller's disposable home."""
import base64
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace as NS

sys.path.insert(0, sys.argv[1])
from talaria_sidecar.methods import Registry, dashboard_plugins
from talaria_sidecar.home import scoped_home

base = Path(os.environ['HERMES_HOME'])
other = base / 'profiles' / 'beta'
api = '''
import os
from fastapi import APIRouter, Request
from hermes_cli.web_deps import late
router = APIRouter()
@router.get("/identity")
async def identity(request: Request):
    late("_require_token")(request)
    from pathlib import Path
    return {"home": os.environ["HERMES_HOME"], "source": __file__, "resource": Path(__file__).with_name("profile-resource.txt").read_text(),
            "origin": __spec__.origin, "loader_source": __loader__.get_filename(__name__), "pid": os.getpid(), "query": str(request.url.query),
            "credentials": [k for k in request.headers if k.lower() in {"authorization", "cookie", "x-hermes-session-token"}]}
'''
secondary = 'talaria-secondary-probe'
for home in (base, other):
    names = ['board'] + ([secondary] if home == other else [])
    home.mkdir(parents=True, exist_ok=True)
    (home / 'config.yaml').write_text('plugins:\n  isolation: in_process\n  enabled: ' + json.dumps(names) + '\n')
    for name in names:
        plugin = home / 'plugins' / name
        (plugin / 'dashboard/dist').mkdir(parents=True)
        (plugin / 'plugin.yaml').write_text(f'name: {name}\nversion: 0.0.1\ndescription: Synthetic dashboard\n')
        (plugin / '__init__.py').write_text('raise AssertionError("dashboard must never import this entrypoint")\n')
        (plugin / 'dashboard/manifest.json').write_text(json.dumps({'name':name, 'panel':'dist/index.html', 'api':'api.py'}))
        (plugin / 'dashboard/dist/index.html').write_text(f'<p>{home.name}:{name}</p>')
        (plugin / 'dashboard/api.py').write_text(api)
        (plugin / 'dashboard/profile-resource.txt').write_text(home.name + ':' + name)
registry = Registry(NS(load=lambda: None, ensure_current=lambda: None))
dashboard_plugins.register(registry)
ctx = NS(check_cancelled=lambda: None)
def call(action, home, **params):
    return registry.methods['plugins.dashboard_' + action](ctx, {'profile_home':str(home), **params})
if not call('list', base)['supported']:
    assert call('list', other) == {'supported':False, 'plugins':[]}
    print('unsupported Agent fails closed')
    sys.exit(0)
from hermes_cli.plugins import get_plugin_manager
hosts = []
request_params = dict(authenticated=True, path='/identity', method='GET', query='profile=wrong&token=secret&q=ok',
                      headers={'authorization':'secret', 'cookie':'secret'}, body='', websocket=False)
try:
    assert secondary not in [p['name'] for p in call('list', base)['plugins']]
    assert secondary in [p['name'] for p in call('list', other)['plugins']]
    for home in (base, other):
        row = next(p for p in call('list', home)['plugins'] if p['name'] == 'board')
        assert row['panel'] == 'dist/index.html' and row['enabled'], row
        asset = call('asset', home, name='board', path='dist/index.html')
        assert base64.b64decode(asset['body']) == f'<p>{home.name}:board</p>'.encode(), asset
        result = call('request', home, name='board', **request_params)
        assert result['status'] == 200, result
        identity = json.loads(base64.b64decode(result['body']))
        assert Path(identity['home']).resolve() == home.resolve(), identity
        assert Path(identity['source']).resolve() == (home / 'plugins/board/dashboard/api.py').resolve(), identity
        assert identity['origin'] == identity['source'] == identity['loader_source'], identity
        assert identity['resource'] == home.name + ':board', identity
        assert identity['pid'] != os.getpid() and identity['credentials'] == [] and identity['query'] == 'q=ok', identity
        with scoped_home(home, load_plugins=False):
            host = get_plugin_manager()._plugin_host()
            hosts.append(host)
        # Same cached app, concurrent admitted/refused IPC calls. No HTTP marker grants admission.
        def request(admitted):
            return host.asgi_request('board', str(home / 'plugins/board/dashboard'), 'api.py', 'GET', '/identity',
                                     'authenticated=true', [('X-Hosted-Http-Authenticated','true')], b'', timeout=10, authenticated=admitted)['status']
        with ThreadPoolExecutor(max_workers=4) as pool:
            assert list(pool.map(request, [True, False, True, False])) == [200, 401, 200, 401]
    assert call('asset', base, name=secondary, path='dist/index.html')['status'] == 404
    secondary_result = call('request', other, name=secondary, **request_params)
    assert secondary_result['status'] == 200, secondary_result
    secondary_identity = json.loads(base64.b64decode(secondary_result['body']))
    assert Path(secondary_identity['source']).resolve() == (other / 'plugins' / secondary / 'dashboard/api.py').resolve(), secondary_identity
    assert secondary_identity['pid'] == hosts[1].pid
    assert secondary_identity['resource'] == other.name + ':' + secondary
    call('toggle', other, name='board', enabled=False)
    assert not next(p for p in call('list', other)['plugins'] if p['name'] == 'board')['enabled']
    assert next(p for p in call('list', base)['plugins'] if p['name'] == 'board')['enabled']
    call('toggle', other, name='board', enabled=True)
    assert next(p for p in call('list', other)['plugins'] if p['name'] == 'board')['enabled']
    assert hosts[0].pid != hosts[1].pid
    print('native profile discovery, credential stripping, host isolation and concurrent request-local admission passed')
finally:
    for host in hosts:
        host.shutdown()
    dashboard_plugins.close_dashboard_sources()
