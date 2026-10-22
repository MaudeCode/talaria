/** Real Agent emitter/plugin delivery is the boundary a FakeSidecar cannot establish. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SidecarClient } from '../sidecar/client.js'
import { bootTestServer } from '../test/harness.js'

const agentDir = process.env.HERMES_WEBUI_AGENT_DIR ?? ''
const python = process.env.HERMES_WEBUI_PYTHON ?? join(agentDir, 'venv/bin/python')
const emitter = join(agentDir, 'hermes_state_common.py')
const supported = existsSync(python) && existsSync(emitter) && readFileSync(emitter, 'utf8').includes('def emit_session_deleted')

it.skipIf(!supported)('a committed archive delivers one profile plugin event without finalization or database writes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'talaria-archive-plugin-'))
  onTestFinished(() => { rmSync(home, { recursive: true, force: true }) })
  const profile = join(home, 'profiles', 'archiving')
  const plugin = join(profile, 'plugins', 'archive-test')
  mkdirSync(plugin, { recursive: true })
  writeFileSync(join(plugin, 'plugin.yaml'), 'name: archive-test\nversion: 0.0.1\n')
  writeFileSync(join(profile, 'config.yaml'), 'plugins:\n  isolation: in_process\n  enabled: [archive-test]\n')
  writeFileSync(join(plugin, '__init__.py'), `import json
from hermes_constants import get_hermes_home

def register(ctx):
    def deleted(**kwargs):
        with open(get_hermes_home() / 'events.jsonl', 'a') as events:
            events.write(json.dumps(kwargs) + '\\n')
    def finalized(**kwargs):
        (get_hermes_home() / 'finalized').touch()
    ctx.register_hook('on_session_delete', deleted)
    ctx.register_hook('on_session_finalize', finalized)
`)
  const client = new SidecarClient({ python, agentDir, sidecarDir: resolve(import.meta.dirname, '../../../../sidecar'), hermesHome: home, log: () => undefined })
  onTestFinished(() => client.close())
  await client.start()
  const server = await bootTestServer({ sidecar: client, env: { HERMES_HOME: home, HERMES_WEBUI_STATE_DIR: join(home, 'webui') } })
  onTestFinished(() => server.close())
  const session = await server.deps.sessionStore.newSession({ profile: 'archiving', workspace: join(home, 'workspace') })
  session.messages = [{ role: 'user', content: 'kept transcript' }]
  session.state_db_lineage = [session.session_id, 'archive-tip']
  await server.deps.sessionStore.save(session)
  const call = client.call.bind(client)
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params, opts) => {
    if (method === 'chat.finalize_session') {
      expect((await server.deps.sessionStore.load(session.session_id))?.archived).toBe(true)
    }
    return call(method, params, opts)
  })
  onTestFinished(() => { spy.mockRestore() })
  await server.deps.sessions.archive(session.session_id, true)
  await server.deps.sessions.archive(session.session_id, true)
  await server.deps.sessions.archive(session.session_id, false)
  const eventFile = join(profile, 'events.jsonl')
  await expect.poll(() => {
    try { return readFileSync(eventFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown) } catch { return [] }
  }, { timeout: 15_000 }).toEqual([{
    session_id: session.session_id, reason: 'archive', profile: 'archiving', telemetry_schema_version: 'hermes.observer.v1',
    deleted_ids: [session.session_id, 'archive-tip'].sort(), sessions_dir: join(profile, 'sessions'),
  }])
  expect(existsSync(join(profile, 'finalized'))).toBe(false)
  expect(existsSync(join(profile, 'state.db'))).toBe(false)
  expect(existsSync(join(home, 'events.jsonl'))).toBe(false)
  expect(session.messages).toEqual([{ role: 'user', content: 'kept transcript' }])
  expect(spy.mock.calls.filter(([method]) => method === 'chat.evict_agent')).toEqual([])
}, 30_000)
