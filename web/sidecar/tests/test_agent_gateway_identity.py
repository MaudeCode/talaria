"""Native gateway records and inline launchers, using only disposable processes."""
import contextlib
import json
import os
import subprocess
import time
from datetime import datetime, timezone

from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, SidecarProcess, isolated_env, requires_agent


@requires_agent
def test_native_inline_successor_readiness(tmp_path):
    _native_proof(tmp_path)


@requires_agent
def test_native_retained_inline_recovery_and_rpc_admission(tmp_path):
    _native_proof(tmp_path, retained=True)


@requires_agent
def test_native_inline_default_profile_readiness(tmp_path):
    _native_proof(tmp_path, profile='default')


@requires_agent
def test_native_inline_recovery_preserves_unverified_sibling_debt(tmp_path):
    _native_proof(tmp_path, retained=True, sibling=True)


def _native_proof(tmp_path, *, retained=False, profile='named', sibling=False):
    home = tmp_path / 'home'
    served = home / 'profiles' / profile if profile != 'default' else home
    served.mkdir(parents=True)
    agent = AGENT_DIR
    if retained:
        agent = tmp_path / 'agent'
        subprocess.run(['git', '-c', 'advice.detachedHead=false', 'clone', '--quiet', '--shared', str(AGENT_DIR), str(agent)], check=True)
    script = r'''
import json, os, shlex, subprocess, sys
from pathlib import Path
from unittest.mock import patch
from hermes_cli import update_cmd_posix_pause as pause, update_pause_record as records, process_identity
from gateway import status
from talaria_sidecar import agent_services as services, agent_mutation
root=Path(os.environ['TEST_ROOT'])
home=Path(os.environ['SERVED_HOME'])
stub=root/'stub'; (stub/'hermes_cli').mkdir(parents=True)
(stub/'hermes_cli/__init__.py').write_text('__path__.append('+repr(str(Path(pause.__file__).parent))+')')
(stub/'hermes_cli/main.py').write_text('from gateway import status\n'
 'assert status.acquire_gateway_runtime_lock()\nstatus.write_pid_file()\n'
 'status.write_runtime_status(gateway_state="running")\nprint("ready",flush=True)\ninput()\n')
source=('import sys, runpy; sys.path.insert(0, '+repr(str(Path(pause.__file__).parents[1]))+'); '
 'sys.path.insert(0, '+repr(str(stub))+'); '
 "sys.argv = ['hermes', '--profile', 'named', 'gateway', 'run', '--replace']; "
 "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)").replace("'named'",repr(os.environ['PROFILE']))
child=subprocess.Popen([sys.executable,'-I','-c',source],env={**os.environ,'HERMES_HOME':str(home)},
 stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
try:
 assert child.stdout.readline().strip()=='ready', child.stderr.read() if child.poll() is not None else 'no readiness'
 runtime=status.get_running_pid_identity_strict(home/'gateway.pid')
 assert runtime and runtime[0]==child.pid
 command=status._read_process_cmdline(child.pid)
 assert status._looks_like_gateway_process(child.pid), command
 if os.environ['PROFILE']=='named':
  # Agents before v0.22.3 refuse the raw inline line; v0.22.3 decodes its argv. Talaria's own decode is the ready() matrix.
  native=status._command_line_belongs_to_profile(command,home)
  assert pause._gateway_on_home(str(home),set())==(child.pid if native else None)
 plist=root/'gateway.plist'; plist.write_text('synthetic original service')
 old=subprocess.Popen([sys.executable,'-c','input()'],stdin=subprocess.PIPE,text=True)
 old_entry=dict(pid=old.pid,service_pid=old.pid)
 try:
  old_entry['processes']=services.snapshot(old_entry,records=records)
 finally:
  old.communicate('\n',timeout=10)
 assert old.returncode==0
 entry=dict(kind='launchd',domain='synthetic',label='synthetic.gateway',plist=str(plist),purpose='gateway',
            home=str(home),phase='retiring',**old_entry)
 entry['config_stamp']=services._config_stamp(entry)
 recovery=services.ServiceRecovery(root,home,records,process_identity,pause)
 with patch.object(services,'_service_pid',return_value=(True,child.pid)), \
      patch.object(pause,'_discover_systemd',return_value=[]), \
      patch.object(pause,'_discover_launchd',side_effect=lambda: [{**entry,'pid':child.pid}]):
  assert recovery._ready(entry,lambda *a: []), 'verified inline successor must satisfy profile readiness'
  discovered=services.gateway_entries([{**entry,'pid':child.pid}],{home.resolve()},pause)
  assert len(discovered)==1 and discovered[0]['pid']==child.pid
  if os.environ['RETAINED']=='0' and os.environ['PROFILE']=='named':
   # Native command/profile parsing owns both ordinary and inline launcher variants.
   def recovery_ready():
    try: return bool(recovery._ready(entry,lambda *a: []))
    except RuntimeError: return False
   def ready(command):
    status._clear_running_pid_cache()
    with patch.object(status,'_read_process_cmdline',return_value=command):
     try: return services._gateway_home_matches(home,runtime,pause)
     except RuntimeError: return False
   for flags in ('--profile named','--profile=named','-p named'):
    for launcher in ('python -m hermes_cli.main','python /synthetic/hermes_cli/main.py'):
     assert ready(launcher+' '+flags+' gateway run'), (launcher,flags)
   for flags in ('-I -c','-X utf8 -I -c','-W ignore -c','-uc'):
    for selector in ("'--profile', 'named'", "'--profile=named'", "'-p', 'named'"):
     body=source.replace("'--profile', 'named'",selector)
     assert ready('python '+flags+' '+shlex.quote(body)), (flags,selector)
   for owner in (home,root/'home link with spaces'):
    if owner!=home: owner.symlink_to(home,target_is_directory=True)
    body=source.replace("'--profile', 'named'",repr('HERMES_HOME='+str(owner)))
    assert ready('python -I -c '+shlex.quote(body)), owner
   for command in (None, 'python -c '+shlex.quote('print("gateway run --profile named")'),
                   'python -c '+shlex.quote('import time; time.sleep(30)')+' -m hermes_cli.main --profile named gateway run',
                   'python -c '+shlex.quote(source.replace("'named'","'foreign'")),
                   'python -c '+shlex.quote(source.replace("['hermes', '--profile', 'named', 'gateway', 'run', '--replace']",'build_argv()')),
                   'python -c '+shlex.quote(source.replace("'run', '--replace'","'status', '--replace'")),
                   'python -c '+shlex.quote(source.replace("'run', '--replace'","'run', '--replace', 'HERMES_HOME=/foreign'")),
                   'python -c "unterminated'):
    assert not ready(command), command
   with patch.object(pause,'_home_of',return_value=str(root/'foreign')):
    assert not recovery_ready()
   with patch.object(status,'_process_is_stopped',return_value=True):
    assert not recovery_ready()
   for path,field,value in ((home/'gateway.pid','hermes_home',str(root/'foreign')),
                           (home/'gateway.lock','hermes_home',str(root/'foreign')),
                           (home/'gateway.pid','start_time',0),
                           (home/'gateway.lock','pid',child.pid+1)):
    original=path.read_text(); data=json.loads(original); data[field]=value; path.write_text(json.dumps(data))
    assert not ready(status._read_process_cmdline(child.pid)), (path,field)
    path.write_text(original)
   with patch.dict(sys.modules,{'gateway.status_inline_source':None}):
    assert not recovery_ready()
   alias=root/'named-link'; alias.symlink_to(home,target_is_directory=True)
   assert recovery._ready({**entry,'home':str(alias)},lambda *a: [])
   with patch.object(services,'_service_pid',return_value=(True,os.getpid())):
    try: recovery._ready(entry,lambda *a: [])
    except RuntimeError: pass
    else: raise AssertionError('foreign supervisor ancestry accepted')
   plist.write_text('changed configuration')
   try: recovery._ready(entry,lambda *a: [])
   except RuntimeError as error: assert 'configuration changed' in str(error)
   else: raise AssertionError('changed supervisor configuration accepted')
  elif os.environ['RETAINED']=='1':
   # This is the actual native checkout lock/reader on a disposable clone, not a recovery mock.
   agent_root=Path(pause.__file__).parents[1]
   recovery=services.ServiceRecovery(agent_root,Path(os.environ['HERMES_HOME']),records,process_identity,pause)
   recovery.state.update(entries=[entry],tree={'baselines':[records.tree_state(agent_root)]})
   recovery.save()
   before=subprocess.check_output(['git','-C',str(agent_root),'rev-parse','HEAD'],text=True)
   def unexpected(*args): raise AssertionError('working successor must not be started or disarmed')
   with patch.object(services,'_start',side_effect=unexpected), patch.object(pause,'_disarm',side_effect=unexpected):
    # An unreadable successor remains owed; retry uses the same retained record and live PID.
    with patch.object(status,'_read_process_cmdline',return_value=None), patch.object(services,'READY_SECONDS',0):
     try: agent_mutation._resume_worker(agent_root)
     except RuntimeError: pass
     else: raise AssertionError('unreadable successor was adopted')
    assert recovery.path.exists()
    result=agent_mutation._resume_worker(agent_root)
    assert result['ok'], result
   assert not recovery.path.exists()
   assert status.get_running_pid_identity_strict(home/'gateway.pid')[0]==child.pid
   assert subprocess.check_output(['git','-C',str(agent_root),'rev-parse','HEAD'],text=True)==before
   from talaria_sidecar.runtime import AgentRuntime
   AgentRuntime(Path(os.environ['HERMES_HOME']),agent_root).ensure_current()
   if os.environ['SIBLING']=='1':
    foreign={**entry,'profile':'foreign','label':'synthetic.foreign'}
    recovery.state['entries']=[entry,foreign]
    recovery.save()
    with patch.object(services,'READY_SECONDS',0), patch.object(services,'_start',side_effect=unexpected), patch.object(pause,'_disarm',side_effect=unexpected):
     try: agent_mutation._resume_worker(agent_root)
     except RuntimeError as error: assert 'recovery remains owed' in str(error)
     else: raise AssertionError('foreign sibling debt was cleared')
    assert [e['label'] for e in json.loads(recovery.path.read_text())['entries']]==['synthetic.foreign']
    assert status.get_running_pid_identity_strict(home/'gateway.pid')[0]==child.pid
    from talaria_sidecar.runtime import AgentRuntimeStale
    try: AgentRuntime(Path(os.environ['HERMES_HOME']),agent_root).ensure_current()
    except AgentRuntimeStale: pass
    else: raise AssertionError('unverified sibling debt did not close Agent admission')
finally:
 child.communicate('\n',timeout=10)
 assert child.returncode==0, child.stderr.read()
'''
    env = isolated_env(home, PYTHONPATH=str(SIDECAR_ROOT) + os.pathsep + str(agent),
                       TEST_ROOT=str(tmp_path), RETAINED='1' if retained else '0', HERMES_DISABLE_LAZY_INSTALLS='1',
                       SERVED_HOME=str(served), PROFILE=profile, SIBLING='1' if sibling else '0')
    result = subprocess.run([AGENT_PYTHON, '-c', script], cwd=agent, env=env,
                            capture_output=True, text=True, timeout=90)
    assert result.returncode == 0, result.stdout[-2000:] + result.stderr[-5000:]
    if retained and not sibling:
        until = int(time.time()) + 3600
        from test_usage_limits import _entry
        (home / 'auth.json').write_text(json.dumps({'version': 1, 'credential_pool': {
            'zai': [_entry('synthetic', last_status='exhausted', last_status_at=time.time(),
                            last_error_code=429, last_error_reset_at=until)]}}))
        with contextlib.closing(SidecarProcess(home, agent_dir=agent, python=AGENT_PYTHON)) as sidecar:
            from talaria_sidecar import SIDECAR_RPC_VERSION
            sidecar.result('runtime.handshake', {'rpc_version': SIDECAR_RPC_VERSION}, timeout=40)
            sidecar.result('runtime.ensure_current', {})
            params = {'provider': 'zai', 'profile_home': str(home)}
            assert sidecar.result('providers.credential_pool', params)['entries'][0]['id'] == 'synthetic'
            assert sidecar.result('providers.model_ids', {**params, 'provider': 'openai'})['model_ids']
            assert sidecar.result('usage.pool', params)['entries'][0]['status'] == 'exhausted'
            limits = sidecar.result('usage.limits', {'profile_home': str(home), 'providers': [{'slug': 'zai', 'models': ['glm-5']}]})
            assert limits['limits'] == {'zai': {'scope': 'account', 'resets_at': datetime.fromtimestamp(until, timezone.utc).isoformat().replace('+00:00', 'Z')}}
