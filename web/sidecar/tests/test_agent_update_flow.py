"""Combined HTTP updater and real supervised-service proof; build Web before running."""
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest

from conftest import AGENT_PYTHON, SIDECAR_ROOT
from test_agent_services import git, supervised_agent

WEB = SIDECAR_ROOT.parent
SERVER = WEB / 'packages/server/dist'
NODE = shutil.which('node')
pytestmark = pytest.mark.skipif(not NODE or not (SERVER / 'test/harness.js').exists(),
                                reason='combined updater proof requires Node 24 and built Web contracts/server')


@pytest.mark.parametrize('mode', ['apply', 'force'])
@pytest.mark.parametrize('transient', [False, True])
def test_http_update_refreshes_legacy_services_and_finishes_selected_revision(tmp_path, mode, transient):
    with supervised_agent(tmp_path, dashboards=2, legacy=True, refresh=True, dependency_sync=True, transient=transient) as (root, home, base, target, sidecar, configs):
        # The original sidecar is idle. The server's sidecar owns the actual update RPCs.
        sidecar.close()
        git(root, 'tag', 'v1.0.0', base)
        git(root, 'tag', 'v2.0.0', target)
        origin = tmp_path / 'origin.git'
        subprocess.run(['git', 'clone', '--bare', str(root), str(origin)], check=True, capture_output=True)
        git(root, 'remote', 'add', 'origin', str(origin))
        support = tmp_path / 'web'
        (support / 'sidecar').mkdir(parents=True)
        (support / 'sidecar/agent_support.json').write_text(json.dumps({'releases': [{'releaseTag': 'v2.0.0', 'version': '2.0.0', 'sourceRevision': target}]}))
        local = root / 'run_agent.py'
        local.write_text(local.read_text() + '# retained local work\n')
        git(root, 'stash', 'push', '-m', 'synthetic retained changes')
        stashes = git(root, 'stash', 'list', '--format=%H')
        original = {c['label']: (Path(c['home']) / 'backend.pid').read_text() for c in configs[1:]}
        script = '''
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
const { bootTestServer } = await import(process.env.TEST_SERVER + '/test/harness.js')
const { SidecarClient } = await import(process.env.TEST_SERVER + '/sidecar/client.js')
const { FakeSidecar } = await import(process.env.TEST_SERVER + '/sidecar/fake.js')
const real = new SidecarClient({ python: process.env.TEST_PYTHON, agentDir: process.env.TEST_AGENT, sidecarDir: process.env.TEST_SIDECAR, hermesHome: process.env.HERMES_HOME, env: { ...process.env }, log: () => {} })
const fake = new FakeSidecar()
fake.describe = { ...fake.describe, agent_dir: process.env.TEST_AGENT }
fake.respond('runtime.agent_mutation', (params) => real.call('runtime.agent_mutation', params, { timeoutMs: 330000 }))
let server
try {
 await real.start()
 server = await bootTestServer({ sidecar: fake, env: { HERMES_HOME: process.env.HERMES_HOME } })
 const deps = server.deps.updates.deps
 deps.webRoot = process.env.TEST_SUPPORT
 deps.scheduleRestart = () => {}
 const request = async (extra = {}) => {
  const response = await server.get('/api/updates/' + process.env.TEST_MODE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'agent', version: 'v2.0.0', ...extra }) })
  assert.equal(response.status, 200)
  return response.json()
 }
 const pending = await request()
 assert.equal(pending.confirmation_required, true, JSON.stringify(pending))
 assert.equal(pending.candidate_revision, process.env.TEST_TARGET)
 assert.equal(execFileSync('git', ['-C', process.env.TEST_AGENT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), process.env.TEST_BASE)
 assert.ok(!existsSync(join(process.env.HERMES_HOME, 'signals')))
 const result = await request({ agent_refresh_token: pending.refresh_confirmation.token })
 assert.equal(result.ok, true, JSON.stringify(result))
 assert.equal(result.verified_revision, process.env.TEST_TARGET)
 assert.equal(result.gateway_restart, 'resumed')
 const history = await (await server.get('/api/update-notifications')).json()
 assert.equal(history.notifications.find((row) => row.id === result.notification_id).phase, 'succeeded')
 console.log('selected revision, refresh consent, dependency repair, restoration and HTTP completion verified')
} finally {
 await server?.close()
 await real.close()
}
'''
        env = {**os.environ, 'HERMES_HOME': str(home), 'HOME': str(tmp_path), 'TEST_SERVER': str(SERVER),
               'TEST_PYTHON': AGENT_PYTHON, 'TEST_SIDECAR': str(SIDECAR_ROOT), 'TEST_AGENT': str(root),
               'TEST_SUPPORT': str(support), 'TEST_MODE': mode, 'TEST_TARGET': target, 'TEST_BASE': base,
               'PATH': str(home / 'bin') + os.pathsep + os.environ['PATH']}
        result = subprocess.run([NODE, '--input-type=module', '-e', script], cwd=WEB, env=env, capture_output=True, text=True, timeout=120)
        assert result.returncode == 0, result.stdout[-3000:] + result.stderr[-5000:]
        assert 'HTTP completion verified' in result.stdout
        assert git(root, 'rev-parse', 'HEAD') == target
        assert git(root, 'stash', 'list', '--format=%H') == stashes
        assert (home / 'sync-runs').read_text().splitlines() == ['sync']
        assert all((Path(c['home']) / 'backend.pid').read_text() != original[c['label']] for c in configs[1:])
        assert not list((home / '.talaria-agent-services').glob('*.json'))
