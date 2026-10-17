"""Disposable supervisors and HTTP backends drive the real update lease."""
import contextlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
from contextlib import contextmanager

import pytest

from conftest import SidecarProcess, AGENT_DIR, AGENT_PYTHON
from test_agent_mutation import native_agent, wait_for, supervised_inventory


def rpc(sidecar, root, action, **params):
    return sidecar.result('runtime.agent_mutation', {'agent_dir': str(root), 'action': action, **params}, timeout=45)


@pytest.mark.parametrize('named', [False, True])
def test_native_legacy_backend_identity_resolves_scoped_profile(tmp_path, named):
    from conftest import isolated_env, SIDECAR_ROOT
    home = tmp_path / 'home'
    served = home / 'profiles' / 'named' if named else home
    served.mkdir(parents=True)
    alias = tmp_path / 'home-link'
    alias.symlink_to(served, target_is_directory=True)
    script = '''import os, psutil, subprocess, sys
from pathlib import Path
from hermes_cli import process_identity
from talaria_sidecar.agent_services import _backend_identity
child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'],env={**os.environ,'HERMES_HOME':os.environ['TARGET_HOME']})
try:
 row=dict(pid=child.pid,create_time=psutil.Process(child.pid).create_time(),purpose='serve')
 home,profile=_backend_identity(row,{Path(os.environ['TARGET_HOME']).resolve()},process_identity)
 assert home==Path(os.environ['TARGET_HOME']).resolve()
 assert profile==os.environ['EXPECTED_PROFILE'],profile
 assert 'hermes_home' not in row and 'profile' not in row
finally:
 child.terminate(); child.wait(timeout=5)
'''
    env = isolated_env(home, PYTHONPATH=str(SIDECAR_ROOT) + os.pathsep + str(AGENT_DIR), TARGET_HOME=str(alias),
                       EXPECTED_PROFILE='named' if named else 'default', HERMES_SUPERVISED_CHILD='1')
    result = subprocess.run([AGENT_PYTHON, '-c', script], cwd=AGENT_DIR, env=env, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr[-5000:]


def git(root, *args):
    return subprocess.check_output(['git', '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
                                   '-c', 'commit.gpgsign=false', '-C', str(root), *args], text=True).strip()


@contextmanager
def supervised_agent(tmp_path, *, dashboards=1, depth=1, gateways=True, dependency_sync=False, readiness=None, legacy=False, refresh=False, manager="launchd", stop_seconds=None, modern_first=False):
    root, home, _, _ = native_agent(tmp_path)
    modules = root / 'hermes_cli'
    (root / 'synthetic_services.py').write_text('''import json, os, subprocess, sys, time, psutil
from pathlib import Path
HOME=Path(os.environ['HERMES_HOME']); ROOT=Path(__file__).parent

def publish_pid(path):
 temporary=path.with_name('.'+path.name+'.'+str(os.getpid())+'.tmp')
 temporary.write_text(str(os.getpid())); temporary.replace(path)
def birth(pid):
 pid=int(pid)
 if pid<=0: return None
 try:
  process=psutil.Process(pid)
  return process.create_time() if process.status()!=psutil.STATUS_ZOMBIE else None
 except psutil.Error: return None
def alive(pid,ct=None):
 actual=birth(pid)
 return actual is not None and (ct is None or abs(actual-ct)<.002)
def services(): return [json.loads(p.read_text()) for p in sorted((HOME/'services').glob('*/config.json'))]
def service_pid(label):
 try:
  pid=int((HOME/'services'/label/'service.pid').read_text())
  return pid if alive(pid) else None
 except FileNotFoundError: return None
def start(label):
 with (HOME/'services'/label/'start-attempts').open('a') as f: f.write('attempt'+chr(10))
 if (HOME/'services'/label/'fail-start').exists(): raise RuntimeError('synthetic service start refused')
 if service_pid(label): return
 (HOME/'services'/label/'disarm').unlink(missing_ok=True)
 cfg=json.loads((HOME/'services'/label/'config.json').read_text())
 if cfg['purpose']=='gateway': (Path(cfg['home'])/'pause').unlink(missing_ok=True)
 with (HOME/'services'/label/'starts').open('a') as f: f.write('start\\n')
 subprocess.Popen([sys.executable,str(ROOT/'supervisor.py'),label],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
 deadline=time.monotonic()+4
 while not service_pid(label) and time.monotonic()<deadline: time.sleep(.01)
 if not service_pid(label): raise RuntimeError('supervisor was not ready')
def stop(label):
 (HOME/'services'/label/'disarm').touch()
 deadline=time.monotonic()+4
 while service_pid(label) and time.monotonic()<deadline: time.sleep(.01)
 if service_pid(label): raise RuntimeError('supervisor did not stop')
def ledger():
 result=[]
 for cfg in services():
  file=Path(cfg['home'])/('active' if cfg['purpose']=='gateway' else 'backend.pid')
  try: pid=int(file.read_text())
  except FileNotFoundError: continue
  ct=birth(pid)
  if ct is not None:
   row=dict(pid=pid,create_time=ct,install='synthetic-install',purpose=cfg['purpose'],hermes_home=cfg['home'],profile=cfg['profile'],host='127.0.0.1',port=cfg.get('port'),argv='hermes '+cfg['purpose'])
   if cfg.get('legacy') and cfg['purpose']!='gateway': row.pop('hermes_home'); row['profile']=''
   result.append(row)
 return result
''')
    (root / 'wrapper.py').write_text('import subprocess, sys\nraise SystemExit(subprocess.call(sys.argv[1:]))\n')
    (root / 'inert.py').write_text("import sys,time\nfrom pathlib import Path\nwhile not (Path(sys.argv[1])/'stop').exists(): time.sleep(.01)\n")
    (root / 'supervisor.py').write_text('''import json, os, signal, subprocess, sys, time
from pathlib import Path
from synthetic_services import HOME, ROOT, publish_pid
label=sys.argv[1]; folder=HOME/'services'/label
cfg=json.loads((folder/'config.json').read_text())
publish_pid(folder/'service.pid')
argv=[sys.executable,str(ROOT/('writer.py' if cfg['purpose']=='gateway' else 'backend.py')),cfg['home']]
if (folder/'wrapper-only').exists(): argv=[sys.executable,str(ROOT/'inert.py'),cfg['home']]
for _ in range(cfg['depth']): argv=[sys.executable,str(ROOT/'wrapper.py'),*argv]
child=subprocess.Popen(argv)
def stop(*_): (folder/'disarm').touch()
signal.signal(signal.SIGTERM,stop)
try:
 while not (folder/'disarm').exists():
  if child.poll() is not None:
   if (folder/'respawn-once').exists():
    (folder/'respawn-once').unlink(); child=subprocess.Popen(argv)
   elif (folder/'respawn').exists(): child=subprocess.Popen(argv)
   elif cfg.get('refresh'): break
  time.sleep(.01)
finally:
 if child.poll() is None:
  if cfg['purpose']=='gateway': (Path(cfg['home'])/'stop').touch()
  else:
   try: os.kill(int((Path(cfg['home'])/'backend.pid').read_text()),signal.SIGTERM)
   except (FileNotFoundError,ProcessLookupError): pass
 child.wait(timeout=5)
 (folder/'service.pid').unlink(missing_ok=True)
''')
    (modules / 'backend_retirement.py').write_bytes((AGENT_DIR / 'hermes_cli/backend_retirement.py').read_bytes())
    (modules / 'web_server_idle_proof.py').write_text("import os\nfrom pathlib import Path\ndef idle_proof(): return {'idle': not (Path(os.environ['BACKEND_HOME'])/'busy').exists()}\n")
    (root / 'backend.py').write_text('''import json, os, signal, sys, threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from synthetic_services import publish_pid
home=Path(sys.argv[1]); os.environ['BACKEND_HOME']=str(home)
from hermes_cli.backend_retirement import retirement
cfg=json.loads((home/'backend-config.json').read_text())
legacy_runtime=(home/'refresh-once').exists()
if legacy_runtime: (home/'refresh-once').unlink()
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def reply(self,data,status=200):
  blob=json.dumps(data).encode(); self.send_response(status); self.send_header('Content-Length',str(len(blob))); self.end_headers(); self.wfile.write(blob)
 def do_GET(self):
  with (home/'get-requests.jsonl').open('a') as log: log.write(json.dumps(dict(pid=os.getpid(),legacy=legacy_runtime,path=self.path))+chr(10))
  if (home/'refuse-auth').exists(): self.reply({},401); return
  missing=legacy_runtime or (home/'missing-identity').exists()
  if self.path=='/openapi.json':
   paths={'/api/sessions':{'get':{}}}
   if not missing: paths['/api/host/identity']={'get':{}}
   if not legacy_runtime and not (home/'missing-retirement').exists(): paths['/api/health/retirement']={'post':{}}
   self.reply({'openapi':'3.1.0','paths':paths}); return
  if self.path.startswith('/api/sessions'):
   if self.headers.get('Authorization')!='Bearer synthetic-local-token': self.reply({},401); return
   self.reply({'sessions':[]}); return
  if missing: self.reply({},404); return
  self.reply({'ok':True,'role':'serve','pid':os.getpid() if not (home/'foreign-listener').exists() else 1})
 def do_POST(self):
  if legacy_runtime or (home/'missing-retirement').exists(): self.reply({},404); return
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  with (home/'retirement-actions').open('a') as log: log.write(body['action']+'\\n')
  self.reply(retirement.prepare() if body['action']=='prepare' else getattr(retirement,body['action'])(body.get('token')))
server=ThreadingHTTPServer(('127.0.0.1',cfg['port']),Handler)
publish_pid(home/'backend.pid')
def stop(*_):
 with (home/'signals').open('a') as log: log.write('TERM'+chr(10))
 if not (home/'slow-stop').exists(): threading.Thread(target=server.shutdown,daemon=True).start()
signal.signal(signal.SIGTERM,stop)
try: server.serve_forever(poll_interval=.02)
finally: server.server_close(); (home/'backend.pid').unlink(missing_ok=True)
''')
    protocol = {
      'process_identity': '''from synthetic_services import *
def _ledger_path(): return HOME/'ledger.json'
def _read_ledger(path): return ledger()
def install_id(root): return 'synthetic-install'
def _pid_alive_matches(pid,ct,**kw): return alive(pid,ct)
''',
      'gateway': '''from synthetic_services import *
def _launchd_print_service_pid(domain,label):
 pid=service_pid(label)
 return pid is not None,pid
def _launchctl_bootstrap(domain,plist,label): start(label)
def _is_pid_ancestor_of_current_process(pid): return False
''',
      'main_dashboard': '''from synthetic_services import *
def _launchd_plist_dirs(): return [('agent',HOME/'plists')]
def _loaded_launchd_backend_jobs(): return [('gui/12345',c['label'],['hermes',c['purpose']],service_pid(c['label'])) for c in services() if c['purpose']!='gateway' and c['manager']=='launchd' and service_pid(c['label'])]
def _launchd_job_owning_backend(pid,cmdline,jobs,ancestors=()): return next(((d,l,p) for d,l,a,p in jobs if p in ancestors),None)
def _get_systemd_service_for_pid(pid): return next((c['label'] for c in services() if c['manager']=='systemd' and service_pid(c['label'])==pid),None)
def _get_pid_cgroup_path(pid): return 'synthetic-user-cgroup'
def _extract_scope_from_cgroup(cgroup): return 'user'
''',
      'dashboard_procs': '''from synthetic_services import ledger, services
def _hermes_home_for_pid(pid): return next((c['home'] for r in ledger() for c in services() if r['pid']==pid and c['purpose']==r['purpose'] and c.get('port')==r.get('port')),None)
def _pid_environ(pid): return {'HERMES_DASHBOARD_SESSION_TOKEN':'synthetic-local-token'}
''',
      'update_receipt': '''from pathlib import Path
from synthetic_services import services
def _profile_homes(): return list({(c['profile'],Path(c['home'])) for c in services()})
''',
      'update_inventory': 'def _is_desktop_ssh_ledger_entry(row): return False\ndef _serve_unit_matches_profile(profile,unit): return True\n',
      'update_fleet_scope': '''from synthetic_services import *
def systemd_unit_hermes_home(cmd,unit): return next(c['home'] for c in services() if c['label']==unit)
''',
      'update_cmd_fleet': '''from synthetic_services import *
from types import SimpleNamespace
def _unit_main_pid(cmd,unit): return service_pid(unit)
def _systemctl(argv,**kw):
 args=[a for a in argv if a not in ('systemctl','--user')]; verb,unit=args[:2]
 if verb=='cat': out=(HOME/'services'/unit/'config.json').read_text()
 elif verb=='show': out='active' if service_pid(unit) else 'inactive'
 elif verb=='start': start(unit); out=''
 elif verb=='stop': stop(unit); out=''
 else: raise AssertionError(argv)
 return SimpleNamespace(returncode=0,stdout=out,stderr='')
''',
      'update_cmd_posix_pause': '''from synthetic_services import *
def _empty_token(): return {'platform':'posix','resume_needed':False,'profiles':{},'unmapped':[],'posix_units':[]}
def _discover_systemd(): return []
def _discover_launchd(): return [dict(kind='launchd',domain='gui/12345',label=c['label'],plist=str(HOME/'plists'/(c['label']+'.plist')),pid=service_pid(c['label']),home=c['home']) for c in services() if c['purpose']=='gateway' and service_pid(c['label'])]
def _left_running(units,jobs): return units,jobs,[]
def _home_of(pid): return next((r['hermes_home'] for r in ledger() if r['pid']==pid),str(HOME))
def _discover_bare(excluded): return [],[f"gateway PID {r['pid']} is supervised" for r in ledger() if r['purpose']=='gateway' and r['pid'] not in excluded]
def _ask_to_drain(entry): (Path(entry['home'])/'pause').touch(); return True
def _gateway_on_home(home,exclude):
 try: pid=int((Path(home)/'active').read_text())
 except FileNotFoundError: return None
 return pid if alive(pid) and pid not in exclude else None
def _drain_budget(): return 4
def _alive(pid,ct): return alive(pid,ct)
def _manage_cmd(scope): return ['systemctl','--user']
def _disarm(entry):
 label=entry.get('label') or entry['unit']
 if label.startswith('synthetic.gateway') and (HOME/'hold-disarm').exists():
  (HOME/'gateway-disarm-requested').touch()
  while (HOME/'hold-disarm').exists(): time.sleep(.01)
 stop(label)
''',
      'update_cmd_windows': '''from synthetic_services import *
def _resume_windows_gateways_after_update(token):
 for entry in token.get('posix_units',[]): start(entry['label'])
 token['posix_units']=[]; token['resume_needed']=False
''',
      '_parser': 'def command_argv(argv): return argv\n',
      '_early_recovery': "def interrupted_pull_marker(root): return root/'.interrupted'\n",
    }
    for name, content in protocol.items():
        (modules / (name + '.py')).write_text(content)
    if readiness is not None or stop_seconds is not None:
        (modules / 'main.py').write_text('from talaria_sidecar import agent_services\n' + (f'agent_services.READY_SECONDS={readiness!r}\n' if readiness is not None else '') + (f'agent_services.STOP_SECONDS={stop_seconds!r}\n' if stop_seconds is not None else ''))
    if dependency_sync:
        (modules / 'venv_sync.py').write_text("import json\nfrom synthetic_services import HOME\nwith (HOME/'sync-runs').open('a') as f: f.write('sync'+chr(10))\nprint(json.dumps({'ok':not (HOME/'fail-sync').exists()}))\n")
    (root / 'gateway/status.py').write_text('''from synthetic_services import birth, alive
from pathlib import Path
def get_process_start_time(pid): return birth(pid)
def _pid_exists(pid): return alive(pid)
def get_running_pid_identity_strict(path):
 try: pid=int((Path(path).parent/'active').read_text())
 except FileNotFoundError: return None
 ct=birth(pid)
 return (pid,ct) if ct is not None else None
''')
    (root / 'gateway/host_rendezvous.py').write_text("ROLE_SERVE='serve'\ndef read_record(role): return None\n")
    (root / 'hermes_constants.py').write_text("import os\nfrom pathlib import Path\ndef get_default_hermes_root(): return Path(os.environ['HERMES_HOME'])\n")
    for name in ['update_pause_record.py', 'update_cmd_pause_gate.py']:
        (modules / name).write_bytes((AGENT_DIR / 'hermes_cli' / name).read_bytes())
    with (modules / 'update_lock.py').open('a') as file:
        file.write('''
from synthetic_services import birth, alive
def process_create_time(pid): return birth(pid)
def incarnation_live(pid,ct):
 if isinstance(ct,str) and ct.startswith('ct:'): ct=float(ct[3:])
 return alive(pid,ct)
def _try_lock(fd):
 try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB); return True
 except OSError: return False
def _unlock(fd): fcntl.flock(fd,fcntl.LOCK_UN)
def holds_checkout_lock(root): return FD is not None
def update_in_progress(root): return FD is not None
def acquire_checkout(self,root):
 if FD is not None and os.fstat(FD).st_ino==os.fstat(self.file.fileno()).st_ino: return True
 return self.acquire()
UpdateLock.acquire_checkout=acquire_checkout
''')
    with (modules / 'update_custody.py').open('a') as file:
        file.write('\ndef run_git(command,args,**kw): return subprocess.run([*command,*args],**kw)\n')
    import plistlib
    import socket
    sockets, configs = [], []
    (home / 'services').mkdir()
    (home / 'plists').mkdir()
    for i in range(dashboards + 1):
        if i == 0 and not gateways:
            continue
        purpose = 'gateway' if i == 0 else 'dashboard'
        label = f'synthetic.{purpose}.{i}'
        served_home = home if i < 2 else home / 'profiles' / f'profile{i}'
        served_home.mkdir(parents=True, exist_ok=True)
        cfg = dict(label=label, purpose=purpose, depth=depth, home=str(served_home), profile='default' if i < 2 else f'profile{i}', legacy=legacy, refresh=refresh, manager=manager)
        if i:
            listener = socket.socket()
            listener.bind(('127.0.0.1', 0))
            cfg['port'] = listener.getsockname()[1]
            sockets.append(listener)
            (served_home / 'backend-config.json').write_text(json.dumps(cfg))
            if refresh and not (modern_first and i == 1): (served_home / 'refresh-once').touch()
        folder = home / 'services' / label
        folder.mkdir()
        (folder / 'config.json').write_text(json.dumps(cfg))
        (home / 'plists' / (label + '.plist')).write_bytes(plistlib.dumps({'Label': label, 'ProgramArguments': ['hermes', purpose]}))
        configs.append(cfg)
    binary = home / 'bin'
    binary.mkdir()
    (binary / 'launchctl').write_text(f'#!{AGENT_PYTHON}\nimport sys\nfrom pathlib import Path\nsys.path.insert(0,{str(root)!r})\nfrom synthetic_services import start\nif sys.argv[1]=="bootstrap": start(Path(sys.argv[3]).stem)\n')
    (binary / 'launchctl').chmod(0o755)
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'supervised native baseline')
    base = git(root, 'rev-parse', 'HEAD')
    (root / 'VERSION').write_text('target\n')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'target')
    target = git(root, 'rev-parse', 'HEAD')
    git(root, 'reset', '--hard', base)
    for listener in sockets:
        listener.close()
    env = {**os.environ, 'HERMES_HOME': str(home), 'PATH': str(binary) + os.pathsep + os.environ['PATH']}
    supervisors = [subprocess.Popen([AGENT_PYTHON, str(root / 'supervisor.py'), cfg['label']], env=env) for cfg in configs]
    sidecar = None
    try:
        wait_for(lambda: (not gateways or (home / 'active').exists()) and all((Path(c['home']) / 'backend.pid').exists() for c in configs if c['purpose'] != 'gateway'))
        sidecar = SidecarProcess(home, agent_dir=root, python=AGENT_PYTHON, env={'PATH': env['PATH']})
        yield root, home, base, target, sidecar, configs
    finally:
        if sidecar is not None:
            sidecar.close()
        for cfg in configs:
            (home / 'services' / cfg['label'] / 'disarm').touch()
            (Path(cfg['home']) / 'slow-stop').unlink(missing_ok=True)
            if cfg['purpose'] == 'gateway':
                (Path(cfg['home']) / 'stop').touch()
            else:
                with contextlib.suppress(FileNotFoundError, ProcessLookupError):
                    os.kill(int((Path(cfg['home']) / 'backend.pid').read_text()), signal.SIGTERM)
        for proc in supervisors:
            proc.wait(timeout=8)
        wait_for(lambda: not list((home / 'services').glob('*/service.pid')))


def test_wrapped_gateway_and_dashboard_stay_paused_through_source_mutation(tmp_path):
    with supervised_agent(tmp_path) as (root, home, base, target, sidecar, configs):
        begun = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
        assert begun['ok'], begun
        assert not (home / 'active').exists()
        assert not (home / 'backend.pid').exists()
        assert not list((home / 'services').glob('*/service.pid'))
        assert rpc(sidecar, root, 'git', token=begun['token'], args=['merge', '--ff-only', target], timeout_ms=10000)['ok']
        finished = rpc(sidecar, root, 'finish', token=begun['token'])
        assert finished['ok'], finished
        wait_for(lambda: (home / 'active').exists() and (home / 'backend.pid').exists())
        assert not list((home / '.talaria-agent-services').glob('*.json'))
        assert all((home / 'services' / c['label'] / 'starts').read_text().splitlines() == ['start'] for c in configs)


@pytest.mark.parametrize('depth', [0, 2])
def test_direct_and_nested_services_resume_all_profiles_once(tmp_path, depth):
    with supervised_agent(tmp_path, dashboards=2, depth=depth) as (root, home, base, target, sidecar, configs):
        begun = rpc(sidecar, root, 'begin', revision=target, homes=list({c['home'] for c in configs}))
        assert begun['ok'], begun
        finished = rpc(sidecar, root, 'finish', token=begun['token'])
        assert finished['ok'], finished
        assert all((Path(c['home']) / 'backend.pid').exists() for c in configs[1:])
        assert not list((home / '.talaria-agent-services').glob('*.json'))


@pytest.mark.parametrize('mode', ['normal', 'force'])
def test_legacy_backends_hold_source_and_dependency_custody(tmp_path, mode):
    with supervised_agent(tmp_path, dashboards=2, dependency_sync=True, legacy=True) as (root, home, base, target, sidecar, configs):
        begun = rpc(sidecar, root, 'begin', revision=target, homes=list({c['home'] for c in configs}))
        assert begun['ok'], begun
        debt = json.loads(next((home / '.talaria-agent-services').glob('*.json')).read_text())
        assert {(e['home'], e.get('profile')) for e in debt['entries'] if e['purpose'] != 'gateway'} == {
            (c['home'], c['profile']) for c in configs if c['purpose'] != 'gateway'}
        assert not list((home / 'services').glob('*/service.pid'))
        args = ['merge', '--ff-only', target] if mode == 'normal' else ['reset', '--hard', target]
        assert rpc(sidecar, root, 'git', token=begun['token'], args=args, timeout_ms=10000)['ok']
        assert git(root, 'rev-parse', 'HEAD') == target
        assert not any((Path(c['home']) / 'backend.pid').exists() for c in configs[1:])
        assert rpc(sidecar, root, 'sync', token=begun['token'])['ok']
        assert rpc(sidecar, root, 'finish', token=begun['token'])['ok']
        assert all((Path(c['home']) / 'backend.pid').exists() for c in configs[1:])
        assert not list((home / '.talaria-agent-services').glob('*.json'))
        assert all((home / 'services' / c['label'] / 'starts').read_text().splitlines() == ['start'] for c in configs)


@pytest.mark.parametrize('missing', ['identity', 'retirement', 'both'])
def test_unsupported_lifecycle_refuses_shared_lease_before_any_stop(tmp_path, missing):
    with supervised_agent(tmp_path, dashboards=2, dependency_sync=True, legacy=True) as (root, home, base, target, sidecar, configs):
        served = Path(configs[-1]['home'])
        marker = served / ('missing-' + ('identity' if missing == 'both' else missing))
        marker.touch()
        if missing == 'both': (served / 'missing-retirement').touch()
        (served / 'busy').touch()
        (root / 'VERSION').write_text('local edit\n')
        (root / 'untracked').write_text('local work\n')
        (home / 'fail-sync').touch()
        (root / '.git/info/exclude').write_text('__pycache__/\n.native-lock\n')
        original = (root / 'run_agent.py').read_text()
        (root / 'run_agent.py').write_text(original + '# saved work\n')
        git(root, 'stash', 'push', '-m', 'retained work')
        (root / 'run_agent.py').write_text(original + '# local edit\n')
        heads = [git(root, 'rev-parse', 'HEAD'), git(root, 'stash', 'list', '--format=%H'), git(root, 'status', '--porcelain')]
        pids = {c['label']: (home / 'services' / c['label'] / 'service.pid').read_text() for c in configs}
        backends = {c['label']: (Path(c['home']) / 'backend.pid').read_text() for c in configs[1:]}
        for _ in range(2):  # Both update modes share this admission boundary; retries stay read-only.
            result = rpc(sidecar, root, 'begin', revision=target, homes=list({c['home'] for c in configs}))
            assert not result['ok'], result
            assert 'interactive operator confirmation' in result['detail'], result
            assert not result.get('refresh_confirmation')
            assert heads == [git(root, 'rev-parse', 'HEAD'), git(root, 'stash', 'list', '--format=%H'), git(root, 'status', '--porcelain')]
            assert (root / 'run_agent.py').read_text() == original + '# local edit\n'
            assert (root / 'VERSION').read_text() == 'local edit\n'
            assert (root / 'untracked').read_text() == 'local work\n'
            assert (home / 'fail-sync').exists()
            assert all((home / 'services' / c['label'] / 'service.pid').read_text() == pids[c['label']] for c in configs)
            assert all((Path(c['home']) / 'backend.pid').read_text() == backends[c['label']] for c in configs[1:])
            assert not list(home.glob('**/retirement-actions'))
            assert not list((home / 'services').glob('*/starts'))
            assert not list((home / '.talaria-agent-services').glob('*.json'))
        # Owner finishes work and uses the original disposable supervisor to refresh.
        marker.unlink()
        if missing == 'both': (served / 'missing-retirement').unlink()
        (served / 'busy').unlink()
        (home / 'fail-sync').unlink()
        cfg = configs[-1]
        (home / 'services' / cfg['label'] / 'disarm').touch()
        wait_for(lambda: not (home / 'services' / cfg['label'] / 'service.pid').exists())
        env = {**os.environ, 'HERMES_HOME': str(home)}
        subprocess.run([AGENT_PYTHON, '-c', 'from synthetic_services import start; start(' + repr(cfg['label']) + ')'], cwd=root, env=env, check=True)
        wait_for(lambda: (served / 'backend.pid').exists())
        assert (served / 'backend.pid').read_text() != backends[cfg['label']]
        begun = rpc(sidecar, root, 'begin', revision=target, homes=list({c['home'] for c in configs}))
        assert begun['ok'], begun
        finished = rpc(sidecar, root, 'finish', token=begun['token'])
        assert finished['ok'], finished
        assert not list((home / '.talaria-agent-services').glob('*.json'))
        assert all((Path(c['home']) / 'backend.pid').exists() for c in configs[1:])
        assert all((home / 'services' / c['label'] / 'starts').read_text().splitlines() == (['start', 'start'] if c == cfg else ['start']) for c in configs)


@pytest.mark.parametrize('profile', ['default', 'named'])
@pytest.mark.parametrize('metadata', ['omitted', 'empty', 'null', 'modern'])
def test_backend_identity_uses_verified_home_for_admission_and_recovery(supervised_inventory, monkeypatch, profile, metadata):
    import types
    from talaria_sidecar import agent_services as services
    from talaria_sidecar.agent_mutation import _owners
    root, home, pause, identity, rows, parents, modules = supervised_inventory
    pause._discover_launchd = lambda: []
    pause._discover_bare = lambda excluded: ([], [])
    served = home if profile == 'default' else home / 'profiles' / profile
    served.mkdir(parents=True, exist_ok=True)
    alias = root / 'home-link'
    alias.symlink_to(served, target_is_directory=True)
    modules['hermes_cli.update_receipt']._profile_homes = lambda: [('default', home), *([] if profile == 'default' else [(profile, served)])]
    modules['hermes_cli.dashboard_procs']._hermes_home_for_pid = lambda pid: str(alias)
    row = dict(purpose='serve', pid=41004, create_time=410040, host='127.0.0.1', port=9417, argv='hermes serve')
    if metadata != 'omitted':
        row.update(hermes_home={'empty': '', 'null': None, 'modern': str(alias)}[metadata],
                   profile={'empty': '', 'null': None, 'modern': profile}[metadata])
    original = dict(row)
    rows.append(row)
    entry = _owners(root, {served.resolve()}, pause, identity)[0]
    assert (entry['home'], entry['profile']) == (str(served.resolve()), profile)
    assert row == original, 'Agent-owned metadata must not be backfilled'
    records = types.SimpleNamespace(identity=lambda pid: {'ct': pid}, identity_is_live=lambda p: False)
    services.bind_processes(entry, records)
    recovery = services.ServiceRecovery(root, home, records, identity, pause)
    recovery.prepare([entry], {})
    recovery.state['entries'][0]['phase'] = 'stopped'
    calls = []
    monkeypatch.setattr(services, 'backend_request', lambda candidate: calls.append(candidate))
    assert recovery._ready(recovery.state['entries'][0], lambda *args: [(row, True)])
    assert [(c['home'], c['profile']) for c in calls] == [(str(served.resolve()), profile)]
    assert row == original


@pytest.mark.parametrize('unsafe', ['ledger-home', 'ledger-profile', 'live-home', 'unreadable-home', 'unreadable-env',
                                  'missing-birth', 'reused-pid', 'birth-during-home', 'birth-during-supervisor',
                                  'ambiguous-profile', 'ambiguous-supervisor', 'manual', 'desktop', 'isolated', 'updater-ancestor'])
def test_legacy_backend_refuses_conflicting_or_unverified_identity(supervised_inventory, unsafe):
    from talaria_sidecar.agent_mutation import _owners
    root, home, pause, identity, rows, parents, modules = supervised_inventory
    pause._discover_launchd = lambda: []
    pause._discover_bare = lambda excluded: ([], [])
    row = dict(purpose='dashboard', pid=41004, create_time=410040, host='127.0.0.1', port=9417, argv='hermes dashboard')
    rows.append(row)
    procs, dashboard = modules['hermes_cli.dashboard_procs'], modules['hermes_cli.main_dashboard']
    if unsafe == 'ledger-home': row['hermes_home'] = str(root / 'foreign')
    if unsafe == 'ledger-profile': row['profile'] = 'named'
    if unsafe == 'live-home': procs._hermes_home_for_pid = lambda pid: str(root / 'foreign')
    if unsafe == 'unreadable-home': procs._hermes_home_for_pid = lambda pid: None
    if unsafe == 'unreadable-env': procs._pid_environ = lambda pid: None
    if unsafe == 'missing-birth': row.pop('create_time')
    if unsafe == 'reused-pid': identity._pid_alive_matches = lambda *args, **kwargs: False
    if unsafe == 'birth-during-home':
        def observed(pid):
            identity._pid_alive_matches = lambda *args, **kwargs: False
            return str(home)
        procs._hermes_home_for_pid = observed
    if unsafe == 'birth-during-supervisor':
        original = dashboard._loaded_launchd_backend_jobs
        def jobs():
            identity._pid_alive_matches = lambda *args, **kwargs: False
            return original()
        dashboard._loaded_launchd_backend_jobs = jobs
    if unsafe == 'ambiguous-profile': modules['hermes_cli.update_receipt']._profile_homes = lambda: [('default', home), ('alias', home)]
    if unsafe == 'ambiguous-supervisor':
        parents[41003] = 41001
        original = dashboard._loaded_launchd_backend_jobs
        dashboard._loaded_launchd_backend_jobs = lambda: [*original(), ('gui/12345', 'other', ['hermes', 'dashboard'], 41001)]
    if unsafe == 'manual': dashboard._loaded_launchd_backend_jobs = lambda: []
    if unsafe == 'desktop': procs._pid_environ = lambda pid: {'HERMES_DESKTOP': '1', 'HERMES_DASHBOARD_SESSION_TOKEN': 'synthetic'}
    if unsafe == 'isolated': row['isolated'] = True
    if unsafe == 'updater-ancestor': parents[os.getpid()] = 41003
    with pytest.raises(RuntimeError, match='backend|Backend|owns the updater'):
        _owners(root, {home}, pause, identity)


@pytest.mark.parametrize('conflict', ['home', 'profile', 'configuration', 'listener-birth'])
def test_legacy_successor_identity_failure_keeps_recovery_debt(supervised_inventory, monkeypatch, conflict):
    import plistlib
    import types
    from talaria_sidecar import agent_services as services
    from talaria_sidecar.agent_mutation import _owners
    root, home, pause, identity, rows, parents, modules = supervised_inventory
    pause._discover_launchd = lambda: []
    pause._discover_bare = lambda excluded: ([], [])
    row = dict(purpose='dashboard', pid=41004, create_time=410040, host='127.0.0.1', port=9417, argv='hermes dashboard')
    rows.append(row)
    entry = _owners(root, {home}, pause, identity)[0]
    records = types.SimpleNamespace(identity=lambda pid: {'ct': pid}, identity_is_live=lambda p: False,
                                    tree_is_whole=lambda *args: (True, ''))
    services.bind_processes(entry, records)
    recovery = services.ServiceRecovery(root, home, records, identity, pause)
    recovery.prepare([entry], {})
    recovery.state['entries'][0]['phase'] = 'stopped'
    recovery.save()
    if conflict == 'home': modules['hermes_cli.dashboard_procs']._hermes_home_for_pid = lambda pid: str(root / 'foreign')
    if conflict == 'profile': row['profile'] = 'foreign'
    if conflict == 'configuration':
        alternate = root / 'alternate'
        alternate.mkdir()
        data = plistlib.loads(Path(entry['plist']).read_bytes())
        data['EnvironmentVariables'] = {'SYNTHETIC_CHANGED': '1'}
        (alternate / (entry['label'] + '.plist')).write_bytes(plistlib.dumps(data))
        modules['hermes_cli.main_dashboard']._launchd_plist_dirs = lambda: [('agent', alternate)]
    def listener(candidate):
        assert conflict == 'listener-birth', 'unverified identity must never reach the listener'
        identity._pid_alive_matches = lambda *args, **kwargs: False
    monkeypatch.setattr(services, 'backend_request', listener)
    monkeypatch.setattr(services, 'READY_SECONDS', .01)
    with pytest.raises(RuntimeError):
        recovery.resume(lambda *args: [(row, True)])
    assert [e['label'] for e in json.loads(recovery.path.read_text())['entries']] == [entry['label']]


@pytest.mark.parametrize('exit_path', ['finish', 'eof', 'owner-kill'])
@pytest.mark.parametrize('legacy', [False, True])
def test_backend_recovery_covers_lease_exit_paths(tmp_path, exit_path, legacy):
    with supervised_agent(tmp_path, legacy=legacy) as (root, home, base, target, sidecar, configs):
        begun = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
        assert begun['ok'], begun
        if exit_path == 'finish':
            assert rpc(sidecar, root, 'finish', token=begun['token'])['ok']
        elif exit_path == 'eof':
            sidecar.proc.stdin.close()
        else:
            sidecar.proc.kill()
        wait_for(lambda: (home / 'active').exists() and (home / 'backend.pid').exists())
        wait_for(lambda: not list((home / '.talaria-agent-services').glob('*.json')))
        assert not (root / 'VERSION').exists()


def test_partial_pause_restores_only_the_services_it_stopped(tmp_path):
    with supervised_agent(tmp_path, dashboards=2) as (root, home, base, target, sidecar, configs):
        busy_home = Path(configs[2]['home'])
        (busy_home / 'busy').touch()
        before = (busy_home / 'backend.pid').read_text()
        gateway_before = (home / 'active').read_text()
        result = rpc(sidecar, root, 'begin', revision=target, homes=list({c['home'] for c in configs}))
        assert not result['ok'] and 'active work' in result['detail'], result
        wait_for(lambda: (home / 'backend.pid').exists())
        assert (busy_home / 'backend.pid').read_text() == before
        assert (home / 'active').read_text() == gateway_before
        assert not (root / 'VERSION').exists()
        assert not list((home / '.talaria-agent-services').glob('*.json'))
        assert not (home / 'services' / configs[2]['label'] / 'starts').exists()


@pytest.mark.parametrize('legacy', [False, True])
def test_failed_restart_retains_debt_and_a_fresh_sidecar_recovers_it(tmp_path, legacy):
    with supervised_agent(tmp_path, dashboards=2, legacy=legacy) as (root, home, base, target, sidecar, configs):
        begun = rpc(sidecar, root, 'begin', revision=target, homes=list({c['home'] for c in configs}))
        assert begun['ok'], begun
        refused = home / 'services' / configs[1]['label'] / 'fail-start'
        refused.touch()
        finished = rpc(sidecar, root, 'finish', token=begun['token'])
        assert not finished['ok'], finished
        assert configs[1]['label'] in finished['detail'] and 'failed to load' in finished['detail']
        assert list((home / '.talaria-agent-services').glob('*.json'))
        debt = json.loads(next((home / '.talaria-agent-services').glob('*.json')).read_text())
        assert [e['label'] for e in debt['entries']] == [configs[1]['label']]
        assert (Path(configs[2]['home']) / 'backend.pid').exists()
        assert not (home / 'backend.pid').exists()
        refused.unlink()
        sidecar.close()
        with contextlib.closing(SidecarProcess(home, agent_dir=root, python=AGENT_PYTHON, env={'PATH': str(home / 'bin') + os.pathsep + os.environ['PATH']})) as replacement:
            replacement.result('runtime.handshake', {'rpc_version': __import__('talaria_sidecar').SIDECAR_RPC_VERSION}, timeout=30)
            wait_for(lambda: not list((home / '.talaria-agent-services').glob('*.json')))
            assert (home / 'backend.pid').exists(), replacement.stderr_lines
            assert (home / 'active').exists(), replacement.stderr_lines
        wait_for(lambda: (home / 'active').exists() and (home / 'backend.pid').exists())
        assert not list((home / '.talaria-agent-services').glob('*.json'))
        assert (home / 'services' / configs[1]['label'] / 'starts').read_text().splitlines() == ['start']


@pytest.mark.parametrize('legacy', [False, True])
def test_native_and_backend_debt_survive_worker_death_and_unsafe_source(tmp_path, legacy):
    with supervised_agent(tmp_path, legacy=legacy) as (root, home, base, target, sidecar, configs):
        begun = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
        assert begun['ok'], begun
        journal = next(p for p in home.glob('*.json') if 'owner' in json.loads(p.read_text()))
        body = json.loads(journal.read_text())
        os.kill(body['owner']['pid'], signal.SIGKILL)
        interrupted = root / '.interrupted'
        interrupted.touch()
        sidecar.close()
        with contextlib.closing(SidecarProcess(home, agent_dir=root, python=AGENT_PYTHON, env={'PATH': str(home / 'bin') + os.pathsep + os.environ['PATH']})) as replacement:
            replacement.result('runtime.handshake', {'rpc_version': __import__('talaria_sidecar').SIDECAR_RPC_VERSION}, timeout=30)
            wait_for(lambda: any('source/dependency' in line for line in replacement.stderr_lines))
            assert not (home / 'backend.pid').exists()
            assert not (home / 'active').exists()
            assert list((home / '.talaria-agent-services').glob('*.json'))
            interrupted.unlink()
            replacement.result('runtime.handshake', {'rpc_version': __import__('talaria_sidecar').SIDECAR_RPC_VERSION}, timeout=30)
            wait_for(lambda: not list((home / '.talaria-agent-services').glob('*.json')))
            assert (home / 'active').exists() and (home / 'backend.pid').exists(), replacement.stderr_lines
        wait_for(lambda: (home / 'active').exists() and (home / 'backend.pid').exists())
        assert not list((home / '.talaria-agent-services').glob('*.json'))


def test_backend_debt_closes_new_agent_admission(tmp_path):
    from talaria_sidecar.runtime import AgentRuntime, AgentRuntimeStale
    from talaria_sidecar.agent_services import recovery_path
    root, home = tmp_path / 'agent', tmp_path / 'home'
    root.mkdir(); home.mkdir()
    runtime = AgentRuntime(home, root)
    file = recovery_path(root, home)
    file.parent.mkdir()
    file.write_text('{}')
    with pytest.raises(AgentRuntimeStale, match='recovery is incomplete'):
        runtime.ensure_current()


def test_backend_stop_ack_does_not_authorize_mutation_or_force_kill(supervised_inventory, monkeypatch):
    import threading
    import types
    from talaria_sidecar import agent_services as services
    from talaria_sidecar.agent_mutation import _owners
    root, home, pause, identity, rows, parents, modules = supervised_inventory
    pause._discover_launchd = lambda: []
    pause._discover_bare = lambda excluded: ([], [])
    rows.append(dict(purpose='dashboard', pid=41004, create_time=1, hermes_home=str(home), profile='default', host='127.0.0.1', port=9417, argv='hermes dashboard'))
    entry = _owners(root, {home}, pause, identity)[0]
    records = types.SimpleNamespace(identity=lambda pid: {'ct': pid}, identity_is_live=lambda p: True)
    services.bind_processes(entry, records)
    recovery = services.ServiceRecovery(root, home, records, identity, pause)
    recovery.prepare([entry], {})
    signals, disarmed = [], []
    monkeypatch.setattr(services, 'STOP_SECONDS', .01)
    monkeypatch.setattr(services, 'backend_request', lambda entry, action=None, permit=None: {'ok': True, 'idle': True, 'token': 'synthetic-permit'})
    monkeypatch.setattr(services.os, 'kill', lambda pid, sig: signals.append((pid, sig)))
    pause._disarm = lambda entry: disarmed.append(entry)
    with pytest.raises(RuntimeError, match='graceful stop has not completed'):
        recovery.stop(entry, threading.Event())
    assert signals == [(41004, signal.SIGTERM)]
    assert disarmed == []
    assert json.loads(recovery.path.read_text())['entries'][0]['phase'] == 'retiring'


def test_wrong_listener_never_discharges_backend_debt(supervised_inventory, monkeypatch):
    import threading
    import types
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from talaria_sidecar import agent_services as services
    from talaria_sidecar.agent_mutation import _owners
    root, home, pause, identity, rows, parents, modules = supervised_inventory
    class Foreign(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_GET(self):
            self.send_response(200); self.end_headers(); self.wfile.write(b'{"ok":true,"pid":1,"role":"serve"}')
    server = ThreadingHTTPServer(('127.0.0.1', 0), Foreign)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        pause._discover_launchd = lambda: []
        pause._discover_bare = lambda excluded: ([], [])
        row = dict(purpose='dashboard', pid=41004, create_time=1, hermes_home=str(home), profile='default', host='127.0.0.1', port=server.server_port, argv='hermes dashboard')
        rows.append(row)
        entry = _owners(root, {home}, pause, identity)[0]
        records = types.SimpleNamespace(identity=lambda pid: {'ct': pid}, identity_is_live=lambda p: False, tree_is_whole=lambda token, root: (True, ''))
        services.bind_processes(entry, records)
        recovery = services.ServiceRecovery(root, home, records, identity, pause)
        recovery.prepare([entry], {})
        recovery.state['entries'][0]['phase'] = 'stopped'
        recovery.save()
        monkeypatch.setattr(services, 'READY_SECONDS', .01)
        monkeypatch.setattr(services, '_auth', lambda entry: 'synthetic-local-token')
        with pytest.raises(RuntimeError, match='readiness is unverified'):
            recovery.resume(lambda root, identity: [(row, True)])
        assert len(json.loads(recovery.path.read_text())['entries']) == 1
    finally:
        server.shutdown(); server.server_close(); worker.join()


def test_supervised_dashboard_without_gateway_recovers(tmp_path):
    with supervised_agent(tmp_path, gateways=False) as (root, home, base, target, sidecar, configs):
        begun = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
        assert begun['ok'], begun
        assert not (home / 'backend.pid').exists()
        finished = rpc(sidecar, root, 'finish', token=begun['token'])
        assert finished['ok'], finished
        assert (home / 'backend.pid').exists()


@pytest.mark.parametrize('legacy', [False, True])
def test_dependency_failure_keeps_both_services_stopped_until_repair(tmp_path, legacy):
    with supervised_agent(tmp_path, dependency_sync=True, legacy=legacy) as (root, home, base, target, sidecar, configs):
        begun = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
        assert begun['ok'], begun
        assert rpc(sidecar, root, 'git', token=begun['token'], args=['merge', '--ff-only', target], timeout_ms=10000)['ok']
        (home / 'fail-sync').touch()
        assert not rpc(sidecar, root, 'sync', token=begun['token'])['ok']
        assert not rpc(sidecar, root, 'finish', token=begun['token'])['ok']
        assert not (home / 'backend.pid').exists() and not (home / 'active').exists()
        debt = next((home / '.talaria-agent-services').glob('*.json'))
        assert json.loads(debt.read_text())['sync_failed']
        assert 'synthetic-local-token' not in debt.read_text()
        (home / 'fail-sync').unlink()
        retried = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
        assert retried['ok'], retried
        assert rpc(sidecar, root, 'sync', token=retried['token'])['ok']
        finished = rpc(sidecar, root, 'finish', token=retried['token'])
        assert finished['ok'], finished
        wait_for(lambda: (home / 'backend.pid').exists() and (home / 'active').exists())
        assert not debt.exists()


@pytest.mark.parametrize('named', [False, True])
@pytest.mark.parametrize('source', ['dotenv', 'config', 'exec'])
def test_native_gated_dashboard_accepts_owner_local_retirement_session(tmp_path, named, source):
    from conftest import AGENT_PYTHON, isolated_env, SIDECAR_ROOT
    home = tmp_path / 'home'
    home.mkdir()
    script = '''import os
from pathlib import Path
from unittest.mock import Mock, patch
from plugins.dashboard_auth import basic
from hermes_cli.dashboard_auth import registry
from hermes_cli import dashboard_procs
from hermes_cli import web_server
from hermes_cli import web_server_idle_proof
from hermes_cli.backend_retirement import retirement
from talaria_sidecar import agent_services as services
from hermes_cli.env_loader import load_hermes_dotenv
from fastapi.testclient import TestClient
secret='synthetic-native-signing-key-for-this-test-only'
launch=Path(os.environ['HERMES_HOME'])
home=launch/'profiles'/'named' if os.environ['NAMED']=='1' else launch
home.mkdir(parents=True,exist_ok=True)
keys={'HERMES_DASHBOARD_BASIC_AUTH_USERNAME':'synthetic-owner','HERMES_DASHBOARD_BASIC_AUTH_SECRET':secret}
source=os.environ['SOURCE']
if source=='config':
 (home/'config.yaml').write_text('dashboard:\\n  basic_auth:\\n    username: synthetic-owner\\n    secret: '+secret+'\\n')
else:
 (home/'.env').write_text('\\n'.join(k+'="'+v+'" # owner credential' for k,v in keys.items())+'\\n')
from hermes_constants import set_hermes_home_override,reset_hermes_home_override
override=set_hermes_home_override(home)
try:
 load_hermes_dotenv(hermes_home=home)
 os.environ['HERMES_DASHBOARD_BASIC_AUTH_PASSWORD']='disposable-password'
 provider=basic.BasicAuthProvider(**basic._settings())
finally:
 reset_hermes_home_override(override)
if source=='exec': (home/'.env').unlink()
for key in (*keys,'HERMES_DASHBOARD_BASIC_AUTH_PASSWORD'): os.environ.pop(key,None)
registry._providers.clear(); registry._scoped_providers.clear()
registry.register_global_provider(provider)
web_server.app.state.auth_required=True
web_server.app.state.bound_host='127.0.0.1'
dashboard_procs._pid_environ=lambda pid: keys if source=='exec' else {}
web_server_idle_proof.idle_proof=lambda: {'idle':True}
before=dict(os.environ)
token=services._local_session({'pid':os.getpid(),'home':str(home)})
assert token and provider.verify_session(access_token=token) is not None, 'owner dotenv session was not authenticated'
client=TestClient(web_server.app,base_url='http://127.0.0.1')
connection=Mock()
requests=[]
def request(method,path,body,headers):
 assert path in {'/api/host/identity','/api/health/retirement','/openapi.json'}
 assert 'disposable-password' not in str(headers) and secret not in str(headers)
 response=client.request(method,path,content=body,headers=headers)
 requests.append((method,path,response.status_code))
 connection.getresponse.return_value=Mock(status=response.status_code,read=lambda limit: response.content)
connection.request.side_effect=request
services.http.client.HTTPConnection=lambda *a,**kw: connection
services._auth=lambda entry: ''
entry=dict(pid=os.getpid(),home=str(home),host='127.0.0.1',port=12345,label='synthetic.dashboard')
assert services.backend_request(entry)['pid']==os.getpid()
assert requests==[('GET','/api/host/identity',401),('GET','/api/host/identity',200),('GET','/openapi.json',200)],requests
assert dict(os.environ)==before, 'lifecycle auth changed the updater environment'
headers={'Authorization':'Bearer '+token}
identity=client.get('/api/host/identity',headers=headers)
assert identity.status_code==200, identity.text
assert identity.json()['pid']==os.getpid()
assert retirement.acquire()
assert client.post('/api/health/retirement',headers=headers,json={'action':'prepare'}).json()['ok'] is False
retirement.release()
if source=='dotenv':
 owed=dict(entry,kind='launchd',domain='synthetic',purpose='dashboard',profile='named' if os.environ['NAMED']=='1' else 'default',
           phase='recorded',config_stamp='synthetic',processes={})
 recovery=services.ServiceRecovery(home,home,Mock(),Mock(),Mock())
 recovery.state.update(entries=[owed],tree={'baselines':[{'synthetic':True}]})
 recovery.save()
 ledger=lambda *a: [(dict(owed,create_time=1),True)]
 with patch.object(services,'_config_stamp',return_value='synthetic'), patch.object(services,'backend_entry',return_value=owed), \\
      patch.object(services,'bind_processes'), patch.object(services,'verify_processes'), patch.object(services,'READY_SECONDS',0):
  recovery.identity._pid_alive_matches.return_value=True
  assert recovery._ready(owed,ledger), 'recovery must authenticate with the same owner credentials'
  original=(home/'.env').read_text()
  for invalid in ('HERMES_DASHBOARD_BASIC_AUTH_USERNAME=synthetic-owner\\nHERMES_DASHBOARD_BASIC_AUTH_SECRET=wrong synthetic signing key!\\n',''):
   (home/'.env').write_text(invalid)
   try: recovery._wait_ready(owed,ledger)
   except RuntimeError as error:
    assert 'recovery remains owed' in str(error)
    assert all(value not in str(error) for value in (secret,token,'disposable-password'))
   else: raise AssertionError('invalid credentials cleared recovery debt')
   assert recovery.path.exists()
   assert all(value not in recovery.path.read_text() for value in (secret,token,'disposable-password'))
  (home/'.env').write_text(original)
  recovery._wait_ready(owed,ledger)
  assert not recovery.path.exists(), 'retry must clear only authenticated recovery debt'
permit=services.backend_request(entry,'prepare')
assert permit['ok'] and permit['idle']
assert services.backend_request(entry,'cancel',permit['token'])['ok']
permit=services.backend_request(entry,'prepare')
assert services.backend_request(entry,'commit',permit['token'])['ok']
assert dict(os.environ)==before
assert not retirement.acquire()
print('native gated retirement accepted; active work preserved')
'''
    env = isolated_env(home, PYTHONPATH=str(SIDECAR_ROOT) + os.pathsep + str(AGENT_DIR), HERMES_DISABLE_LAZY_INSTALLS='1',
                       NAMED='1' if named else '0', SOURCE=source)
    result = subprocess.run([AGENT_PYTHON, '-c', script], cwd=AGENT_DIR, env=env, capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr[-5000:]
    assert 'native gated retirement accepted' in result.stdout


def test_native_lifecycle_credentials_are_scoped_and_preserve_decoding(tmp_path):
    from conftest import isolated_env, SIDECAR_ROOT
    home = tmp_path / 'home'
    home.mkdir()
    script = r'''import base64, os, threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from plugins.dashboard_auth import basic
from hermes_cli import dashboard_procs, env_loader
from agent.secret_scope import current_secret_scope
from talaria_sidecar import agent_services as services
from talaria_sidecar.home import scoped_home
root=Path(os.environ['HERMES_HOME'])
prefix='HERMES_DASHBOARD_BASIC_AUTH_'
env={}
dashboard_procs._pid_environ=lambda pid: env
def files(home, values, config=''):
 home.mkdir(parents=True,exist_ok=True)
 (home/'.env').write_text('\n'.join(prefix+k+'='+v for k,v in values.items())+'\n')
 (home/'config.yaml').write_text(config)
def session(home): return services._local_session(dict(pid=os.getpid(),home=str(home)))
def check(home, raw, username='owner'):
 # Use the native resolver only to establish the reference key, outside concurrent calls.
 with patch.dict(os.environ,{prefix+'SECRET':raw}): key=basic._resolve_secret({})
 token=session(home)
 payload=basic._unsign(token,key,'access') if token else None
 assert payload and payload['sub']==username, 'owner credential resolution disagrees with native auth'
 return key
raws=['short!', 'synthetic signing key with spaces!',base64.b64encode(b'base64 synthetic key only').decode(),b'hex synthetic key only'.hex()]
for raw in raws:
 files(root,{'USERNAME':'"owner"','SECRET':'"'+raw+'"'})
 check(root,raw)
# Empty dotenv values fall through to the native config; nonempty exec values take precedence.
config='dashboard:\n  basic_auth:\n    username: config-owner\n    secret: config synthetic signing key!\n'
files(root,{'USERNAME':'""','SECRET':"''"},config)
check(root,'config synthetic signing key!','config-owner')
env.update({prefix+'USERNAME':' exec-owner ',prefix+'SECRET':' exec synthetic signing key! '})
check(root,'exec synthetic signing key!','exec-owner')
env.clear()
files(root,{'USERNAME':'owner','SECRET':'synthetic scope-only signing key!'})
env_loader._SECRET_SOURCE_VALUES_BY_HOME[str(root.resolve())]={prefix+'SECRET':'file-backed external signing key!'}
env_loader._APPLIED_HOMES.add(str(root.resolve()))
check(root,'file-backed external signing key!')
env_loader.reset_secret_source_cache(root)
# Updater launch credentials must never fill a missing owner field, even for the launch home.
os.environ.update({prefix+'USERNAME':'updater',prefix+'SECRET':'updater synthetic signing key!'})
files(root,{},'dashboard:\n  basic_auth:\n    username: owner\n    secret: ${HERMES_DASHBOARD_BASIC_AUTH_SECRET}\n')
with patch.dict(os.environ,{prefix+'SECRET':'updater synthetic signing key!'}): updater_key=basic._resolve_secret({})
token=session(root)
assert token is None or basic._unsign(token,updater_key,'access') is None, 'config interpolation leaked the updater signing key'
files(root,{'ALIAS':'"profile alias synthetic signing key!"'},
      'dashboard:\n  basic_auth:\n    username: owner\n    secret: ${HERMES_DASHBOARD_BASIC_AUTH_ALIAS}\n')
check(root,'profile alias synthetic signing key!')
for values in ({},{'USERNAME':'owner'},{'SECRET':'synthetic scope-only signing key!'}):
 files(root,values)
 assert session(root) is None, 'updater credentials leaked into an owner session'
(root/'.env').unlink()
assert session(root) is None
(root/'.env').mkdir()
assert session(root) is None, 'unreadable dotenv must not use updater credentials'
(root/'.env').rmdir()
dashboard_procs._pid_environ=lambda pid: None
files(root,{'USERNAME':'owner','SECRET':'synthetic scope-only signing key!'})
assert session(root) is None, 'unreadable process identity must refuse file credentials'
dashboard_procs._pid_environ=lambda pid: {}
homes=[root/'profiles'/name for name in ('first','second')]
keys=[]
for i,home in enumerate(homes):
 raw='profile '+str(i)+' synthetic signing key!'
 files(home,{'USERNAME':'owner'+str(i),'SECRET':'"'+raw+'"'})
 keys.append(check(home,raw,'owner'+str(i)))
before=dict(os.environ)
outer=current_secret_scope()
barrier=threading.Barrier(2)
with ThreadPoolExecutor(2) as pool:
 # Both profiles resolve repeatedly with different keys in the same process.
 def resolve(i):
  with scoped_home(homes[i]):
   scope=current_secret_scope()
   barrier.wait(timeout=10)
   for _ in range(10):
    token=session(homes[i])
    assert basic._unsign(token,keys[i],'access')['sub']=='owner'+str(i)
    assert basic._unsign(token,keys[1-i],'access') is None
    assert current_secret_scope() is scope
 list(pool.map(resolve,range(2)))
for failure in (RuntimeError,KeyboardInterrupt):
 with scoped_home(homes[0]):
  scope=current_secret_scope()
  try:
   with patch.object(basic,'_sign',side_effect=failure('synthetic failure')): session(homes[0])
  except failure: pass
  else: raise AssertionError('expected signing failure')
  assert current_secret_scope() is scope
assert current_secret_scope() is outer
assert dict(os.environ)==before, 'credential resolution changed process environment'
print('native credential precedence, decoding, isolation and cleanup verified')
'''
    env = isolated_env(home, PYTHONPATH=str(SIDECAR_ROOT) + os.pathsep + str(AGENT_DIR), HERMES_DISABLE_LAZY_INSTALLS='1')
    result = subprocess.run([AGENT_PYTHON, '-c', script], cwd=AGENT_DIR, env=env, capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr[-5000:]
    assert 'native credential precedence, decoding, isolation and cleanup verified' in result.stdout


@pytest.mark.parametrize('legacy', [False, True])
def test_supervisor_respawn_refuses_mutation_and_recovery_adopts_its_successor(tmp_path, legacy):
    with supervised_agent(tmp_path, legacy=legacy) as (root, home, base, target, sidecar, configs):
        service = home / 'services' / configs[1]['label']
        (service / 'respawn').touch()
        result = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
        assert not result['ok'], result
        assert not (root / 'VERSION').exists()
        assert 'descendant' in result['detail'] or 'identity/ancestry' in result['detail'], result
        sidecar.close()
        with contextlib.closing(SidecarProcess(home, agent_dir=root, python=AGENT_PYTHON, env={'PATH': str(home / 'bin') + os.pathsep + os.environ['PATH']})) as replacement:
            replacement.result('runtime.handshake', {'rpc_version': __import__('talaria_sidecar').SIDECAR_RPC_VERSION}, timeout=30)
            wait_for(lambda: not list((home / '.talaria-agent-services').glob('*.json')))
            assert (home / 'backend.pid').exists(), replacement.stderr_lines
        assert not list((home / '.talaria-agent-services').glob('*.json'))
        assert not (service / 'starts').exists(), 'a verified supervisor successor must be adopted, never started again'


def test_stopped_dashboard_is_never_started_by_an_update(tmp_path):
    with supervised_agent(tmp_path) as (root, home, base, target, sidecar, configs):
        service = home / 'services' / configs[1]['label']
        (service / 'disarm').touch()
        wait_for(lambda: not (service / 'service.pid').exists())
        begun = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
        assert begun['ok'], begun
        assert rpc(sidecar, root, 'finish', token=begun['token'])['ok']
        assert not (home / 'backend.pid').exists()
        assert not (service / 'starts').exists()


def test_crash_after_wrapped_gateway_drain_finishes_the_supervisor_obligation_once(tmp_path):
    with supervised_agent(tmp_path) as (root, home, base, target, sidecar, configs):
        (home / 'hold-disarm').touch()
        sidecar.request('runtime.agent_mutation', {'agent_dir': str(root), 'action': 'begin', 'revision': target, 'homes': [str(home)]})
        wait_for(lambda: (home / 'gateway-disarm-requested').exists())
        assert not (home / 'active').exists()
        assert (home / 'services' / configs[0]['label'] / 'service.pid').exists()
        journal = next(p for p in home.glob('*.json') if 'owner' in json.loads(p.read_text()))
        body = json.loads(journal.read_text())
        debt = json.loads(next((home / '.talaria-agent-services').glob('*.json')).read_text())
        entry = next(e for e in debt['entries'] if e['purpose'] == 'gateway')
        assert body['token']['posix_units'] == [], 'the native reader must not independently replay this supervisor'
        assert str(entry['service_pid']) in map(str, body['token']['stop_sent'])
        assert str(entry['pid']) in map(str, body['token']['stop_sent'])
        os.kill(body['owner']['pid'], signal.SIGKILL)
        (home / 'hold-disarm').unlink()
        sidecar.close()
        with contextlib.closing(SidecarProcess(home, agent_dir=root, python=AGENT_PYTHON, env={'PATH': str(home / 'bin') + os.pathsep + os.environ['PATH']})) as replacement:
            replacement.result('runtime.handshake', {'rpc_version': __import__('talaria_sidecar').SIDECAR_RPC_VERSION}, timeout=45)
            wait_for(lambda: not list((home / '.talaria-agent-services').glob('*.json')))
            assert (home / 'active').exists() and (home / 'backend.pid').exists(), replacement.stderr_lines
        assert not list((home / '.talaria-agent-services').glob('*.json'))
        assert all((home / 'services' / c['label'] / 'starts').read_text().splitlines() == ['start'] for c in configs)


def test_native_wrapper_pid_cannot_clear_gateway_readiness_debt(tmp_path):
    with supervised_agent(tmp_path, readiness=.05) as (root, home, base, target, sidecar, configs):
        begun = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
        assert begun['ok'], begun
        service = home / 'services' / configs[0]['label']
        (service / 'wrapper-only').touch()
        finished = rpc(sidecar, root, 'finish', token=begun['token'])
        assert not finished['ok'] and 'readiness is unverified' in finished['detail'], finished
        assert (service / 'service.pid').exists()
        assert not (home / 'active').exists()
        retained = next((home / '.talaria-agent-services').glob('*.json'))
        assert any(e['purpose'] == 'gateway' for e in json.loads(retained.read_text())['entries'])
        assert (home / 'backend.pid').exists(), 'a failed gateway must not strand a safe dashboard sibling'


def test_loaded_service_is_never_booted_out_or_bootstrapped_again(supervised_inventory, monkeypatch):
    from talaria_sidecar import agent_services as services
    from talaria_sidecar.agent_mutation import _owners
    root, home, pause, identity, rows, parents, modules = supervised_inventory
    pause._discover_launchd = lambda: []
    pause._discover_bare = lambda excluded: ([], [])
    rows.append(dict(purpose='dashboard', pid=41004, create_time=1, hermes_home=str(home), profile='default', host='127.0.0.1', port=9417, argv='hermes dashboard'))
    entry = _owners(root, {home}, pause, identity)[0]
    entry['config_stamp'] = services._config_stamp(entry)
    calls = []
    monkeypatch.setattr(services, '_service_pid', lambda entry: (True, 41003))
    monkeypatch.setattr(subprocess, 'run', lambda argv, **kwargs: (calls.append(argv), subprocess.CompletedProcess(argv, 0, '', ''))[1])
    services._start(entry, pause)
    assert calls == [['launchctl', 'kickstart', 'gui/12345/synthetic.dashboard']]


def test_unavailable_backend_auth_refuses_before_stops_or_recovery_intent(tmp_path):
    with supervised_agent(tmp_path) as (root, home, base, target, sidecar, configs):
        gateway = (home / 'active').read_text()
        backend = (home / 'backend.pid').read_text()
        (home / 'refuse-auth').touch()
        result = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
        assert not result['ok'] and configs[1]['label'] in result['detail'] and 'HTTP 401' in result['detail'], result
        assert (home / 'active').read_text() == gateway
        assert (home / 'backend.pid').read_text() == backend
        assert not list((home / '.talaria-agent-services').glob('*.json'))
        assert not (root / 'VERSION').exists()


def test_service_recovery_keeps_handshake_responsive_and_admission_closed(tmp_path, monkeypatch):
    import threading
    from talaria_sidecar import agent_mutation, agent_services
    from talaria_sidecar.runtime import AgentRuntime, AgentRuntimeStale
    root, home = tmp_path / 'agent', tmp_path / 'home'
    root.mkdir(); home.mkdir()
    runtime = AgentRuntime(home, root)
    file = agent_services.recovery_path(root, home)
    file.parent.mkdir(); file.write_text('{}')
    entered, release = threading.Event(), threading.Event()
    calls = []
    def recover(*args, **kwargs):
        calls.append(args)
        entered.set()
        release.wait(2)
        file.unlink()
        return subprocess.CompletedProcess(args, 0, '{"ok":true}', '')
    monkeypatch.setattr(subprocess, 'run', recover)
    try:
        agent_mutation.recover_retained(runtime)
        assert entered.wait(1)
        assert file.exists(), 'handshake must return while retained service recovery still owns admission'
        with pytest.raises(AgentRuntimeStale, match='recovery is incomplete'):
            runtime.ensure_current()
        agent_mutation.recover_retained(runtime)
        assert len(calls) == 1, 'concurrent handshakes must share one recovery worker'
    finally:
        release.set()
        wait_for(lambda: not file.exists())
    runtime.ensure_current()


@pytest.mark.parametrize('case,unsupported', [
    ('missing-identity', True), ('missing-both', True), ('missing-retirement', True),
    ('auth-401', False), ('auth-403', False), ('generic-404', False), ('public-sessions', False),
    ('bad-credential', False), ('bad-schema', False), ('malformed-identity', False),
    ('mismatched-identity', False), ('changing-identity', False), ('transient-503', False),
    ('unreachable', False), ('native-session', True), ('retirement-post', True), ('schema-unavailable', False), ('malformed-operation', False), ('changing-retirement-identity', False),
])
def test_backend_lifecycle_capability_evidence(monkeypatch, case, unsupported):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    import threading
    from talaria_sidecar import agent_services as services
    calls = []
    identity_calls = 0
    missing_identity = case in {'missing-identity', 'missing-both', 'generic-404', 'public-sessions', 'bad-credential', 'bad-schema', 'changing-identity', 'native-session'}
    missing_retirement = case in {'missing-both', 'missing-retirement', 'retirement-post', 'changing-retirement-identity'}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass

        def do_GET(self):
            nonlocal identity_calls
            calls.append((self.path, self.headers.get('Authorization')))
            status, result = 200, {}
            if self.path == '/api/host/identity':
                identity_calls += 1
                status = 404 if missing_identity else 200
                if case == 'auth-401': status = 401
                if case == 'auth-403': status = 403
                if case == 'transient-503': status = 503
                result = {'ok': True, 'pid': 123, 'role': 'serve'}
                if case == 'malformed-identity': result = []
                if case == 'mismatched-identity': result['pid'] = 456
                if case in {'changing-identity', 'changing-retirement-identity'} and identity_calls > 1:
                    status, result['pid'] = 200, 456
            elif self.path == '/openapi.json':
                paths = {'/api/sessions': {'get': {}}}
                if not missing_identity or case == 'generic-404': paths['/api/host/identity'] = {'get': {}}
                if not missing_retirement: paths['/api/health/retirement'] = {'post': {}}
                result = {'openapi': '3.1.0', 'paths': paths}
                if case == 'bad-schema': result = {'paths': []}
                if case == 'schema-unavailable': status = 503
                if case == 'malformed-operation': paths['/api/health/retirement'] = 'post'
            elif self.path.startswith('/api/sessions'):
                status = 200 if self.headers.get('Authorization') == 'Bearer fixture-private-session' or case == 'public-sessions' else 401
                if case == 'bad-credential': status = 401
                result = {'sessions': []}
            blob = json.dumps(result).encode()
            self.send_response(status)
            self.send_header('Content-Length', str(len(blob)))
            self.end_headers()
            self.wfile.write(blob)

        def do_POST(self):
            self.send_response(404)
            self.end_headers()

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    entry = dict(pid=123, host='127.0.0.1', port=server.server_port, label='synthetic.dashboard', home='/synthetic')
    monkeypatch.setattr(services, '_auth', lambda entry: '' if case == 'native-session' else 'fixture-private-session')
    monkeypatch.setattr(services, '_local_session', lambda entry: 'fixture-private-session' if case == 'native-session' else None)
    thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
    thread.start()
    try:
        if case == 'unreachable':
            server.shutdown()
            server.server_close()
        with pytest.raises(RuntimeError) as failure:
            services.backend_request(entry, 'prepare' if case == 'retirement-post' else None)
        assert isinstance(failure.value, services.BackendLifecycleUnsupported) == unsupported
        assert 'fixture-private-session' not in str(failure.value)
        if case in {'auth-401', 'auth-403'}:
            assert 'refused authenticated' in str(failure.value)
        if case == 'transient-503':
            assert 'HTTP 503' in str(failure.value) and 'refused authenticated' not in str(failure.value)
        if case == 'missing-identity':
            assert ('/api/sessions?limit=1', None) in calls
            assert ('/api/sessions?limit=1', 'Bearer fixture-private-session') in calls
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.mark.parametrize('missing', ['identity', 'retirement'])
def test_unsupported_lifecycle_recovery_keeps_debt_and_restores_sibling(tmp_path, missing):
    with supervised_agent(tmp_path, dashboards=2, legacy=True, readiness=.3) as (root, home, base, target, sidecar, configs):
        begun = rpc(sidecar, root, 'begin', revision=target, homes=list({c['home'] for c in configs}))
        assert begun['ok'], begun
        marker = home / ('missing-' + missing)
        marker.touch()
        finished = rpc(sidecar, root, 'finish', token=begun['token'])
        assert not finished['ok'], finished
        assert 'lifecycle APIs are unsupported' in finished['detail'], finished
        assert 'recovery remains owed' in finished['detail'], finished
        path = next((home / '.talaria-agent-services').glob('*.json'))
        debt = json.loads(path.read_text())
        assert [e['label'] for e in debt['entries']] == [configs[1]['label']]
        assert (Path(configs[2]['home']) / 'backend.pid').exists()
        assert (home / 'active').exists()
        original = (home / 'backend.pid').read_text()
        sidecar.close()
        with contextlib.closing(SidecarProcess(home, agent_dir=root, python=AGENT_PYTHON, env={'PATH': str(home / 'bin') + os.pathsep + os.environ['PATH']})) as replacement:
            replacement.result('runtime.handshake', {'rpc_version': __import__('talaria_sidecar').SIDECAR_RPC_VERSION}, timeout=30)
            # The retained incompatible listener is never stopped or counted as recovered.
            attempt = rpc(replacement, root, 'begin', revision=target, homes=list({c['home'] for c in configs}))
            assert not attempt['ok'], attempt
            assert json.loads(path.read_text())['entries'] == debt['entries']
            assert (home / 'backend.pid').read_text() == original
            marker.unlink()
            replacement.result('runtime.handshake', {'rpc_version': __import__('talaria_sidecar').SIDECAR_RPC_VERSION}, timeout=30)
            wait_for(lambda: not path.exists())
        assert all((home / 'services' / c['label'] / 'starts').read_text().splitlines() == ['start'] for c in configs)


@pytest.mark.parametrize('mode', ['normal', 'force'])
@pytest.mark.parametrize('depth,manager,mixed,respawn', [(0, 'launchd', False, False), (2, 'launchd', False, True), (1, 'systemd', True, True)])
def test_legacy_refresh_confirmation_continues_original_update(tmp_path, mode, depth, manager, mixed, respawn):
    with supervised_agent(tmp_path, dashboards=2, depth=depth, dependency_sync=True, legacy=True, refresh=True, manager=manager, modern_first=mixed) as (root, home, base, target, sidecar, configs):
        homes = list({c['home'] for c in configs})
        legacy_configs = configs[2:] if mixed else configs[1:]
        if respawn:
            for cfg in legacy_configs: (home / 'services' / cfg['label'] / 'respawn-once').touch()
        before = {c['label']: (Path(c['home']) / 'backend.pid').read_text() for c in configs[1:]}
        pending = rpc(sidecar, root, 'begin', revision=target, homes=homes, intent='synthetic-owner:' + mode)
        assert not pending['ok']
        assert pending.get('refresh_confirmation'), pending
        confirmation = pending['refresh_confirmation']
        assert sorted(confirmation['services']) == sorted(c['label'] for c in legacy_configs)
        assert git(root, 'rev-parse', 'HEAD') == base
        assert all((Path(c['home']) / 'backend.pid').read_text() == before[c['label']] for c in configs[1:])
        assert not list((home / '.talaria-agent-services').glob('*.json'))
        begun = rpc(sidecar, root, 'begin', revision=target, homes=homes, intent='synthetic-owner:' + mode, refresh_token=confirmation['token'])
        assert begun['ok'], begun
        assert not list((home / 'services').glob('*/service.pid'))
        if respawn:
            assert all(not (home / 'services' / c['label'] / 'starts').exists() for c in legacy_configs), 'bootstrap must adopt the supervisor successor'
        args = ['merge', '--ff-only', target] if mode == 'normal' else ['reset', '--hard', target]
        assert rpc(sidecar, root, 'git', token=begun['token'], args=args, timeout_ms=10000)['ok']
        assert rpc(sidecar, root, 'sync', token=begun['token'])['ok']
        assert rpc(sidecar, root, 'finish', token=begun['token'])['ok']
        assert git(root, 'rev-parse', 'HEAD') == target
        assert all((Path(c['home']) / 'backend.pid').read_text() != before[c['label']] for c in configs[1:])
        assert not list((home / '.talaria-agent-services').glob('*.json'))
        for cfg in configs:
            starts = 2 if cfg in legacy_configs and not respawn else 1
            assert (home / 'services' / cfg['label'] / 'starts').read_text().splitlines() == ['start'] * starts


@pytest.mark.parametrize('changed', ['operator', 'revision', 'homes', 'config', 'endpoint', 'profile', 'birth', 'replay'])
def test_legacy_refresh_rejects_changed_or_replayed_consent(tmp_path, changed):
    with supervised_agent(tmp_path, refresh=True, gateways=False) as (root, home, base, target, sidecar, configs):
        params = dict(revision=target, homes=[str(home)], intent='synthetic-owner:normal')
        pending = rpc(sidecar, root, 'begin', **params)
        confirmation = pending['refresh_confirmation']
        before = (home / 'backend.pid').read_text()
        if changed == 'operator': params['intent'] = 'different-owner:normal'
        if changed == 'revision': params['revision'] = base
        if changed == 'homes': params['homes'] = [str(home / 'profiles' / 'other')]
        if changed == 'config':
            plist = home / 'plists' / (configs[0]['label'] + '.plist')
            import plistlib
            cfg = plistlib.loads(plist.read_bytes()); cfg['RunAtLoad'] = True
            plist.write_bytes(plistlib.dumps(cfg))
        if changed == 'endpoint':
            path = home / 'services' / configs[0]['label'] / 'config.json'
            cfg = json.loads(path.read_text()); cfg['port'] += 1; path.write_text(json.dumps(cfg))
        if changed == 'profile':
            path = home / 'services' / configs[0]['label'] / 'config.json'
            cfg = json.loads(path.read_text()); cfg['profile'] = 'changed'; path.write_text(json.dumps(cfg))
        if changed == 'birth':
            (home / 'services' / configs[0]['label'] / 'respawn-once').touch()
            os.kill(int(before), signal.SIGTERM)  # Change only the test-owned incarnation to invalidate the old consent.
            wait_for(lambda: (home / 'backend.pid').exists() and (home / 'backend.pid').read_text() != before)
            before = (home / 'backend.pid').read_text()
        if changed == 'replay':
            wrong = {**params, 'intent': 'different-owner:normal'}
            assert not rpc(sidecar, root, 'begin', **wrong, refresh_token=confirmation['token'])['ok']
        result = rpc(sidecar, root, 'begin', **params, refresh_token=confirmation['token'])
        assert not result['ok'], result
        assert not result.get('refresh_confirmation')
        assert (home / 'backend.pid').read_text() == before
        assert git(root, 'rev-parse', 'HEAD') == base
        assert ((home / 'signals').read_text().splitlines() if (home / 'signals').exists() else []) == (['TERM'] if changed == 'birth' else [])
        assert not list((home / '.talaria-agent-services').glob('*.json'))


def test_legacy_refresh_requires_interactive_intent_and_keeps_timeout_debt(tmp_path):
    with supervised_agent(tmp_path, refresh=True, gateways=False, stop_seconds=.15) as (root, home, base, target, sidecar, configs):
        params = dict(revision=target, homes=[str(home)])
        blocked = rpc(sidecar, root, 'begin', **params)
        assert not blocked['ok'] and not blocked.get('refresh_confirmation')
        assert not (home / 'signals').exists()
        params['intent'] = 'synthetic-owner:normal'
        pending = rpc(sidecar, root, 'begin', **params)
        (home / 'slow-stop').touch()
        result = rpc(sidecar, root, 'begin', **params, refresh_token=pending['refresh_confirmation']['token'])
        assert not result['ok'], result
        debt = next((home / '.talaria-agent-services').glob('*.json'))
        assert json.loads(debt.read_text())['entries'][0]['legacy_refresh'] is True
        assert git(root, 'rev-parse', 'HEAD') == base
        assert (home / 'signals').read_text().splitlines() == ['TERM']
        retry = rpc(sidecar, root, 'begin', **params)
        assert not retry['ok'], retry
        assert (home / 'signals').read_text().splitlines() == ['TERM']
        assert debt.exists()


def test_expired_refresh_consent_is_refused_before_starting_a_worker(tmp_path, monkeypatch):
    from talaria_sidecar import agent_mutation
    from types import SimpleNamespace
    root, home, base, target = native_agent(tmp_path)
    token = 'c' * 32
    monkeypatch.setitem(agent_mutation._CONSENTS, token, {'expires': 0})
    result = agent_mutation.call(SimpleNamespace(agent_dir=root), None, dict(agent_dir=str(root), action='begin', revision=target, homes=[str(home)], intent='synthetic-owner', refresh_token=token))
    assert not result['ok'] and 'expired' in result['detail']
    assert token not in agent_mutation._CONSENTS


def test_legacy_refresh_failure_restores_siblings_and_fresh_sidecar_recovers(tmp_path):
    with supervised_agent(tmp_path, dashboards=2, refresh=True) as (root, home, base, target, sidecar, configs):
        homes = list({c['home'] for c in configs})
        pending = rpc(sidecar, root, 'begin', revision=target, homes=homes, intent='synthetic-owner')
        service = home / 'services' / configs[-1]['label']
        (service / 'fail-start').touch()
        result = rpc(sidecar, root, 'begin', revision=target, homes=homes, intent='synthetic-owner', refresh_token=pending['refresh_confirmation']['token'])
        assert not result['ok'], result
        assert (service / 'start-attempts').exists(), result
        assert (service / 'start-attempts').read_text().splitlines() == ['attempt'], result
        assert git(root, 'rev-parse', 'HEAD') == base
        assert (home / 'backend.pid').exists()
        assert (home / 'active').exists()
        debts = list((home / '.talaria-agent-services').glob('*.json'))
        assert debts, result
        debt = debts[0]
        assert [e['label'] for e in json.loads(debt.read_text())['entries']] == [configs[-1]['label']]
        sidecar.close()
        (service / 'fail-start').unlink()
        env = {'PATH': str(home / 'bin') + os.pathsep + os.environ['PATH']}
        with contextlib.closing(SidecarProcess(home, agent_dir=root, python=AGENT_PYTHON, env=env)) as replacement:
            replacement.result('runtime.handshake', {'rpc_version': __import__('talaria_sidecar').SIDECAR_RPC_VERSION})
            wait_for(lambda: not debt.exists())
            begun = rpc(replacement, root, 'begin', revision=target, homes=homes, intent='synthetic-owner')
            assert begun['ok'], begun
            assert rpc(replacement, root, 'git', token=begun['token'], args=['merge', '--ff-only', target], timeout_ms=10000)['ok']
            assert rpc(replacement, root, 'finish', token=begun['token'])['ok']
        assert git(root, 'rev-parse', 'HEAD') == target


@pytest.mark.parametrize('exit_path', ['eof', 'cancel', 'worker-death'])
def test_legacy_refresh_interruption_retains_debt_without_replaying_signal(tmp_path, exit_path):
    with supervised_agent(tmp_path, refresh=True, gateways=False, stop_seconds=2) as (root, home, base, target, sidecar, configs):
        params = dict(revision=target, homes=[str(home)], intent='synthetic-owner')
        pending = rpc(sidecar, root, 'begin', **params)
        (home / 'slow-stop').touch()
        request = sidecar.request('runtime.agent_mutation', dict(agent_dir=str(root), action='begin', **params, refresh_token=pending['refresh_confirmation']['token']))
        wait_for(lambda: (home / 'signals').exists())
        debt = next((home / '.talaria-agent-services').glob('*.json'))
        assert json.loads(debt.read_text())['entries'][0]['legacy_refresh'] is True
        if exit_path == 'eof':
            sidecar.proc.stdin.close()
        elif exit_path == 'cancel':
            sidecar.request('rpc.cancel', {'id': request})
        else:
            journal = next(p for p in home.glob('*.json') if 'owner' in json.loads(p.read_text()))
            os.kill(json.loads(journal.read_text())['owner']['pid'], signal.SIGKILL)
        sidecar.close()
        assert git(root, 'rev-parse', 'HEAD') == base
        env = {'PATH': str(home / 'bin') + os.pathsep + os.environ['PATH']}
        with contextlib.closing(SidecarProcess(home, agent_dir=root, python=AGENT_PYTHON, env=env)) as replacement:
            replacement.result('runtime.handshake', {'rpc_version': __import__('talaria_sidecar').SIDECAR_RPC_VERSION})
            wait_for(lambda: any('Agent service recovery remains owed' in line for line in replacement.stderr_lines))
            retry = rpc(replacement, root, 'begin', **params)
            assert not retry['ok'], retry
            assert debt.exists()
            assert (home / 'signals').read_text().splitlines() == ['TERM']
            assert not list((home / 'services').glob('*/starts'))


@pytest.mark.parametrize('cancelled', [False, True])
def test_refresh_persists_incarnation_before_signal_and_definitive_refusal_is_retryable(monkeypatch, cancelled):
    from talaria_sidecar import agent_services as services
    import copy
    recovery = object.__new__(services.ServiceRecovery)
    entry = dict(kind='launchd', domain='gui/12345', label='synthetic.dashboard', pid=41001,
                 phase='recorded', config_stamp='same')
    sibling = {**entry, 'label': 'synthetic.sibling', 'pid': 41002}
    recovery.state = {'entries': [entry, sibling]}
    recovery.records = object()
    saved = []
    recovery.save = lambda: saved.append(copy.deepcopy(recovery.state))
    monkeypatch.setattr(services, '_config_stamp', lambda e: 'same')
    monkeypatch.setattr(services, 'verify_processes', lambda *a, **kw: None)
    monkeypatch.setattr(services, 'verify_listener', lambda *a: None)
    def refuse(pid, sig):
        assert not cancelled
        assert pid == 41001 and sig == signal.SIGTERM
        assert saved[-1]['entries'][0]['legacy_refresh'] is True
        assert saved[-1]['entries'][0]['phase'] == 'refreshing'
        raise PermissionError('synthetic delivery refusal')
    monkeypatch.setattr(services.os, 'kill', refuse)
    stopped = __import__('threading').Event()
    if cancelled: stopped.set()
    with pytest.raises(RuntimeError, match='cancelled or its signal was refused'):
        recovery.refresh(entry, stopped, None)
    assert recovery.state['entries'] == [sibling]
    assert saved[-1]['entries'] == [sibling]


@pytest.mark.parametrize('failure', ['active-modern', 'missing-successor-api', 'wrong-successor', 'unsafe-source', 'unsafe-dependencies'])
def test_refresh_failure_never_mutates_source_or_interrupts_modern_work(tmp_path, failure):
    with supervised_agent(tmp_path, dashboards=2, gateways=False, refresh=True, modern_first=True, readiness=5) as (root, home, base, target, sidecar, configs):
        homes = [c['home'] for c in configs]
        params = dict(revision=target, homes=homes, intent='synthetic-owner')
        modern = home / 'backend.pid'
        before = modern.read_text()
        if failure == 'unsafe-source': (root / 'run_agent.py').write_text('# local source edit\n')
        if failure == 'unsafe-dependencies': (root / '.interrupted').touch()
        pending = rpc(sidecar, root, 'begin', **params)
        assert pending.get('refresh_confirmation'), pending
        legacy_home = Path(configs[-1]['home'])
        original_legacy = int((legacy_home / 'backend.pid').read_text())
        if failure == 'active-modern': (home / 'busy').touch()
        if failure == 'missing-successor-api': (legacy_home / 'missing-retirement').touch()
        if failure == 'wrong-successor': (legacy_home / 'foreign-listener').touch()
        result = rpc(sidecar, root, 'begin', **params, refresh_token=pending['refresh_confirmation']['token'])
        assert not result['ok'], result
        assert git(root, 'rev-parse', 'HEAD') == base
        assert modern.read_text() == before
        assert not (home / 'signals').exists(), 'the busy/untouched modern writer must never be interrupted'
        if failure in {'missing-successor-api', 'wrong-successor'}:
            requests = [json.loads(line) for line in (legacy_home / 'get-requests.jsonl').read_text().splitlines()]
            successor_paths = {r['path'] for r in requests if r['pid'] != original_legacy and r['legacy'] is False}
            assert '/api/host/identity' in successor_paths, result
            if failure == 'missing-successor-api':
                assert '/openapi.json' in successor_paths
                assert 'running backend lifecycle APIs are unsupported' in result['detail']
            assert (legacy_home / 'signals').read_text().splitlines() == ['TERM']
            assert (home / 'services' / configs[-1]['label'] / 'start-attempts').read_text().splitlines() == ['attempt']
        if failure.startswith('unsafe-'):
            assert not (legacy_home / 'signals').exists()
        elif failure != 'active-modern':
            debt = next((home / '.talaria-agent-services').glob('*.json'))
            assert [e['label'] for e in json.loads(debt.read_text())['entries']] == [configs[-1]['label']]


def test_legacy_listener_requires_the_attested_os_process():
    from talaria_sidecar import agent_services as services
    import socket
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0)); listener.listen()
        entry = dict(pid=os.getpid(), host='127.0.0.1', port=listener.getsockname()[1], label='synthetic.listener')
        services.verify_listener(entry)
        with pytest.raises((RuntimeError, OSError)):
            services.verify_listener({**entry, 'pid': os.getppid()})


@pytest.mark.parametrize('manager', ['launchd', 'systemd'])
def test_refresh_failed_supervisor_start_is_attempted_once_per_worker(tmp_path, manager):
    with supervised_agent(tmp_path, gateways=False, refresh=True, readiness=.2, manager=manager) as (root, home, base, target, sidecar, configs):
        params = dict(revision=target, homes=[str(home)], intent='synthetic-owner')
        pending = rpc(sidecar, root, 'begin', **params)
        service = home / 'services' / configs[0]['label']
        (service / 'fail-start').touch()
        result = rpc(sidecar, root, 'begin', **params, refresh_token=pending['refresh_confirmation']['token'])
        assert not result['ok'], result
        assert git(root, 'rev-parse', 'HEAD') == base
        debt = next((home / '.talaria-agent-services').glob('*.json'))
        assert json.loads(debt.read_text())['entries'][0]['legacy_refresh'] is True
        assert (service / 'start-attempts').read_text().splitlines() == ['attempt']
