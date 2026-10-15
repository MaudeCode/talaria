"""Real supervisor/process lifetime tests with a disposable native-Agent protocol double."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import shutil
from contextlib import contextmanager

import pytest

from conftest import AGENT_DIR, SidecarProcess, assert_matches, requires_agent


def wait_for(predicate):
    deadline = time.monotonic() + 8
    while not predicate() and time.monotonic() < deadline:
        time.sleep(.02)
    assert predicate()


def native_agent(tmp_path):
    root, home = tmp_path / 'agent', tmp_path / 'home'
    root.mkdir()
    home.mkdir()
    (root / 'run_agent.py').write_text('raise RuntimeError("not required for repair")\n')
    (root / 'writer.py').write_text('''import os, sys, time
from pathlib import Path
home=Path(sys.argv[1])
(home/'active').write_text(str(os.getpid()))
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
 def release(self): self.file.close()
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
def identity_is_live(ident): return (HOME/'active').exists() and int((HOME/'active').read_text())==ident['pid']
def adopt_orphans():
 if file().exists(): return json.loads(file().read_text()),[]
 return None,[]
def record_pause(token,adopted,claims):
 if adopted:
  token.update(adopted)
 token.setdefault('pause_id',uuid.uuid4().hex); write(token)
def mark_stop_requested(token,pids): token['stop_requested']=pids; write(token)
def mark_stop_sent(token,pid):
 token.setdefault('stop_sent',[]).append(pid)
 try: write(token)
 except OSError: pass
def write(token,owner=None):
 if (HOME/'fail-stop-record').exists() and token.get('stop_sent'): raise OSError('synthetic checkpoint failure')
 file().write_text(json.dumps({**token,'owner':owner or os.getpid()}))
def discharge(token): file().unlink(missing_ok=True)
def tree_is_whole(token,root=None): return not ((HOME/'torn').exists() or (HOME/'dependency-stale').exists()),'synthetic torn tree or stale dependencies'
def record_path(): return file()
def _claims(path): return []
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
def _discover_bare(pids):
 return ([{'pid':int((HOME/'active').read_text()),'argv':['synthetic-writer'],'home':str(HOME)}] if (HOME/'active').exists() else []),[]
def _ask_to_drain(entry):
 (HOME/'stop-asked').touch()
 record=json.loads((HOME/'pause-record.json').read_text())
 assert str(entry['pid']) in map(str,record['stop_sent']),'stop was not durably recorded before request'
 if (HOME/'refuse-drain').exists(): return False
 (HOME/'pause').touch(); return True
def _drain_budget(): return .2
def _alive(pid,ct): return (HOME/'active').exists() and int((HOME/'active').read_text())==pid
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
        'update_cmd_pause_gate': '''from contextlib import contextmanager
@contextmanager
def _checkout_move(token,*args,**kwargs): yield {}
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
 home=Path(os.environ['HERMES_HOME'])
 return pid==os.getpid() or ((home/'active').exists() and int((home/'active').read_text())==pid)
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


@pytest.mark.parametrize('changed', ['canonical', 'native'])
def test_reused_gateway_identity_samples_refuse_before_record_or_drain(owned, changed):
    root, home, base, target, sidecar = owned
    if changed == 'canonical':
        with (root / 'hermes_cli/update_pause_record.py').open('a') as file:
            file.write("\ndef identity(pid=None): return {'ct':2 if (HOME/'identity-reused').exists() else 1}\n")
        (root / 'gateway/status.py').write_text("import os\nfrom pathlib import Path\ndef get_process_start_time(pid):\n (Path(os.environ['HERMES_HOME'])/'identity-reused').touch()\n return 1\n")
    else:
        (root / 'gateway/status.py').write_text("calls=0\ndef get_process_start_time(pid):\n global calls\n calls+=1\n return calls\n")
    result = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
    assert result['ok'] is False, 'mismatched identity samples must not admit an update'
    assert 'identity changed' in result['detail']
    assert (home / 'active').exists(), 'the original writer must remain untouched'
    assert not (home / 'stop-asked').exists()
    assert not (home / 'pause-record.json').exists(), 'no owner was safely bound for a pause record'
    assert not (home / 'resumed').exists()
    assert not (root / 'VERSION').exists()


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


def test_failed_git_step_resumes_old_source_without_dropping_work(owned):
    root, home, base, target, sidecar = owned
    begun = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
    assert begun['ok'], begun
    result = rpc(sidecar, root, 'git', token=begun['token'], args=['merge', '--ff-only', 'missing-target'], timeout_ms=10000)
    assert result['ok'] is False
    assert rpc(sidecar, root, 'finish', token=begun['token'])['ok']
    wait_for(lambda: (home / 'resumed').exists())
    assert not (root / 'VERSION').exists()


@pytest.mark.parametrize('unsafe', ['unknown-owner', 'foreign-home', 'corrupt-ledger'])
def test_unprovable_writer_ownership_refuses_before_any_stop_or_source_mutation(owned, unsafe):
    root, home, base, target, sidecar = owned
    if unsafe == 'unknown-owner':
        (home / 'ledger.json').write_text(json.dumps([{'install': 'synthetic-install', 'purpose': 'serve', 'pid': 1234, 'create_time': 1}]))
    if unsafe == 'corrupt-ledger':
        (home / 'ledger.json').write_text('broken json')
    result = rpc(sidecar, root, 'begin', revision=target, homes=[str(home / 'another-home') if unsafe == 'foreign-home' else str(home)])
    assert result['ok'] is False
    assert (home / 'active').exists()
    assert not (home / 'pause').exists()
    wait_for(lambda: not (home / 'pause-record.json').exists())
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
    assert rpc(sidecar, root, 'finish', token=retried['token'])['ok']
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
    assert rpc(sidecar, root, 'finish', token=retried['token'])['ok']
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
    assert rpc(sidecar, root, 'finish', token=retried['token'])['ok']
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
def test_native_journal_retains_a_killed_atomic_restore_at_an_unmoved_head(native_journal_owner):
    root, home, base, target, patch = native_journal_owner
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
    with own_agent(root, home, base, target, {'PATH': str(binary) + os.pathsep + os.environ['PATH']}) as (*_, sidecar):
        begun = rpc(sidecar, root, 'begin', revision=target, homes=[str(home)])
        assert begun['ok'], begun
        sidecar.request('runtime.agent_mutation', {'action': 'git', 'agent_dir': str(root), 'token': begun['token'], 'args': ['apply', str(patch)], 'timeout_ms': 300000})
        wait_for(lambda: (home / 'partial').exists())
        sidecar.proc.kill()
        def settled():
            journals = list(home.glob('.hermes-update-paused-gateways.*.json'))
            return (home / 'resumed').exists() or any(json.loads(path.read_text()).get('owner', {}).get('pid') == 0 for path in journals)
        wait_for(settled)
        assert not (home / 'resumed').exists(), 'an unmoved HEAD must not certify a half-written patch'
        assert list(home.glob('.hermes-update-paused-gateways.*.json'))
