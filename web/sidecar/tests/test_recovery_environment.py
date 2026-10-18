"""Real recovery children enter disposable environments through the native PM selector."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, isolated_env, requires_agent
from test_agent_mutation import native_agent, wait_for

pytestmark = requires_agent


def recovery_layout(tmp_path):
    root, home, _, _ = native_agent(tmp_path)
    # Use the supported release's unmodified stdlib selector, never live install facts.
    (root / 'pm').mkdir()
    for name in ('__init__.py', 'environments.py', '_venv_entry.py'):
        shutil.copyfile(AGENT_DIR / 'pm' / name, root / 'pm' / name)
    shutil.copyfile(AGENT_DIR / 'hermes_constants.py', root / 'hermes_constants.py')
    base = subprocess.check_output([AGENT_PYTHON, '-c', 'import sys; print(sys._base_executable)'], text=True).strip()
    (root / 'hermes_cli/_launchers.py').write_text(f'def resolve_store_python(root): return {base!r}\n')
    key = hashlib.sha256(str(root.resolve()).encode()).hexdigest()[:16]
    install = home / 'installs' / key

    def generation(name):
        venv = install / 'environments' / name / 'venv'
        subprocess.run([base, '-m', 'venv', '--without-pip', str(venv)], check=True, capture_output=True)
        site = next((venv / 'lib').glob('python*/site-packages'))
        source = subprocess.check_output([AGENT_PYTHON, '-c', 'import ruamel.yaml; print(next(iter(__import__("ruamel").__path__)))'], text=True).strip()
        shutil.copytree(source, site / 'ruamel')
        (site / 'selected_generation.py').write_text(f'NAME={name!r}\n')
        return venv

    old, selected = generation('old'), generation('selected')
    facts = install / 'facts.json'
    facts.write_text(json.dumps({'packages': {'venv': {'environment': str(selected)}}}))
    (root / 'hermes_cli/main.py').write_text('''import json, os, sys
from pathlib import Path
import ruamel.yaml
from selected_generation import NAME
with (Path(os.environ['HERMES_HOME'])/'entered.jsonl').open('a') as out:
 out.write(json.dumps({'generation':NAME,'python':sys.executable})+'\\n')
''')
    revision = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
    from talaria_sidecar.agent_services import recovery_path
    receipt = recovery_path(root, home)
    receipt.parent.mkdir(parents=True)
    receipt.write_text(json.dumps({'schema': 1, 'root': str(root), 'entries': [], 'sync_failed': False,
        'tree': {'baselines': [{'pre_sha': revision, 'dirty_at_pause': [], 'dirty_digests': {}}]},
        'transaction': {'revision': revision, 'homes': [str(home)], 'dependencies_verified': True, 'runtime_revision': revision}}))
    return root, home, old, selected, facts, receipt, revision, base


def recover(layout, complete=False):
    root, home, old, _, _, _, revision, _ = layout
    env = isolated_env(home, PYTHONPATH=str(SIDECAR_ROOT) + os.pathsep + str(root))
    # Keep the lifetime pipe open until recovery ends, as the real sidecar does.
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        child = subprocess.Popen([str(old / 'bin/python'), '-m', 'talaria_sidecar.agent_mutation', '--recover-current', str(root), revision if complete else ''],
                                 cwd=root, env=env, stdin=subprocess.PIPE, stdout=out, stderr=err)
        try:
            child.wait(timeout=20)
        finally:
            child.stdin.close()
            if child.poll() is None:
                child.kill()
                child.wait()
        out.seek(0); err.seek(0)
        stdout, stderr = out.read().decode(), err.read().decode()
        assert child.returncode == 0, stderr
        return json.loads(stdout)


def test_recovery_enters_new_committed_generation_and_acknowledges_runtime(tmp_path):
    layout = recovery_layout(tmp_path)
    root, home, _, selected, _, receipt, revision, base = layout
    bare = subprocess.run([base, '-c', 'import ruamel.yaml'], capture_output=True, text=True)
    assert bare.returncode != 0 and "No module named 'ruamel'" in bare.stderr
    assert (selected / 'bin/python').is_symlink(), 'exercise the POSIX venv entry symlink'
    first = recover(layout)
    assert first.get('ok') is True, first
    assert first['revision'] == revision and first['runtime_pending'] is True
    assert receipt.exists(), 'runtime acknowledgement is still owed'
    entered = json.loads((home / 'entered.jsonl').read_text().splitlines()[-1])
    assert entered == {'generation': 'selected', 'python': str(selected / 'bin/python')}
    second = recover(layout, complete=True)
    assert second['ok'] and second['runtime_pending'] is False, second
    assert not receipt.exists()
    assert subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip() == revision


@pytest.mark.parametrize('invalid', ['missing', 'malformed', 'foreign', 'absent-selection', 'abi'])
def test_invalid_committed_environment_retains_recovery_debt(tmp_path, invalid):
    layout = recovery_layout(tmp_path)
    _, home, _, selected, facts, receipt, _, _ = layout
    if invalid == 'missing': shutil.rmtree(selected)
    elif invalid == 'malformed': facts.write_text('{')
    elif invalid == 'foreign': facts.write_text(json.dumps({'packages': {'venv': {'environment': str(home)}}}))
    elif invalid == 'absent-selection': facts.write_text('{"packages":{}}')
    else:
        cfg = selected / 'pyvenv.cfg'
        cfg.write_text(cfg.read_text().replace('version = 3.', 'version = 8.'))
    result = recover(layout)
    assert result['ok'] is False, result
    assert receipt.exists()
    assert not (home / 'entered.jsonl').exists(), 'invalid selection must not reach Agent-dependent code'


def test_packaged_recovery_uses_native_environment_entry(tmp_path):
    layout = recovery_layout(tmp_path)
    root, home, _, selected, _, _, _, base = layout
    packaged_python = tmp_path / 'tool-python'
    # A disposable launcher stands in for the package-owned executable on this host.
    import shlex
    packaged_python.write_text(f'#!/bin/sh\nexec {shlex.quote(base)} "$@"\n')
    packaged_python.chmod(0o755)
    manifest = {'repo': root.name, 'venv': str(selected.relative_to(tmp_path)), 'target': 'synthetic-package',
                'runtime': {'commands': {'hermes': 'bin/hermes'}, 'storePython': packaged_python.name}}
    (tmp_path / 'manifest.json').write_text(json.dumps(manifest))
    (selected / 'bin/python').unlink()  # A package must not enter through its redirector.
    result = recover(layout, complete=True)
    assert result['ok'] is True, result
    assert json.loads((home / 'entered.jsonl').read_text().splitlines()[-1])['generation'] == 'selected'


def test_dependency_repair_reselects_before_agent_import(tmp_path):
    layout = recovery_layout(tmp_path)
    root, home, old, selected, facts, receipt, _, _ = layout
    facts.write_text(json.dumps({'packages': {'venv': {'environment': str(old)}}}))
    state = json.loads(receipt.read_text())
    state['sync_failed'] = True
    state['transaction']['dependencies_verified'] = False
    receipt.write_text(json.dumps(state))
    selected_facts = json.dumps({'packages': {'venv': {'environment': str(selected)}}})
    (root / 'hermes_cli/venv_sync.py').write_text(f'''import json
from pathlib import Path
Path({str(facts)!r}).write_text({selected_facts!r})
with Path({str(home / 'syncs')!r}).open('a') as out: out.write('sync\\n')
print(json.dumps({{'ok':True}}))
''')
    result = recover(layout, complete=True)
    assert result['ok'] is True, result
    assert (home / 'syncs').read_text() == 'sync\n'
    assert json.loads((home / 'entered.jsonl').read_text().splitlines()[-1])['generation'] == 'selected'


@pytest.mark.parametrize('in_tree', [True, False])
def test_legacy_recovery_keeps_its_venv(tmp_path, in_tree):
    layout = recovery_layout(tmp_path)
    root, home, old, _, _, receipt, _, _ = layout
    shutil.rmtree(root / 'pm')
    if in_tree:
        (root / 'venv').symlink_to(old, target_is_directory=True)
    result = recover(layout, complete=True)
    assert result['ok'] is True, result
    assert not receipt.exists()
    assert json.loads((home / 'entered.jsonl').read_text().splitlines()[-1])['generation'] == 'old'


def test_recovery_retries_corrected_selection_without_discarding_debt(tmp_path):
    layout = recovery_layout(tmp_path)
    _, _, _, _, facts, receipt, _, _ = layout
    original = facts.read_text()
    debt = receipt.read_bytes()
    facts.write_text('{')
    assert recover(layout)['ok'] is False
    assert receipt.read_bytes() == debt
    facts.write_text(original)
    assert recover(layout, complete=True)['ok'] is True
    assert not receipt.exists()


def test_server_retry_refreshes_runtime_and_restores_agent_rpcs(tmp_path):
    server = SIDECAR_ROOT.parent / 'packages/server/dist'
    if not (server / 'runtime.js').exists() or shutil.which('node') is None:
        pytest.skip('requires built server and Node 24, supplied in compatibility CI')
    layout = recovery_layout(tmp_path)
    root, home, old, _, facts, receipt, revision, _ = layout
    (root / 'pm/__init__.py').write_text('')  # Synthetic checkout has only PM's stdlib selection module.
    (root / 'run_agent.py').write_text("from selected_generation import NAME\nif NAME != 'selected': raise ImportError('old dependency generation')\nclass AIAgent: pass\n")
    (root / 'hermes_cli/auth.py').write_text("PROVIDER_REGISTRY={'synthetic':{'id':'synthetic','name':'Synthetic','auth_type':'api_key'}}\n")
    (root / 'hermes_cli/models.py').write_text("def provider_model_ids(provider,**kw): return ['synthetic-model']\n")
    (root / 'providers.py').write_text('def get_provider_profile(provider): return None\n')
    (root / 'agent').mkdir()
    (root / 'agent/__init__.py').write_text('')
    (root / 'agent/account_usage.py').write_text("def fetch_account_usage(provider,**kw): return {'provider':provider,'available':True,'windows':[{'remaining':7}], 'details':[]}\n")
    args = dict(root=str(root), home=str(home), old=str(old / 'bin/python'), revision=revision,
                facts=str(facts), selectedFacts=facts.read_text(), web=str(SIDECAR_ROOT.parent))
    script = tmp_path / 'recovery.mjs'
    script.write_text("import {createApp} from " + json.dumps((server / 'app.js').as_uri()) + ";\n"
        + "import {createDeps} from " + json.dumps((server / 'runtime.js').as_uri()) + ";\n"
        + "import {SidecarClient} from " + json.dumps((server / 'sidecar/client.js').as_uri()) + ";\n"
        + "import {discoverAgentPython} from " + json.dumps((server / 'sidecar/discover.js').as_uri()) + ";\n"
        + "import assert from 'node:assert/strict'; import {writeFileSync} from 'node:fs';\nconst a=" + json.dumps(args) + ";\n" + r'''
const logs=[],phases=[];
const env={...process.env,HERMES_HOME:a.home,HERMES_WEBUI_STATE_DIR:a.home+'/webui',HERMES_WEBUI_TEST_NETWORK_BLOCK:'1',HERMES_WEBUI_CLAUDE_PROJECTS_DIR:a.home+'/claude'};
let initial=true;
const client=new SidecarClient({python:()=>{if(initial){initial=false;return a.old}return discoverAgentPython(env,a.root,a.home)},agentDir:a.root,sidecarDir:a.web+'/sidecar',hermesHome:a.home,env,log:l=>logs.push(l)});
let deps;
try {
 await client.start(); const oldPid=client.child.pid;
 deps=await createDeps({webRoot:a.web,env,sidecar:client,pty:null,log:l=>logs.push(l),fetch:async()=>{throw Error('network forbidden')}});
 const wire=deps.updates.deps;
 wire.checkEnabled=()=>false; wire.autoApply=()=>false;
 wire.scheduleRestart=()=>{throw Error('Web restart is not authorized')};
 const notify=wire.recoveryChanged;
 wire.recoveryChanged=async state=>{
  await notify(state); phases.push(state.phase);
  if(state.phase==='waiting') writeFileSync(a.facts,a.selectedFacts);
 };
 writeFileSync(a.facts,'{');
 deps.updates.startAutoApply();
 const deadline=Date.now()+30000;
 while(deps.updates.cachedStatus().agent_recovery.phase!=='complete' && Date.now()<deadline) await new Promise(r=>setTimeout(r,25));
 assert.equal(deps.updates.cachedStatus().agent_recovery.phase,'complete',JSON.stringify({logs,phases,status:deps.updates.cachedStatus()}));
 assert.ok(phases.includes('waiting'),JSON.stringify(phases));
 assert.notEqual(client.child.pid,oldPid,'unusable old generation must refresh');
 assert.equal((await client.call('runtime.ensure_current',{})).agent_revision,a.revision);
 assert.ok((await client.call('providers.registry',{profile_home:a.home})).providers.synthetic);
 assert.deepEqual((await client.call('providers.model_ids',{provider:'synthetic',profile_home:a.home})).model_ids,['synthetic-model']);
 assert.equal((await client.call('usage.account',{provider:'synthetic',profile_home:a.home})).snapshot.windows[0].remaining,7);
 const notices=(await deps.updateNotifications.list({owner:'*',profile:'default',serverOwner:true})).notifications;
 assert.equal(notices.find(n=>n.kind==='agent_recovery')?.phase,'succeeded',JSON.stringify(notices));
 console.log('same-server selected-environment retry and Agent RPCs verified');
} finally {
 deps?.updates.stopAutoApply(); await client.close(); await deps?.sessionStore.close();
}
''')
    result = subprocess.run(['node', str(script)], env=isolated_env(home), capture_output=True, text=True, timeout=45)
    assert result.returncode == 0, (result.stdout + result.stderr)[-12000:]
    assert 'same-server selected-environment retry and Agent RPCs verified' in result.stdout
    assert not receipt.exists()
    assert subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip() == revision


def test_competing_update_lock_keeps_selected_recovery_debt(tmp_path):
    import fcntl
    layout = recovery_layout(tmp_path)
    root, _, _, _, _, receipt, _, _ = layout
    debt = receipt.read_bytes()
    with (root / '.native-lock').open('a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = recover(layout)
        assert result['ok'] is False and 'lock' in result['detail'], result
        assert receipt.read_bytes() == debt
    assert recover(layout, complete=True)['ok'] is True


def test_cancel_selected_recovery_stops_dependency_writer_and_retains_debt(tmp_path):
    from conftest import SidecarProcess, process_snapshot
    layout = recovery_layout(tmp_path)
    root, home, old, _, _, receipt, _, _ = layout
    state = json.loads(receipt.read_text())
    state['sync_failed'] = True
    receipt.write_text(json.dumps(state))
    (root / 'hermes_cli/venv_sync.py').write_text("import os,time\nfrom pathlib import Path\nPath('sync-writer.pid').write_text(str(os.getpid()))\nwhile True: time.sleep(.01)\n")
    sidecar = SidecarProcess(home, agent_dir=root, python=str(old / 'bin/python'))
    try:
        request = sidecar.request('runtime.agent_recovery', {})
        wait_for(lambda: (root / 'sync-writer.pid').exists())
        writer = int((root / 'sync-writer.pid').read_text())
        sidecar.request('rpc.cancel', {'id': request})
        wait_for(lambda: not any(pid == writer for pid, *_ in process_snapshot()))
        assert json.loads(receipt.read_text())['sync_failed'] is True
        assert not (home / 'entered.jsonl').exists()
    finally:
        sidecar.close()


@pytest.mark.parametrize('entry', ['symlink', 'anchored'])
def test_recovery_bootstrap_survives_retired_parent_venv_entry(tmp_path, entry):
    layout = recovery_layout(tmp_path)
    root, home, old, _, _, _, _, base = layout
    if entry == 'anchored':
        for executable in (old / 'bin').glob('python*'):
            executable.unlink()
            shutil.copy2(base, executable)
        # macOS anchors carry libpython beside the real-file interpreter.
        for library in (Path(base).parent.parent / 'lib').glob('libpython*'):
            if library.is_file():
                os.link(library, old / 'lib' / library.name)
        assert not (old / 'bin/python').is_symlink()
    lock = root / 'hermes_cli/update_lock.py'
    with lock.open('a') as code:
        code.write(f'''\n_acquire = UpdateLock.acquire
def acquire(self):
 result = _acquire(self)
 # Model the reviewed anchored-base identity; CPython need not expose the durable store here.
 if {entry == 'anchored'!r}:
  import sys
  sys._base_executable = sys.executable
 import shutil
 shutil.rmtree({str(old)!r}, ignore_errors=True)
 return result
UpdateLock.acquire = acquire
''')
    result = recover(layout, complete=True)
    assert result['ok'] is True, result
