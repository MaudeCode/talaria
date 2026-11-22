/**
 * TAL-2661: the Agent-home backup routes. Only the owner (the `auth/gate.test.ts` matrix) in the root profile may run, read
 * or download it: the native command archives every profile. The archive streams from its private file.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { hostname, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBackupStatusSchema } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'

const servers: TestServer[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const json = { 'content-type': 'application/json' }
/** The shared statuses the App decodes (TAL-2307); this producer answers its idle and named-profile states exactly. */
const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../contracts/fixtures/agent-backup.json'), 'utf8')) as Record<'idle' | 'named_profile', { server: string }>
const status = async (s: TestServer, headers: Record<string, string> = {}) => AgentBackupStatusSchema.parse(await (await s.get('/api/agent-backup', { headers })).json())

async function boot(env: Record<string, string> = {}) {
  const sidecar = new FakeSidecar()
  const s = await bootTestServer({ sidecar, env })
  servers.push(s)
  mkdirSync(join(s.state, 'profiles', 'work'), { recursive: true })
  return { s, sidecar }
}

describe('Agent-home backup routes (TAL-2661)', () => {
  it('backs up the root home and streams the archive to the owner', async () => {
    const { s, sidecar } = await boot()
    const bytes = randomBytes(300_000)
    sidecar.respond('backup.create', (params) => {
      writeFileSync(params.output, bytes, { mode: 0o600 })
      return { status: 'completed', size_bytes: bytes.length, returncode: 0 }
    })
    expect({ ...(await status(s)), server: fixture.idle.server }).toEqual(fixture.idle)
    expect((await status(s)).server).toBe(hostname())
    const created = await s.get('/api/agent-backup', { method: 'POST', headers: json, body: JSON.stringify({ scope: 'agent_home' }) })
    expect(created.status).toBe(200)
    const { job } = AgentBackupStatusSchema.parse(await created.json())
    expect(sidecar.calls.find((c) => c.method === 'backup.create')?.params).toMatchObject({ profile_home: s.state, scope: 'agent_home' })
    await vi.waitFor(async () => { expect((await status(s)).job?.state).toBe('ready') })
    const ready = (await status(s)).job!
    const res = await s.get(`/${ready.download_url!}`)
    expect([res.status, res.headers.get('content-type'), res.headers.get('cache-control'), res.headers.get('content-disposition')])
      .toEqual([200, 'application/zip', 'no-store', `attachment; filename="${ready.file_name!}"; filename*=UTF-8''${ready.file_name!}`])
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true)
    const discarded = await s.get(`/api/agent-backup/${job!.id}`, { method: 'DELETE' })
    expect(AgentBackupStatusSchema.parse(await discarded.json()).job).toBeNull()
    expect((await s.get(`/${ready.download_url!}`)).status).toBe(404)
  })

  it('refuses a second backup while one runs', async () => {
    const { s, sidecar } = await boot()
    sidecar.respond('backup.create', (_params, _emit, opts) => new Promise((resolve) => { opts.signal?.addEventListener('abort', () => { resolve({ status: 'cancelled' }) }) }))
    const start = () => s.get('/api/agent-backup', { method: 'POST', headers: json, body: JSON.stringify({ scope: 'agent_home' }) })
    expect((await start()).status).toBe(200)
    const again = await start()
    expect([again.status, await again.json()]).toEqual([409, { error: 'An Agent-home backup is already running.', code: 'agent_backup_running' }])
  })

  it('refuses a named profile without reaching the Agent', async () => {
    const { s, sidecar } = await boot()
    const work = { cookie: 'hermes_profile=work' }
    expect({ ...(await status(s, work)), server: fixture.named_profile.server }).toEqual(fixture.named_profile)
    const res = await s.get('/api/agent-backup', { method: 'POST', headers: { ...json, ...work }, body: JSON.stringify({ scope: 'agent_home' }) })
    expect([res.status, await res.json()]).toEqual([403, { error: 'Only the root profile can back up the whole Agent home.', code: 'agent_backup_unavailable', unavailable_reason: 'named_profile' }])
    expect((await s.get(`/api/agent-backup/download?id=${'a'.repeat(32)}`, { headers: work })).status).toBe(403)
    expect(sidecar.calls.some((c) => c.method === 'backup.create')).toBe(false)
  })

  it('refuses a server pinned to one profile', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'talaria-agent-backup-isolated-')))
    dirs.push(root)
    const home = join(root, 'profiles', 'solo')
    mkdirSync(home, { recursive: true })
    const { s } = await boot({ HERMES_HOME: home, TALARIA_WEB_STATE_DIR: join(root, 'state'), TALARIA_WEB_ISOLATED_PROFILE: '1' })
    const res = await s.get('/api/agent-backup', { method: 'POST', headers: json, body: JSON.stringify({ scope: 'agent_home' }) })
    expect([res.status, ((await res.json()) as { unavailable_reason: string }).unavailable_reason]).toEqual([403, 'isolated_profile'])
  })
})
