"""Real supervisor/process lifetime tests with a disposable native-Agent protocol double."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import shutil
import types
from contextlib import contextmanager

import pytest

from conftest import AGENT_DIR, SidecarProcess, assert_matches, requires_agent, process_snapshot


def wait_for(predicate):
    deadline = time.monotonic() + 8
    while not predicate() and time.monotonic() < deadline:
        time.sleep(.02)
    assert predicate()


def wait_for_agent_exit(root, home):
    """Wait for all disposable Agent processes, including restarted supervisors."""
    wait_for(lambda: not any(str(root) in args or str(home) in args
                             for _, _, _, args in process_snapshot()))


def native_agent(tmp_path, *, git_history=True):
    root, home = tmp_path / 'agent', tmp_path / 'home'
    root.mkdir()
    home.mkdir()
    (root / 'run_agent.py').write_text('raise RuntimeError("not required for repair")\n')
    (root / 'writer.py').write_text('''import os, sys, time
from pathlib import Path
home=Path(sys.argv[1])
(home/'active.tmp').write_text(str(os.getpid()))
(home/'active.tmp').replace(home/'active')
while not (home/'stop').exists() and not (home/'pause').exists():
    if (home/'write-request').exists(): (home/'external-write').write_text('unsafe')
    time.sleep(.01)
(home/'active').unlink(missing_ok=True)
''')
    modules = {
        'main': '',
        'update_lock': '''import fcntl, os
from pathlib import Path
FD=None
class UpdateLock:
 def __init__(self,install_root=None): self.file=open((install_root or Path(__file__).parents[1])/'.native-lock','a+')
 def acquire(self):
  global FD
  inherited=os.environ.get('SYNTHETIC_UPDATE_FD')
  if inherited and os.fstat(int(inherited)).st_ino==os.fstat(self.file.fileno()).st_ino: FD=int(inherited); return True
  try: fcntl.flock(self.file,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except OSError: return False
  FD=self.file.fileno(); return True
 def acquire_checkout(self,root): return self.acquire()
 def release(self):
  gate=os.environ.get('SYNTHETIC_LOCK_RELEASE_GATE')
  if gate:
   import time
   path=Path(gate); path.with_suffix('.ready').touch()
   while not path.exists(): time.sleep(.01)
  self.file.close()
''',
        'update_custody': '''import subprocess
from . import update_lock
def git_argv(cmd,args): return [*cmd,*args]
def popen(argv,inherit_lock=False,**kw):
 if inherit_lock:
  kw['pass_fds']=(update_lock.FD,)
  import os
  kw['env']={**os.environ,'SYNTHETIC_UPDATE_FD':str(update_lock.FD)}
 return subprocess.Popen(argv,**kw)
''',
        'update_pause_record': '''import json, os, uuid
from pathlib import Path
HOME=Path(os.environ['HERMES_HOME']); UNOWNED='unowned'
def file(): return HOME/'pause-record.json'
def identity(pid=None): return {'ct':1}
def identity_is_live(ident):
 from .update_cmd_posix_pause import _active_pid
 return _active_pid()==ident['pid']
def adopt_orphans():
 if file().exists(): return json.loads(file().read_text()),[]
 return None,[]
def record_pause(token,adopted,claims):
 if adopted:
  token.update(adopted)
 token.setdefault('pause_id',uuid.uuid4().hex)
 token.setdefault('baselines',[{'pause_id':token['pause_id'],**tree_state(Path(__file__).parents[1])}]); write(token)
def mark_stop_requested(token,pids): token['stop_requested']=pids; write(token)
def mark_stop_sent(token,pid):
 token.setdefault('stop_sent',[]).append(pid)
 try: write(token)
 except OSError: pass
def write(token,owner=None):
 if (HOME/'fail-stop-record').exists() and token.get('stop_sent'): raise OSError('synthetic checkpoint failure')
 temporary=file().with_name(file().name+'.'+uuid.uuid4().hex+'.tmp')
 temporary.write_text(json.dumps({**token,'owner':owner or os.getpid()}))
 temporary.replace(file())
def discharge(token): file().unlink(missing_ok=True)
def tree_is_whole(token,root=None): return not ((HOME/'torn').exists() or (HOME/'dependency-stale').exists()),'synthetic torn tree or stale dependencies'
def record_path(): return file()
def _claims(path): return []
def orphans(): return [(file(),{'token':json.loads(file().read_text())})] if file().exists() else []
def merge_into(token,adopted):
 token=token or {}; token.update(adopted); return token
def tree_state(root):
 import subprocess
 return {'pre_sha':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'dirty_at_pause':[],'dirty_digests':{}}
def recover(argv=None):
 if file().exists():
  token=json.loads(file().read_text())
  from .update_cmd_windows import _resume_windows_gateways_after_update
  _resume_windows_gateways_after_update(token)
  if not token.get('resume_needed'): discharge(token)

''',
        'process_identity': '''import os
from pathlib import Path
def _ledger_path(): return Path(os.environ['HERMES_HOME'])/'ledger.json'
def _read_ledger(path):
 import json
 return json.loads(path.read_text()) if path.exists() else []
def install_id(root): return 'synthetic-install'
def _pid_alive_matches(pid,ct): return True
''',
        'update_cmd_posix_pause': '''import json, os
from pathlib import Path
HOME=Path(os.environ['HERMES_HOME'])
def _empty_token(): return {'platform':'posix','resume_needed':False,'profiles':{},'unmapped':[],'posix_units':[]}
def _discover_systemd(): return []
def _discover_launchd(): return []
def _left_running(units,jobs): return units,jobs,[]
def _active_pid():
 try: return int((HOME/'active').read_text())
 except FileNotFoundError: return None
def _discover_bare(pids):
 pid=_active_pid()
 return ([{'pid':pid,'argv':['synthetic-writer'],'home':str(HOME)}] if pid is not None else []),[]
def _ask_to_drain(entry):
 (HOME/'stop-asked').touch()
 record=json.loads((HOME/'pause-record.json').read_text())
 assert str(entry['pid']) in map(str,record['stop_sent']),'stop was not durably recorded before request'
 if (HOME/'refuse-drain').exists(): return False
 (HOME/'pause').touch(); return True
# Allow journal fsync and child shutdown on loaded CI workers, as in supervised_agent.
def _drain_budget(): return 4
def _alive(pid,ct): return _active_pid()==pid
def _disarm(entry): pass
''',
        'update_cmd_windows': '''import os, subprocess, sys, time
from pathlib import Path
HOME=Path(os.environ['HERMES_HOME']); ROOT=Path(__file__).parents[1]
def _resume_windows_gateways_after_update(token):
 if (HOME/'refuse-resume').exists(): raise RuntimeError('synthetic resume failure')
 (HOME/'pause').unlink(missing_ok=True)
 proc=subprocess.Popen([sys.executable,str(ROOT/'writer.py'),str(HOME)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
 deadline=time.monotonic()+5
 while not (HOME/'active').exists() and proc.poll() is None and time.monotonic()<deadline: time.sleep(.01)
 if not (HOME/'active').exists(): raise RuntimeError('resume was not ready')
 (HOME/'resumed').write_text(str(proc.pid)); token['resume_needed']=False
''',
        '_launchers': 'def resolve_store_python(root): return None\n',
        '_early_recovery': "def interrupted_pull_marker(root): return root/'.interrupted'\n",
        'update_cmd_commit': "def arm_tree_move(command,root,**kwargs): return root/'.synthetic-source-move'\n",
        'update_cmd_pause_gate': '''from contextlib import contextmanager
@contextmanager
def _checkout_move(token,*args,**kwargs):
 for baseline in token.get('baselines',[]):
  baseline.setdefault('move_targets',[]).extend(args)
 yield {}
''',
    }
    for name, content in modules.items():
        path = root / 'hermes_cli' / (name + '.py')
        path.parent.mkdir(exist_ok=True)
        path.write_text(content)
    (root / 'hermes_cli/__init__.py').write_text('')
    (root / 'gateway').mkdir()
    (root / 'gateway/__init__.py').write_text('')
    (root / 'gateway/status.py').write_text('def get_process_start_time(pid): return 1\n')
    if not git_history:
        return root, home, 'a' * 40, 'b' * 40
    env = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1',
           'GIT_AUTHOR_NAME': 'Synthetic', 'GIT_COMMITTER_NAME': 'Synthetic',
           'GIT_AUTHOR_EMAIL': 'synthetic@example.invalid', 'GIT_COMMITTER_EMAIL': 'synthetic@example.invalid'}
    def git(*args):
        return subprocess.check_output(['git', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-C', str(root), *args], env=env, text=True).strip()
    git('init', '-q')
    git('add', '.')
    git('commit', '-qm', 'synthetic base')
    base = git('rev-parse', 'HEAD')
    (root / 'VERSION').write_text('target\n')
    git('add', '.')
    git('commit', '-qm', 'synthetic target')
    target = git('rev-parse', 'HEAD')
    git('reset', '--hard', base)
    return root, home, base, target


def test_native_pause_record_stays_readable_during_publication(tmp_path, monkeypatch):
    import importlib.util

    root, home, _, _ = native_agent(tmp_path, git_history=False)
    monkeypatch.setenv('HERMES_HOME', str(home))
    spec = importlib.util.spec_from_file_location('synthetic_pause_record', root / 'hermes_cli/update_pause_record.py')
    records = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(records)
    published = records.file()
    before = json.dumps({'owner': 'original'})
    published.write_text(before)
    observations = []
    original_open = Path.open

    def observe_open(path, mode='r', *args, **kwargs):
        handle = original_open(path, mode, *args, **kwargs)
        if mode == 'w' and path.parent == home:
            observations.append(published.read_text())
        return handle

    monkeypatch.setattr(Path, 'open', observe_open)
    records.write({'resume_needed': True}, owner='unowned')
    assert observations == [before], 'readers must see the prior complete record during publication'
    assert json.loads(published.read_text()) == {'resume_needed': True, 'owner': 'unowned'}


@contextmanager
def own_agent(root, home, base, target, env=None):
    writer = subprocess.Popen([sys.executable, str(root / 'writer.py'), str(home)])
    wait_for(lambda: (home / 'active').exists())
    sidecar = SidecarProcess(home, agent_dir=root, python=sys.executable, env=env)
    try:
        yield root, home, base, target, sidecar
    finally:
        sidecar.close()
        (home / 'stop').touch()
        wait_for(lambda: not (home / 'active').exists())
        writer.wait(timeout=5)
        # Crash recovery publishes its journal before the supervisor exits.
        wait_for_agent_exit(root, home)


@pytest.fixture
def owned(tmp_path):
    with own_agent(*native_agent(tmp_path)) as owner:
        yield owner


@pytest.fixture
def native_journal_owner(tmp_path):
    root, home, _, _ = native_agent(tmp_path)
    # Run the installed Agent's unmodified journal and checkout gate against disposable source.
    for name in ['update_pause_record.py', 'update_cmd_pause_gate.py']:
        shutil.copyfile(AGENT_DIR / 'hermes_cli' / name, root / 'hermes_cli' / name)
    with (root / 'hermes_cli/update_custody.py').open('a') as file:
        file.write('\ndef run_git(command,args,**kwargs): return subprocess.run([*command,*args],**kwargs)\n')
    (root / 'hermes_constants.py').write_text("import os\nfrom pathlib import Path\ndef get_default_hermes_root(): return Path(os.environ['HERMES_HOME'])\n")
    (root / 'hermes_cli/_parser.py').write_text('def command_argv(argv): return argv\n')
    (root / 'hermes_cli/_early_recovery.py').write_text("def interrupted_pull_marker(root): return root / '.interrupted'\n")
    with (root / 'hermes_cli/update_lock.py').open('a') as file:
        file.write('''
def process_create_time(pid): return 1
def incarnation_live(pid,ct):
 from .update_cmd_posix_pause import _active_pid
 return pid==os.getpid() or _active_pid()==pid
def _try_lock(fd):
 try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB); return True
 except OSError: return False
def _unlock(fd): fcntl.flock(fd,fcntl.LOCK_UN)
def holds_checkout_lock(root): return FD is not None
def update_in_progress(root): return FD is not None
''')
    pause = root / 'hermes_cli/update_cmd_posix_pause.py'
    pause.write_text(pause.read_text().replace("record=json.loads((HOME/'pause-record.json').read_text())", "from hermes_cli import update_pause_record as records\n record=json.loads(records.record_path().read_text())['token']"))
    (root / 'payload.txt').write_text('original\n')
    env = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1'}
    def git(*args):
        return subprocess.check_output(['git', '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', '-C', str(root), *args], text=True, env=env).strip()
    git('add', '.')
    git('commit', '-qm', 'native journal baseline')
    base = git('rev-parse', 'HEAD')
    (root / 'VERSION').write_text('target\n')
    git('add', 'VERSION'); git('commit', '-qm', 'target')
    target = git('rev-parse', 'HEAD')
    git('reset', '--hard', base)
    (root / 'payload.txt').write_text('restored local change\n')
    patch = home / 'local.patch'
    patch.write_bytes(subprocess.check_output(['git', '-C', str(root), 'diff', '--binary']))
    git('checkout', '--', 'payload.txt')
    yield root, home, base, target, patch


def rpc(sidecar, root, action, **params):
    return sidecar.result('runtime.agent_mutation', {'agent_dir': str(root), 'action': action, **params}, timeout=10)


@pytest.fixture
def supervised_inventory(tmp_path, monkeypatch):
    """Native discovery boundaries; synthetic PIDs never reach a signal or real supervisor."""
    from talaria_sidecar import agent_mutation
    home = tmp_path / 'home'
    home.mkdir()
    rows = []
    parent = {41001: 1, 41002: 41001, 41003: 1, 41004: 41003, os.getpid(): os.getppid(), os.getppid(): 1}
    modules = {}
    for name in ['gateway', 'gateway.status', 'gateway.status_inline_source', 'hermes_cli', 'hermes_cli.gateway',
                 'hermes_cli.main_dashboard', 'hermes_cli.dashboard_procs', 'hermes_cli.update_inventory',
                 'hermes_cli.update_receipt']:
        module = types.ModuleType(name)
        module.__path__ = []
        modules[name] = module
        monkeypatch.setitem(sys.modules, name, module)
    status = modules['gateway.status']
    status.get_process_start_time = lambda pid: pid * 10
    status.get_running_pid_identity_strict = lambda path: (41002, 410020)
    status._read_process_cmdline = lambda pid: 'hermes gateway run'
    modules['gateway.status_inline_source'].command_line_runs_inline_source = lambda tokens: False
    modules['gateway.status_inline_source'].inline_bootstrap_argv = lambda tokens: None
    status._pid_exists = lambda pid: pid in parent
    gateway = modules['hermes_cli.gateway']
    gateway._is_pid_ancestor_of_current_process = lambda pid: False
    gateway._launchd_print_service_pid = lambda domain, label: (True, 41001 if label == 'synthetic.gateway' else 41003)
    dash = modules['hermes_cli.main_dashboard']
    dash._loaded_launchd_backend_jobs = lambda: [('gui/12345', 'synthetic.dashboard', ['hermes', 'dashboard'], 41003)]
    dash._launchd_job_owning_backend = lambda pid, cmdline, jobs, ancestors=(): ('gui/12345', 'synthetic.dashboard', 41003) if jobs else None
    dash._launchd_plist_dirs = lambda: [('agent', tmp_path)]
    dash._get_systemd_service_for_pid = lambda pid: None
    import plistlib
    (tmp_path / 'synthetic.dashboard.plist').write_bytes(plistlib.dumps({'Label': 'synthetic.dashboard', 'ProgramArguments': ['hermes', 'dashboard']}))
    modules['hermes_cli.dashboard_procs']._hermes_home_for_pid = lambda pid: str(home)
    modules['hermes_cli.dashboard_procs']._pid_environ = lambda pid: {}
    modules['hermes_cli.update_receipt']._profile_homes = lambda: [('default', home)]
    modules['hermes_cli.update_inventory']._is_desktop_ssh_ledger_entry = lambda row: False
    original_run = subprocess.run
    def run(argv, **kwargs):
        if argv[:1] == ['ps']:
            return subprocess.CompletedProcess(argv, 0, ''.join(f'{pid} {ppid}\n' for pid, ppid in parent.items()), '')
        return original_run(argv, **kwargs)
    monkeypatch.setattr(subprocess, 'run', run)
    monkeypatch.setattr(agent_mutation, '_writer_ledger', lambda root, identity: [(r, True) for r in rows])
    service = {'kind': 'launchd', 'domain': 'gui/12345', 'label': 'synthetic.gateway',
               'plist': str(tmp_path / 'synthetic.gateway.plist'), 'pid': 41001, 'home': str(home)}
    def gateway_on_home(home, excluded):
        runtime = status.get_running_pid_identity_strict(Path(home) / 'gateway.pid')
        return runtime[0] if runtime and runtime[0] not in excluded else None

    pause = types.SimpleNamespace(_discover_systemd=lambda: [], _discover_launchd=lambda: [dict(service)],
        _left_running=lambda units, jobs: (units, jobs, []), _home_of=lambda pid: str(home),
        _gateway_on_home=gateway_on_home)
    pause._discover_bare = lambda excluded: ([], [] if 41002 in excluded else ['gateway PID 41002 is supervised by synthetic.gateway'])
    identity = types.SimpleNamespace(_pid_alive_matches=lambda pid, ct, **kw: pid in parent)
    return tmp_path, home, pause, identity, rows, parent, modules


def test_wrapped_gateway_is_owned_by_its_verified_service(supervised_inventory):
    from talaria_sidecar.agent_mutation import _owners
    root, home, pause, identity, rows, _, _ = supervised_inventory
    rows.append({'purpose': 'gateway', 'pid': 41002, 'create_time': 1, 'hermes_home': str(home)})
    entries = _owners(root, {home}, pause, identity)
    assert len(entries) == 1
    assert entries[0]['pid'] == 41002
    assert entries[0]['service_pid'] == 41001


def test_supervised_dashboard_is_in_the_same_owned_writer_set(supervised_inventory):
    from talaria_sidecar.agent_mutation import _owners
    root, home, pause, identity, rows, _, _ = supervised_inventory
    pause._discover_launchd = lambda: []
    pause._discover_bare = lambda excluded: ([], [])
    rows.append({'purpose': 'dashboard', 'pid': 41004, 'create_time': 1,
                 'hermes_home': str(home), 'profile': 'default', 'host': '127.0.0.1', 'port': 9417, 'argv': 'hermes dashboard'})
    entries = _owners(root, {home}, pause, identity)
    assert len(entries) == 1
    assert entries[0]['purpose'] == 'dashboard'
    assert entries[0]['pid'] == 41004
    assert entries[0]['service_pid'] == 41003


def test_external_writer_is_quiesced_before_mutation_and_resumed_after_finish(owned):
    root, home, base, target, sidecar = owned
    begun = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
    assert_matches('runtime.agent_mutation', begun)
    assert begun['ok'], begun
    assert not (home / 'active').exists()
    (home / 'write-request').touch()
    assert rpc(sidecar, root, 'git', token=begun['token'], args=['merge', '--ff-only', target], timeout_ms=10000)['ok']
    assert not (home / 'external-write').exists()
    assert rpc(sidecar, root, 'finish', token=begun['token'])['ok']
    wait_for(lambda: (home / 'external-write').exists())
    wait_for(lambda: not (home / 'pause-record.json').exists())


@pytest.mark.parametrize('stop', ['finish', 'eof', 'kill'])
def test_pre_mutation_refusal_or_owner_exit_resumes_the_same_owned_set(owned, stop):
    root, home, base, target, sidecar = owned
    begun = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
    assert begun['ok'], begun
    if stop == 'finish':
        assert rpc(sidecar, root, 'finish', token=begun['token'])['ok']
    elif stop == 'eof':
        sidecar.proc.stdin.close()
    else:
        sidecar.proc.kill()
    wait_for(lambda: (home / 'resumed').exists())
    assert not (root / 'VERSION').exists()
    wait_for(lambda: not (home / 'pause-record.json').exists())




def test_unacknowledged_drain_never_mutates_source_and_retains_resume_debt(owned):
    root, home, base, target, sidecar = owned
    (home / 'refuse-drain').touch()
    result = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
    assert result['ok'] is False
    assert 'acknowledge' in result['detail']
    assert not (root / 'VERSION').exists()
    assert json.loads((home / 'pause-record.json').read_text())['resume_needed'] is True


def test_a_failed_best_effort_checkpoint_cannot_authorize_a_stop_request(owned):
    root, home, base, target, sidecar = owned
    (home / 'fail-stop-record').touch()
    result = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
    assert result['ok'] is False
    assert not (home / 'stop-asked').exists()
    assert (home / 'active').exists()
    assert not (root / 'VERSION').exists()


@pytest.mark.parametrize('failure', ['torn', 'refuse-resume'])
def test_unverified_tree_or_resume_keeps_the_native_recovery_record(owned, failure):
    root, home, base, target, sidecar = owned
    begun = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
    assert begun['ok'], begun
    (home / failure).touch()
    result = rpc(sidecar, root, 'finish', token=begun['token'])
    assert result['ok'] is False
    assert json.loads((home / 'pause-record.json').read_text())['resume_needed'] is True


@pytest.mark.parametrize('probe', ['alive', 'identity', 'discovery'])
def test_synthetic_owner_disappearing_during_probe_is_not_live(tmp_path, monkeypatch, probe):
    import importlib.util
    root, home, _, _ = native_agent(tmp_path, git_history=False)
    monkeypatch.setenv('HERMES_HOME', str(home))
    package = types.ModuleType('hermes_cli')
    package.__path__ = [str(root / 'hermes_cli')]
    monkeypatch.setitem(sys.modules, 'hermes_cli', package)
    loaded = {}
    for name in ('update_cmd_posix_pause', 'update_pause_record'):
        spec = importlib.util.spec_from_file_location('hermes_cli.' + name, root / 'hermes_cli' / (name + '.py'))
        module = importlib.util.module_from_spec(spec)
        monkeypatch.setitem(sys.modules, spec.name, module)
        spec.loader.exec_module(module)
        loaded[name] = module
    (home / 'active').write_text('123')
    active, read = home / 'active', Path.read_text
    def disappear(path, *args, **kwargs):
        if path == active: active.unlink(missing_ok=True)
        return read(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'read_text', disappear)
    pause, records = loaded['update_cmd_posix_pause'], loaded['update_pause_record']
    result = {'alive': lambda: pause._alive(123, 1),
              'identity': lambda: records.identity_is_live({'pid': 123, 'ct': 1}),
              'discovery': lambda: pause._discover_bare(set())}[probe]()
    expected = ([], []) if probe == 'discovery' else False
    assert result == expected, 'a vanished synthetic owner must be reported absent'


def test_failed_git_step_resumes_old_source_without_dropping_work(owned):
    root, home, base, target, sidecar = owned
    begun = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
    assert begun['ok'], begun
    result = rpc(sidecar, root, 'git', token=begun['token'], args=['merge', '--ff-only', 'missing-target'], timeout_ms=10000)
    assert result['ok'] is False
    assert rpc(sidecar, root, 'finish', token=begun['token'])['ok']
    wait_for(lambda: (home / 'resumed').exists())
    assert not (root / 'VERSION').exists()




@pytest.mark.parametrize('broken_imports', [False, True])
def test_dependency_failure_retains_the_pause_and_a_retry_resumes_it(owned, broken_imports):
    root, home, base, target, sidecar = owned
    sync = root / 'hermes_cli/venv_sync.py'
    sync.write_text("import os\nfrom pathlib import Path\n(Path(os.environ['HERMES_HOME'])/'dependency-stale').touch()\nprint('{\"ok\":false,\"detail\":\"synthetic dependency failure\"}')\n")
    begun = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
    assert begun['ok'], begun
    assert rpc(sidecar, root, 'git', token=begun['token'], args=['merge', '--ff-only', target], timeout_ms=10000)['ok']
    if broken_imports: (root / 'hermes_cli/main.py').write_text("raise ImportError('new dependencies are not installed')\n")
    assert rpc(sidecar, root, 'sync', token=begun['token'])['ok'] is False
    assert rpc(sidecar, root, 'finish', token=begun['token'])['ok'] is False
    assert json.loads((home / 'pause-record.json').read_text())['resume_needed'] is True
    assert not (home / 'active').exists()
    sync.write_text("import os\nfrom pathlib import Path\n(Path(os.environ['HERMES_HOME'])/'dependency-stale').unlink(missing_ok=True)\nprint('{\"ok\":true,\"detail\":\"\"}')\n")
    if broken_imports:
        sync.write_text(sync.read_text()+"from pathlib import Path\nPath(__file__).with_name('main.py').write_text('')\n")
    retried = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
    assert retried['ok'], retried
    assert rpc(sidecar, root, 'git', token=retried['token'], args=['reset', '--hard', target], timeout_ms=1000)['ok'] is False
    assert rpc(sidecar, root, 'sync', token=retried['token'])['ok']
    finished = rpc(sidecar, root, 'finish', token=retried['token'])
    assert finished['ok'], finished
    wait_for(lambda: (home / 'resumed').exists())
    wait_for(lambda: not (home / 'pause-record.json').exists())


def test_a_killed_supervisor_leaves_an_adoptable_native_resume_record(owned):
    import signal
    root, home, base, target, sidecar = owned
    begun = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
    assert begun['ok'], begun
    owner = json.loads((home / 'pause-record.json').read_text())['owner']
    os.kill(owner, signal.SIGKILL)
    wait_for(lambda: json.loads((home / 'pause-record.json').read_text())['resume_needed'])
    # Poll the real supervisor handle via the next command, then retry through the same sidecar.
    message, _ = sidecar.call('runtime.agent_mutation', {'action': 'git', 'agent_dir': str(root), 'token': begun['token'], 'args': ['status'], 'timeout_ms': 1000})
    assert 'error' in message
    retried = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
    assert retried['ok'], retried
    finished = rpc(sidecar, root, 'finish', token=retried['token'])
    assert finished['ok'], finished
    wait_for(lambda: (home / 'resumed').exists())


def test_a_confirmed_legacy_target_can_recover_a_paused_broken_environment(owned):
    root, home, base, _, sidecar = owned
    def git(*args):
        return subprocess.check_output(['git', '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', '-C', str(root), *args], text=True).strip()
    (root / 'hermes_cli/main.py').write_text("raise ImportError('new environment is incomplete')\n")
    (root / 'hermes_cli/venv_sync.py').write_text('print(\'{"ok":false,"detail":"sync failed"}\')\n')
    git('add', '.'); git('commit', '-qm', 'source requiring unavailable dependencies')
    broken = git('rev-parse', 'HEAD')
    (root / 'hermes_cli/main.py').write_text('')
    git('rm', 'hermes_cli/venv_sync.py'); git('commit', '-am', 'legacy environment recovery')
    legacy = git('rev-parse', 'HEAD')
    git('reset', '--hard', base)
    begun = rpc(sidecar, root, 'begin', revision=broken, homes=[str(home)])
    assert begun['ok'], begun
    assert rpc(sidecar, root, 'git', token=begun['token'], args=['merge', '--ff-only', broken], timeout_ms=10000)['ok']
    assert rpc(sidecar, root, 'sync', token=begun['token'])['ok'] is False
    assert rpc(sidecar, root, 'finish', token=begun['token'])['ok'] is False
    retried = rpc(sidecar, root, 'begin', revision=legacy, homes=[str(home)])
    assert retried['ok'], retried
    assert rpc(sidecar, root, 'git', token=retried['token'], args=['reset', '--hard', legacy], timeout_ms=10000)['ok']
    finished = rpc(sidecar, root, 'finish', token=retried['token'])
    assert finished['ok'], finished
    wait_for(lambda: (home / 'resumed').exists())


@pytest.mark.parametrize('stop', ['kill', 'cancel', 'shutdown'])
def test_owner_death_stops_and_reaps_a_mutator_before_preserving_torn_tree_debt(owned, stop):
    root, home, base, target, sidecar = owned
    hook = root / 'monitor.py'
    hook.write_text(f'''#!{sys.executable}
import os, time
from pathlib import Path
home=Path({str(home)!r})
(home/'mutator.pid').write_text(str(os.getpid()))
(home/'torn').touch()
while True:
 with (home/'mutator-writes').open('a') as out: out.write('x')
 time.sleep(.02)
''')
    hook.chmod(0o700)
    subprocess.run(['git', '-C', str(root), 'config', 'core.fsmonitor', str(hook)], check=True)
    begun = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
    assert begun['ok'], begun
    request = sidecar.request('runtime.agent_mutation', {'action': 'git', 'agent_dir': str(root), 'token': begun['token'], 'args': ['status', '--porcelain'], 'timeout_ms': 300000})
    wait_for(lambda: (home / 'mutator-writes').exists())
    if stop == 'kill':
        sidecar.proc.kill()
    elif stop == 'cancel':
        sidecar.request('rpc.cancel', {'id': request})
    else:
        sidecar.request('runtime.shutdown', {})
    wait_for(lambda: json.loads((home / 'pause-record.json').read_text()).get('owner') == 'unowned')
    before = (home / 'mutator-writes').stat().st_size
    time.sleep(.2)
    assert (home / 'mutator-writes').stat().st_size == before
    assert json.loads((home / 'pause-record.json').read_text())['resume_needed'] is True
    assert not (home / 'resumed').exists()


@pytest.mark.parametrize('service', [False, True])
def test_windows_owner_inventory_preserves_native_service_identity_or_bare_resume_command(tmp_path, monkeypatch, service):
    import types
    from talaria_sidecar.agent_mutation import _owners
    root, home = tmp_path / 'agent', tmp_path / 'home'
    root.mkdir(); home.mkdir()
    native_service = types.SimpleNamespace(gateway_pid=1234, name='synthetic-service', profile='default', service_pid=4567,
                                           service_create_time=1.25, descendant_identities=((1234, 2.5),))
    windows = types.SimpleNamespace(_discover_windows_gateways=lambda: ({}, [native_service] if service else [], set(), [1234]),
                                   list_venv_holders=lambda: [{'pid': 1234, 'kind': 'gateway'}])
    pause = types.SimpleNamespace(_home_of=lambda pid: str(home))
    identity = types.SimpleNamespace(_ledger_path=lambda: home / 'absent-ledger', _read_ledger=lambda path: [], install_id=lambda path: 'synthetic')
    monkeypatch.setitem(sys.modules, 'hermes_cli', types.ModuleType('hermes_cli'))
    monkeypatch.setitem(sys.modules, 'hermes_cli.gateway', types.SimpleNamespace(_capture_gateway_argv=lambda pid: ['hermes', 'gateway', 'run']))
    entries = _owners(root, {home}, pause, identity, windows)
    assert entries[0]['pid'] == 1234 and entries[0]['home'] == str(home)
    if service:
        assert entries[0]['service'] == 'synthetic-service'
        assert entries[0]['service_pid'] == 4567 and entries[0]['service_ct'] == 1.25
    else:
        assert entries[0]['argv'] == ['hermes', 'gateway', 'run']


@requires_agent
def test_native_journal_accepts_a_complete_atomic_restore_at_an_unmoved_head(native_journal_owner):
    root, home, base, target, patch = native_journal_owner
    with own_agent(root, home, base, target) as (*_, sidecar):
        begun = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
        assert begun['ok'], begun
        assert rpc(sidecar, root, 'git', token=begun['token'], args=['apply', str(patch)], timeout_ms=10000)['ok']
        result = rpc(sidecar, root, 'finish', token=begun['token'])
        assert result['ok'], result
        assert (root / 'payload.txt').read_text() == 'restored local change\n'
        wait_for(lambda: (home / 'resumed').exists())


@requires_agent
def test_native_journal_retains_a_killed_atomic_restore_at_an_unmoved_head(native_journal_owner, monkeypatch):
    root, home, base, target, patch = native_journal_owner
    release = home / 'release-lock'
    snapshot = process_snapshot

    def release_after_snapshot():
        rows = snapshot()
        release.touch()
        return rows

    # Keep the supervisor alive after it publishes UNOWNED. Teardown must
    # observe that child and wait for its natural exit, not just its journal.
    monkeypatch.setitem(globals(), 'process_snapshot', release_after_snapshot)
    binary = home / 'bin'
    binary.mkdir()
    real_git = shutil.which('git')
    proxy = binary / 'git'
    proxy.write_text(f'''#!{sys.executable}
import os, sys, time
from pathlib import Path
if sys.argv[1:2]==['apply'] and '--numstat' not in sys.argv:
 Path({str(root / 'payload.txt')!r}).write_text('partial restore')
 Path({str(home / 'partial')!r}).touch()
 while True: time.sleep(.01)
os.execv({real_git!r},[{real_git!r},*sys.argv[1:]])
''')
    proxy.chmod(0o700)
    with own_agent(root, home, base, target, {'PATH': str(binary) + os.pathsep + os.environ['PATH'],
                                           'SYNTHETIC_LOCK_RELEASE_GATE': str(release)}) as (*_, sidecar):
        begun = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
        assert begun['ok'], begun
        sidecar.request('runtime.agent_mutation', {'action': 'git', 'agent_dir': str(root), 'token': begun['token'], 'args': ['apply', str(patch)], 'timeout_ms': 300000})
        wait_for(lambda: (home / 'partial').exists())
        sidecar.proc.kill()
        def settled():
            journals = list(home.glob('.hermes-update-paused-gateways.*.json'))
            return (home / 'resumed').exists() or any(json.loads(path.read_text()).get('owner', {}).get('pid') == 0 for path in journals)
        wait_for(settled)
        wait_for(lambda: release.with_suffix('.ready').exists())
        assert not (home / 'resumed').exists(), 'an unmoved HEAD must not certify a half-written patch'
        assert list(home.glob('.hermes-update-paused-gateways.*.json'))


@pytest.mark.parametrize('shape', ['direct', 'nested', 'duplicate', 'symlink'])
def test_service_gateway_identity_shapes(supervised_inventory, shape):
    from talaria_sidecar.agent_mutation import _owners
    root, home, pause, identity, rows, parents, modules = supervised_inventory
    if shape == 'direct':
        modules['gateway.status'].get_running_pid_identity_strict = lambda path: (41001, 410010)
        pause._discover_bare = lambda excluded: ([], [])
    elif shape == 'nested':
        parents[41005] = 41001
        parents[41002] = 41005
    elif shape == 'duplicate':
        discover = pause._discover_launchd
        pause._discover_launchd = lambda: discover() + discover()
    else:
        alias = root / 'home-alias'
        alias.symlink_to(home, target_is_directory=True)
        home = alias
    entries = _owners(root, {home}, pause, identity)
    assert len(entries) == 1
    assert entries[0]['home'] == str(home.resolve())


@pytest.mark.parametrize('unsafe', ['foreign-home', 'unknown-home', 'unrelated-child', 'ancestry', 'parent-birth', 'child-birth', 'canonical-reuse', 'updater-ancestor'])
def test_service_gateway_ambiguity_refuses_custody(supervised_inventory, unsafe):
    from talaria_sidecar.agent_mutation import _owners
    from talaria_sidecar import agent_services
    root, home, pause, identity, rows, parents, modules = supervised_inventory
    if unsafe == 'foreign-home':
        with pytest.raises(RuntimeError, match='outside'):
            _owners(root, {root / 'foreign'}, pause, identity)
        return
    if unsafe == 'unknown-home':
        pause._home_of = lambda pid: None
        with pytest.raises(RuntimeError, match='no verified gateway'):
            _owners(root, {home}, pause, identity)
        return
    if unsafe == 'updater-ancestor':
        parents[os.getpid()] = 41001
        with pytest.raises(RuntimeError, match='updater or an ancestor'):
            _owners(root, {home}, pause, identity)
        return
    if unsafe == 'unrelated-child':
        parents[41005] = 41001
        pause._discover_bare = lambda excluded: ([], [] if 41005 in excluded else ['unrelated supervised gateway 41005'])
        with pytest.raises(RuntimeError, match='unrelated supervised'):
            _owners(root, {home}, pause, identity)
        return
    entry = _owners(root, {home}, pause, identity)[0]
    records = types.SimpleNamespace(identity=lambda pid: {'ct': pid})
    agent_services.bind_processes(entry, records)
    if unsafe == 'ancestry':
        parents[41002] = 1
    elif unsafe in {'parent-birth', 'child-birth'}:
        changed = 41001 if unsafe == 'parent-birth' else 41002
        modules['gateway.status'].get_process_start_time = lambda pid: pid * 10 + (1 if pid == changed else 0)
    else:
        records.identity = lambda pid: {'ct': pid + 1}
    for stopping in (False, True):
        with pytest.raises(RuntimeError, match='identity/ancestry changed'):
            agent_services.verify_processes(entry, records, stopping=stopping)


@pytest.mark.parametrize('unsafe', ['foreign', 'unknown-service', 'desktop', 'desktop-env', 'birth'])
def test_unmanageable_backend_is_an_actionable_refusal(supervised_inventory, unsafe):
    from talaria_sidecar.agent_mutation import _owners
    root, home, pause, identity, rows, parents, modules = supervised_inventory
    pause._discover_launchd = lambda: []
    pause._discover_bare = lambda excluded: ([], [])
    row = dict(purpose='dashboard', pid=41004, create_time=1, hermes_home=str(home), profile='default', host='127.0.0.1', port=9417, argv='hermes dashboard')
    rows.append(row)
    if unsafe == 'foreign': row['hermes_home'] = str(root / 'foreign')
    if unsafe == 'unknown-service': modules['hermes_cli.main_dashboard']._loaded_launchd_backend_jobs = lambda: []
    if unsafe == 'desktop': row['isolated'] = True
    if unsafe == 'desktop-env': modules['hermes_cli.dashboard_procs']._pid_environ = lambda pid: {'HERMES_DESKTOP': '1', 'HERMES_DASHBOARD_SESSION_TOKEN': 'synthetic-token'}
    if unsafe == 'birth': identity._pid_alive_matches = lambda *args, **kwargs: False
    with pytest.raises(RuntimeError, match='backend|Backend'):
        _owners(root, {home}, pause, identity)


@pytest.mark.parametrize('legacy', [False, True])
def test_systemd_backend_wrapper_uses_native_unit_and_profile_ownership(supervised_inventory, monkeypatch, legacy):
    from talaria_sidecar.agent_mutation import _owners
    root, home, pause, identity, rows, parents, modules = supervised_inventory
    pause._discover_launchd = lambda: []
    pause._discover_bare = lambda excluded: ([], [])
    pause._manage_cmd = lambda scope: ['systemctl', '--user']
    dash = modules['hermes_cli.main_dashboard']
    dash._loaded_launchd_backend_jobs = lambda: []
    dash._get_systemd_service_for_pid = lambda pid: 'hermes-dashboard.service' if pid == 41003 else None
    dash._get_pid_cgroup_path = lambda pid: '/user.slice/user@12345.service/hermes-dashboard.service'
    dash._extract_scope_from_cgroup = lambda group: 'user'
    modules['hermes_cli.update_inventory']._serve_unit_matches_profile = lambda profile, unit: profile == 'default' and unit == 'hermes-dashboard.service'
    scope = types.ModuleType('hermes_cli.update_fleet_scope')
    scope.systemd_unit_hermes_home = lambda command, unit: str(home)
    monkeypatch.setitem(sys.modules, scope.__name__, scope)
    row = dict(purpose='dashboard', pid=41004, create_time=1, host='127.0.0.1', port=9417, argv='hermes dashboard')
    if not legacy:
        row.update(hermes_home=str(home), profile='default')
    rows.append(row)
    entry = _owners(root, {home}, pause, identity)[0]
    assert (entry['kind'], entry['scope'], entry['unit'], entry['service_pid'], entry['pid']) == ('systemd', 'user', 'hermes-dashboard.service', 41003, 41004)
    scope.systemd_unit_hermes_home = lambda command, unit: str(root / 'foreign')
    with pytest.raises(RuntimeError, match='ownership of this backend profile'):
        _owners(root, {home}, pause, identity)
