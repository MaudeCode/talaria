import { initializeStore, useJsonStorage } from '../test/storage.js'
/**
 * Profiles across one server: visibility, profile-home escapes, per-profile workspaces and skills, the deletion
 * lifecycle, and profile-scoped session routes.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SidecarError } from '../sidecar/client.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, freshCronListingsPerTest, type TestServer } from '../test/harness.js'
import { ProfileService, splitProviderModel } from './profiles.js'
import { str } from '../util.js'
import { writeEnvFile } from '../test/env-file.js'

/** Holds a sidecar handler open: `entered` resolves once the RPC is dispatched, and `release` is safe at any time. */
function parkHandler(): { entered: Promise<void>; park: () => Promise<void>; release: () => void } {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const released = new Promise<void>((resolve) => { release = resolve })
  return { entered, park: () => { enter(); return released }, release }
}

useJsonStorage()

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json
const row = (name: string, extra: Json = {}): Json => ({ name, path: '', is_default: false, gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0, ...extra })

describe('profiles, crons, workspaces, skills, and sessions across profiles', () => {
  const cronClock = freshCronListingsPerTest()
  let s: TestServer
  let sidecar: FakeSidecar
  let configs: Map<string, Json>
  let cronJobs: Map<string, Json[]>
  let workHome = ''
  let workCookie = ''
  const skillRows = new Map<string, Json[]>()
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    configs = new Map()
    cronJobs = new Map()
    sidecar.respond('profiles.list', () => ({ profiles: [row('default', { is_default: true, path: s.state }), row('work', { path: join(s.state, 'profiles', 'work') }), row('research', { path: join(s.state, 'profiles', 'research') }), row('hidden', { visible: false, path: join(s.state, 'profiles', 'hidden') })] as never[] }))
    sidecar.respond('config.get', (params) => ({ path: join(params.profile_home, 'config.yaml'), exists: true, config: configs.get(params.profile_home) ?? {} }))
    sidecar.respond('config.set', (params) => { configs.set(params.profile_home, params.config); mkdirSync(params.profile_home, { recursive: true }); writeFileSync(join(params.profile_home, 'config.yaml'), `# ${String(Math.random())}\n`); return { ok: true as const, path: join(params.profile_home, 'config.yaml') } })
    sidecar.respond('cron.list', (params) => ({ jobs: (cronJobs.get(params.profile_home) ?? []) as never[] }))
    sidecar.respond('cron.create', (params) => { const job = { id: `job-${String(cronJobs.size + 1)}`, name: null, profile: null, toast_notifications: true, monitor: '', continuity: false, ...(params.job as Json) }; cronJobs.set(params.profile_home, [...(cronJobs.get(params.profile_home) ?? []), job]); return { job: job } })
    sidecar.respond('cron.update', (params) => { for (const jobs of cronJobs.values()) { const job = jobs.find((j) => j.id === params.job_id); if (job) { Object.assign(job, params.updates); return { job: job as never } } } throw new Error('missing') })
    sidecar.respond('skills.list', (params) => ({ success: true, skills: (skillRows.get(params.profile_home) ?? []).map((row) => ({ locked: false, ...row })) as never[], categories: [], count: (skillRows.get(params.profile_home) ?? []).length }))
    sidecar.respond('skills.find', (params) => { const dir = join(params.profile_home, 'skills', params.name); return { found: existsSync(dir), skill_dir: existsSync(dir) ? dir : null, skill_md: existsSync(dir) ? join(dir, 'SKILL.md') : null } })
    s = await bootTestServer({ sidecar, now: cronClock.now })
    writeFileSync(join(s.state, 'config.yaml'), '# seed\n')
    workHome = join(s.state, 'profiles', 'work')
    for (const p of ['work', 'research', 'hidden']) { mkdirSync(join(s.state, 'profiles', p), { recursive: true }); writeFileSync(join(s.state, 'profiles', p, 'config.yaml'), '# seed\n') }
    const res = await post(s, '/api/profile/switch', { name: 'work' })
    expect(res.status, await res.clone().text()).toBe(200)
    workCookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    expect(workCookie).toMatch(/^hermes_profile=work/)
  })
  afterAll(() => s.close())
  const asWork = (): Record<string, string> => ({ cookie: workCookie })
  /** The activity check a profile delete refuses on: a run, a stream, or detached profile work. */
  const runsActive = (name: string): boolean => (s.deps.profiles as unknown as { deps: { profileRunsActive: (n: string) => boolean } }).deps.profileRunsActive(name)
  /** A full request round trip: work the server was about to do without waiting has run by its end. */
  const roundTrip = async (): Promise<void> => { expect((await s.get('/health')).status).toBe(200) }

  it('a profile the Agent marks visible:false is listed hidden', async () => {
    const profiles = (await json(await s.get('/api/profiles'))).profiles as Json[]
    expect(profiles.find((p) => p.name === 'hidden')?.visible).toBe(false)
    expect(profiles.find((p) => p.name === 'work')?.visible).toBe(true)
  })

  it('the default profile row stays visible', async () => {
    const profiles = (await json(await s.get('/api/profiles'))).profiles as Json[]
    expect(profiles.find((p) => p.name === 'default')).toMatchObject({ visible: true, is_default: true })
  })

  it('a profiles/<name> symlink that escapes the profiles root is refused on switch and never used as a home', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'talaria-escape-'))
    writeFileSync(join(outside, 'config.yaml'), '# outside\n')
    symlinkSync(outside, join(s.state, 'profiles', 'escape'))
    symlinkSync(join(outside, 'missing'), join(s.state, 'profiles', 'dangling'))
    symlinkSync(workHome, join(s.state, 'profiles', 'inside'))
    try {
      for (const name of ['escape', 'dangling']) {
        const res = await post(s, '/api/profile/switch', { name })
        expect(res.status, name).toBe(400)
        expect(await res.text(), name).toContain('outside the profiles directory')
        expect(res.headers.get('set-cookie'), name).toBeNull()
        expect(() => s.deps.profileHome(name), name).toThrow('outside the profiles directory')
        const created = await post(s, '/api/profile/create', { name, base_url: 'https://example.invalid' })
        expect(created.status, name).toBe(400)
        expect(await created.text(), name).toContain('outside the profiles directory')
        const session = await post(s, '/api/session/new', { profile: name, worktree: false })
        expect(session.status, name).toBe(400)
        expect(await session.text(), name).toContain('outside the profiles directory')
      }
      expect(s.deps.profileHome('inside')).toBe(realpathSync(workHome))
      expect((await post(s, '/api/profile/switch', { name: 'inside' })).status).toBe(200)
    } finally {
      for (const name of ['escape', 'dangling', 'inside']) rmSync(join(s.state, 'profiles', name), { force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('a request under a cookie whose profile home later escapes is refused and the cookie cleared, never served from the root home', async () => {
    const home = join(s.state, 'profiles', 'turncoat')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'config.yaml'), '# seed\n')
    const switched = await post(s, '/api/profile/switch', { name: 'turncoat' })
    const cookie = (switched.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    expect(cookie).toMatch(/^hermes_profile=turncoat/)
    const outside = mkdtempSync(join(tmpdir(), 'talaria-escape-'))
    rmSync(home, { recursive: true, force: true })
    symlinkSync(outside, home)
    try {
      for (const res of [await s.get('/api/profile/active', { headers: { cookie } }), await post(s, '/api/session/new', {}, { cookie })]) {
        expect(res.status).toBe(400)
        expect(await res.text()).toContain('outside the profiles directory')
        expect(res.headers.get('set-cookie')).toMatch(/^hermes_profile=(""|);.*Max-Age=0/)
      }
      expect((await json(await s.get('/api/profile/active'))).name).toBe('default')
    } finally {
      rmSync(home, { force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('a background wakeup for a session whose profile home later escapes is retained, never run against another home', async () => {
    const home = join(s.state, 'profiles', 'drifter')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'config.yaml'), '# seed\n')
    const cookie = ((await post(s, '/api/profile/switch', { name: 'drifter' })).headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const created = await post(s, '/api/session/new', {}, { cookie })
    const session = (await json(created)).session as Json
    expect(session.profile).toBe('drifter')
    const sid = String(session.session_id)
    const outside = mkdtempSync(join(tmpdir(), 'talaria-escape-'))
    rmSync(home, { recursive: true, force: true })
    symlinkSync(outside, home)
    const homes: string[] = []
    sidecar.respond('process.drain', () => ({ events: [] }))
    sidecar.respond('process.claim_delivery', (params) => { homes.push(params.profile_home); return { claim_id: 'c1' } })
    sidecar.respond('chat.start', (params) => { homes.push(params.profile_home); throw new Error('must not start') })
    try {
      await s.deps.completions.processOne({ process_id: 'drift_1', session_id: 'drift_1', type: 'completion', command: 'make', exit_code: 0, output: 'ok', session_key: sid, origin_ui_session_id: sid, consumed: false })
      await vi.waitFor(() => { expect(s.logs.some((line) => line.includes(`wakeup retained for session ${sid}`) && line.includes('outside the profiles directory'))).toBe(true) })
      expect(homes).toEqual([])
      expect(s.deps.completions.deferredCount(sid)).toBe(1)
    } finally {
      rmSync(home, { force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('profile/active carries the resolved default workspace', async () => {
    const body = await json(await s.get('/api/profile/active'))
    expect(body).toMatchObject({ name: 'default', is_default: true })
    expect(realpathSync(String(body.default_workspace))).toBe(realpathSync(s.workspace))
  })

  it('a named profile answers its own last workspace', async () => {
    const ws = join(workHome, 'ws-last')
    mkdirSync(join(workHome, 'webui_state'), { recursive: true })
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(workHome, 'webui_state', 'last_workspace.txt'), ws)
    const body = await json(await s.get('/api/profile/active', { headers: asWork() }))
    expect(body).toMatchObject({ name: 'work', is_default: false })
    expect(realpathSync(String(body.default_workspace))).toBe(realpathSync(ws))
  })

  it('without a last workspace the profile config workspace answers', async () => {
    rmSync(join(workHome, 'webui_state', 'last_workspace.txt'), { force: true })
    const ws = join(workHome, 'ws-config')
    mkdirSync(ws, { recursive: true })
    configs.set(workHome, { workspace: ws })
    s.deps.agentConfig.invalidate()
    await s.deps.agentConfig.read(workHome)
    const body = await json(await s.get('/api/profile/active', { headers: asWork() }))
    expect(realpathSync(String(body.default_workspace))).toBe(realpathSync(ws))
  })

  it('the global last workspace never leaks into a named profile', async () => {
    const global = join(s.workspace, 'global-ws')
    mkdirSync(global, { recursive: true })
    writeFileSync(join(s.state, 'last_workspace.txt'), global)
    const body = await json(await s.get('/api/profile/active', { headers: asWork() }))
    expect(realpathSync(String(body.default_workspace))).toBe(realpathSync(join(workHome, 'ws-config')))
  })

  it('an empty workspace list falls back to the configured Home, never the profile last workspace (Python `_profile_default_workspace`)', async () => {
    const last = join(workHome, 'ws-last-again')
    mkdirSync(last, { recursive: true })
    writeFileSync(join(workHome, 'webui_state', 'last_workspace.txt'), last)
    writeFileSync(join(workHome, 'webui_state', 'workspaces.json'), '[]')
    const body = await json(await s.get('/api/workspaces', { headers: asWork() }))
    expect((body.workspaces as { path: string; name: string }[]).map((w) => ({ path: realpathSync(w.path), name: w.name }))).toEqual([{ path: realpathSync(join(workHome, 'ws-config')), name: 'Home' }])
    // `/api/profile/active` keeps preferring the profile's own last workspace.
    expect(realpathSync(String((await json(await s.get('/api/profile/active', { headers: asWork() }))).default_workspace))).toBe(realpathSync(last))
    rmSync(join(workHome, 'webui_state', 'workspaces.json'), { force: true })
    rmSync(join(workHome, 'webui_state', 'last_workspace.txt'), { force: true })
  })

  it('skills list and content read the cookie profile home', async () => {
    skillRows.set(s.state, [{ name: 'root-skill', description: '', category: null, disabled: false }])
    skillRows.set(workHome, [{ name: 'work-skill', description: '', category: null, disabled: false }])
    mkdirSync(join(workHome, 'skills', 'work-skill', 'references'), { recursive: true })
    writeFileSync(join(workHome, 'skills', 'work-skill', 'SKILL.md'), '# work skill\n')
    writeFileSync(join(workHome, 'skills', 'work-skill', 'references', 'note.md'), 'work note\n')
    expect(((await json(await s.get('/api/skills'))).skills as Json[]).map((r) => r.name)).toEqual(['root-skill'])
    expect(((await json(await s.get('/api/skills', { headers: asWork() }))).skills as Json[]).map((r) => r.name)).toEqual(['work-skill'])
    const content = await json(await s.get('/api/skills/content?name=work-skill&file=references/note.md', { headers: asWork() }))
    expect(content.content).toBe('work note\n')
  })

  it('save and delete write under the cookie profile home, never the root', async () => {
    let res = await post(s, '/api/skills/save', { name: 'cookie-skill', content: '# c\n' }, asWork())
    expect(res.status, await res.clone().text()).toBe(200)
    expect(existsSync(join(workHome, 'skills', 'cookie-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(s.state, 'skills', 'cookie-skill'))).toBe(false)
    res = await post(s, '/api/skills/delete', { name: 'cookie-skill' }, asWork())
    expect(res.status, await res.clone().text()).toBe(200)
    expect(existsSync(join(workHome, 'skills', 'cookie-skill'))).toBe(false)
  })

  it('skill content never follows a symlink out of the skill directory, and a symlinked skill directory is not written through', async () => {
    mkdirSync(join(workHome, 'skills', 'linked-skill', 'references'), { recursive: true })
    writeFileSync(join(workHome, 'skills', 'linked-skill', 'SKILL.md'), '# linked\n')
    writeFileSync(join(s.state, 'outside-secret.md'), 'secret\n')
    symlinkSync(join(s.state, 'outside-secret.md'), join(workHome, 'skills', 'linked-skill', 'references', 'secret.md'))
    const res = await s.get('/api/skills/content?name=linked-skill&file=references/secret.md', { headers: asWork() })
    expect(res.status).toBe(404)
    const outsideDir = join(s.state, 'outside-skill-dir')
    mkdirSync(outsideDir, { recursive: true })
    symlinkSync(outsideDir, join(workHome, 'skills', 'escape-skill'))
    const save = await post(s, '/api/skills/save', { name: 'escape-skill', content: '# pwned\n' }, asWork())
    expect(save.status).toBe(400)
    expect(existsSync(join(outsideDir, 'SKILL.md'))).toBe(false)
  })

  it('the skills list reflects the active profile disabled state', async () => {
    skillRows.set(s.state, [{ name: 'alpha', description: '', category: null, disabled: true }, { name: 'beta', description: '', category: null, disabled: false }])
    skillRows.set(workHome, [{ name: 'alpha', description: '', category: null, disabled: false }, { name: 'beta', description: '', category: null, disabled: true }])
    const rows = (await json(await s.get('/api/skills', { headers: asWork() }))).skills as Json[]
    expect(rows.find((r) => r.name === 'beta')?.disabled).toBe(true)
    expect(rows.find((r) => r.name === 'alpha')?.disabled).toBe(false)
    const listed = sidecar.calls.filter((c) => c.method === 'skills.list').at(-1)?.params as Json
    expect(listed.profile_home).toBe(workHome)
  })

  it('toggling a skill writes the active profile config, not the default one', async () => {
    configs.set(workHome, {})
    configs.set(s.state, {})
    s.deps.agentConfig.invalidate()
    mkdirSync(join(workHome, 'skills', 'gamma'), { recursive: true })
    writeFileSync(join(workHome, 'skills', 'gamma', 'SKILL.md'), '# gamma\n')
    const res = await post(s, '/api/skills/toggle', { name: 'gamma', enabled: false }, asWork())
    expect(await json(res)).toEqual({ ok: true, name: 'gamma', enabled: false })
    expect(((configs.get(workHome)?.skills as Json | undefined)?.disabled as string[]) ?? []).toContain('gamma')
    expect(configs.get(s.state)?.skills ?? null).toBeNull()
  })

  it('a SOUL.md or skill edit asks the edited profile to rebuild open chats prompts; MEMORY.md and USER.md stay frozen (TAL-1821)', async () => {
    sidecar.respond('memory.check', (params) => ({ count: params.content.length, limit: 2200 }))
    sidecar.respond('memory.write', () => ({ written: true }))
    const requests = () => sidecar.calls.filter((c) => c.method === 'state_db.request_prompt_refresh').map((c) => c.params)
    const requestedBy = async (edit: () => Promise<Response>): Promise<unknown[]> => {
      const before = requests().length
      const res = await edit()
      expect(res.status, await res.clone().text()).toBe(200)
      return requests().slice(before)
    }
    const saveMemory = async (section: string): Promise<Response> => {
      const revision = (await json(await s.get('/api/memory', { headers: asWork() })))[`${section}_revision`]
      return post(s, '/api/memory/write', { section, content: 'edited', revision }, asWork())
    }
    const work = [{ profile_home: workHome }]
    expect(await requestedBy(() => saveMemory('soul'))).toEqual(work)
    expect(await requestedBy(() => saveMemory('memory'))).toEqual([])
    expect(await requestedBy(() => saveMemory('user'))).toEqual([])
    expect(await requestedBy(() => post(s, '/api/skills/save', { name: 'refreshed', content: '# r\n' }, asWork()))).toEqual(work)
    expect(await requestedBy(() => post(s, '/api/skills/toggle', { name: 'refreshed', enabled: false }, asWork()))).toEqual(work)
    expect(await requestedBy(() => post(s, '/api/skills/delete', { name: 'refreshed' }, asWork()))).toEqual(work)
    // A refused save changed nothing, so open chats keep their prompt.
    const before = requests().length
    expect((await post(s, '/api/memory/write', { section: 'soul', content: 'stale', revision: 'stale' }, asWork())).status).toBe(409)
    expect((await post(s, '/api/skills/delete', { name: 'refreshed' }, asWork())).status).toBe(404)
    expect(requests().slice(before)).toEqual([])
    // The file is already saved, so a failed request does not turn the save into an error.
    const refresh = sidecar.responderFor('state_db.request_prompt_refresh')
    sidecar.respond('state_db.request_prompt_refresh', () => { throw new SidecarError('state.db is locked', { condition: 'state_db_unavailable' }) })
    try {
      expect(await requestedBy(() => saveMemory('soul'))).toEqual(work)
    } finally {
      if (refresh) sidecar.respond('state_db.request_prompt_refresh', refresh)
    }
  })

  it('a per-client switch is allowed while an agent stream runs', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    sidecar.respond('chat.interrupt', () => ({ ok: true }))
    sidecar.respond('chat.start', (params, emit, opts) => new Promise((resolve) => {
      emit({ event: 'token', data: { text: 'working' } })
      opts.signal?.addEventListener('abort', () => { resolve({ status: 'cancelled', messages: [{ role: 'user', content: str(params.user_message) }], final_response: '', error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '', usage: { prompt_tokens: 0, completion_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: null }, context: {}, model: 'm', provider: 'p', compressed: false, agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [] }) })
    }))
    const startRes = await post(s, '/api/chat/start', { session_id: sid, message: 'busy' })
    expect(startRes.status, await startRes.clone().text()).toBe(200)
    const streamId = String((await json(startRes)).stream_id)
    await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'token')
    const res = await post(s, '/api/profile/switch', { name: 'work' })
    expect(res.status).toBe(200)
    expect((await json(res)).active).toBe('work')
    await s.get(`/api/chat/cancel?stream_id=${streamId}`)
    await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, (f) => f.event === 'cancel')
  })

  it('deleting a profile is refused while any client runs a turn under it, even from another profile', async () => {
    // The turn runs under `research` (cookie), the delete is issued from `work`: Python's active-profile check alone
    // would let the sidecar remove `research`'s home while its Agent still uses it.
    const switched = await post(s, '/api/profile/switch', { name: 'research' })
    const researchCookie = (switched.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    expect(researchCookie).toMatch(/^hermes_profile=research/)
    const created = await post(s, '/api/session/new', { profile: 'research' }, { cookie: researchCookie })
    expect(created.status, await created.clone().text()).toBe(200)
    const sid = String(((await json(created)).session as Json).session_id)
    sidecar.respond('chat.interrupt', () => ({ ok: true }))
    sidecar.respond('chat.start', (params, emit, opts) => new Promise((resolve) => {
      emit({ event: 'token', data: { text: 'working' } })
      opts.signal?.addEventListener('abort', () => { resolve({ status: 'cancelled', messages: [{ role: 'user', content: str(params.user_message) }], final_response: '', error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '', usage: { prompt_tokens: 0, completion_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: null }, context: {}, model: 'm', provider: 'p', compressed: false, agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [] }) })
    }))
    const startRes = await post(s, '/api/chat/start', { session_id: sid, message: 'busy' }, { cookie: researchCookie })
    expect(startRes.status, await startRes.clone().text()).toBe(200)
    const streamId = String((await json(startRes)).stream_id)
    await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'token', { headers: { cookie: researchCookie } })
    const deletes = sidecar.calls.filter((c) => c.method === 'profiles.delete').length
    const res = await post(s, '/api/profile/delete', { name: 'research' }, asWork())
    expect(res.status).toBe(409)
    expect(String((await json(res)).error)).toContain('while an agent is running')
    expect(sidecar.calls.filter((c) => c.method === 'profiles.delete')).toHaveLength(deletes)
    await s.get(`/api/chat/cancel?stream_id=${streamId}`, { headers: { cookie: researchCookie } })
    await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, (f) => f.event === 'cancel', { headers: { cookie: researchCookie } })
  })

  it('a profile stays undeletable while a finished turn is still generating its title', async () => {
    mkdirSync(join(s.state, 'profiles', 'titling'), { recursive: true })
    writeFileSync(join(s.state, 'profiles', 'titling', 'config.yaml'), '# seed\n')
    s.deps.profiles.invalidate()
    const switched = await post(s, '/api/profile/switch', { name: 'titling' })
    const cookie = (switched.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const sid = String(((await json(await post(s, '/api/session/new', { profile: 'titling' }, { cookie }))).session as Json).session_id)
    const title = parkHandler()
    sidecar.respond('aux.complete', async () => { await title.park(); return { model: 'aux', text: 'Titled', usage: null } })
    sidecar.respond('chat.start', (params) => ({ status: 'completed', messages: [{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'done' }], final_response: 'done', error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '', usage: { prompt_tokens: 0, completion_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: null }, context: {}, model: 'm', provider: 'p', compressed: false, agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [] }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'hello there' }, { cookie }))
    await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}`, (f) => f.event === 'done', { headers: { cookie } })
    // Admission is released at `done`, but the title prompt is still parked on the profile's aux route.
    await title.entered
    sidecar.respond('profiles.delete', () => ({ ok: true }))
    const refused = await post(s, '/api/profile/delete', { name: 'titling' }, asWork())
    expect(refused.status).toBe(409)
    expect(String((await json(refused)).error)).toContain('while an agent is running')
    title.release()
    await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}&after_event_id=${String(start.stream_id)}:0`, (f) => f.event === 'stream_end', { headers: { cookie } })
    await vi.waitFor(() => { expect(runsActive('titling')).toBe(false) })
    expect(await json(await post(s, '/api/profile/delete', { name: 'titling' }, asWork()))).toEqual({ ok: true, name: 'titling' })
    sidecar.respond('aux.complete', () => { throw new Error('no aux model') })
  })

  it('no turn is admitted under a profile while its deletion RPC is in flight', async () => {
    mkdirSync(join(s.state, 'profiles', 'doomed'), { recursive: true })
    writeFileSync(join(s.state, 'profiles', 'doomed', 'config.yaml'), '# seed\n')
    s.deps.profiles.invalidate()
    const switched = await post(s, '/api/profile/switch', { name: 'doomed' })
    const cookie = (switched.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    expect(cookie).toMatch(/^hermes_profile=doomed/)
    const created = await post(s, '/api/session/new', { profile: 'doomed' }, { cookie })
    const sid = String(((await json(created)).session as Json).session_id)
    const rpc = parkHandler()
    sidecar.respond('profiles.delete', async (params) => { await rpc.park(); rmSync(join(s.state, 'profiles', params.name), { recursive: true, force: true }); return { ok: true } })
    sidecar.respond('chat.start', (params) => ({ status: 'completed', messages: [{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'late' }], final_response: 'late', error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '', usage: { prompt_tokens: 0, completion_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: null }, context: {}, model: 'm', provider: 'p', compressed: false, agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [] }))
    const deletion = post(s, '/api/profile/delete', { name: 'doomed' }, asWork())
    await rpc.entered
    const refused = await post(s, '/api/chat/start', { session_id: sid, message: 'sneak in' }, { cookie })
    expect(refused.status).toBe(409)
    expect(String((await json(refused)).error)).toContain('being deleted')
    // A second overlapping delete is refused rather than sharing (and then clearing) the mark while the first RPC runs.
    const overlapping = await post(s, '/api/profile/delete', { name: 'doomed' }, asWork())
    expect(overlapping.status).toBe(409)
    expect(String((await json(overlapping)).error)).toContain('already being deleted')
    expect(s.deps.profiles.isDeleting('doomed')).toBe(true)
    expect((await post(s, '/api/chat/start', { session_id: sid, message: 'still refused' }, { cookie })).status).toBe(409)
    // Every profile-scoped write is held off too, so `config.set` cannot resurrect the home mid-deletion; the same
    // request from another profile is unaffected.
    const write = await post(s, '/api/model/set', { model: '@anthropic:claude-sonnet-4-6', provider: 'anthropic' }, { cookie })
    expect(write.status).toBe(409)
    expect(String((await json(write)).error)).toContain('being deleted')
    expect((await s.get('/api/profiles', { headers: { cookie } })).status).toBe(200)
    // Another client cannot switch into the profile mid-deletion either (its next write would recreate the home).
    const sneak = await post(s, '/api/profile/switch', { name: 'doomed' }, asWork())
    expect(sneak.status).toBe(409)
    expect(sneak.headers.get('set-cookie')).toBeNull()
    rpc.release()
    expect(await json(await deletion)).toEqual({ ok: true, name: 'doomed' })
    expect(s.deps.profiles.isDeleting('doomed')).toBe(false)
    // The home is gone: a client still carrying the old cookie cannot write (and so cannot recreate it), but can
    // still switch away.
    const stale = await post(s, '/api/model/set', { scope: 'main', model: '@anthropic:claude-sonnet-4-6', provider: 'anthropic' }, { cookie })
    expect(stale.status).toBe(404)
    expect(String((await json(stale)).error)).toContain('does not exist')
    expect((await post(s, '/api/profile/switch', { name: 'work' }, { cookie })).status).toBe(200)
  })

  it('a switch into a profile runs on its lifecycle chain, so a concurrent delete waits and the switched client cannot resurrect the home', async () => {
    mkdirSync(join(s.state, 'profiles', 'wobbly'), { recursive: true })
    writeFileSync(join(s.state, 'profiles', 'wobbly', 'config.yaml'), '# seed\n')
    s.deps.profiles.invalidate()
    const originalGet = sidecar.responderFor('config.get')
    let releaseRead: () => void = () => undefined
    sidecar.respond('config.get', (params, emit, opts) => {
      if (!str(params.profile_home).endsWith('wobbly') || !originalGet) return originalGet ? originalGet(params, emit, opts) : { path: join(params.profile_home, 'config.yaml'), exists: false, config: {} }
      return new Promise((resolve, reject) => { releaseRead = () => { Promise.resolve(originalGet(params, emit, opts)).then(resolve, reject) } })
    })
    const order: string[] = []
    sidecar.respond('profiles.delete', () => { order.push('delete'); return { ok: true } })
    const switching = post(s, '/api/profile/switch', { name: 'wobbly' })
    await vi.waitFor(() => { expect(sidecar.calls.some((c) => c.method === 'config.get' && str((c.params as Json).profile_home).endsWith('wobbly'))).toBe(true) })
    const deleting = post(s, '/api/profile/delete', { name: 'wobbly' }, asWork())
    await vi.waitFor(() => { expect(s.deps.profiles.isDeleting('wobbly')).toBe(true) })
    await roundTrip()
    expect(order).toEqual([])
    releaseRead()
    // The delete was queued behind the switch and marked the target meanwhile: the switch re-validates before handing
    // out a cookie and refuses, so no client ends up scoped to the profile that is about to disappear.
    const switched = await switching
    expect(switched.status, await switched.clone().text()).toBe(409)
    expect(switched.headers.get('set-cookie')).toBeNull()
    expect(await json(await deleting)).toEqual({ ok: true, name: 'wobbly' })
    expect(order).toEqual(['delete'])
    if (originalGet) sidecar.respond('config.get', originalGet)
  })

  it('a profile-scoped write already in flight finishes before that profile is deleted', async () => {
    mkdirSync(join(s.state, 'profiles', 'fleeting'), { recursive: true })
    writeFileSync(join(s.state, 'profiles', 'fleeting', 'config.yaml'), '# seed\n')
    s.deps.profiles.invalidate()
    const switched = await post(s, '/api/profile/switch', { name: 'fleeting' })
    const cookie = (switched.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    expect(cookie).toMatch(/^hermes_profile=fleeting/)
    const order: string[] = []
    let finishWrite: () => void = () => undefined
    const originalSet = sidecar.responderFor('config.set')
    sidecar.respond('config.set', (params, emit, opts) => new Promise((resolve, reject) => {
      finishWrite = () => { order.push('config.set'); if (originalSet) Promise.resolve(originalSet(params, emit, opts)).then(resolve, reject); else resolve({ ok: true, path: join(params.profile_home, 'config.yaml') }) }
    }))
    sidecar.respond('profiles.delete', () => { order.push('profiles.delete'); return { ok: true } })
    const write = post(s, '/api/model/set', { scope: 'main', model: '@anthropic:claude-sonnet-4-6', provider: 'anthropic' }, { cookie })
    await vi.waitFor(() => { expect(sidecar.calls.some((c) => c.method === 'config.set' && str((c.params as Json).profile_home).endsWith('fleeting'))).toBe(true) })
    // The write is parked inside the sidecar; the delete must wait for it instead of removing the home underneath.
    const deletion = post(s, '/api/profile/delete', { name: 'fleeting' }, asWork())
    await vi.waitFor(() => { expect(s.deps.profiles.isDeleting('fleeting')).toBe(true) })
    await roundTrip()
    expect(order).toEqual([])
    finishWrite()
    expect((await write).status, await (await write).clone().text()).toBe(200)
    expect(await json(await deletion)).toEqual({ ok: true, name: 'fleeting' })
    expect(order).toEqual(['config.set', 'profiles.delete'])
    if (originalSet) sidecar.respond('config.set', originalSet)
  })

  it('a client can delete its own active named profile without waiting on its own write lease', async () => {
    mkdirSync(join(s.state, 'profiles', 'selfie'), { recursive: true })
    writeFileSync(join(s.state, 'profiles', 'selfie', 'config.yaml'), '# seed\n')
    s.deps.profiles.invalidate()
    const switched = await post(s, '/api/profile/switch', { name: 'selfie' })
    const cookie = (switched.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    expect(cookie).toMatch(/^hermes_profile=selfie/)
    sidecar.respond('profiles.delete', () => ({ ok: true }))
    // Waiting on its own lease would hold the delete past the suite's test timeout.
    const res = await post(s, '/api/profile/delete', { name: 'selfie' }, { cookie })
    expect(res.status, await res.clone().text()).toBe(200)
    expect(s.deps.profiles.isDeleting('selfie')).toBe(false)
    // ...and the client is moved back to `default`, so its next write cannot resurrect the deleted home.
    expect(res.headers.get('set-cookie')).toMatch(/^hermes_profile=default/)
    const unrelated = await post(s, '/api/profile/delete', { name: 'nonexistent-zz' }, asWork())
    expect(unrelated.headers.get('set-cookie')).toBeNull()
  })

  it('deletion tombstones are persisted and honoured by a fresh service instance', async () => {
    mkdirSync(join(s.state, 'profiles', 'ephemeral'), { recursive: true })
    writeFileSync(join(s.state, 'profiles', 'ephemeral', 'config.yaml'), '# seed\n')
    s.deps.profiles.invalidate()
    sidecar.respond('profiles.delete', (params) => { rmSync(join(s.state, 'profiles', params.name), { recursive: true, force: true }); return { ok: true } })
    expect(await json(await post(s, '/api/profile/delete', { name: 'ephemeral' }, asWork()))).toEqual({ ok: true, name: 'ephemeral' })
    const file = join(s.deps.config.stateDir, 'deleted-profiles.json')
    expect(JSON.parse(readFileSync(file, 'utf8')) as string[]).toContain('ephemeral')
    // A restarted server reads the tombstones back: the stale cookie is still refused.
    const restarted = (await initializeStore(new ProfileService({ ...(s.deps.profiles as unknown as { deps: ConstructorParameters<typeof ProfileService>[0] }).deps })))
    expect((await restarted.beginWrite('ephemeral'))).toBe('missing')
    expect(typeof (await restarted.beginWrite('work'))).toBe('function')
  })

  it('a profile being cloned from cannot be deleted until the clone finishes', async () => {
    mkdirSync(join(s.state, 'profiles', 'source'), { recursive: true })
    writeFileSync(join(s.state, 'profiles', 'source', 'config.yaml'), '# seed\n')
    s.deps.profiles.invalidate()
    const order: string[] = []
    let finishCreate: () => void = () => undefined
    sidecar.respond('profiles.create', (params) => new Promise((resolve) => { finishCreate = () => { order.push('create'); mkdirSync(join(s.state, 'profiles', params.name), { recursive: true }); resolve({ profile: row(params.name, { path: join(s.state, 'profiles', params.name) }) as never }) } }))
    sidecar.respond('profiles.delete', (params) => { order.push('delete'); rmSync(join(s.state, 'profiles', params.name), { recursive: true, force: true }); return { ok: true } })
    const creating = post(s, '/api/profile/create', { name: 'copy', clone_from: 'source', clone_config: true })
    await vi.waitFor(() => { expect(sidecar.calls.some((c) => c.method === 'profiles.create' && (c.params as Json).name === 'copy')).toBe(true) })
    const deleting = post(s, '/api/profile/delete', { name: 'source' }, asWork())
    await vi.waitFor(() => { expect(s.deps.profiles.isDeleting('source')).toBe(true) })
    await roundTrip()
    expect(order).toEqual([])
    finishCreate()
    expect((await creating).status, await (await creating).clone().text()).toBe(200)
    expect(await json(await deleting)).toEqual({ ok: true, name: 'source' })
    expect(order).toEqual(['create', 'delete'])
    // Cloning from a profile that is gone is refused up front.
    expect((await post(s, '/api/profile/create', { name: 'copy2', clone_from: 'source' })).status).toBe(404)
  })

  it('a detached memory commit counts as profile activity, so the profile cannot be deleted underneath it', async () => {
    mkdirSync(join(s.state, 'profiles', 'memo'), { recursive: true })
    writeFileSync(join(s.state, 'profiles', 'memo', 'config.yaml'), '# seed\n')
    s.deps.profiles.invalidate()
    const switched = await post(s, '/api/profile/switch', { name: 'memo' })
    const cookie = (switched.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const first = String(((await json(await post(s, '/api/session/new', { profile: 'memo' }, { cookie }))).session as Json).session_id)
    const commit = parkHandler()
    sidecar.respond('chat.commit_memory', async () => { await commit.park(); return { committed: true } })
    expect((await post(s, '/api/session/new', { profile: 'memo', prev_session_id: first }, { cookie })).status).toBe(200)
    await commit.entered
    expect(sidecar.calls.filter((c) => c.method === 'chat.commit_memory').at(-1)?.params).toEqual({ profile_home: join(s.state, 'profiles', 'memo'), session_id: first })
    sidecar.respond('profiles.delete', (params) => { rmSync(join(s.state, 'profiles', params.name), { recursive: true, force: true }); return { ok: true } })
    const refused = await post(s, '/api/profile/delete', { name: 'memo' }, asWork())
    expect(refused.status).toBe(409)
    commit.release()
    await vi.waitFor(() => { expect(runsActive('memo')).toBe(false) })
    expect(await json(await post(s, '/api/profile/delete', { name: 'memo' }, asWork()))).toEqual({ ok: true, name: 'memo' })
  })

  it('a background STT warm-up counts as profile activity, so the profile cannot be deleted under the load (TAL-916)', async () => {
    mkdirSync(join(s.state, 'profiles', 'warmth'), { recursive: true })
    writeFileSync(join(s.state, 'profiles', 'warmth', 'config.yaml'), '# seed\n')
    s.deps.profiles.invalidate()
    const switched = await post(s, '/api/profile/switch', { name: 'warmth' })
    const cookie = (switched.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    let finishWarm: () => void = () => undefined
    sidecar.respond('stt.warm', () => new Promise((resolve) => { finishWarm = () => { resolve({ provider: 'local', warmed: true, action: 'loaded' }) } }))
    try {
      // The route answers at once; the load it started keeps running against the profile's home.
      expect(await json(await post(s, '/api/transcribe/warm', {}, { cookie }))).toEqual({ ok: true })
      expect(sidecar.calls.filter((c) => c.method === 'stt.warm').at(-1)?.params).toEqual({ profile_home: join(s.state, 'profiles', 'warmth') })
      sidecar.respond('profiles.delete', (params) => { rmSync(join(s.state, 'profiles', params.name), { recursive: true, force: true }); return { ok: true } })
      const refused = await post(s, '/api/profile/delete', { name: 'warmth' }, asWork())
      expect(refused.status).toBe(409)
    } finally {
      finishWarm()
      sidecar.respond('stt.warm', undefined)
    }
    await vi.waitFor(() => { expect(runsActive('warmth')).toBe(false) })
    expect(await json(await post(s, '/api/profile/delete', { name: 'warmth' }, asWork()))).toEqual({ ok: true, name: 'warmth' })
  })

  it('deletion re-checks profile activity after draining writers, so a commit started by a draining request still blocks it', async () => {
    mkdirSync(join(s.state, 'profiles', 'memo2'), { recursive: true })
    writeFileSync(join(s.state, 'profiles', 'memo2', 'config.yaml'), '# seed\n')
    s.deps.profiles.invalidate()
    const switched = await post(s, '/api/profile/switch', { name: 'memo2' })
    const cookie = (switched.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const first = String(((await json(await post(s, '/api/session/new', { profile: 'memo2' }, { cookie }))).session as Json).session_id)
    // An admitted request holds its write lease...
    const release = (await s.deps.profiles.beginWrite('memo2'))
    expect(typeof release).toBe('function')
    sidecar.respond('profiles.delete', (params) => { rmSync(join(s.state, 'profiles', params.name), { recursive: true, force: true }); return { ok: true } })
    const deleting = post(s, '/api/profile/delete', { name: 'memo2' }, asWork())
    await vi.waitFor(() => { expect(s.deps.profiles.isDeleting('memo2')).toBe(true) })
    // ...starts a detached memory commit on its way out, then releases the lease.
    const commit = parkHandler()
    sidecar.respond('chat.commit_memory', async () => { await commit.park(); return { committed: true } })
    await s.deps.sessions.deps.commitSessionMemory?.(first)
    await commit.entered
    if (typeof release === 'function') release()
    const refused = await deleting
    expect(refused.status).toBe(409)
    expect(existsSync(join(s.state, 'profiles', 'memo2'))).toBe(true)
    commit.release()
    await vi.waitFor(() => { expect(runsActive('memo2')).toBe(false) })
    expect(await json(await post(s, '/api/profile/delete', { name: 'memo2' }, asWork()))).toEqual({ ok: true, name: 'memo2' })
  })

  it('a profile is not deleted when its tombstone cannot be persisted', async () => {
    mkdirSync(join(s.state, 'profiles', 'sticky'), { recursive: true })
    writeFileSync(join(s.state, 'profiles', 'sticky', 'config.yaml'), '# seed\n')
    s.deps.profiles.invalidate()
    const file = join(s.deps.config.stateDir, 'deleted-profiles.json')
    const previous = existsSync(file) ? readFileSync(file, 'utf8') : null
    rmSync(file, { force: true })
    mkdirSync(file) // a directory in the file's place makes the atomic rename fail
    let rpcs = 0
    sidecar.respond('profiles.delete', () => { rpcs += 1; return { ok: true } })
    try {
      const res = await post(s, '/api/profile/delete', { name: 'sticky' }, asWork())
      expect(res.status).toBe(503)
      expect(String((await json(res)).error)).toContain('deletion record could not be written')
      expect(rpcs).toBe(0)
      expect(existsSync(join(s.state, 'profiles', 'sticky'))).toBe(true)
      expect(s.deps.profiles.isDeleting('sticky')).toBe(false)
      expect(typeof (await s.deps.profiles.beginWrite('sticky'))).toBe('function')
    } finally {
      rmSync(file, { recursive: true, force: true })
      if (previous !== null) writeFileSync(file, previous)
    }
  })

  it('recreating a deleted profile fails closed when the tombstone removal cannot be persisted', async () => {
    mkdirSync(join(s.state, 'profiles', 'phoenix'), { recursive: true })
    writeFileSync(join(s.state, 'profiles', 'phoenix', 'config.yaml'), '# seed\n')
    s.deps.profiles.invalidate()
    sidecar.respond('profiles.delete', (params) => { rmSync(join(s.state, 'profiles', params.name), { recursive: true, force: true }); return { ok: true } })
    expect(await json(await post(s, '/api/profile/delete', { name: 'phoenix' }, asWork()))).toEqual({ ok: true, name: 'phoenix' })
    const file = join(s.deps.config.stateDir, 'deleted-profiles.json')
    const previous = readFileSync(file, 'utf8')
    rmSync(file, { force: true })
    mkdirSync(file)
    sidecar.respond('profiles.create', (params) => { mkdirSync(join(s.state, 'profiles', params.name), { recursive: true }); return { profile: row(params.name, { path: join(s.state, 'profiles', params.name) }) as never } })
    let creates = 0
    sidecar.respond('profiles.create', (params) => { creates += 1; mkdirSync(join(s.state, 'profiles', params.name), { recursive: true }); return { profile: row(params.name, { path: join(s.state, 'profiles', params.name) }) as never } })
    try {
      const res = await post(s, '/api/profile/create', { name: 'phoenix' })
      expect(res.status).toBe(503)
      expect(String((await json(res)).error)).toContain('deletion record could not be cleared')
      // The in-memory mark and the durable record agree: writes stay refused.
      expect((await s.deps.profiles.beginWrite('phoenix'))).toBe('missing')
      expect(creates).toBe(1)
    } finally {
      rmSync(file, { recursive: true, force: true })
      writeFileSync(file, previous)
    }
    // Once the state directory is writable again, retrying the create clears the record without re-running the
    // sidecar against the existing home, re-applies the requested configuration, and the profile becomes writable.
    const retry = await post(s, '/api/profile/create', { name: 'phoenix', base_url: 'https://llm.example/v1' })
    expect(retry.status, await retry.clone().text()).toBe(200)
    expect(creates).toBe(1)
    expect(sidecar.calls.some((c) => c.method === 'config.set' && str((c.params as Json).profile_home).endsWith('phoenix') && JSON.stringify((c.params as Json).config).includes('https://llm.example/v1'))).toBe(true)
    expect(typeof (await s.deps.profiles.beginWrite('phoenix'))).toBe('function')
    expect(JSON.parse(readFileSync(file, 'utf8')) as string[]).not.toContain('phoenix')
  })

  it('an unreadable tombstone record fails named-profile writes closed until it can be read again', async () => {
    const file = join(s.deps.config.stateDir, 'deleted-profiles.json')
    const previous = existsSync(file) ? readFileSync(file, 'utf8') : null
    writeFileSync(file, '{not json')
    const broken = (await initializeStore(new ProfileService({ ...(s.deps.profiles as unknown as { deps: ConstructorParameters<typeof ProfileService>[0] }).deps })))
    expect((await broken.beginWrite('work'))).toBe('unreadable')
    expect(typeof (await broken.beginWrite('default'))).toBe('function')
    // Repaired record: the next lease attempt re-reads it and honours its contents.
    writeFileSync(file, JSON.stringify(['gone-profile']))
    expect(typeof (await broken.beginWrite('work'))).toBe('function')
    expect((await broken.beginWrite('gone-profile'))).toBe('missing')
    if (previous === null) rmSync(file, { force: true }); else writeFileSync(file, previous)
  })

  it('a first-time creation whose configuration write fails is rolled back, so a retry creates cleanly', async () => {
    let creates = 0
    let deletes = 0
    sidecar.respond('profiles.create', (params) => { creates += 1; mkdirSync(join(s.state, 'profiles', params.name), { recursive: true }); return { profile: row(params.name, { path: join(s.state, 'profiles', params.name) }) as never } })
    sidecar.respond('profiles.delete', (params) => { deletes += 1; rmSync(join(s.state, 'profiles', params.name), { recursive: true, force: true }); return { ok: true } })
    const originalSet = sidecar.responderFor('config.set')
    sidecar.respond('config.set', (params, emit, opts) => {
      if (str(params.profile_home).endsWith('halfway') && creates === 1) throw new Error('disk full')
      return originalSet ? originalSet(params, emit, opts) : { ok: true, path: join(params.profile_home, 'config.yaml') }
    })
    try {
      const failed = await post(s, '/api/profile/create', { name: 'halfway', base_url: 'https://llm.example/v1' })
      expect(failed.status).toBe(500)
      expect(String((await json(failed)).error)).toContain('rolled back')
      expect(existsSync(join(s.state, 'profiles', 'halfway'))).toBe(false)
      expect(deletes).toBe(1)
      // The retry is a clean create (the sidecar would have refused a leftover directory) and applies the settings.
      const retried = await post(s, '/api/profile/create', { name: 'halfway', base_url: 'https://llm.example/v1' })
      expect(retried.status, await retried.clone().text()).toBe(200)
      expect(creates).toBe(2)
      expect(sidecar.calls.some((c) => c.method === 'config.set' && str((c.params as Json).profile_home).endsWith('halfway') && JSON.stringify((c.params as Json).config).includes('https://llm.example/v1'))).toBe(true)
    } finally {
      if (originalSet) sidecar.respond('config.set', originalSet)
    }
  })

  it('New Chat refuses a profile outside the profile grammar before allocating a session or worktree (TAL-2257)', async () => {
    const sessions = async (): Promise<string[]> => [...new Set([...s.deps.sessionStore.sessions.keys(), ...(await s.deps.sessionStore.persistedIds())])].sort()
    const before = await sessions()
    const reference = { session_id: 'tal2257src', tip_session_id: 'tal2257src', profile: 'default' }
    for (const profile of ['../evil', ' ', 'a/b', '..', 'Work', ' work', 'work\n', 'x'.repeat(65)]) {
      for (const extra of [{ worktree: false }, { worktree: true }, { execution_mode: 'safe' }, { request_id: 'tal-2257', source_references: [reference] }]) {
        const res = await post(s, '/api/session/new', { profile, ...extra })
        expect({ profile, extra, status: res.status, error: (await json(res)).error }).toEqual({ profile, extra, status: 400, error: 'Invalid profile' })
      }
    }
    expect(await sessions()).toEqual(before)
  })

  it('New Chat keeps an absent, empty, root or named profile through save and reload (TAL-2257)', async () => {
    const cases: [Json, string][] = [[{}, 'default'], [{ profile: null }, 'default'], [{ profile: '' }, 'default'], [{ profile: 'default' }, 'default'], [{ profile: 'research' }, 'research']]
    for (const [body, stored] of cases) {
      const res = await post(s, '/api/session/new', { ...body, worktree: false })
      expect(res.status, JSON.stringify(body)).toBe(200)
      const sid = String(((await json(res)).session as Json).session_id)
      await s.deps.sessionStore.save(await s.deps.sessionStore.get(sid))
      const raw = JSON.parse(readFileSync(join(s.state, 'sessions', `${sid}.json`), 'utf8')) as Json
      expect({ body, profile: raw.profile }).toEqual({ body, profile: stored })
    }
  })

  it('a prev_session_id from another profile is ignored, not an error', async () => {
    const other = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const res = await post(s, '/api/session/new', { profile: 'work', prev_session_id: other }, asWork())
    expect(res.status, await res.clone().text()).toBe(200)
    expect(((await json(res)).session as Json).profile).toBe('work')
  })

  it('a new session without a body profile takes the cookie profile and its default model', async () => {
    configs.set(workHome, { model: { default: 'work-default-model', provider: 'anthropic' } })
    writeFileSync(join(workHome, 'config.yaml'), '# work default model\n')
    try {
      await s.deps.agentConfig.read(workHome)
      const res = await post(s, '/api/session/new', {}, asWork())
      expect(res.status, await res.clone().text()).toBe(200)
      const sid = String(((await json(res)).session as Json).session_id)
      const detail = await s.get(`/api/session?session_id=${sid}`, { headers: asWork() })
      expect(detail.status, await detail.clone().text()).toBe(200)
      expect((await json(detail)).session).toMatchObject({ profile: 'work', model: 'work-default-model', model_provider: 'anthropic' })
      const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'first message' }, asWork()))
      await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}`, (f) => f.event === 'done', { headers: asWork() })
      const listed = (await json(await s.get('/api/sessions', { headers: asWork() }))).sessions as Json[]
      expect(listed.map((r) => r.session_id)).toContain(sid)
    } finally {
      configs.delete(workHome)
      writeFileSync(join(workHome, 'config.yaml'), '# seed\n')
    }
  })

  it('an explicit profile other than the cookie starts on its own config default, even uncached', async () => {
    const researchHome = join(s.state, 'profiles', 'research')
    configs.set(researchHome, { model: '@anthropic:research-model' })
    writeFileSync(join(researchHome, 'config.yaml'), '# research qualified model\n')
    try {
      const res = await post(s, '/api/session/new', { profile: 'research' }, asWork())
      expect(res.status, await res.clone().text()).toBe(200)
      const sid = String(((await json(res)).session as Json).session_id)
      expect((await s.deps.sessionStore.get(sid))).toMatchObject({ profile: 'research', model: 'research-model', model_provider: 'anthropic' })
    } finally {
      configs.delete(researchHome)
      writeFileSync(join(researchHome, 'config.yaml'), '# seed\n')
    }
  })

  it('a target profile without a default model falls back to one consistent model and provider pair', async () => {
    const researchHome = join(s.state, 'profiles', 'research')
    configs.set(researchHome, { model: { provider: 'openrouter' } })
    configs.set(workHome, { model: { default: 'work-default-model', provider: 'anthropic' } })
    writeFileSync(join(researchHome, 'config.yaml'), '# research provider only\n')
    writeFileSync(join(workHome, 'config.yaml'), '# work default model pair\n')
    try {
      const res = await post(s, '/api/session/new', { profile: 'research' }, asWork())
      expect(res.status, await res.clone().text()).toBe(200)
      const sid = String(((await json(res)).session as Json).session_id)
      expect((await s.deps.sessionStore.get(sid))).toMatchObject({ profile: 'research', model: 'work-default-model', model_provider: 'anthropic' })
    } finally {
      configs.delete(researchHome)
      configs.delete(workHome)
      writeFileSync(join(researchHome, 'config.yaml'), '# seed\n')
      writeFileSync(join(workHome, 'config.yaml'), '# seed\n')
    }
  })

  it('an explicit provider argument beats the parsed hint', () => {
    expect(splitProviderModel('@ollama:qwen3.8:27b-mtp-q8_0', 'anthropic')).toEqual(['qwen3.8:27b-mtp-q8_0', 'anthropic'])
  })

  it('unqualified values pass through unchanged', () => {
    for (const v of ['qwen3.8:27b-mtp-q8_0', 'llama4', '@nocolon']) expect(splitProviderModel(v, null)[0]).toBe(v)
    expect(splitProviderModel('', null)[0] ?? null).toBeNull()
    expect(splitProviderModel('  ', null)[0] ?? null).toBeNull()
  })

  it('a plain model with an explicit provider passes through', () => {
    expect(splitProviderModel('gpt-5.5', 'openai')).toEqual(['gpt-5.5', 'openai'])
  })

  it('creating a profile with a base URL and a model keeps both in config.yaml', async () => {
    sidecar.respond('profiles.create', (params) => ({ profile: row(params.name, { path: join(s.state, 'profiles', params.name) }) as never }))
    mkdirSync(join(s.state, 'profiles', 'newbie'), { recursive: true })
    writeEnvFile(join(s.state, '.env'), { ANTHROPIC_API_KEY: 'sk-ant-base-1234' })
    s.deps.catalog.invalidate()
    const res = await post(s, '/api/profile/create', { name: 'newbie', base_url: 'https://llm.example/v1', api_key: 'sk-newbie-12345', model_provider: 'anthropic', default_model: '@anthropic:claude-sonnet-4-6' })
    expect(res.status, await res.clone().text()).toBe(200)
    const model = configs.get(join(s.state, 'profiles', 'newbie'))?.model as Json
    expect(model).toMatchObject({ base_url: 'https://llm.example/v1', default: 'claude-sonnet-4-6', provider: 'anthropic' })
  })

  it('all_profiles accepts every truthy spelling outside isolated mode', async () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'YES', 'on']) expect((await json(await s.get(`/api/sessions?all_profiles=${v}`))).all_profiles, v).toBe(true)
  })

  it('missing, zero, empty, or garbage values stay scoped', async () => {
    for (const v of ['', '0', 'garbage']) expect((await json(await s.get(`/api/sessions?all_profiles=${v}`))).all_profiles, v).toBe(false)
    expect((await json(await s.get('/api/sessions'))).all_profiles).toBe(false)
  })

  it('a cookieless load of a foreign-profile session answers the 409 envelope, never content', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', { profile: 'work' }, asWork()))).session as Json).session_id)
    const res = await s.get(`/api/session?session_id=${sid}&messages=1`)
    expect(res.status).toBe(409)
    const body = await json(res)
    expect(body).toMatchObject({ code: 'session_profile_mismatch', profile: 'work', session_id: sid })
    expect(body).not.toHaveProperty('messages')
  })

  it('an import under a named profile stamps that profile', async () => {
    const res = await post(s, '/api/session/import', { messages: [{ role: 'user', content: 'imported' }], title: 'Imported' }, asWork())
    expect(res.status, await res.clone().text()).toBe(200)
    const session = (await json(res)).session as Json
    const sid = String(session.session_id)
    expect(session.profile).toBe('work')
    const raw = JSON.parse(readFileSync(join(s.state, 'sessions', `${sid}.json`), 'utf8')) as Json
    expect(raw.profile).toBe('work')
  })

  it('an import under default stays default-owned', async () => {
    const res = await post(s, '/api/session/import', { messages: [{ role: 'user', content: 'imported' }] })
    expect(res.status).toBe(200)
    expect(((await json(res)).session as Json).profile).toBe('default')
  })
})
