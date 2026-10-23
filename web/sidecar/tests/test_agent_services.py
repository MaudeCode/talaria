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
from test_agent_mutation import native_agent, wait_for, wait_for_agent_exit, supervised_inventory


def test_snapshot_resamples_a_descendant_exited_before_birth_lookup(supervised_inventory, monkeypatch):
    from talaria_sidecar import agent_services as services
    _, _, _, _, _, parents, modules = supervised_inventory
    parents[41005] = 41002
    status = modules['gateway.status']
    original = status.get_process_start_time

    def birth(pid):
        if pid == 41005:
            parents.pop(pid, None)
            return None
        return original(pid)

    monkeypatch.setattr(status, 'get_process_start_time', birth)
    entry = dict(pid=41002, service_pid=41001, label='synthetic.gateway')
    assert services.snapshot(entry) == {
        '41001': {'birth': 410010, 'parent': 1},
        '41002': {'birth': 410020, 'parent': 41001},
    }


def test_snapshot_excludes_an_unreaped_dead_child_with_a_readable_birth(supervised_inventory, monkeypatch):
    from talaria_sidecar import agent_services as services
    _, _, _, _, _, parents, modules = supervised_inventory
    parents[41005] = 41002
    monkeypatch.setattr(modules['gateway.status'], '_pid_exists', lambda p: p != 41005 and p in parents)
    result = services.snapshot(dict(pid=41002, service_pid=41001))
    assert set(result) == {'41001', '41002'}


@pytest.mark.parametrize('boundary', ['inventory', 'birth-1', 'after-birth-1', 'inventory-2', 'birth-2', 'after-birth-2', 'inventory-3'])
@pytest.mark.parametrize('children', [1, 3])
def test_snapshot_brackets_exits_at_each_read(supervised_inventory, monkeypatch, boundary, children):
    from talaria_sidecar import agent_services as services
    _, _, _, _, _, parents, modules = supervised_inventory
    helpers = set(range(41005, 41005 + children))
    parents.update({p: 41002 for p in helpers})
    original_table = services._process_table
    tables, births = 0, 0

    def leave():
        for p in helpers:
            parents.pop(p, None)

    def table():
        nonlocal tables
        tables += 1
        if boundary == {2: 'inventory-2', 3: 'inventory-3'}.get(tables):
            leave()
        result = original_table()
        if tables == 1 and boundary == 'inventory':
            leave()
        return result

    def birth(pid):
        nonlocal births
        if pid == min(helpers):
            births += 1
            if boundary == f'birth-{births}':
                leave()
            value = pid * 10 if pid in parents else None
            if boundary == f'after-birth-{births}':
                leave()
            return value
        return pid * 10 if pid in parents else None

    monkeypatch.setattr(services, '_process_table', table)
    monkeypatch.setattr(modules['gateway.status'], 'get_process_start_time', birth)
    result = services.snapshot(dict(pid=41002, service_pid=41001))
    assert set(result) == {'41001', '41002'}
    assert tables <= services.SNAPSHOT_ATTEMPTS * 3


@pytest.mark.parametrize('arrival', [2, 3])
def test_snapshot_attests_new_children_before_returning(supervised_inventory, monkeypatch, arrival):
    from talaria_sidecar import agent_services as services
    _, _, _, _, _, parents, _ = supervised_inventory
    original = services._process_table
    calls = 0

    def table():
        nonlocal calls
        calls += 1
        if calls == arrival:
            parents[41005] = 41002
        return original()

    monkeypatch.setattr(services, '_process_table', table)
    result = services.snapshot(dict(pid=41002, service_pid=41001))
    assert result['41005'] == {'birth': 410050, 'parent': 41002}
    assert calls >= 6


@pytest.mark.parametrize('unsafe', ['live-unreadable', 'unknown-liveness', 'reused-child', 'reused-runtime',
                                  'reused-supervisor', 'changed-parent', 'departed-live', 'departed-unknown'])
def test_snapshot_refuses_unsafe_identity_evidence(supervised_inventory, monkeypatch, unsafe):
    from talaria_sidecar import agent_services as services
    _, _, _, _, _, parents, modules = supervised_inventory
    parents[41005] = 41002
    status = modules['gateway.status']
    calls = {}

    def birth(pid):
        calls[pid] = calls.get(pid, 0) + 1
        if pid == 41005 and unsafe in {'live-unreadable', 'unknown-liveness', 'departed-live', 'departed-unknown'}:
            return None
        changed = {'reused-child': 41005, 'reused-runtime': 41002, 'reused-supervisor': 41001}.get(unsafe)
        if pid == changed and calls[pid] > 1:
            return pid * 10 + 1
        if pid == 41005 and unsafe == 'changed-parent':
            parents[pid] = 41001
        return pid * 10

    probes = 0

    def exists(pid):
        nonlocal probes
        if pid == 41005:
            probes += 1
            if unsafe == 'unknown-liveness':
                return None
            if unsafe.startswith('departed-'):
                return False if probes == 1 else (True if unsafe == 'departed-live' else None)
        return pid in parents

    monkeypatch.setattr(status, 'get_process_start_time', birth)
    monkeypatch.setattr(status, '_pid_exists', exists)
    with pytest.raises(RuntimeError, match='live or unreadable|identity/ancestry changed|became live or unreadable'):
        services.snapshot(dict(pid=41002, service_pid=41001))


@pytest.mark.parametrize('output', ['', 'unreadable', '41001 x\n'])
def test_snapshot_refuses_unreadable_or_empty_inventory(supervised_inventory, monkeypatch, output):
    from talaria_sidecar import agent_services as services
    monkeypatch.setattr(subprocess, 'run', lambda *a, **kw: subprocess.CompletedProcess(a, 0, output, ''))
    with pytest.raises(RuntimeError, match='inventory is empty|inventory is unreadable'):
        services.snapshot(dict(pid=41002, service_pid=41001))


def test_snapshot_bounds_persistent_churn(supervised_inventory, monkeypatch):
    from talaria_sidecar import agent_services as services
    _, _, _, _, _, parents, _ = supervised_inventory
    original = services._process_table
    calls = 0

    def table():
        nonlocal calls
        calls += 1
        parents[42000 + calls] = 41002
        return original()

    monkeypatch.setattr(services, '_process_table', table)
    with pytest.raises(RuntimeError, match='kept changing.*retry.*recovery remains owed'):
        services.snapshot(dict(pid=41002, service_pid=41001))
    assert calls == services.SNAPSHOT_ATTEMPTS * 3


@pytest.mark.parametrize('anchor', [41001, 41002])
def test_snapshot_never_retries_a_departed_anchor(supervised_inventory, monkeypatch, anchor):
    from talaria_sidecar import agent_services as services
    _, _, _, _, _, parents, modules = supervised_inventory

    def birth(pid):
        if pid == anchor:
            parents.pop(pid)
            return None
        return pid * 10

    monkeypatch.setattr(modules['gateway.status'], 'get_process_start_time', birth)
    with pytest.raises(RuntimeError, match='anchor process .* disappeared'):
        services.snapshot(dict(pid=41002, service_pid=41001))


def test_recovery_churn_preserves_source_and_retiring_debt(supervised_inventory, monkeypatch):
    from types import SimpleNamespace
    from talaria_sidecar import agent_services as services
    from talaria_sidecar.agent_mutation import _owners
    root, home, pause, identity, _, parents, _ = supervised_inventory
    entry = {**_owners(root, {home}, pause, identity)[0], 'purpose': 'gateway'}
    Path(entry['plist']).write_text('synthetic gateway configuration')
    records = SimpleNamespace(identity=lambda p: {'ct': p}, write=lambda token: None,
                              identity_is_live=lambda p: False, tree_is_whole=lambda *a: (True, ''))
    services.bind_processes(entry, records)
    recovery = services.ServiceRecovery(root, home, records, identity, pause)
    recovery.prepare([entry], {'baselines': [{'synthetic': True}]})
    recovery.state['entries'][0]['phase'] = 'retiring'
    recovery.save()
    before = recovery.path.read_bytes()
    source = root / 'synthetic-source'
    source.write_text('retained source')
    original = services._process_table
    calls = 0

    def table():
        nonlocal calls
        calls += 1
        parents[42000 + calls] = 41002
        return original()

    def unexpected(*args):
        pytest.fail('unverified readiness must not start or disarm a service')

    monkeypatch.setattr(services, '_process_table', table)
    monkeypatch.setattr(services, '_start', unexpected)
    pause._disarm = unexpected
    with pytest.raises(RuntimeError, match='kept changing.*retry.*recovery remains owed'):
        recovery.resume(lambda *a: [])
    assert calls == services.SNAPSHOT_ATTEMPTS * 3
    assert recovery.path.read_bytes() == before
    assert source.read_text() == 'retained source'


def test_gateway_readiness_rejects_a_recycled_runtime_anchor(supervised_inventory, monkeypatch):
    from types import SimpleNamespace
    from talaria_sidecar import agent_services as services
    from talaria_sidecar.agent_mutation import _owners
    root, home, pause, identity, _, _, modules = supervised_inventory
    entry = {**_owners(root, {home}, pause, identity)[0], 'purpose': 'gateway'}
    Path(entry['plist']).write_text('synthetic gateway configuration')
    records = SimpleNamespace(identity=lambda p: {'ct': p}, write=lambda token: None, identity_is_live=lambda p: False)
    services.bind_processes(entry, records)
    recovery = services.ServiceRecovery(root, home, records, identity, pause)
    recovery.prepare([entry], {'baselines': [{'synthetic': True}]})
    owed = recovery.state['entries'][0]
    owed['phase'] = 'retiring'
    recovery.save()
    before = recovery.path.read_bytes()
    pause._gateway_on_home = lambda *a: 41002
    monkeypatch.setattr(modules['gateway.status'], 'get_running_pid_identity_strict', lambda *a: (41002, 410019))
    with pytest.raises(RuntimeError, match='identity/ancestry changed'):
        recovery._ready(owed, lambda *a: [])
    assert recovery.path.read_bytes() == before


def test_newly_discovered_child_cannot_escape_between_samples(supervised_inventory, monkeypatch):
    from talaria_sidecar import agent_services as services
    _, _, _, _, _, parents, _ = supervised_inventory
    original = services._process_table
    calls = 0

    def table():
        nonlocal calls
        calls += 1
        if calls == 2:
            parents[41005] = 41002
        if calls == 3:
            parents[41005] = 1
        return original()

    monkeypatch.setattr(services, '_process_table', table)
    with pytest.raises(RuntimeError, match='identity/ancestry changed'):
        services.snapshot(dict(pid=41002, service_pid=41001))


@pytest.mark.parametrize('pid', [41001, 41002, 41005])
def test_binding_refuses_canonical_pid_reuse(supervised_inventory, pid):
    from types import SimpleNamespace
    from talaria_sidecar import agent_services as services
    _, _, _, _, _, parents, _ = supervised_inventory
    parents[41005] = 41002
    entry = dict(kind='launchd', domain='gui/12345', label='synthetic.gateway', pid=41002, service_pid=41001)
    entry['processes'] = services.snapshot(entry)
    probes = 0

    def identity(p):
        nonlocal probes
        if p == pid:
            probes += 1
        return {'ct': p + (1 if p == pid and probes > 1 else 0)}

    with pytest.raises(RuntimeError, match='identity/ancestry changed'):
        services.bind_processes(entry, SimpleNamespace(identity=identity))


@pytest.mark.parametrize('boundary', [1, 2])
def test_binding_resamples_exit_during_canonical_identity(supervised_inventory, monkeypatch, boundary):
    from types import SimpleNamespace
    from talaria_sidecar import agent_services as services
    _, _, _, _, _, parents, modules = supervised_inventory
    parents[41005] = 41002
    entry = dict(kind='launchd', domain='gui/12345', label='synthetic.gateway', pid=41002, service_pid=41001)
    entry['processes'] = services.snapshot(entry)
    monkeypatch.setattr(modules['gateway.status'], 'get_process_start_time', lambda p: p * 10 if p in parents else None)
    probes = 0

    def identity(pid):
        nonlocal probes
        if pid == 41005:
            probes += 1
            if probes == boundary:
                parents.pop(pid)
                return {'ct': None}
        return {'ct': pid}

    services.bind_processes(entry, SimpleNamespace(identity=identity))
    assert entry['processes'] == {
        '41001': {'birth': 410010, 'parent': 1, 'ct': 41001},
        '41002': {'birth': 410020, 'parent': 41001, 'ct': 41002},
    }


@pytest.mark.parametrize('stopping', [False, True])
@pytest.mark.parametrize('probe', ['liveness', 'birth', 'canonical', 'ancestry'])
def test_verification_exit_race_requires_stop_permission(supervised_inventory, monkeypatch, stopping, probe):
    from types import SimpleNamespace
    from talaria_sidecar import agent_services as services
    _, _, _, _, _, parents, modules = supervised_inventory
    parents[41005] = 41002
    status = modules['gateway.status']
    entry = dict(kind='launchd', domain='gui/12345', label='synthetic.gateway', pid=41002, service_pid=41001)
    records = SimpleNamespace(identity=lambda p: {'ct': p})
    entry['processes'] = services.snapshot(entry)
    services.bind_processes(entry, records)

    def birth(pid):
        if pid == 41005 and probe == 'birth':
            parents.pop(pid, None)
            return None
        return pid * 10

    def canonical(pid):
        if pid == 41005 and probe == 'canonical':
            parents.pop(pid, None)
            return {'ct': None}
        return {'ct': pid}

    monkeypatch.setattr(status, 'get_process_start_time', birth)
    records.identity = canonical
    if probe in {'liveness', 'ancestry'}:
        parents.pop(41005)
        if probe == 'ancestry':
            exists = status._pid_exists
            first = True

            def race(pid):
                nonlocal first
                if pid == 41005 and first:
                    first = False
                    return True
                return exists(pid)

            monkeypatch.setattr(status, '_pid_exists', race)
    if stopping:
        services.verify_processes(entry, records, stopping=True)
    else:
        with pytest.raises(RuntimeError, match='disappeared|identity/ancestry changed'):
            services.verify_processes(entry, records)


@pytest.mark.parametrize('stopping', [False, True])
def test_verification_rejects_a_child_arriving_during_identity_probes(supervised_inventory, monkeypatch, stopping):
    from types import SimpleNamespace
    from talaria_sidecar import agent_services as services
    _, _, _, _, _, parents, modules = supervised_inventory
    entry = dict(kind='launchd', domain='gui/12345', label='synthetic.gateway', pid=41002, service_pid=41001)
    records = SimpleNamespace(identity=lambda p: {'ct': p})
    entry['processes'] = services.snapshot(entry)
    services.bind_processes(entry, records)

    def birth(pid):
        parents[41005] = 41002
        return pid * 10

    monkeypatch.setattr(modules['gateway.status'], 'get_process_start_time', birth)
    with pytest.raises(RuntimeError, match='unrecorded descendant'):
        services.verify_processes(entry, records, stopping=stopping)


@pytest.mark.parametrize('revived', [True, None])
def test_stopping_verification_rejects_reuse_after_an_earlier_exit_probe(supervised_inventory, monkeypatch, revived):
    from types import SimpleNamespace
    from talaria_sidecar import agent_services as services
    _, _, _, _, _, parents, modules = supervised_inventory
    parents[41005] = 41002
    entry = dict(kind='launchd', domain='gui/12345', label='synthetic.gateway', pid=41002, service_pid=41001)
    records = SimpleNamespace(identity=lambda p: {'ct': p})
    entry['processes'] = services.snapshot(entry)
    services.bind_processes(entry, records)
    probes = 0

    def exists(pid):
        nonlocal probes
        if pid == 41005:
            probes += 1
            return False if probes == 1 else revived
        return pid in parents

    monkeypatch.setattr(modules['gateway.status'], '_pid_exists', exists)
    monkeypatch.setattr(modules['gateway.status'], 'get_process_start_time', lambda p: p * 10 + (p == 41005))
    with pytest.raises(RuntimeError, match='identity/ancestry changed'):
        services.verify_processes(entry, records, stopping=True)


def rpc(sidecar, root, action, **params):
    return sidecar.result('runtime.agent_mutation', {'agent_dir': str(root), 'action': action, **params}, timeout=45)


def test_native_snapshot_attests_a_barrier_controlled_child_exit(tmp_path):
    from conftest import isolated_env, SIDECAR_ROOT
    supervisor = tmp_path / 'supervisor.py'
    supervisor.write_text('''import subprocess, sys
child=subprocess.Popen([sys.executable,'-c','import sys; sys.stdin.readline()'],stdin=subprocess.PIPE,text=True)
try:
 print(child.pid,flush=True)
 assert sys.stdin.readline().strip()=='exit'
 child.communicate('exit\\n',timeout=5)
 print('reaped',flush=True)
 sys.stdin.readline()
finally:
 if child.poll() is None: child.terminate(); child.wait(timeout=5)
''')
    script = '''import subprocess, sys, psutil
from types import SimpleNamespace
from unittest.mock import patch
from gateway import status
from talaria_sidecar import agent_services as services
supervisor=subprocess.Popen([sys.executable,sys.argv[1]],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
try:
 helper=int(supervisor.stdout.readline())
 original=status.get_process_start_time
 probes=[]
 def birth(pid):
  if pid==helper:
   probes.append(pid)
   supervisor.stdin.write('exit\\n'); supervisor.stdin.flush()
   assert supervisor.stdout.readline().strip()=='reaped'
  return original(pid)
 entry=dict(pid=supervisor.pid,service_pid=supervisor.pid)
 with patch.object(status,'get_process_start_time',birth):
  entry['processes']=services.snapshot(entry)
 assert probes==[helper]
 assert set(entry['processes'])=={str(supervisor.pid)}
 records=SimpleNamespace(identity=lambda p:{'ct':psutil.Process(p).create_time()})
 with patch.object(services,'_service_pid',lambda e:(True,supervisor.pid)):
  services.bind_processes(entry,records)
  services.verify_processes(entry,records)
finally:
 supervisor.communicate('done\\n',timeout=5)
'''
    env = isolated_env(tmp_path / 'home', PYTHONPATH=str(SIDECAR_ROOT) + os.pathsep + str(AGENT_DIR))
    result = subprocess.run([AGENT_PYTHON, '-c', script, str(supervisor)], cwd=AGENT_DIR, env=env,
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr[-5000:]


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


@pytest.mark.parametrize('stopping', [False, True])
def test_native_process_exit_between_liveness_and_identity_probes(tmp_path, stopping):
    from conftest import isolated_env, SIDECAR_ROOT
    home = tmp_path / 'home'
    home.mkdir()
    script = '''import os, subprocess, sys
from pathlib import Path
from talaria_sidecar import agent_services as services
from hermes_cli import update_pause_record as records
import gateway.status as status
marker=Path(os.environ['HERMES_HOME'])/'exit'
child=subprocess.Popen([sys.executable,'-c',
 'import sys,time; from pathlib import Path; marker=Path(sys.argv[1]); print("ready",flush=True); exec("while not marker.exists(): time.sleep(.001)")',str(marker)],stdout=subprocess.PIPE,text=True)
try:
 assert child.stdout.readline().strip()=='ready'
 entry=dict(kind='launchd',label='synthetic.gateway',domain='synthetic',pid=child.pid,service_pid=child.pid)
 entry['processes']=services.snapshot(entry)
 for pid,expected in entry['processes'].items():
  expected['ct']=records.identity(int(pid))['ct']; assert expected['ct'] is not None
 services._service_pid=lambda entry:(False,None)
 original_exists=status._pid_exists
 def observed_then_exit(pid):
  observed=original_exists(pid)
  if pid==child.pid and observed:
   marker.touch(); assert child.wait(timeout=5)==0
  return observed
 status._pid_exists=observed_then_exit
 if os.environ['TEST_STOPPING']=='1':
  services.verify_processes(entry,records,stopping=True)
 else:
  try: services.verify_processes(entry,records)
  except RuntimeError as error: assert 'identity/ancestry changed' in str(error),str(error)
  else: raise AssertionError('normal custody must reject a process that exits during verification')
 assert child.returncode==0
 print('natural-exit verification boundary preserved')
finally:
 if child.poll() is None: child.kill(); child.wait()
'''
    env = isolated_env(home, PYTHONPATH=str(SIDECAR_ROOT) + os.pathsep + str(AGENT_DIR),
                       TEST_STOPPING=str(int(stopping)))
    result = subprocess.run([AGENT_PYTHON, '-c', script], cwd=AGENT_DIR, env=env, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'natural-exit verification boundary preserved' in result.stdout


def git(root, *args):
    return subprocess.check_output(['git', '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
                                   '-c', 'commit.gpgsign=false', '-C', str(root), *args], text=True).strip()


@contextmanager
def supervised_agent(tmp_path, *, local_edit_file=False, repair_module_change=False, runtime_importable=False, dashboards=1, depth=1, gateways=True, dependency_sync=False, readiness=None, legacy=False, refresh=False, manager="launchd", stop_seconds=None, modern_first=False, gateway_respawn=False, gateway_profiles=1, transient=False, respawn_barrier=False, backend_respawn=False, backend_purpose="dashboard"):
    root, home, _, _ = native_agent(tmp_path)
    modules = root / 'hermes_cli'
    writer = root / 'writer.py'
    writer.write_text(writer.read_text().replace("home=Path(sys.argv[1])", """home=Path(sys.argv[1])
import fcntl
lock=(home/'gateway.lock').open('a+')
try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError: raise SystemExit(0)
if os.environ.get('TALARIA_SYNTHETIC_ADMISSION'): Path(os.environ['TALARIA_SYNTHETIC_ADMISSION']).touch()
if (home/'hold-runtime-publication').exists():
 (home/'runtime-publication-held').touch()
 while (home/'hold-runtime-publication').exists(): time.sleep(.01)
import subprocess
tool=None
if (home/'hold-successor-drain').exists():
 tool=subprocess.Popen([sys.executable,'-c',"import sys,time; from pathlib import Path; flag=Path(sys.argv[1]); exec('while flag.exists(): time.sleep(.01)')",str(home/'hold-successor-drain')])
""").replace("(home/'active').unlink(missing_ok=True)", """while (home/'hold-successor-drain').exists(): time.sleep(.01)
if tool is not None: tool.wait(timeout=5)
(home/'active').unlink(missing_ok=True)"""))
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
def native_pid(label):
 cfg=json.loads((HOME/'services'/label/'config.json').read_text())
 if cfg['depth']==0:
  file=Path(cfg['home'])/('active' if cfg['purpose']=='gateway' else 'backend.pid')
  try: pid=int(file.read_text())
  except FileNotFoundError: return None
  return pid if alive(pid) else None
 return service_pid(label)
def start(label):
 cfg=json.loads((HOME/'services'/label/'config.json').read_text())
 if cfg['depth']==0 and cfg['purpose']!='gateway':
  # The fixture manager can still be reaping an exited direct job.
  deadline=time.monotonic()+4
  while service_pid(label) and not native_pid(label) and time.monotonic()<deadline: time.sleep(.01)
  if native_pid(label): return
 with (HOME/'services'/label/'start-attempts').open('a') as f: f.write('attempt'+chr(10))
 if (HOME/'services'/label/'fail-start').exists(): raise RuntimeError('synthetic service start refused')
 if service_pid(label): return
 (HOME/'services'/label/'disarm').unlink(missing_ok=True)
 if cfg['purpose']=='gateway':
  (Path(cfg['home'])/'pause').unlink(missing_ok=True)
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
    (root / 'supervisor.py').write_text('''import json, os, signal, subprocess, sys, threading, time
from pathlib import Path
from synthetic_services import HOME, ROOT, publish_pid
label=sys.argv[1]; folder=HOME/'services'/label
cfg=json.loads((folder/'config.json').read_text())
helper=None
if cfg.get('transient'):
 for name in ('helper-control','helper-ack'):
  path=folder/name; path.unlink(missing_ok=True); os.mkfifo(path)
 helper=subprocess.Popen([sys.executable,'-c','import sys; sys.stdin.readline()'],stdin=subprocess.PIPE,text=True)
 (folder/'helper.pid').write_text(str(helper.pid))
 def release_helper():
  with (folder/'helper-control').open() as control: assert control.read()=='exit'
  helper.communicate('exit\\n',timeout=5)
  (folder/'helper.pid').unlink()
  with (folder/'helper-ack').open('w') as ack: ack.write('reaped')
 threading.Thread(target=release_helper,daemon=True).start()
publish_pid(folder/'service.pid')
argv=[sys.executable,str(ROOT/('writer.py' if cfg['purpose']=='gateway' else 'backend.py')),cfg['home']]
if (folder/'wrapper-only').exists(): argv=[sys.executable,str(ROOT/'inert.py'),cfg['home']]
for _ in range(cfg['depth']): argv=[sys.executable,str(ROOT/'wrapper.py'),*argv]
admission=folder/('admitted.'+str(os.getpid()))
def spawn():
 admission.unlink(missing_ok=True)
 return subprocess.Popen(argv,env={**os.environ,'TALARIA_SYNTHETIC_ADMISSION':str(admission)})
child=spawn()
def stop(*_): (folder/'disarm').touch()
signal.signal(signal.SIGTERM,stop)
try:
 while not (folder/'disarm').exists():
  if child.poll() is not None:
   if (folder/'gateway-respawn-once').exists() or (folder/'backend-respawn-once').exists():
    (folder/'gateway-respawn-once').unlink(missing_ok=True)
    (folder/'backend-respawn-once').unlink(missing_ok=True)
    (Path(cfg['home'])/'pause').unlink(missing_ok=True)
    if (folder/'hold-successor').exists(): (Path(cfg['home'])/'hold-successor-drain').touch()
    subprocess.Popen([sys.executable,str(ROOT/'supervisor.py'),label],start_new_session=True)
    while int((folder/'service.pid').read_text())==os.getpid(): time.sleep(.01)
    break
   elif (folder/'respawn-once').exists():
    (folder/'respawn-once').unlink(); child=spawn()
   elif (folder/'respawn').exists():
    while (folder/'hold-respawn').exists(): time.sleep(.01)
    if not (folder/'disarm').exists(): child=spawn()
   elif cfg.get('refresh') or (cfg['purpose']!='gateway' and cfg['depth']==0) or (cfg['purpose']=='gateway' and not admission.exists()): break
  time.sleep(.01)
finally:
 if helper is not None and helper.poll() is None: helper.terminate(); helper.wait(timeout=5)
 if child.poll() is None:
  if cfg['purpose']=='gateway': (Path(cfg['home'])/'stop').touch()
  else:
   try: os.kill(int((Path(cfg['home'])/'backend.pid').read_text()),signal.SIGTERM)
   except (FileNotFoundError,ProcessLookupError): pass
 child.wait(timeout=5)
 if (folder/'service.pid').exists() and int((folder/'service.pid').read_text())==os.getpid(): (folder/'service.pid').unlink()
 while (HOME/'hold-supervisor-exit').exists(): time.sleep(.01)
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
  if self.headers.get('Authorization')!='Bearer synthetic-local-token': self.reply({},401); return
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
  if self.headers.get('Authorization')!='Bearer synthetic-local-token': self.reply({},401); return
  if legacy_runtime or (home/'missing-retirement').exists(): self.reply({},404); return
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  if body['action']=='work':
   with retirement.work() as admitted: self.reply({'admitted':admitted})
   return
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
 return service_pid(label) is not None,native_pid(label)
def _launchctl_bootstrap(domain,plist,label): start(label)
def _is_pid_ancestor_of_current_process(pid): return False
''',
      'main_dashboard': '''from synthetic_services import *
def _launchd_plist_dirs(): return [('agent',HOME/'plists')]
def _loaded_launchd_backend_jobs(): return [('gui/12345',c['label'],['hermes',c['purpose']],native_pid(c['label'])) for c in services() if c['purpose']!='gateway' and c['manager']=='launchd' and native_pid(c['label'])]
def _launchd_job_owning_backend(pid,cmdline,jobs,ancestors=()): return next(((d,l,p) for d,l,a,p in jobs if p in ancestors),None)
def _get_systemd_service_for_pid(pid): return next((c['label'] for c in services() if c['manager']=='systemd' and native_pid(c['label'])==pid),None)
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
def _unit_main_pid(cmd,unit): return native_pid(unit)
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
def _discover_systemd(): return [dict(kind='systemd',scope='user',unit=c['label'],pid=native_pid(c['label']),home=c['home']) for c in services() if c['purpose']=='gateway' and c['manager']=='systemd' and native_pid(c['label'])]
def _discover_launchd(): return [dict(kind='launchd',domain='gui/12345',label=c['label'],plist=str(HOME/'plists'/(c['label']+'.plist')),pid=native_pid(c['label']),home=c['home']) for c in services() if c['purpose']=='gateway' and c['manager']=='launchd' and native_pid(c['label'])]
def _left_running(units,jobs): return units,jobs,[]
def _home_of(pid): return next((r['hermes_home'] for r in ledger() if r['pid']==pid),str(HOME))
def _discover_bare(excluded): return [],[f"gateway PID {r['pid']} is supervised" for r in ledger() if r['purpose']=='gateway' and r['pid'] not in excluded]
def _ask_to_drain(entry): (Path(entry['home'])/'pause').touch(); return True
def _gateway_on_home(home,exclude):
 try: pid=int((Path(home)/'active').read_text())
 except FileNotFoundError: return None
 return pid if alive(pid) and pid not in exclude else None
def _drain_budget(): return 4
def _alive(pid,ct):
 result=alive(pid,ct)
 if not result and (HOME/'wait-gateway-successor').exists():
  deadline=time.monotonic()+4
  while time.monotonic()<deadline:
   if (HOME/'hold-runtime-publication').exists():
    if (HOME/'runtime-publication-held').exists(): break
   elif any(r['purpose']=='gateway' and r['pid']!=pid for r in ledger()): break
   time.sleep(.01)
  (HOME/'wait-gateway-successor').unlink()
 return result
def _manage_cmd(scope): return ['systemctl','--user']
def _disarm(entry):
 label=entry.get('label') or entry['unit']
 if entry.get('purpose')!='gateway':
  if (HOME/'fail-backend-disarm').exists(): raise RuntimeError('synthetic backend manager refused')
  if (HOME/'hold-backend-disarm').exists():
   (HOME/'backend-disarm-requested').touch()
   deadline=time.monotonic()+4
   while (HOME/'hold-backend-disarm').exists() and time.monotonic()<deadline: time.sleep(.01)
   if (HOME/'hold-backend-disarm').exists(): raise RuntimeError('synthetic backend stop timed out')
 if label.startswith('synthetic.gateway') and (HOME/'fail-gateway-disarm').exists(): raise RuntimeError('synthetic disarm failure')
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
    # Keep process ancestry real while avoiding host-wide ps subprocess contention between test workers.
    (modules / 'main.py').write_text("from talaria_sidecar import agent_services\nimport psutil\nagent_services._process_table=lambda: {p.info['pid']:p.info['ppid'] for p in psutil.process_iter(['pid','ppid'])}\n")
    if readiness is not None or stop_seconds is not None or respawn_barrier or backend_respawn:
        main = (modules / 'main.py').read_text()
        if readiness is not None:
            main += f'agent_services.READY_SECONDS={readiness!r}\n'
        if stop_seconds is not None:
            main += f'agent_services.STOP_SECONDS={stop_seconds!r}\n'
        if respawn_barrier or backend_respawn:
            main += '''import time
from pathlib import Path
from synthetic_services import HOME, birth
original_wait_stopped=agent_services.wait_stopped
def wait_stopped(entry,records,stopped,*,writers_only=False):
 original_wait_stopped(entry,records,stopped,writers_only=writers_only)
 if writers_only and entry['purpose']!='gateway':
  (HOME/'services'/entry['label']/'hold-respawn').unlink(missing_ok=True)
  deadline=time.monotonic()+4
  while True:
   try: successor=int((Path(entry['home'])/'backend.pid').read_text())
   except (FileNotFoundError,ValueError): successor=0
   if successor and successor!=entry['pid'] and birth(successor) is not None: break
   if time.monotonic()>=deadline: raise RuntimeError('synthetic successor did not become ready')
   time.sleep(.01)
agent_services.wait_stopped=wait_stopped
'''
        if respawn_barrier:
            main += '''import os, signal, threading
from hermes_cli import update_pause_record
original_backend_request=agent_services.backend_request
def backend_request(entry,action=None,permit=None):
 result=original_backend_request(entry,action,permit)
 if action=='commit' and result.get('ok'):
  os.kill(entry['pid'],signal.SIGTERM)
  wait_stopped(entry,update_pause_record,threading.Event(),writers_only=True)
 return result
agent_services.backend_request=backend_request
'''
        (modules / 'main.py').write_text(main)
    if dependency_sync:
        (modules / 'venv_sync.py').write_text("import json\nfrom synthetic_services import HOME, ledger, services, service_pid\nassert not ledger() and not any(service_pid(c['label']) for c in services()), 'writer survived dependency custody'\nwith (HOME/'sync-runs').open('a') as f: f.write('sync'+chr(10))\nprint(json.dumps({'ok':not (HOME/'fail-sync').exists()}))\n")
    (root / 'gateway/status.py').write_text('''from synthetic_services import HOME, birth, alive
from pathlib import Path
import fcntl
def _get_gateway_lock_path(pid_path): return pid_path.with_name('gateway.lock')
def _try_acquire_file_lock(handle):
 try: fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB); return True
 except BlockingIOError: return False
def _release_file_lock(handle): fcntl.flock(handle,fcntl.LOCK_UN)
def _build_pid_record(): return {'pid':os.getpid(),'start_time':birth(os.getpid()),'kind':'gateway','hermes_home':str(Path(os.environ['HERMES_HOME']))}
def get_process_start_time(pid):
 for file in (HOME/'services').glob('*/helper.pid'):
  if int(file.read_text())!=pid: continue
  with (file.parent/'helper-control').open('w') as control: control.write('exit')
  with (file.parent/'helper-ack').open() as ack: assert ack.read()=='reaped'
  with (file.parent/'sampled-exits').open('a') as log: log.write(str(pid)+'\\n')
 return birth(pid)
def _pid_exists(pid): return alive(pid)
def _read_process_cmdline(pid): return 'hermes gateway run' if alive(pid) else None
def get_running_pid_identity_strict(path):
 try: pid=int((Path(path).parent/'active').read_text())
 except FileNotFoundError:
  if (Path(path).parent/'runtime-publication-held').exists(): (Path(path).parent/'unpublished-runtime-observed').touch()
  return None
 ct=birth(pid)
 return (pid,ct) if ct is not None else None
''')
    import ast
    native_status = ast.parse((AGENT_DIR / 'gateway/status.py').read_text())
    lock_functions = {'_get_gateway_lock_path', '_try_acquire_file_lock', '_release_file_lock'}
    with (root / 'gateway/status.py').open('a') as status:
        status.write("\nimport contextlib, os\nfrom typing import Optional\n_IS_WINDOWS=False\n_GATEWAY_LOCK_FILENAME='gateway.lock'\n")
        for function in native_status.body:
            if isinstance(function, ast.FunctionDef) and function.name in lock_functions:
                status.write(ast.unparse(function) + '\n')
    (root / 'gateway/host_rendezvous.py').write_text("ROLE_SERVE='serve'\ndef read_record(role): return None\n")
    (root / 'gateway/status_inline_source.py').write_text('def command_line_runs_inline_source(tokens): return False\ndef inline_bootstrap_argv(tokens): return None\n')
    (root / 'hermes_constants.py').write_text("import os\nfrom pathlib import Path\ndef get_default_hermes_root(): return Path(os.environ['HERMES_HOME'])\n")
    for name in ['update_pause_record.py', 'update_cmd_pause_gate.py', 'update_cmd_commit.py', 'update_cmd_common.py', '_early_recovery.py']:
        (modules / name).write_bytes((AGENT_DIR / 'hermes_cli' / name).read_bytes())
    with (modules / '_launchers.py').open('a') as file:
        tree = ast.parse((AGENT_DIR / 'hermes_cli/_launchers.py').read_text())
        for node in tree.body:
            if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == '_CLOSURE_REPAIR' for t in node.targets):
                file.write(ast.unparse(node) + '\n')
    with (modules / '_early_recovery.py').open('a') as file:
        file.write("\n_native_marker = interrupted_pull_marker\ndef interrupted_pull_marker(root): return root/'.interrupted' if (root/'.interrupted').exists() else _native_marker(root)\n")
    with (modules / 'update_lock.py').open('a') as file:
        file.write('''
import psutil
def process_create_time(pid): return birth(pid)
def incarnation_live(pid,ct):
 if isinstance(ct,str) and ct.startswith('ct:'): ct=float(ct[3:])
 return alive(pid,ct)
def _try_lock(fd):
 try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB); return True
 except OSError: return False
def _unlock(fd): fcntl.flock(fd,fcntl.LOCK_UN)
def _acquire_checkout(root):
 global native_lease
 native_lease=UpdateLock(install_root=root)
 return None if native_lease.acquire() else 'held'
def _release_checkout(): native_lease.release()
def checkout_lock_held(root): return FD is not None
def holds_checkout_lock(root): return FD is not None
def update_in_progress(root): return FD is not None
def acquire_checkout(self,root):
 if FD is not None and os.fstat(FD).st_ino==os.fstat(self.file.fileno()).st_ino: return True
 return self.acquire()
UpdateLock.acquire_checkout=acquire_checkout
''')
    # Native repair imports only its verified closure, never the damaged checkout.
    with (modules / 'update_custody.py').open('a') as file:
        file.write("\nimport json, os, psutil\nfrom pathlib import Path\nHOME=Path(os.environ['HERMES_HOME'])\n")
    tree = ast.parse((root / 'synthetic_services.py').read_text())
    for name, helpers in (
            ('update_lock.py', {'birth', 'alive'}),
            ('update_custody.py', {'birth', 'alive', 'services', 'service_pid', 'ledger'})):
        with (modules / name).open('a') as file:
            for node in tree.body:
                if isinstance(node, ast.FunctionDef) and node.name in helpers:
                    file.write(ast.unparse(node) + '\n')
    with (modules / 'update_custody.py').open('a') as file:
        file.write('''
def run_git(command,args,**kw):
 if args and args[0] in ('merge','reset','checkout','stash','apply','restore','clean'):
  assert not ledger(), 'old-source writer survived quiescence'
  assert not any(service_pid(c['label']) for c in services()), 'supervisor survived quiescence'
 return subprocess.run([*command,*args],**kw)
''')
    import plistlib
    import socket
    sockets, configs = [], []
    (home / 'services').mkdir()
    (home / 'plists').mkdir()
    for i in range(dashboards + gateway_profiles):
        if i < gateway_profiles and not gateways:
            continue
        purpose = 'gateway' if i < gateway_profiles else backend_purpose
        label = f'synthetic.{purpose}.{i}'
        served_home = home if i in {0, gateway_profiles} else home / 'profiles' / f'profile{i}'
        served_home.mkdir(parents=True, exist_ok=True)
        cfg = dict(label=label, purpose=purpose, depth=depth, home=str(served_home), profile='default' if served_home == home else f'profile{i}', legacy=legacy, refresh=refresh, manager=manager, transient=transient)
        if purpose != 'gateway':
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
        if backend_respawn and purpose != 'gateway':
            (folder / 'backend-respawn-once').touch()
        if gateway_respawn and purpose == 'gateway':
            (folder / 'gateway-respawn-once').touch()
            (home / 'wait-gateway-successor').touch()
        configs.append(cfg)
    binary = home / 'bin'
    binary.mkdir()
    (binary / 'launchctl').write_text(f'#!{AGENT_PYTHON}\nimport sys\nfrom pathlib import Path\nsys.path.insert(0,{str(root)!r})\nfrom synthetic_services import start,native_pid\nif sys.argv[1]=="bootstrap": start(Path(sys.argv[3]).stem)\nif sys.argv[1]=="kickstart" and not native_pid(sys.argv[2].split("/")[-1]): start(sys.argv[2].split("/")[-1])\n')
    (binary / 'launchctl').chmod(0o755)
    if runtime_importable:
        (root / 'run_agent.py').write_text('class AIAgent: pass\n')
        (modules / 'auth.py').write_text('')
    if local_edit_file: (root / 'local.txt').write_text('baseline local content\n')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'supervised native baseline')
    base = git(root, 'rev-parse', 'HEAD')
    (root / 'VERSION').write_text('target\n')
    if repair_module_change:
        with (modules / 'update_lock.py').open('a') as file: file.write('# target lock module\n')
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
        wait_for(lambda: (not gateways or all((Path(c['home'])/'active').exists() for c in configs if c['purpose']=='gateway')) and all((Path(c['home']) / 'backend.pid').exists() for c in configs if c['purpose'] != 'gateway'))
        sidecar = SidecarProcess(home, agent_dir=root, python=AGENT_PYTHON, env={'PATH': env['PATH']})
        yield root, home, base, target, sidecar, configs
    finally:
        for cfg in configs:
            (Path(cfg['home']) / 'hold-runtime-publication').unlink(missing_ok=True)
        if sidecar is not None:
            sidecar.close()
        for cfg in configs:
            (home / 'services' / cfg['label'] / 'disarm').touch()
            (home / 'services' / cfg['label'] / 'hold-respawn').unlink(missing_ok=True)
            (Path(cfg['home']) / 'slow-stop').unlink(missing_ok=True)
            (Path(cfg['home']) / 'hold-successor-drain').unlink(missing_ok=True)
            if cfg['purpose'] == 'gateway':
                (Path(cfg['home']) / 'stop').touch()
            else:
                with contextlib.suppress(FileNotFoundError, ProcessLookupError):
                    os.kill(int((Path(cfg['home']) / 'backend.pid').read_text()), signal.SIGTERM)
        for proc in supervisors:
            proc.wait(timeout=8)
        wait_for(lambda: not list((home / 'services').glob('*/service.pid')))
        wait_for_agent_exit(root, home)


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


@pytest.mark.parametrize('mode', ['normal'])
def test_updates_and_recovery_attest_barrier_controlled_descendant_exits(tmp_path, mode):
    with supervised_agent(tmp_path, dashboards=2, dependency_sync=True, transient=True) as (root, home, base, target, sidecar, configs):
        begun = rpc(sidecar, root, 'begin', revision=target, homes=list({c['home'] for c in configs}))
        assert begun['ok'], begun
        for cfg in configs:
            assert len((home / 'services' / cfg['label'] / 'sampled-exits').read_text().splitlines()) == 1
        args = ['merge', '--ff-only', target] if mode == 'normal' else ['reset', '--hard', target]
        assert rpc(sidecar, root, 'git', token=begun['token'], args=args, timeout_ms=10000)['ok']
        assert rpc(sidecar, root, 'sync', token=begun['token'])['ok']
        finished = rpc(sidecar, root, 'finish', token=begun['token'])
        assert finished['ok'], finished
        assert git(root, 'rev-parse', 'HEAD') == target
        assert not list((home / '.talaria-agent-services').glob('*.json'))
        for cfg in configs:
            folder = home / 'services' / cfg['label']
            assert len((folder / 'sampled-exits').read_text().splitlines()) == 2
            assert (folder / 'starts').read_text().splitlines() == ['start']








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
@pytest.mark.parametrize('legacy', [False])
def test_backend_recovery_covers_lease_exit_paths(tmp_path, exit_path, legacy):
    with supervised_agent(tmp_path, legacy=legacy) as (root, home, base, target, sidecar, configs):
        begun = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
        assert begun['ok'], begun
        if exit_path == 'finish':
            finished = rpc(sidecar, root, 'finish', token=begun['token'])
            assert finished['ok'], finished
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


@pytest.mark.parametrize('legacy', [False])
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
            replacement.result('runtime.agent_recovery', {}, timeout=45)
            wait_for(lambda: not list((home / '.talaria-agent-services').glob('*.json')))
            assert (home / 'backend.pid').exists(), replacement.stderr_lines
            assert (home / 'active').exists(), replacement.stderr_lines
        wait_for(lambda: (home / 'active').exists() and (home / 'backend.pid').exists())
        assert not list((home / '.talaria-agent-services').glob('*.json'))
        assert (home / 'services' / configs[1]['label'] / 'starts').read_text().splitlines() == ['start']


@pytest.mark.parametrize('legacy', [True])
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
            replacement.result('runtime.agent_recovery', {}, timeout=45)
            assert not replacement.result('runtime.agent_recovery', {}, timeout=45)['ok']
            assert not (home / 'backend.pid').exists()
            assert not (home / 'active').exists()
            assert list((home / '.talaria-agent-services').glob('*.json'))
            interrupted.unlink()
            replacement.result('runtime.handshake', {'rpc_version': __import__('talaria_sidecar').SIDECAR_RPC_VERSION}, timeout=30)
            replacement.result('runtime.agent_recovery', {}, timeout=45)
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


@pytest.mark.parametrize('wrapper_exits', [False, True])
def test_backend_stop_ack_does_not_authorize_mutation_or_force_kill(supervised_inventory, monkeypatch, wrapper_exits):
    import threading
    import types
    from talaria_sidecar import agent_services as services
    from talaria_sidecar.agent_mutation import _owners
    root, home, pause, identity, rows, parents, modules = supervised_inventory
    pause._discover_launchd = lambda: []
    pause._discover_bare = lambda excluded: ([], [])
    rows.append(dict(purpose='dashboard', pid=41004, create_time=1, hermes_home=str(home), profile='default', host='127.0.0.1', port=9417, argv='hermes dashboard'))
    entry = _owners(root, {home}, pause, identity)[0]
    records = types.SimpleNamespace(identity=lambda pid: {'ct': pid}, identity_is_live=lambda p: p['pid'] in parents)
    services.bind_processes(entry, records)
    recovery = services.ServiceRecovery(root, home, records, identity, pause)
    recovery.prepare([entry], {})
    signals, disarmed = [], []
    monkeypatch.setattr(services, 'STOP_SECONDS', .01)
    monkeypatch.setattr(services, 'backend_request', lambda entry, action=None, permit=None: {'ok': True, 'idle': True, 'token': 'synthetic-permit'})
    monkeypatch.setattr(services.os, 'kill', lambda pid, sig: signals.append((pid, sig)))
    def disarm(entry):
        disarmed.append(entry)
        if wrapper_exits:
            parents.pop(entry['pid'])
            parents[entry['runtime_pid']] = 1
    pause._disarm = disarm
    with pytest.raises(RuntimeError, match='graceful stop has not completed'):
        recovery.stop(entry, threading.Event())
    assert signals == []
    assert [e['runtime_pid'] for e in disarmed] == [41004]
    assert json.loads(recovery.path.read_text())['entries'][0]['phase'] == 'retiring'


def test_wrong_listener_never_discharges_backend_debt(supervised_inventory, monkeypatch):
    import types
    from unittest.mock import Mock
    from talaria_sidecar import agent_services as services
    from talaria_sidecar.agent_mutation import _owners
    root, home, pause, identity, rows, parents, modules = supervised_inventory
    connection = Mock()
    connection.getresponse.return_value = Mock(status=200, read=lambda limit: b'{"ok":true,"pid":1,"role":"serve"}')
    monkeypatch.setattr(services.http.client, 'HTTPConnection', lambda *args, **kwargs: connection)
    pause._discover_launchd = lambda: []
    pause._discover_bare = lambda excluded: ([], [])
    row = dict(purpose='dashboard', pid=41004, create_time=1, hermes_home=str(home), profile='default', host='127.0.0.1', port=9417, argv='hermes dashboard')
    rows.append(row)
    entry = _owners(root, {home}, pause, identity)[0]
    records = types.SimpleNamespace(identity=lambda pid: {'ct': pid}, identity_is_live=lambda p: False, tree_is_whole=lambda token, root: (True, ''))
    services.bind_processes(entry, records)
    recovery = services.ServiceRecovery(root, home, records, identity, pause)
    recovery.prepare([entry], {})
    recovery.state['entries'][0]['phase'] = 'stopped'
    recovery.save()
    clock = [0.0]
    def advance(seconds): clock[0] += seconds
    monkeypatch.setattr(services, 'time', types.SimpleNamespace(monotonic=lambda: clock[0], sleep=advance))
    monkeypatch.setattr(services, 'READY_SECONDS', .01)
    monkeypatch.setattr(services, '_auth', lambda entry: 'synthetic-local-token')
    with pytest.raises(RuntimeError, match='readiness is unverified'):
        recovery.resume(lambda root, identity: [(row, True)])
    assert len(json.loads(recovery.path.read_text())['entries']) == 1


def test_supervised_dashboard_without_gateway_recovers(tmp_path):
    with supervised_agent(tmp_path, gateways=False) as (root, home, base, target, sidecar, configs):
        begun = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
        assert begun['ok'], begun
        assert not (home / 'backend.pid').exists()
        finished = rpc(sidecar, root, 'finish', token=begun['token'])
        assert finished['ok'], finished
        assert (home / 'backend.pid').exists()




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






@pytest.mark.parametrize('transient', [True])
def test_crash_after_wrapped_gateway_drain_finishes_the_supervisor_obligation_once(tmp_path, transient):
    with supervised_agent(tmp_path, transient=transient) as (root, home, base, target, sidecar, configs):
        (home / 'hold-disarm').touch()
        sidecar.request('runtime.agent_mutation', {'agent_dir': str(root), 'action': 'begin', 'revision': target, 'homes': [str(home)]})
        wait_for(lambda: (home / 'gateway-disarm-requested').exists())
        assert not (home / 'active').exists()
        assert (home / 'services' / configs[0]['label'] / 'service.pid').exists()
        journal = next(p for p in home.glob('*.json') if 'owner' in json.loads(p.read_text()))
        body = json.loads(journal.read_text())
        debt = json.loads(next((home / '.talaria-agent-services').glob('*.json')).read_text())
        entry = next(e for e in debt['entries'] if e['purpose'] == 'gateway')
        assert entry['phase'] == 'retiring'
        assert body['token']['posix_units'] == [], 'the native reader must not independently replay this supervisor'
        assert str(entry['service_pid']) in map(str, body['token']['stop_sent'])
        assert str(entry['pid']) in map(str, body['token']['stop_sent'])
        os.kill(body['owner']['pid'], signal.SIGKILL)
        (home / 'hold-disarm').unlink()
        sidecar.close()
        with contextlib.closing(SidecarProcess(home, agent_dir=root, python=AGENT_PYTHON, env={'PATH': str(home / 'bin') + os.pathsep + os.environ['PATH']})) as replacement:
            replacement.result('runtime.handshake', {'rpc_version': __import__('talaria_sidecar').SIDECAR_RPC_VERSION}, timeout=45)
            replacement.result('runtime.agent_recovery', {}, timeout=45)
            wait_for(lambda: not list((home / '.talaria-agent-services').glob('*.json')))
            assert (home / 'active').exists() and (home / 'backend.pid').exists(), replacement.stderr_lines
        assert not list((home / '.talaria-agent-services').glob('*.json'))
        assert all((home / 'services' / c['label'] / 'starts').read_text().splitlines() == ['start'] for c in configs)
        if transient:
            assert all(len((home / 'services' / c['label'] / 'sampled-exits').read_text().splitlines()) == 2 for c in configs)




def test_retained_recovery_repairs_dependencies_and_resumes_without_another_update(tmp_path):
    with supervised_agent(tmp_path, dependency_sync=True, gateway_profiles=2) as (root, home, base, target, sidecar, configs):
        (home / 'fail-sync').touch()
        begun = rpc(sidecar, root, 'begin', revision=target, homes=[str(home), str(home / 'profiles' / 'profile1')])
        assert begun['ok'], begun
        moved = rpc(sidecar, root, 'git', token=begun['token'], args=['merge', '--ff-only', target], timeout_ms=10000)
        assert moved['ok'], moved
        assert not rpc(sidecar, root, 'sync', token=begun['token'])['ok']
        assert not rpc(sidecar, root, 'finish', token=begun['token'])['ok']
        (home / 'fail-sync').unlink()
        from conftest import isolated_env, SIDECAR_ROOT
        result = subprocess.run([AGENT_PYTHON, '-m', 'talaria_sidecar.agent_mutation', '--resume', str(root)], cwd=root,
                                env=isolated_env(home, PYTHONPATH=str(SIDECAR_ROOT) + os.pathsep + str(root), PATH=str(home / 'bin') + os.pathsep + os.environ['PATH']),
                                capture_output=True, text=True, timeout=30)
        reply = json.loads(result.stdout)
        assert reply['ok'], reply
        assert (home / 'active').exists() and (home / 'backend.pid').exists()
        assert not list((home / '.talaria-agent-services').glob('*.json'))
        assert (home / 'sync-runs').read_text().splitlines() == ['sync', 'sync']



@pytest.mark.parametrize('handoff', [False, True])
def test_retained_recovery_holds_services_until_the_leased_local_restore(tmp_path, handoff):
    with supervised_agent(tmp_path) as (root, home, base, target, sidecar, configs):
        def git(*args):
            return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()
        local = root / 'local.txt'
        local.write_text('baseline\n')
        git('add', 'local.txt'); git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'local baseline')
        baseline = git('rev-parse', 'HEAD')
        local.write_text('preserved edit\n')
        begun = rpc(sidecar, root, 'begin', revision=baseline, homes=[str(home)])
        assert begun['ok'], begun
        stash = rpc(sidecar, root, 'git', token=begun['token'], args=['stash', 'create'], timeout_ms=10000)['detail']
        assert rpc(sidecar, root, 'git', token=begun['token'], args=['update-ref', 'refs/talaria/autostash/pending/' + stash, stash], timeout_ms=10000)['ok']
        patch = tmp_path / 'edits.patch'
        patch.write_text(subprocess.check_output(['git', '-C', str(root), 'diff', stash + '^1', stash, '--', 'local.txt'], text=True))
        assert rpc(sidecar, root, 'git', token=begun['token'], args=['apply', '-R', str(patch)], timeout_ms=10000)['ok']
        # Kill the writer owner, leaving its exact pause and private autostash receipts.
        journal = next(p for p in home.glob('*.json') if 'owner' in json.loads(p.read_text()))
        os.kill(json.loads(journal.read_text())['owner']['pid'], signal.SIGKILL)
        import time
        time.sleep(.1)
        if handoff:
            for _ in range(5):
                result = sidecar.result('runtime.agent_recovery', {}, timeout=45)
                if result.get('local_restore'): break
                time.sleep(.05)
            assert result.get('local_restore') and result.get('revision') == baseline, result
            assert not (home / 'active').exists() and not (home / 'backend.pid').exists()
        resumed = rpc(sidecar, root, 'begin', revision=baseline, homes=[str(home)])
        assert resumed['ok'], resumed
        assert rpc(sidecar, root, 'git', token=resumed['token'], args=['apply', str(patch)], timeout_ms=10000)['ok']
        assert rpc(sidecar, root, 'git', token=resumed['token'], args=['update-ref', '-d', 'refs/talaria/autostash/pending/' + stash, stash], timeout_ms=10000)['ok']
        restored = rpc(sidecar, root, 'finish', token=resumed['token'])
        assert restored['ok'], restored
        assert local.read_text() == 'preserved edit\n'
        assert (home / 'active').exists() and (home / 'backend.pid').exists()


@pytest.mark.parametrize('failure', ['before-head', 'after-head', 'recovery-module'])
def test_native_recorded_source_repair_restores_the_baseline_without_upgrading(tmp_path, failure):
    import shutil
    with supervised_agent(tmp_path, repair_module_change=failure == 'recovery-module') as (root, home, base, target, sidecar, configs):
        real_git = shutil.which('git')
        shim = home / 'bin' / 'git'
        shim.write_text(f'''#!{AGENT_PYTHON}
import os,sys
from pathlib import Path
if sys.argv[1:2]==['merge']:
 if {failure!r} == 'after-head':
  import subprocess
  subprocess.run([{real_git!r},*sys.argv[1:]],check=True)
 Path('hermes_cli/update_lock.py' if {failure!r} == 'recovery-module' else 'VERSION').write_text('' if {failure!r} == 'recovery-module' else 'tar')
 raise SystemExit(1)
os.execv({real_git!r},[{real_git!r},*sys.argv[1:]])
''')
        shim.chmod(0o755)
        unrelated = root / 'unrelated-local.txt'
        unrelated.write_text('preserve this work\n')
        begun = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
        assert begun['ok'], begun
        moved = rpc(sidecar, root, 'git', token=begun['token'], args=['merge', '--ff-only', target], timeout_ms=10000)
        assert not moved['ok'], moved
        finished = rpc(sidecar, root, 'finish', token=begun['token'])
        assert not finished['ok'], finished
        assert (root / '.git/hermes-update-pull').exists()
        result = sidecar.result('runtime.agent_recovery', {}, timeout=45)
        assert result['ok'] and not result['owed'] and result['revision'] == base, result['detail']
        assert subprocess.check_output([real_git, '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip() == base
        assert unrelated.read_text() == 'preserve this work\n'
        assert not (root / 'VERSION').exists()
        assert (home / 'active').exists() and (home / 'backend.pid').exists()


def test_loaded_runtime_acknowledgement_is_required_before_repair_intent_is_cleared(tmp_path):
    import hashlib
    with supervised_agent(tmp_path, runtime_importable=True) as (root, home, base, target, sidecar, configs):
        sidecar.result('runtime.handshake', {'rpc_version': __import__('talaria_sidecar').SIDECAR_RPC_VERSION})
        begun = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
        assert begun['ok'], begun
        marker = home / 'webui/agent-dependency-sync' / hashlib.sha256(str(root).encode()).hexdigest()
        marker.parent.mkdir(parents=True)
        marker.write_text('pending\n')
        assert rpc(sidecar, root, 'finish', token=begun['token'])['ok']
        assert marker.exists()
        assert list((home / '.talaria-agent-services').glob('*.json'))
        wrong = sidecar.result('runtime.agent_recovery', {'complete_revision': target})
        assert not wrong['ok'] and marker.exists()
        held, _ = sidecar.call('runtime.ensure_current')
        assert held['error']['data']['condition'] == 'agent_runtime_stale'
        recovered = sidecar.result('runtime.agent_recovery', {'complete_revision': base}, timeout=45)
        assert recovered['ok'] and not recovered['owed'], recovered
        assert not marker.exists()
        assert sidecar.result('runtime.ensure_current')['current']

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




@pytest.mark.parametrize('invalid', [{'sync_failed': 'false'}, {'transaction': {'revision': 'unknown', 'homes': []}}])
def test_unknown_recovery_transaction_is_never_consumed(tmp_path, invalid):
    from talaria_sidecar import agent_services as services
    root, home = tmp_path / 'agent', tmp_path / 'home'
    root.mkdir(); home.mkdir()
    path = services.recovery_path(root, home)
    path.parent.mkdir()
    body = json.dumps({'schema': 1, 'root': str(root), 'entries': [], 'tree': {}, 'sync_failed': False, **invalid})
    path.write_text(body)
    with pytest.raises(RuntimeError, match='unknown identity or format'):
        services.ServiceRecovery(root, home, None, None, None)
    assert path.read_text() == body


def test_recovery_probe_keeps_handshake_responsive_and_admission_closed(tmp_path):
    from talaria_sidecar import agent_mutation, agent_services
    from talaria_sidecar.runtime import AgentRuntime, AgentRuntimeStale
    from types import SimpleNamespace
    root, home = tmp_path / 'agent', tmp_path / 'home'
    root.mkdir(); home.mkdir()
    runtime = AgentRuntime(home, root)
    file = agent_services.recovery_path(root, home)
    file.parent.mkdir(); file.write_text('{}')
    first = agent_mutation.recover_retained(runtime, SimpleNamespace(), probe=True)
    assert first['owed'] and not first['ok']
    assert first == agent_mutation.recover_retained(runtime, SimpleNamespace(), probe=True)
    (root / '.git').mkdir()
    (root / '.git/HEAD').write_text('a' * 40)
    changed = agent_mutation.recover_retained(runtime, SimpleNamespace(), probe=True)
    assert changed['owed'] and changed['fingerprint'] != first['fingerprint']
    (root / '.git/HEAD').write_text('ref: refs/heads/main')
    before_ref = agent_mutation.recover_retained(runtime, SimpleNamespace(), probe=True)
    (root / '.git/refs/heads').mkdir(parents=True)
    (root / '.git/refs/heads/main').write_text('b' * 40)
    assert agent_mutation.recover_retained(runtime, SimpleNamespace(), probe=True)['fingerprint'] != before_ref['fingerprint']
    with pytest.raises(AgentRuntimeStale, match='recovery is incomplete'):
        runtime.ensure_current()
    file.unlink()
    assert agent_mutation.recover_retained(runtime, SimpleNamespace(), probe=True)['ok']
    runtime.ensure_current()


@pytest.mark.parametrize('case,unsupported', [
    ('missing-identity', True), ('missing-both', True), ('missing-retirement', True),
    ('auth-401', False), ('auth-403', False), ('generic-404', False), ('public-sessions', False),
    ('bad-credential', False), ('bad-schema', False), ('malformed-identity', False),
    ('mismatched-identity', False), ('changing-identity', False), ('transient-503', False),
    ('unreachable', False), ('native-session', True), ('retirement-post', True), ('schema-unavailable', False), ('malformed-operation', False), ('changing-retirement-identity', False),
])
def test_backend_lifecycle_capability_evidence(monkeypatch, case, unsupported):
    from unittest.mock import Mock
    from talaria_sidecar import agent_services as services
    calls = []
    identity_calls = 0
    missing_identity = case in {'missing-identity', 'missing-both', 'generic-404', 'public-sessions', 'bad-credential', 'bad-schema', 'changing-identity', 'native-session'}
    missing_retirement = case in {'missing-both', 'missing-retirement', 'retirement-post', 'changing-retirement-identity'}

    connection = Mock()

    def request(method, path, body, headers):
        # Same HTTPConnection boundary as the supported-Agent TestClient proof above.
        nonlocal identity_calls
        if case == 'unreachable':
            raise ConnectionRefusedError('synthetic unavailable backend')
        calls.append((path, headers.get('Authorization')))
        status, result = 200, {}
        if method == 'POST':
            status = 404
        elif path == '/api/host/identity':
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
        elif path == '/openapi.json':
            paths = {'/api/sessions': {'get': {}}}
            if not missing_identity or case == 'generic-404': paths['/api/host/identity'] = {'get': {}}
            if not missing_retirement: paths['/api/health/retirement'] = {'post': {}}
            result = {'openapi': '3.1.0', 'paths': paths}
            if case == 'bad-schema': result = {'paths': []}
            if case == 'schema-unavailable': status = 503
            if case == 'malformed-operation': paths['/api/health/retirement'] = 'post'
        elif path.startswith('/api/sessions'):
            status = 200 if headers.get('Authorization') == 'Bearer fixture-private-session' or case == 'public-sessions' else 401
            if case == 'bad-credential': status = 401
            result = {'sessions': []}
        blob = json.dumps(result).encode()
        connection.getresponse.return_value = Mock(status=status, read=lambda limit: blob[:limit])

    connection.request.side_effect = request
    monkeypatch.setattr(services.http.client, 'HTTPConnection', lambda *args, **kwargs: connection)
    entry = dict(pid=123, host='127.0.0.1', port=9417, label='synthetic.dashboard', home='/synthetic')
    monkeypatch.setattr(services, '_auth', lambda entry: '' if case == 'native-session' else 'fixture-private-session')
    monkeypatch.setattr(services, '_local_session', lambda entry: 'fixture-private-session' if case == 'native-session' else None)
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






@pytest.mark.parametrize('changed', ['operator', 'revision', 'homes', 'replay'])
def test_legacy_refresh_rejects_changed_or_replayed_consent(tmp_path, monkeypatch, changed):
    from types import SimpleNamespace
    from talaria_sidecar import agent_mutation as mutation
    root, home, target = tmp_path / 'agent', tmp_path / 'home', 'b' * 40
    root.mkdir(); home.mkdir()
    token = 'c' * 32
    params = dict(agent_dir=str(root), action='begin', revision=target, homes=[str(home)], intent='synthetic-owner', refresh_token=token)
    monkeypatch.setitem(mutation._CONSENTS, token, dict(root=root.resolve(), revision=target, homes=[str(home.resolve())],
        intent='synthetic-owner', binding='d' * 64, expires=float('inf')))
    if changed == 'operator': params['intent'] = 'other-owner'
    elif changed == 'revision': params['revision'] = 'e' * 40
    elif changed == 'homes': params['homes'] = [str(home / 'other')]
    else:
        assert not mutation.call(SimpleNamespace(agent_dir=root), None, {**params, 'intent': 'other-owner'})['ok']
    result = mutation.call(SimpleNamespace(agent_dir=root), None, params)
    assert not result['ok'] and 'expired, changed or was already used' in result['detail']
    assert token not in mutation._CONSENTS


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
    root, home, target = tmp_path / 'agent', tmp_path / 'home', 'b' * 40
    root.mkdir(); home.mkdir()
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
            replacement.result('runtime.agent_recovery', {}, timeout=45)
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
            attempted = replacement.result('runtime.agent_recovery', {}, timeout=45)
            assert not attempted['ok'] and attempted['owed'], attempted
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


@pytest.mark.parametrize('failure', ['active-modern'])
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






def test_gateway_successor_work_finishes_before_disarm_or_mutation(tmp_path):
    with supervised_agent(tmp_path, gateway_respawn=True, depth=2) as (root, home, base, target, sidecar, configs):
        service = home / 'services' / configs[0]['label']
        (service / 'hold-successor').touch()
        request = sidecar.request('runtime.agent_mutation', {'agent_dir': str(root), 'action': 'begin', 'revision': target, 'homes': [str(home)]})
        wait_for(lambda: (home / 'hold-successor-drain').exists() and (home / 'pause').exists())
        wait_for(lambda: any(e.get('settle_attempts') and e.get('drain_acknowledged')
                             for p in (home / '.talaria-agent-services').glob('*.json')
                             for e in json.loads(p.read_text())['entries']))
        assert (home / 'active').exists() and (service / 'service.pid').exists()
        debt = json.loads(next((home / '.talaria-agent-services').glob('*.json')).read_text())
        gateway = next(e for e in debt['entries'] if e['purpose'] == 'gateway')
        assert any(p['parent'] == gateway['pid'] for p in gateway['processes'].values()), 'active tool subprocess was not covered by successor custody'
        assert not (service / 'disarm').exists()
        assert git(root, 'rev-parse', 'HEAD') == base
        (home / 'hold-successor-drain').unlink()
        begun = sidecar.next_message(timeout=30)
        while begun.get('method') == 'stream' and begun['params']['id'] == request:
            assert begun['params']['event'] == 'progress' and begun['params']['data']['phase'] == 'gateway_drain', begun
            begun = sidecar.next_message(timeout=30)
        assert begun['id'] == request and begun['result']['ok'], begun
        assert not (home / 'active').exists()
        assert git(root, 'rev-parse', 'HEAD') == base
        assert rpc(sidecar, root, 'finish', token=begun['result']['token'])['ok']


@pytest.mark.parametrize('exit_path', ['owner-kill'])
def test_expected_respawn_custody_recovers_after_lease_exit(tmp_path, exit_path):
    with supervised_agent(tmp_path, gateway_respawn=True) as (root, home, base, target, sidecar, configs):
        begun = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
        assert begun['ok'], begun
        if exit_path == 'finish':
            assert rpc(sidecar, root, 'finish', token=begun['token'])['ok']
        elif exit_path == 'eof':
            sidecar.close()
        else:
            journal = next(p for p in home.glob('*.json') if 'owner' in json.loads(p.read_text()))
            os.kill(json.loads(journal.read_text())['owner']['pid'], signal.SIGKILL)
            sidecar.close()
        with contextlib.closing(SidecarProcess(home, agent_dir=root, python=AGENT_PYTHON, env={'PATH': str(home / 'bin') + os.pathsep + os.environ['PATH']})) as replacement:
            replacement.result('runtime.handshake', {'rpc_version': __import__('talaria_sidecar').SIDECAR_RPC_VERSION}, timeout=45)
            replacement.result('runtime.agent_recovery', {}, timeout=45)
            wait_for(lambda: not list((home / '.talaria-agent-services').glob('*.json')))
        assert (home / 'active').exists() and (home / 'backend.pid').exists()
        assert all((home / 'services' / c['label'] / 'starts').read_text().splitlines() == ['start'] for c in configs)


@pytest.fixture
def gateway_successor(supervised_inventory, monkeypatch):
    import types
    from talaria_sidecar import agent_services as services
    from talaria_sidecar.agent_mutation import _owners
    root, home, pause, identity, rows, parents, modules = supervised_inventory
    plist = root / 'synthetic.gateway.plist'
    plist.write_bytes(b'original supervisor configuration')
    records = types.SimpleNamespace(identity=lambda pid: {'ct': pid},
        identity_is_live=lambda p: p['pid'] in parents and p['ct'] == p['pid'],
        tree_is_whole=lambda *args: (True, ''), write=lambda *args: None)
    entry = _owners(root, {home}, pause, identity)[0]
    services.bind_processes(entry, records)
    recovery = services.ServiceRecovery(root, home, records, identity, pause)
    recovery.prepare([{**entry, 'purpose': 'gateway'}], {'baselines': [{'synthetic': True}]})
    owed = recovery.state['entries'][0]
    owed.update(phase='retiring', drain_acknowledged=True)
    recovery.save()
    parents.pop(41001); parents.pop(41002)
    parents.update({42001: 1, 42002: 42001})
    pause._discover_launchd = lambda: [{**entry, 'pid': 42001}]
    modules['hermes_cli.gateway']._launchd_print_service_pid = lambda *args: (True, 42001)
    status = modules['gateway.status']
    status.get_running_pid_identity_strict = lambda path: (42002, 420020)
    status._get_gateway_lock_path = lambda path: home / 'gateway.lock'
    (home / 'gateway.lock').touch()
    status._build_pid_record = lambda: {'pid':os.getpid(),'start_time':os.getpid()*10}
    status._try_acquire_file_lock = lambda file: False
    status._release_file_lock = lambda file: None
    pause._drain_budget = lambda: .1
    calls = []
    pause._ask_to_drain = lambda e: calls.append(('drain', e['pid'])) or True
    pause._disarm = lambda e: calls.append(('disarm', e['pid']))
    return recovery, owed, calls, parents, pause, records, modules


@pytest.mark.parametrize('unsafe', ['before-ack', 'configuration', 'foreign-home', 'changed-profile', 'service-key',
                                  'unrelated-child', 'updater-ancestor', 'runtime-birth', 'pid-reuse'])
def test_gateway_successor_cannot_gain_custody_from_label_alone(gateway_successor, unsafe):
    import threading
    recovery, entry, calls, parents, pause, records, modules = gateway_successor
    if unsafe == 'before-ack': entry['drain_acknowledged'] = False
    if unsafe == 'configuration': Path(entry['plist']).write_bytes(b'changed')
    original = pause._discover_launchd
    if unsafe in {'foreign-home', 'changed-profile', 'service-key'}:
        field, value = {'foreign-home': ('home', '/foreign'), 'changed-profile': ('profile', 'foreign'), 'service-key': ('label', 'foreign')}[unsafe]
        pause._discover_launchd = lambda: [{**original()[0], field: value}]
    if unsafe == 'unrelated-child': parents[42003] = 42001
    if unsafe == 'updater-ancestor': parents[os.getpid()] = 42001
    if unsafe == 'runtime-birth': modules['gateway.status'].get_running_pid_identity_strict = lambda path: (42002, -1)
    if unsafe == 'pid-reuse': entry['processes']['42002'] = {'birth': -1, 'ct': -1, 'parent': 42001}
    with pytest.raises(RuntimeError):
        recovery.settle_gateway(entry, threading.Event())
    assert calls == []
    assert recovery.path.exists()
    assert json.loads(recovery.path.read_text())['entries'][0]['phase'] == 'retiring'


def test_persisted_retiring_gateway_adopts_verified_ready_successor_without_restart(gateway_successor):
    from talaria_sidecar import agent_services as services
    recovery, entry, calls, parents, pause, records, modules = gateway_successor
    recovered = services.ServiceRecovery(recovery.root, Path(entry['home']), records, recovery.identity, pause)
    recovered.resume(lambda *args: [])
    assert not recovered.path.exists()
    assert calls == []


@pytest.mark.parametrize('publishes', [False, True])
def test_gateway_successor_waits_for_runtime_identity_before_drain(gateway_successor, monkeypatch, publishes):
    import types
    from talaria_sidecar import agent_services as services
    recovery, entry, calls, parents, pause, records, modules = gateway_successor
    status = modules['gateway.status']
    runtime = [None]
    status.get_running_pid_identity_strict = lambda path: runtime[0]
    with pytest.raises(RuntimeError, match='no verified gateway'):
        services.gateway_entries(pause._discover_launchd(), {Path(entry['home'])}, pause)
    clock = [0]
    class Waiting:
        def is_set(self): return False
        def wait(self, seconds):
            assert calls == [], 'an unpublished successor received a lifecycle request'
            assert json.loads(recovery.path.read_text())['entries'][0]['pid'] == 41002
            clock[0] += 1
            if publishes: runtime[0] = (42002, 420020)
            return False
    monkeypatch.setattr(services, 'time', types.SimpleNamespace(monotonic=lambda: clock[0]))
    pause._ask_to_drain = lambda e: calls.append(('drain', e['pid'])) or False
    with pytest.raises(RuntimeError, match='did not acknowledge' if publishes else 'gateway drain remains owed'):
        recovery.settle_gateway(entry, Waiting(), deadline=3)
    assert clock[0] == (1 if publishes else 3)
    assert calls == ([('drain', 42002)] if publishes else [])
    assert recovery.path.exists()


def test_gateway_successor_is_durable_before_drain_and_attempts_are_bounded(gateway_successor):
    import threading
    recovery, entry, calls, parents, pause, records, modules = gateway_successor
    def drain(candidate):
        saved = json.loads(recovery.path.read_text())['entries'][0]
        assert saved['pid'] == 42002 and saved['drain_acknowledged'] is False
        assert saved['retired_processes']
        calls.append(('drain', candidate['pid']))
        return False
    pause._ask_to_drain = drain
    with pytest.raises(RuntimeError, match='did not acknowledge'):
        recovery.settle_gateway(entry, threading.Event())
    assert calls == [('drain', 42002)]
    entry.update(drain_acknowledged=True, settle_attempts=8)
    parents.pop(42002)
    parents[43002] = 42001
    modules['gateway.status'].get_running_pid_identity_strict = lambda path: (43002, 430020)
    with pytest.raises(RuntimeError, match='repeatedly respawned'):
        recovery.settle_gateway(entry, threading.Event())
    assert calls == [('drain', 42002)]


@pytest.mark.parametrize('named', [False, True])
def test_native_gateway_startup_preserves_live_talaria_fence(tmp_path, named):
    from conftest import isolated_env, SIDECAR_ROOT
    home = tmp_path / 'home' / 'profiles' / 'named' if named else tmp_path / 'home'
    home.mkdir(parents=True)
    script = """import json, os, subprocess, sys
from pathlib import Path
from gateway import status
from talaria_sidecar.agent_services import gateway_fence, _verify_fence
home=Path(os.environ['HERMES_HOME'])
path=status._get_gateway_lock_path(home/'gateway.pid')
path.write_text(json.dumps({'pid':999999999,'start_time':1,'kind':'gateway','hermes_home':str(home)}))
pid_path=home/'gateway.pid';pid_path.write_bytes(path.read_bytes());original_pid=pid_path.read_bytes()
with gateway_fence({'home':str(home)}) as fence:
 assert fence is not None
 original=os.fstat(fence.fileno()).st_ino
 child=subprocess.run([sys.executable,'-c','from gateway import status; status.get_running_pid(); print(status.acquire_gateway_runtime_lock())'],capture_output=True,text=True,env=os.environ)
 assert child.returncode==0,child.stderr
 print('replacement acquired runtime lock:',child.stdout.strip(),flush=True)
 assert child.stdout.strip()=='False', 'native startup admitted a replacement despite the live Talaria fence'
 assert path.exists() and path.stat().st_ino==original
 assert json.loads(path.read_text())['kind']=='talaria-update-fence'
 assert pid_path.read_bytes()==original_pid, 'Talaria changed the gateway PID record'
 _verify_fence({'home':str(home),'pid':999999999},fence)
child=subprocess.run([sys.executable,'-c','from gateway import status; status.get_running_pid(); print(status.acquire_gateway_runtime_lock())'],capture_output=True,text=True,env=os.environ)
assert child.returncode==0 and child.stdout.strip()=='True', 'released Talaria fence prevented recovery startup'
"""
    env = isolated_env(home, PYTHONPATH=str(SIDECAR_ROOT) + os.pathsep + str(AGENT_DIR))
    result = subprocess.run([AGENT_PYTHON, '-c', script], cwd=AGENT_DIR, env=env, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr[-3000:]


@pytest.mark.parametrize('failure', ['pending-starter', 'replaced-inode', 'disarm', 'cancelled'])
def test_runtime_fence_failure_never_authorizes_source_change(gateway_successor, monkeypatch, failure):
    import threading
    from talaria_sidecar import agent_services as services
    recovery, entry, calls, parents, pause, records, modules = gateway_successor
    status = modules['gateway.status']
    releases = []
    status._try_acquire_file_lock = lambda file: True
    status._release_file_lock = lambda file: releases.append(True)
    if failure != 'pending-starter':
        monkeypatch.setattr(services, '_service_pid', lambda e: (True, None))
    if failure == 'replaced-inode':
        original = status._build_pid_record
        def publish():
            assert json.loads(recovery.path.read_text())['entries'][0]['runtime_fence_requested']
            lock = Path(entry['home']) / 'gateway.lock'
            lock.unlink(); lock.touch()
            return original()
        status._build_pid_record = publish
    if failure == 'disarm':
        def disarm(e):
            calls.append(('disarm', e['pid']))
            raise RuntimeError('synthetic disarm failure')
        pause._disarm = disarm
    stopped = threading.Event()
    if failure == 'cancelled': stopped.set()
    with pytest.raises(RuntimeError):
        recovery.settle_gateway(entry, stopped)
    assert calls == ([('disarm', 41001)] if failure == 'disarm' else [])
    assert recovery.path.exists()
    assert json.loads(recovery.path.read_text())['entries'][0]['phase'] == 'retiring'
    assert releases == ([] if failure == 'cancelled' else [True])




@pytest.mark.parametrize('manager', ['launchd'])
def test_multiple_gateway_profiles_and_backends_survive_expected_respawns(tmp_path, manager):
    with supervised_agent(tmp_path, gateway_respawn=True, gateway_profiles=2, dashboards=2, manager=manager) as (root, home, base, target, sidecar, configs):
        begun = rpc(sidecar, root, 'begin', revision=target, homes=list({c['home'] for c in configs}))
        assert begun['ok'], begun
        assert not any((Path(c['home'])/('active' if c['purpose']=='gateway' else 'backend.pid')).exists() for c in configs)
        assert not list((home/'services').glob('*/service.pid'))
        assert rpc(sidecar, root, 'git', token=begun['token'], args=['merge','--ff-only',target], timeout_ms=10000)['ok']
        assert rpc(sidecar, root, 'finish', token=begun['token'])['ok']
        assert all((Path(c['home'])/('active' if c['purpose']=='gateway' else 'backend.pid')).exists() for c in configs)
        assert not list((home/'.talaria-agent-services').glob('*.json'))
        assert all((home/'services'/c['label']/'starts').read_text().splitlines()==['start'] for c in configs)




@pytest.mark.parametrize('link', ['symbolic', 'hard'])
def test_runtime_fence_does_not_write_through_linked_files(gateway_successor, link):
    from talaria_sidecar import agent_services as services
    recovery, entry, calls, parents, pause, records, modules = gateway_successor
    victim = Path(entry['home']) / 'unrelated-file'
    victim.write_bytes(b'original unrelated content')
    lock = victim.with_name('gateway.lock')
    lock.unlink()
    if link == 'symbolic': lock.symlink_to(victim)
    else: os.link(victim, lock)
    modules['gateway.status']._try_acquire_file_lock = lambda file: True
    try:
        with services.gateway_fence(entry):
            pass
    except (OSError, RuntimeError):
        pass
    assert victim.read_bytes() == b'original unrelated content'


def test_recovery_shares_gateway_drain_budget(gateway_successor, monkeypatch):
    import copy
    import types
    from talaria_sidecar import agent_services as services
    recovery, entry, calls, parents, pause, records, modules = gateway_successor
    candidate = recovery._gateway_candidate(entry)
    entry.update(candidate, phase='retiring', drain_acknowledged=True)
    sibling = copy.deepcopy(entry)
    sibling.update(label='synthetic.second', pid=43002, service_pid=43001,
                   processes={'43001': {'birth': 430010, 'ct': 43001, 'parent': 1},
                              '43002': {'birth': 430020, 'ct': 43002, 'parent': 43001}})
    parents.update({43001: 1, 43002: 43001})
    recovery.state['entries'].append(sibling)
    recovery.save()
    clock = [0]
    class Waiting:
        def is_set(self): return False
        def wait(self, seconds): clock[0] += 1; return False
    monkeypatch.setattr(services, 'time', types.SimpleNamespace(monotonic=lambda: clock[0]))
    monkeypatch.setattr(services, 'threading', types.SimpleNamespace(Event=Waiting))
    pause._drain_budget = lambda: 3
    with pytest.raises(RuntimeError, match='gateway drain remains owed'):
        recovery.resume(lambda *args: [])
    assert clock[0] == 3, 'recovery granted a new drain budget to the next profile'
    assert calls == []
    assert len(json.loads(recovery.path.read_text())['entries']) == 2


# The native default: after-turn wait 1800 s, stop envelope 60 s, observer headroom 15 s.
NATIVE_BUDGET = 1875


@pytest.fixture
def native_drain(gateway_successor, monkeypatch):
    """The original acknowledged gateway keeps finishing native work on a controlled clock."""
    import types
    from talaria_sidecar import agent_services as services
    recovery, entry, calls, parents, pause, records, modules = gateway_successor
    status, launchd = modules['gateway.status'], modules['hermes_cli.gateway']
    parents.pop(42001); parents.pop(42002)
    parents.update({41001: 1, 41002: 41001})
    model = {'clock': 0, 'service': 41001, 'runtime': 41002, 'lock_free': True, 'events': [], 'cancel_at': None}
    discovered = {key: entry[key] for key in ('kind', 'domain', 'label', 'plist', 'home')}
    pause._discover_launchd = lambda: [{**discovered, 'pid': model['service']}] if model['service'] in parents else []
    launchd._launchd_print_service_pid = lambda *args: (True, model['service']) if model['service'] in parents else (False, None)
    status.get_running_pid_identity_strict = lambda path: (model['runtime'], model['runtime'] * 10) if model['runtime'] in parents else None
    status._try_acquire_file_lock = lambda file: model['lock_free']
    pause._disarm = lambda e: calls.append(('disarm', e['pid'])) or parents.pop(e['pid'], None)
    pause._drain_budget = lambda: NATIVE_BUDGET

    def exit_runtime():
        parents.pop(model['runtime'], None)
        model['lock_free'] = True

    def respawn():
        # launchd KeepAlive hands the unchanged job to a successor that holds the runtime lock.
        parents.pop(41001, None); parents.pop(41002, None)
        parents.update({42001: 1, 42002: 42001})
        model.update(service=42001, runtime=42002, lock_free=False)

    class Waiting:
        def is_set(self):
            return model['cancel_at'] is not None and model['clock'] >= model['cancel_at']

        def wait(self, seconds):
            model['clock'] += 1
            for event in [e for e in model['events'] if model['clock'] >= e[0]]:
                model['events'].remove(event)
                event[1]()
            return self.is_set()

    monkeypatch.setattr(services, 'time', types.SimpleNamespace(monotonic=lambda: model['clock'], sleep=lambda s: Waiting().wait(s)))
    model.update(exit=exit_runtime, respawn=respawn, waiting=Waiting)
    entry.update(phase='retiring', drain_acknowledged=True)
    recovery.save()
    return recovery, entry, calls, parents, pause, model


@pytest.mark.parametrize('case', ['idle', 'after-turn', 'stop-drain', 'successor', 'exceeded', 'cancelled', 'unacknowledged'])
def test_acknowledged_drain_settles_within_the_native_budget(native_drain, case):
    recovery, entry, calls, parents, pause, model = native_drain
    exits = {'idle': 1, 'after-turn': 1000, 'stop-drain': NATIVE_BUDGET - 5, 'successor': 1500}
    if case in exits:
        model['events'].append((exits[case], model['exit']))
    if case == 'successor':
        model['events'].append((400, model['respawn']))
    if case == 'cancelled':
        model['cancel_at'] = 500
    if case == 'unacknowledged':
        entry['drain_acknowledged'] = False
    deadline = recovery.gateway_deadline()
    try:
        recovery.settle_gateway(entry, model['waiting'](), deadline=deadline)
        outcome = 'stopped'
    except RuntimeError as exc:
        outcome = str(exc)
    saved = json.loads(recovery.path.read_text())['entries'][0]
    if case in exits:
        assert outcome == 'stopped', f'drain refused at {model["clock"]} s of a {NATIVE_BUDGET} s native budget: {outcome}'
        assert model['clock'] == exits[case] and saved['phase'] == 'stopped'
        assert calls == ([('drain', 42002), ('disarm', 42001)] if case == 'successor' else [('disarm', 41001)])
        return
    assert 'remains owed' in outcome
    assert model['clock'] == {'exceeded': NATIVE_BUDGET, 'cancelled': 500, 'unacknowledged': 0}[case]
    assert saved['phase'] == 'retiring' and calls == [] and model['runtime'] in parents


def test_profiles_share_the_longest_bounded_native_budget(native_drain, monkeypatch):
    import copy
    import types
    from talaria_sidecar import agent_services as services
    recovery, entry, calls, parents, pause, model = native_drain
    other = Path(entry['home']).parent / 'profiles' / 'second'
    sibling = copy.deepcopy(entry)
    sibling.update(label='synthetic.second', home=str(other))
    recovery.state['entries'].append(sibling)
    budgets = {entry['home']: 600, str(other): NATIVE_BUDGET}
    before = os.environ.get('HERMES_HOME')
    pause._drain_budget = lambda: budgets.get(os.environ.get('HERMES_HOME'), 45.0)
    assert recovery.gateway_deadline() == NATIVE_BUDGET, 'one profile clipped or ignored another profile\'s native budget'
    assert os.environ.get('HERMES_HOME') == before
    budgets[str(other)] = float('inf')
    assert recovery.gateway_deadline() == services.GATEWAY_DRAIN_CEILING
    # One orphan-recovery attempt still fits its recovery RPC; the retained debt drives the next attempt.
    monkeypatch.setattr(services, 'threading', types.SimpleNamespace(Event=model['waiting']))
    with pytest.raises(RuntimeError, match='gateway drain remains owed'):
        recovery.resume(lambda *args: [])
    assert model['clock'] == services.RECOVERY_DRAIN_SECONDS and calls == []


@pytest.mark.parametrize('manager', ['launchd', 'systemd'])
def test_successor_configuration_is_rechecked_before_drain(gateway_successor, monkeypatch, manager):
    import threading
    import types
    recovery, entry, calls, parents, pause, records, modules = gateway_successor
    config = Path(entry['plist'])
    if manager == 'systemd':
        label = entry.pop('label')
        entry.update(kind='systemd', scope='user', unit=label)
        pause._discover_launchd = lambda: []
        pause._discover_systemd = lambda: [{**entry, 'pid': 42001}]
        fleet = types.ModuleType('hermes_cli.update_cmd_fleet')
        fleet._unit_main_pid = lambda *args: 42001
        fleet._systemctl = lambda argv, **kwargs: types.SimpleNamespace(returncode=0, stdout=config.read_text() if 'cat' in argv else 'active')
        monkeypatch.setitem(sys.modules, 'hermes_cli.update_cmd_fleet', fleet)
    original_save = recovery.save
    def save(token=None):
        original_save(token)
        if entry.get('settle_attempts') and not entry.get('drain_acknowledged'):
            config.write_text('externally changed supervisor configuration')
    monkeypatch.setattr(recovery, 'save', save)
    with pytest.raises(RuntimeError, match='configuration changed'):
        recovery.settle_gateway(entry, threading.Event())
    assert calls == [], 'changed supervisor received a cooperative drain request'
    retained = json.loads(recovery.path.read_text())['entries'][0]
    assert retained['pid'] == 42002 and retained['phase'] == 'retiring'






@pytest.fixture
def backend_stop(supervised_inventory, monkeypatch):
    import threading
    import types
    from talaria_sidecar import agent_services as services
    from talaria_sidecar.agent_mutation import _owners
    root, home, pause, identity, rows, parents, modules = supervised_inventory
    pause._discover_launchd = lambda: []
    pause._discover_bare = lambda excluded: ([], [])
    rows.append(dict(purpose='dashboard', pid=41004, create_time=1, hermes_home=str(home), profile='default', host='127.0.0.1', port=9417, argv='hermes dashboard'))
    entry = _owners(root, {home}, pause, identity)[0]
    records = types.SimpleNamespace(identity=lambda pid: {'ct': pid}, identity_is_live=lambda p: p['pid'] in parents,
                                    tree_is_whole=lambda *args: (True, ''))
    services.bind_processes(entry, records)
    recovery = services.ServiceRecovery(root, home, records, identity, pause)
    recovery.prepare([entry], {'baselines': {'synthetic': {}}})
    events = []
    model = {'service': 41003, 'runtime': 41004, 'idle': True, 'supported': True, 'start_failure': False,
             'start_attempts': 0, 'depth': 1, 'configuration': 'original unit'}
    clock = [0.0]
    def advance(seconds): clock[0] += seconds
    pause.advance = advance
    monkeypatch.setattr(services, 'time', types.SimpleNamespace(monotonic=lambda: clock[0], sleep=advance))
    pause.model = model
    pause.ledger = lambda *args: [(dict(rows[0]), True)] if model['runtime'] in parents else []

    def spawn():
        model['start_attempts'] += 1
        if model['start_failure']:
            return subprocess.CompletedProcess([], 1, '', 'synthetic supervisor refusal')
        model['service'] += 100
        model['runtime'] = model['service'] + model['depth'] + 1
        parents[model['service']] = 1
        for pid in range(model['service'] + 1, model['runtime'] + 1):
            parents[pid] = pid - 1
        rows[0]['pid'] = model['runtime']
        return subprocess.CompletedProcess([], 0, '', '')
    pause.spawn = spawn

    dashboard = modules['hermes_cli.main_dashboard']
    dashboard._loaded_launchd_backend_jobs = lambda: [('gui/12345', entry['label'], ['hermes', 'dashboard'], model['service'])] if entry['kind'] == 'launchd' else []
    dashboard._launchd_job_owning_backend = lambda pid, cmdline, jobs, ancestors=(): jobs[0][:2] + (model['service'],) if jobs else None
    dashboard._get_systemd_service_for_pid = lambda pid: 'synthetic.dashboard' if entry['kind'] == 'systemd' and pid == model['service'] else None
    modules['hermes_cli.update_inventory']._serve_unit_matches_profile = lambda profile, unit: profile == 'default'
    dashboard._get_pid_cgroup_path = lambda pid: 'synthetic'
    dashboard._extract_scope_from_cgroup = lambda group: 'user'
    fleet_scope = types.ModuleType('hermes_cli.update_fleet_scope')
    fleet_scope.systemd_unit_hermes_home = lambda *args: str(home)
    monkeypatch.setitem(sys.modules, 'hermes_cli.update_fleet_scope', fleet_scope)
    pause._manage_cmd = lambda scope: ['systemctl', '--user']
    fleet = types.ModuleType('hermes_cli.update_cmd_fleet')
    fleet._systemctl = lambda argv, **kwargs: (subprocess.CompletedProcess(argv, 0, model['configuration'], '')
        if 'cat' in argv else spawn())
    monkeypatch.setitem(sys.modules, 'hermes_cli.update_cmd_fleet', fleet)
    original_run = subprocess.run

    def command(argv, **kwargs):
        if argv[:1] == ['launchctl']:
            if argv[1] == 'kickstart': return spawn()
            return subprocess.CompletedProcess(argv, 0, '', '')
        return original_run(argv, **kwargs)

    monkeypatch.setattr(subprocess, 'run', command)

    def request(candidate, action=None, permit=None):
        events.append(action or 'identity')
        if model.get('auth_refused'):
            raise RuntimeError('synthetic.dashboard refused authenticated backend lifecycle access (HTTP 401)')
        if not model['supported']:
            raise services.BackendLifecycleUnsupported('synthetic backend lifecycle APIs are unsupported')
        if action == 'commit':
            assert json.loads(recovery.path.read_text())['entries'][0]['phase'] == 'retiring'
        return {'ok': True, 'idle': model['idle'], 'token': 'synthetic-permit'}

    def disarm(candidate):
        saved = json.loads(recovery.path.read_text())['entries'][0]
        assert saved['backend_committed'] and saved['backend_stop_requested']
        assert (candidate['pid'], candidate['runtime_pid']) == (model['service'], model['runtime'])
        events.append('disarm')
        for pid in range(model['service'], model['runtime'] + 1):
            parents.pop(pid, None)

    monkeypatch.setattr(services, 'backend_request', request)
    monkeypatch.setattr(services, '_service_pid', lambda e: (model['service'] in parents, model['service'] if model['service'] in parents else None))
    monkeypatch.setattr(services.os, 'kill', lambda *args: pytest.fail('backend custody must use its supervisor, never direct signals'))
    pause._disarm = disarm
    return recovery, entry, threading.Event(), parents, modules, events, pause


@pytest.mark.parametrize('manager,depth,purpose', [('launchd', 0, 'dashboard'), ('launchd', 1, 'serve'),
    ('systemd', 0, 'dashboard'), ('systemd', 2, 'serve')])
def test_backend_custody_and_fresh_recovery_use_original_supervisor(backend_stop, manager, depth, purpose):
    from talaria_sidecar import agent_services as services
    recovery, entry, stopped, parents, modules, events, pause = backend_stop
    pause.model['depth'] = depth
    entry['purpose'] = purpose
    owed = recovery.state['entries'][0]
    owed['purpose'] = purpose
    if manager == 'systemd':
        for candidate in (entry, owed):
            candidate.update(kind='systemd', scope='user', unit='synthetic.dashboard')
            for key in ('domain', 'label', 'plist'):
                candidate.pop(key, None)
        owed['config_stamp'] = services._config_stamp(owed)
    # The ledger is an external Agent boundary; it reports the successor, never decides readiness.
    ledger = pause.ledger
    pause.ledger = lambda *args: [(dict(row, purpose=purpose), live) for row, live in ledger(*args)]
    recovery.save()
    services.bind_processes(entry, recovery.records)
    recovery.stop(entry, stopped)
    assert events == ['identity', 'prepare', 'commit', 'disarm']
    assert not {41003, 41004} & parents.keys()
    fresh = services.ServiceRecovery(recovery.root, entry['home'], recovery.records, recovery.identity, pause)
    assert fresh.state['entries'][0]['phase'] == 'stopped'
    fresh.resume(pause.ledger)
    assert pause.model['start_attempts'] == 1
    assert pause.model['runtime'] in parents
    assert fresh.state['entries'] == [] and not fresh.path.exists()
    fresh.resume(pause.ledger)
    assert pause.model['start_attempts'] == 1


@pytest.mark.parametrize('failure', ['busy', 'unsupported', 'source', 'dependencies', 'start', 'readiness'])
def test_backend_recovery_failure_keeps_exact_debt_until_repair(backend_stop, monkeypatch, failure):
    from talaria_sidecar import agent_services as services
    recovery, entry, stopped, parents, modules, events, pause = backend_stop
    if failure in {'busy', 'unsupported'}:
        pause.model['idle'] = failure != 'busy'
        pause.model['supported'] = failure != 'unsupported'
        with pytest.raises(RuntimeError, match='active work|unsupported'):
            recovery.stop(entry, stopped)
        assert {41003, 41004} <= parents.keys()
        assert 'disarm' not in events and pause.model['start_attempts'] == 0
        assert recovery.state['entries'] == ([] if failure == 'busy' else [recovery.state['entries'][0]])
        return
    recovery.stop(entry, stopped)
    if failure == 'source': recovery.records.tree_is_whole = lambda *args: (False, 'synthetic torn source')
    if failure == 'dependencies': recovery.state['sync_failed'] = True
    if failure == 'start': pause.model['start_failure'] = True
    if failure == 'readiness': pause.model['supported'] = False
    recovery.save()
    with pytest.raises(RuntimeError):
        recovery.resume(pause.ledger)
    assert [e['label'] for e in recovery.state['entries']] == [entry['label']]
    assert recovery.path.exists()
    assert pause.model['start_attempts'] == (1 if failure in {'start', 'readiness'} else 0)
    recovery.records.tree_is_whole = lambda *args: (True, '')
    recovery.state['sync_failed'] = False
    pause.model.update(start_failure=False, supported=True)
    recovery.resume(pause.ledger)
    assert not recovery.path.exists()


@pytest.fixture
def mutation_worker(backend_stop, monkeypatch):
    """Extend backend_stop with the native Agent protocol consumed by the real lease worker."""
    import contextlib
    import queue
    import threading
    import types
    from talaria_sidecar import agent_mutation as mutation
    from talaria_sidecar import agent_services as services
    recovery, entry, stopped, parents, modules, events, pause = backend_stop
    root, home, model = recovery.root, Path(entry['home']), pause.model
    recovery.path.unlink()
    model.update(head='a' * 40, target='b' * 40, dirty=[], fail_sync=False, commands=[])
    monkeypatch.setenv('HERMES_HOME', str(home))
    monkeypatch.setattr(sys, 'path', list(sys.path))
    records = recovery.records
    records.UNOWNED = 'unowned'
    journal = home / 'native-journal.json'
    records.tree_state = lambda root: {'pre_sha': model['head'], 'dirty_at_pause': list(model['dirty'])}
    records.adopt_orphans = lambda: (None, [])
    records.write = lambda token, **kwargs: journal.write_text(json.dumps(token))
    records.discharge = lambda token: journal.unlink(missing_ok=True)

    def record(token, adopted, claims):
        token['baselines'] = [records.tree_state(root)]
        records.write(token)

    records.record_pause = record
    records.mark_stop_requested = lambda token, pids: token.update(stop_requested=pids)
    records.mark_stop_sent = lambda token, pid: token.setdefault('stop_sent', []).append(pid)
    pause._empty_token = lambda: {}
    pause._drain_budget = lambda: 1
    monkeypatch.setattr(mutation, '_writer_ledger', lambda *args: pause.ledger())
    marker = root / 'move-marker'
    def arm_move(command, checkout, **intent):
        assert checkout == root and intent['pre'] == model['head'] and intent['target'] == model['target']
        marker.write_text(json.dumps(intent))
        return marker
    native = {
        'update_lock': types.SimpleNamespace(UpdateLock=lambda **kwargs: types.SimpleNamespace(acquire=lambda: True, release=lambda: events.append('unlock'))),
        'update_cmd_posix_pause': pause, 'update_pause_record': records, 'process_identity': recovery.identity,
        'update_custody': types.SimpleNamespace(git_argv=lambda cmd, args: [*cmd, *args]),
        'update_cmd_pause_gate': types.SimpleNamespace(_checkout_move=lambda *args, **kwargs: contextlib.nullcontext({})),
        'update_cmd_windows': types.SimpleNamespace(_resume_windows_gateways_after_update=lambda token: token.update(resume_needed=False)),
        'update_cmd_commit': types.SimpleNamespace(arm_tree_move=arm_move),
        'main': types.SimpleNamespace(),
    }
    for name, module in native.items():
        module.__file__ = str(root / 'hermes_cli' / (name + '.py'))
        monkeypatch.setitem(sys.modules, 'hermes_cli.' + name, module)
    (root / 'hermes_cli').mkdir(exist_ok=True)
    (root / 'hermes_cli/venv_sync.py').touch()

    def command(argv, root, timeout, stopped, custody):
        model['commands'].append(argv)
        if argv[1:2] in (['merge'], ['reset']) or 'hermes_cli.venv_sync' in argv:
            assert not pause.ledger(), 'a writer reached the external mutation boundary'
        if argv[1:2] in (['merge'], ['reset']):
            assert marker.exists(), 'the external source move has no prior native rollback intent'
        if 'hermes_cli.venv_sync' in argv:
            return {'ok': True, 'detail': json.dumps({'ok': not model['fail_sync'], 'detail': 'synthetic dependency result'})}
        args = argv[1:]
        assert args[0] in {'rev-parse', 'show', 'ls-tree', 'merge', 'reset', 'for-each-ref'}, argv
        if args[0] == 'rev-parse': detail = model['head']
        elif args[0] == 'show': detail = '\n'.join('def ' + name + '(): pass' for name in ('recover', 'tree_is_whole', 'adopt_orphans'))
        elif args[0] == 'ls-tree': detail = '\n'.join('hermes_cli/' + name + '.py' for name in [*native, 'venv_sync'])
        else:
            if args[0] in {'merge', 'reset'}: model['head'] = args[-1]
            detail = ''
        return {'ok': True, 'detail': detail}

    monkeypatch.setattr(mutation, '_command', command)

    def run(requests=(), binding=None, cancel_at=None):
        incoming, replies = queue.Queue(), []
        for request in requests: incoming.put(request)
        incoming.put({'action': 'finish'})
        cancelled = lambda: cancel_at is not None and services.time.monotonic() >= cancel_at
        stopped = types.SimpleNamespace(is_set=cancelled, wait=lambda seconds: pause.advance(seconds) or cancelled())
        mutation._worker(root, model['target'], {home}, incoming, stopped, replies.append, binding)
        return replies

    return run, model, recovery, entry, parents, events, pause


@pytest.mark.parametrize('mode', ['normal', 'force'])
@pytest.mark.parametrize('failure', [False, True])
def test_worker_holds_custody_through_selected_revision_and_dependency_result(mutation_worker, mode, failure):
    run, model, recovery, entry, parents, events, pause = mutation_worker
    model['fail_sync'] = failure
    args = ['merge', '--ff-only', model['target']] if mode == 'normal' else ['reset', '--hard', model['target']]
    replies = run([{'action': 'git', 'args': args}, {'action': 'sync'}])
    assert [reply['ok'] for reply in replies] == [True, True, not failure, not failure], replies
    assert model['head'] == model['target']
    assert events[:4] == ['identity', 'identity', 'prepare', 'commit']
    assert events[-1] == 'unlock'
    if failure:
        saved = json.loads(recovery.path.read_text())
        assert saved['sync_failed'] and saved['entries'][0]['phase'] == 'stopped'
        assert pause.model['start_attempts'] == 0
        assert not pause.ledger()
        model['fail_sync'] = False
        repaired = run([{'action': 'sync'}])
        assert all(reply['ok'] for reply in repaired), repaired
        assert not recovery.path.exists() and pause.ledger()
    else:
        assert not recovery.path.exists()
        assert pause.model['start_attempts'] == 1
        assert pause.ledger()


@pytest.mark.parametrize('mode', ['normal', 'force'])
@pytest.mark.parametrize('finish', [1000, None, 'cancelled'])
def test_worker_lets_an_acknowledged_gateway_finish_past_the_former_cutoff(mutation_worker, monkeypatch, mode, finish):
    """A live gateway still inside its native after-turn drain delays, never fails, the same update."""
    from talaria_sidecar import agent_mutation as mutation
    from talaria_sidecar import agent_services as services
    run, model, recovery, entry, parents, events, pause = mutation_worker
    status, launchd = sys.modules['gateway.status'], sys.modules['hermes_cli.gateway']
    root, home = recovery.root, Path(entry['home'])
    (root / 'synthetic.gateway.plist').write_bytes(b'original gateway supervisor configuration')
    (home / 'gateway.lock').touch()
    gateway = {'service': 41001, 'runtime': 41002}
    parents.update({41001: 1, 41002: 41001})
    discovered = {'kind': 'launchd', 'domain': 'gui/12345', 'label': 'synthetic.gateway',
                  'plist': str(root / 'synthetic.gateway.plist'), 'home': str(home)}
    pause._discover_launchd = lambda: [{**discovered, 'pid': gateway['service']}] if gateway['service'] in parents else []
    status.get_running_pid_identity_strict = lambda path: (gateway['runtime'], gateway['runtime'] * 10) if gateway['runtime'] in parents else None
    status._get_gateway_lock_path = lambda path: home / 'gateway.lock'
    status._try_acquire_file_lock = lambda file: True
    status._release_file_lock = lambda file: None
    status._build_pid_record = lambda: {'pid': os.getpid(), 'start_time': os.getpid() * 10}
    backend_service_pid, backend_disarm = services._service_pid, pause._disarm
    monkeypatch.setattr(services, '_service_pid', lambda e: (gateway['service'] in parents, gateway['service'] if gateway['service'] in parents else None)
                        if e.get('label') == 'synthetic.gateway' else backend_service_pid(e))
    def disarm(e):
        if e.get('label') != 'synthetic.gateway':
            return backend_disarm(e)
        events.append('gateway-disarm')
        parents.pop(e['pid'], None)
    pause._disarm = disarm
    pause._alive = lambda pid, ct: pid in parents
    pause._ask_to_drain = lambda e: events.append('gateway-drain') or True
    pause._drain_budget = lambda: NATIVE_BUDGET
    backend_run = subprocess.run
    def supervisor(argv, **kwargs):
        if argv[:2] == ['launchctl', 'kickstart'] and argv[2].endswith('/synthetic.gateway'):
            events.append('gateway-start')
            gateway.update(service=44001, runtime=44002)
            parents.update({44001: 1, 44002: 44001})
            return subprocess.CompletedProcess(argv, 0, '', '')
        return backend_run(argv, **kwargs)
    monkeypatch.setattr(subprocess, 'run', supervisor)
    monkeypatch.setattr(mutation, 'time', services.time)
    advance = pause.advance
    def tick(seconds):
        advance(1)
        if isinstance(finish, int) and services.time.monotonic() >= finish:
            parents.pop(41002, None)  # The native after-turn wait and stop drain complete.
    pause.advance = tick
    args = ['merge', '--ff-only', model['target']] if mode == 'normal' else ['reset', '--hard', model['target']]
    replies = run([{'action': 'git', 'args': args}, {'action': 'sync'}], cancel_at=500 if finish == 'cancelled' else None)
    progress = [reply for reply in replies if 'progress' in reply]
    results = [reply for reply in replies if 'progress' not in reply]
    if isinstance(finish, int):
        assert results and results[0]['ok'], f'begin refused while the gateway was inside its native drain budget: {results}'
        assert [reply['ok'] for reply in results] == [True, True, True, True], results
        assert model['head'] == model['target']
        assert progress == [{'progress': {'phase': 'gateway_drain', 'deadline_seconds': NATIVE_BUDGET, 'services': ['synthetic.gateway']}}]
        assert events.index('gateway-disarm') < events.index('gateway-start')
        assert gateway['runtime'] == 44002 and pause.model['start_attempts'] == 1 and pause.ledger()
        assert not recovery.path.exists()
        return
    # An exceeded native budget or a lost lease refuses the update once; unwind spends no second budget.
    assert [reply['ok'] for reply in results] == [False], results
    assert 'Gateway drain has not completed' in results[0]['detail']
    assert model['head'] != model['target'] and not any(argv[1:2] in (['merge'], ['reset']) for argv in model['commands'])
    ended = NATIVE_BUDGET if finish is None else 500
    assert ended <= services.time.monotonic() < ended + services.STOP_SECONDS
    assert 'gateway-disarm' not in events and 41002 in parents
    saved = json.loads(recovery.path.read_text())
    assert [(e['label'], e['phase'], e['drain_acknowledged']) for e in saved['entries']] == [('synthetic.gateway', 'retiring', True)]
    assert pause.model['start_attempts'] == 1 and pause.ledger(), 'the stopped dashboard was not resumed'


@pytest.mark.parametrize('changed', ['revision', 'homes', 'config', 'endpoint', 'profile', 'birth', 'source'])
def test_worker_binds_legacy_refresh_to_the_complete_current_identity(mutation_worker, monkeypatch, changed):
    from talaria_sidecar import agent_services as services
    run, model, recovery, entry, parents, events, pause = mutation_worker
    model['supported'] = False
    monkeypatch.setattr(services, 'verify_listener', lambda candidate: None)
    pending = run()
    binding = pending[0]['refresh_confirmation']['binding']
    assert model['commands'] and model['head'] == 'a' * 40
    assert 'disarm' not in events and not recovery.path.exists()
    if changed == 'revision': model['target'] = 'c' * 40
    elif changed == 'source': model['dirty'].append('local.txt')
    elif changed == 'config': Path(entry['plist']).write_text('changed configuration')
    elif changed == 'endpoint':
        ledger = pause.ledger
        pause.ledger = lambda *args: [(dict(row, port=9420), live) for row, live in ledger(*args)]
    elif changed == 'profile':
        pause.ledger = lambda *args: [(dict(pid=41004, create_time=1, purpose='dashboard', hermes_home=entry['home'], profile='foreign', host='127.0.0.1', port=9417, argv='hermes dashboard'), True)]
    elif changed == 'birth':
        monkeypatch.setattr(sys.modules['gateway.status'], 'get_process_start_time', lambda pid: pid * 10 + 1)
    else:
        # A changed profile scope cannot discover the consented process.
        monkeypatch.setattr(sys.modules['hermes_cli.dashboard_procs'], '_hermes_home_for_pid', lambda pid: str(recovery.root / 'foreign'))
    replies = run(binding=binding)
    assert replies[-1]['ok'] is False, replies
    assert 'disarm' not in events
    assert not recovery.path.exists()
    assert model['head'] == 'a' * 40


@pytest.mark.parametrize('mode', ['normal', 'force'])
@pytest.mark.parametrize('depth', [0, 2])
def test_worker_refreshes_only_the_consented_incarnation_before_the_original_update(mutation_worker, monkeypatch, mode, depth):
    from talaria_sidecar import agent_services as services
    run, model, recovery, entry, parents, events, pause = mutation_worker
    model.update(supported=False, depth=depth)
    monkeypatch.setattr(services, 'verify_listener', lambda candidate: None)
    pending = run()
    assert 'disarm' not in events
    binding = pending[0]['refresh_confirmation']['binding']
    signals = []

    def retire(pid, sig):
        saved = json.loads(recovery.path.read_text())['entries'][0]
        assert saved['legacy_refresh'] and saved['phase'] == 'refreshing'
        assert model['head'] == 'a' * 40
        assert pid == saved['pid'] == 41004 and sig == signal.SIGTERM
        signals.append(pid)
        parents.pop(41003); parents.pop(41004)
        model['supported'] = True
        pause.spawn()

    monkeypatch.setattr(services.os, 'kill', retire)
    args = ['merge', '--ff-only', model['target']] if mode == 'normal' else ['reset', '--hard', model['target']]
    replies = run([{'action': 'git', 'args': args}, {'action': 'sync'}], binding)
    assert all(reply['ok'] for reply in replies), replies
    assert model['head'] == model['target'] and signals == [41004]
    assert model['start_attempts'] == 2
    assert not recovery.path.exists()


@pytest.mark.parametrize('unsafe', ['source', 'dependencies'])
def test_worker_never_refreshes_an_unsafe_baseline(mutation_worker, monkeypatch, unsafe):
    from talaria_sidecar import agent_services as services
    run, model, recovery, entry, parents, events, pause = mutation_worker
    model['supported'] = False
    monkeypatch.setattr(services, 'verify_listener', lambda candidate: None)
    if unsafe == 'source': model['dirty'] = ['local.txt']
    else: (recovery.root / '.interrupted').touch()
    binding = run()[0]['refresh_confirmation']['binding']
    replies = run(binding=binding)
    assert not replies[-1]['ok'] and 'not safe for a legacy refresh' in replies[-1]['detail']
    assert 'disarm' not in events and not recovery.path.exists()
    assert model['head'] == 'a' * 40


def test_worker_attempts_a_failed_legacy_successor_start_once_and_preserves_debt(mutation_worker, monkeypatch):
    from talaria_sidecar import agent_services as services
    run, model, recovery, entry, parents, events, pause = mutation_worker
    model['supported'] = False
    monkeypatch.setattr(services, 'verify_listener', lambda candidate: None)
    binding = run()[0]['refresh_confirmation']['binding']
    signals = []

    def retire(pid, sig):
        assert json.loads(recovery.path.read_text())['entries'][0]['legacy_refresh']
        signals.append((pid, sig))
        parents.pop(41003); parents.pop(41004)
        model.update(supported=True, start_failure=True)

    monkeypatch.setattr(services.os, 'kill', retire)
    replies = run(binding=binding)
    assert not replies[-1]['ok'], replies
    assert model['head'] == 'a' * 40 and model['start_attempts'] == 1
    assert signals == [(41004, signal.SIGTERM)]
    saved = json.loads(recovery.path.read_text())
    assert saved['entries'][0]['legacy_refresh'] and saved['entries'][0]['phase'] == 'refreshing'
    model['start_failure'] = False
    fresh = services.ServiceRecovery(recovery.root, entry['home'], recovery.records, recovery.identity, pause)
    fresh.resume(pause.ledger)
    assert fresh.state['entries'] == []
    assert model['start_attempts'] == 2 and signals == [(41004, signal.SIGTERM)]


@pytest.mark.parametrize('running', [False, True])
def test_worker_never_starts_a_stopped_backend_or_stops_an_unauthenticated_one(mutation_worker, running):
    run, model, recovery, entry, parents, events, pause = mutation_worker
    if running: model['auth_refused'] = True
    else:
        parents.pop(41003); parents.pop(41004)
    replies = run()
    assert replies[-1]['ok'] is not running
    assert model['head'] == 'a' * 40 and model['start_attempts'] == 0
    assert 'disarm' not in events and not recovery.path.exists()
    if running:
        assert 'HTTP 401' in replies[-1]['detail']
        assert {41003, 41004} <= parents.keys()


@pytest.mark.parametrize('unsafe', ['unknown-owner', 'foreign-home', 'corrupt-ledger'])
def test_worker_refuses_unprovable_writer_ownership_before_any_stop(mutation_worker, unsafe):
    run, model, recovery, entry, parents, events, pause = mutation_worker
    ledger = pause.ledger
    if unsafe == 'corrupt-ledger':
        def unreadable(*args): raise ValueError('synthetic unreadable native ledger')
        pause.ledger = unreadable
    else:
        change = {'purpose': 'cli'} if unsafe == 'unknown-owner' else {'hermes_home': str(recovery.root / 'foreign')}
        pause.ledger = lambda *args: [(dict(row, **change), live) for row, live in ledger(*args)]
    replies = run()
    assert not replies[-1]['ok'], replies
    assert not recovery.path.exists() and model['head'] == 'a' * 40
    assert 'disarm' not in events and model['start_attempts'] == 0
    assert {41003, 41004} <= parents.keys()


@pytest.mark.parametrize('probe', ['canonical', 'native'])
def test_worker_refuses_reused_identity_samples_before_durable_intent(mutation_worker, monkeypatch, probe):
    run, model, recovery, entry, parents, events, pause = mutation_worker
    from collections import Counter
    samples = Counter()
    def changed(pid):
        samples[pid] += 1
        value = pid + int(samples[pid] > 1)
        return {'ct': value} if probe == 'canonical' else value * 10
    if probe == 'canonical': monkeypatch.setattr(recovery.records, 'identity', changed)
    else: monkeypatch.setattr(sys.modules['gateway.status'], 'get_process_start_time', changed)
    replies = run()
    assert not replies[-1]['ok'], replies
    assert any(count > 1 for count in samples.values())
    assert not recovery.path.exists() and model['head'] == 'a' * 40
    assert 'disarm' not in events and model['start_attempts'] == 0


def test_backend_stop_timeout_retains_commit_and_fresh_recovery_retries_the_manager(backend_stop):
    from types import SimpleNamespace
    from talaria_sidecar import agent_services as services
    recovery, entry, stopped, parents, modules, events, pause = backend_stop
    disarm = pause._disarm
    pause._disarm = lambda candidate: events.append('unconfirmed-disarm')
    controlled = SimpleNamespace(is_set=lambda: False, wait=lambda seconds: pause.advance(seconds))
    with pytest.raises(RuntimeError, match='graceful stop has not completed'):
        recovery.stop(entry, controlled)
    saved = json.loads(recovery.path.read_text())['entries'][0]
    assert saved['backend_committed'] and saved['backend_stop_requested'] and saved['phase'] == 'retiring'
    assert {41003, 41004} <= parents.keys()
    pause._disarm = disarm
    fresh = services.ServiceRecovery(recovery.root, entry['home'], recovery.records, recovery.identity, pause)
    fresh.resume(pause.ledger)
    assert not fresh.path.exists() and pause.model['start_attempts'] == 1


def test_gateway_wrapper_without_a_runtime_cannot_discharge_readiness_debt(gateway_successor, monkeypatch):
    from types import SimpleNamespace
    from talaria_sidecar import agent_services as services
    recovery, entry, calls, parents, pause, records, modules = gateway_successor
    monkeypatch.setattr(modules['gateway.status'], 'get_running_pid_identity_strict', lambda path: None)
    clock = [0.0]
    def advance(seconds): clock[0] += seconds
    monkeypatch.setattr(services, 'time', SimpleNamespace(monotonic=lambda: clock[0], sleep=advance))
    before = recovery.path.read_bytes()
    with pytest.raises(RuntimeError, match='readiness is unverified'):
        recovery._wait_ready(entry, lambda *args: [])
    assert recovery.path.read_bytes() == before and calls == []


def test_backend_stop_persists_commit_and_intent_before_supervisor_action(backend_stop):
    recovery, entry, stopped, parents, modules, events, pause = backend_stop
    recovery.stop(entry, stopped)
    assert events == ['identity', 'prepare', 'commit', 'disarm']
    assert json.loads(recovery.path.read_text())['entries'][0]['phase'] == 'stopped'


@pytest.mark.parametrize('unsafe', ['config', 'birth', 'ancestry', 'successor', 'child', 'cancel'])
def test_backend_stop_rechecks_custody_after_durable_intent(backend_stop, monkeypatch, unsafe):
    from talaria_sidecar import agent_services as services
    recovery, entry, stopped, parents, modules, events, pause = backend_stop
    save = recovery.save

    def change(token=None):
        save(token)
        if not recovery.state['entries'][0].get('backend_stop_requested'):
            return
        if unsafe == 'config': Path(entry['plist']).write_text('changed')
        elif unsafe == 'birth': modules['gateway.status'].get_process_start_time = lambda pid: pid * 10 + 1
        elif unsafe == 'ancestry': parents[41004] = 1
        elif unsafe == 'successor': monkeypatch.setattr(services, '_service_pid', lambda e: (True, 41005))
        elif unsafe == 'child': parents[41005] = 41003
        else: stopped.set()

    monkeypatch.setattr(recovery, 'save', change)
    with pytest.raises(RuntimeError, match='changed|respawned|descendant|cancelled'):
        recovery.stop(entry, stopped)
    assert 'disarm' not in events
    assert json.loads(recovery.path.read_text())['entries'][0]['phase'] == 'retiring'


@pytest.mark.parametrize('failure', ['refused', 'lost-reply', 'commit-save', 'intent-save', 'management', 'stop-reply'])
def test_backend_stop_failure_retains_exact_recoverable_debt(backend_stop, monkeypatch, failure):
    from talaria_sidecar import agent_services as services
    recovery, entry, stopped, parents, modules, events, pause = backend_stop
    request, save, disarm = services.backend_request, recovery.save, pause._disarm

    def faulty_request(candidate, action=None, permit=None):
        result = request(candidate, action, permit)
        if action == 'commit':
            if failure == 'refused': return {'ok': False}
            if failure == 'lost-reply': raise RuntimeError('lost commit reply')
        return result

    def faulty_save(token=None):
        owed = recovery.state['entries'][0]
        if ((failure == 'commit-save' and owed.get('backend_committed'))
                or (failure == 'intent-save' and owed.get('backend_stop_requested'))):
            raise OSError('failed durable receipt')
        save(token)

    def faulty_disarm(candidate):
        if failure == 'management': raise RuntimeError('manager refused')
        disarm(candidate)
        if failure == 'stop-reply': raise RuntimeError('lost stop reply')

    monkeypatch.setattr(services, 'backend_request', faulty_request)
    monkeypatch.setattr(recovery, 'save', faulty_save)
    pause._disarm = faulty_disarm
    with pytest.raises((RuntimeError, OSError)):
        recovery.stop(entry, stopped)
    saved = json.loads(recovery.path.read_text())['entries'][0]
    assert (saved['pid'], saved['service_pid'], saved['phase']) == (41004, 41003, 'retiring')
    assert ('disarm' in events) == (failure == 'stop-reply')


def test_recovery_uses_same_supervisor_stop_after_committed_backend_exits(backend_stop, monkeypatch):
    from talaria_sidecar import agent_services as services
    recovery, entry, stopped, parents, modules, events, pause = backend_stop
    owed = recovery.state['entries'][0]
    owed.update(phase='retiring', backend_committed=True)
    recovery.save()
    parents.pop(entry['pid'])
    ready = []
    monkeypatch.setattr(recovery, '_ready', lambda *args: False)
    monkeypatch.setattr(services, '_start', lambda *args: ready.append('start'))
    monkeypatch.setattr(recovery, '_wait_ready', lambda *args: ready.append('verified-ready'))
    recovery.resume(lambda *args: [])
    assert events == ['disarm']
    assert ready == ['start', 'verified-ready']






@pytest.mark.parametrize('boundary', ['retiring', 'committed', 'stop-requested', 'stopped'])
def test_fresh_recovery_replays_durable_backend_stop_boundaries_once(backend_stop, monkeypatch, boundary):
    from talaria_sidecar import agent_services as services
    recovery, entry, stopped, parents, modules, events, pause = backend_stop
    save = recovery.save

    def crash(token=None):
        save(token)
        owed = recovery.state['entries'][0]
        current = ('stopped' if owed['phase'] == 'stopped' else 'stop-requested' if owed.get('backend_stop_requested')
                   else 'committed' if owed.get('backend_committed') else owed['phase'])
        if current == boundary: raise KeyboardInterrupt('synthetic worker death')

    monkeypatch.setattr(recovery, 'save', crash)
    with pytest.raises(KeyboardInterrupt):
        recovery.stop(entry, stopped)
    fresh = services.ServiceRecovery(recovery.root, Path(entry['home']), recovery.records, recovery.identity, pause)
    monkeypatch.setattr(fresh, '_ready', lambda *args: False)
    started = []
    monkeypatch.setattr(services, '_start', lambda *args: started.append(entry['label']))

    def verified(owed, ledger):
        assert not any(pid in parents for pid in (41003, 41004))
        fresh.state['entries'].remove(owed)
        fresh.save()

    monkeypatch.setattr(fresh, '_wait_ready', verified)
    fresh.resume(lambda *args: [])
    assert events.count('disarm') == 1
    assert started == [entry['label']]
    assert not fresh.path.exists()
