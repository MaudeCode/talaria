/**
 * Profile regressions: isolation semantics, profile-home routing, per-profile
 * system projects, profile visibility, cross-profile crons, per-profile
 * workspaces and skills, and profile-scoped session routes.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { loadStartupEnv } from '../cli/dotenv.js'
import { ProjectStore } from '../projects.js'
import { ProfileService, splitProviderModel } from '../profiles/profiles.js'
import { jobForApi } from '../tools/crons.js'
import { str } from '../util.js'
import { writeEnvFile } from '../providers/env-file.js'

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json
const row = (name: string, extra: Json = {}): Json => ({ name, path: '', is_default: false, gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0, ...extra })

function profileShapedHome(profile: string): { base: string; home: string } {
  const base = mkdtempSync(join(tmpdir(), 'talaria-iso-'))
  const home = join(base, 'profiles', profile)
  mkdirSync(home, { recursive: true })
  return { base, home }
}

describe('isolation flag semantics', () => {
  const opened: TestServer[] = []
  const bases: string[] = []
  afterAll(async () => { for (const s of opened) await s.close(); for (const b of bases) rmSync(b, { recursive: true, force: true }) })
  const boot = async (env: Record<string, string>, profile = 'webui', rows: Json[] = [row('default', { is_default: true }), row('webui'), row('other')], extraEnv: (base: string) => Record<string, string> = () => ({})): Promise<{ s: TestServer; home: string; base: string }> => {
    const { base, home } = profileShapedHome(profile)
    bases.push(base)
    Object.assign(env, extraEnv(base))
    for (const r of rows) { mkdirSync(join(base, 'profiles', String(r.name)), { recursive: true }); writeFileSync(join(base, 'profiles', String(r.name), 'config.yaml'), '# seed\n') }
    writeFileSync(join(home, 'config.yaml'), '# seed\n')
    writeFileSync(join(base, 'config.yaml'), '# seed\n')
    const sidecar = new FakeSidecar()
    sidecar.respond('profiles.list', () => ({ profiles: rows.map((r) => ({ ...r, path: r.is_default ? base : join(base, 'profiles', String(r.name)) })) as never[] }))
    sidecar.respond('config.get', (params) => ({ path: join(params.profile_home, 'config.yaml'), exists: true, config: { workspace: params.profile_home } }))
    const s = await bootTestServer({ sidecar, env: { HERMES_HOME: home, ...env } })
    opened.push(s)
    return { s, home, base }
  }

  it('a profiles/<name> home without the flag is not isolated', async () => {
    const { s } = await boot({})
    expect(s.deps.isolatedProfileMode()).toBe(false)
  })

  it('a normal named-profile launch lists every profile', async () => {
    const { s } = await boot({})
    const body = await json(await s.get('/api/profiles'))
    expect((body.profiles as Json[]).map((p) => p.name)).toEqual(['default', 'webui', 'other'])
    expect(body.single_profile_mode).toBe(false)
  })

  it('switching profiles stays allowed under a named-profile home', async () => {
    const { s } = await boot({})
    expect((await post(s, '/api/profile/switch', { name: 'other' })).status).toBe(200)
  })

  it('every truthy flag spelling plus the profile shape isolates', async () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
      const { s } = await boot({ HERMES_WEBUI_ISOLATED_PROFILE: value })
      expect(s.deps.isolatedProfileMode(), value).toBe(true)
      expect(s.deps.activeProfile()).toBe('webui')
    }
  })

  it('the flag with a base home stays off', async () => {
    const sidecar = new FakeSidecar()
    const s = await bootTestServer({ sidecar, env: { HERMES_WEBUI_ISOLATED_PROFILE: '1' } })
    opened.push(s)
    expect(s.deps.isolatedProfileMode()).toBe(false)
  })

  it('falsey flag values keep isolation off even with the profile shape', async () => {
    for (const value of ['', '0', 'false', 'no', 'off', '  ']) {
      const { s } = await boot({ HERMES_WEBUI_ISOLATED_PROFILE: value })
      expect(s.deps.isolatedProfileMode(), JSON.stringify(value)).toBe(false)
    }
  })

  it('the pinned profile .env cannot turn the startup flag off', () => {
    const { base, home } = profileShapedHome('tenant')
    bases.push(base)
    mkdirSync(join(base, 'web'))
    writeFileSync(join(home, '.env'), 'HERMES_WEBUI_ISOLATED_PROFILE=0\nORDINARY_KEY=loaded\n')
    const env: Record<string, string | undefined> = { HERMES_HOME: home, HERMES_WEBUI_ISOLATED_PROFILE: '1' }
    loadStartupEnv({ env, webRoot: join(base, 'web'), home: base })
    expect(env.HERMES_WEBUI_ISOLATED_PROFILE).toBe('1')
    expect(env.ORDINARY_KEY).toBe('loaded')
  })

  it('HERMES_BASE_HOME alongside the pinned home keeps isolation on', async () => {
    const { s } = await boot({ HERMES_WEBUI_ISOLATED_PROFILE: '1' }, 'webui', undefined, (base) => ({ HERMES_BASE_HOME: base }))
    expect(s.deps.isolatedProfileMode()).toBe(true)
  })

  it('normal mode lists every profile the Agent reports', async () => {
    const { s } = await boot({}, 'user1', [row('user1'), row('user2'), row('user3')])
    expect(((await json(await s.get('/api/profiles'))).profiles as Json[]).map((p) => p.name)).toEqual(['user1', 'user2', 'user3'])
  })

  it('a pinned profiles/default home stays pinned for the default name', async () => {
    const { s, home } = await boot({ HERMES_WEBUI_ISOLATED_PROFILE: '1' }, 'default')
    expect(s.deps.activeProfile()).toBe('default')
    expect(s.deps.profileHome('default')).toBe(home)
  })

  it('explicit default resolution answers the pinned home', async () => {
    const { s, home } = await boot({ HERMES_WEBUI_ISOLATED_PROFILE: '1' }, 'default')
    expect(s.deps.profileHome('default')).toBe(home)
    expect(s.deps.profileHome('')).toBe(home)
  })

  it('the resolver never falls back to the base home in isolated mode', async () => {
    const { s, home, base } = await boot({ HERMES_WEBUI_ISOLATED_PROFILE: '1' }, 'default')
    expect(s.deps.profileHome('default')).toBe(home)
    expect(s.deps.profileHome('default')).not.toBe(base)
  })

  it('a foreign profile name resolves to the pinned home', async () => {
    const { s, home } = await boot({ HERMES_WEBUI_ISOLATED_PROFILE: '1' })
    expect(s.deps.profileHome('other')).toBe(home)
    expect(s.deps.profileHome('default')).toBe(home)
  })

  it('the isolated list carries one row whose path is the pinned home', async () => {
    const { s, home } = await boot({ HERMES_WEBUI_ISOLATED_PROFILE: '1' }, 'default', [row('default', { is_default: true }), row('default')])
    const profiles = (await json(await s.get('/api/profiles'))).profiles as Json[]
    expect(profiles).toHaveLength(1)
    expect(profiles[0]).toMatchObject({ name: 'default', path: home })
  })

  it('switching to the pinned profile passes the guard', async () => {
    const { s } = await boot({ HERMES_WEBUI_ISOLATED_PROFILE: '1' })
    expect((await post(s, '/api/profile/switch', { name: 'webui' })).status).toBe(200)
    expect((await post(s, '/api/profile/switch', { name: 'other' })).status).toBe(403)
  })

  it('switching to default in a pinned profiles/default home reads the pinned config', async () => {
    const { s, home } = await boot({ HERMES_WEBUI_ISOLATED_PROFILE: '1' }, 'default')
    const res = await post(s, '/api/profile/switch', { name: 'default' })
    expect(res.status).toBe(200)
    expect(realpathSync(String((await json(res)).default_workspace))).toBe(realpathSync(home))
  })
})

describe('an escaped process-wide profile', () => {
  it('refuses profile-scoped API requests instead of serving the root home, and leaves listing and switching away open', async () => {
    const base = mkdtempSync(join(tmpdir(), 'talaria-escaped-'))
    const outside = mkdtempSync(join(tmpdir(), 'talaria-escape-'))
    mkdirSync(join(base, 'profiles'), { recursive: true })
    symlinkSync(outside, join(base, 'profiles', 'rogue'))
    writeFileSync(join(base, 'active_profile'), 'rogue\n')
    writeFileSync(join(base, 'config.yaml'), '# seed\n')
    const sidecar = new FakeSidecar()
    sidecar.respond('profiles.list', () => ({ profiles: [row('default', { is_default: true, path: base })] as never[] }))
    sidecar.respond('config.get', (params) => ({ path: join(params.profile_home, 'config.yaml'), exists: true, config: {} }))
    const s = await bootTestServer({ sidecar, env: { HERMES_HOME: base } })
    try {
      expect(s.deps.activeProfile()).toBe('rogue')
      const refused = await s.get('/api/profile/active')
      expect(refused.status).toBe(400)
      expect(await refused.text()).toContain('outside the profiles directory')
      expect((await s.get('/api/profiles')).status).toBe(200)
      expect((await post(s, '/api/profile/switch', { name: 'default' })).status).toBe(200)
      // The sidecar-wide completion drain still runs, scoped to the base home instead of failing on every tick.
      const drained: string[] = []
      sidecar.respond('process.drain', (params) => { drained.push(params.profile_home); return { events: [] } })
      await s.deps.completions.drainOnce()
      expect(drained).toEqual([base])
    } finally {
      await s.close()
      rmSync(base, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('profile home routing and root aliases', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    sidecar.respond('profiles.list', () => ({ profiles: [row('default', { is_default: true }), row('ayan'), row('haku')] as never[] }))
    s = await bootTestServer({ sidecar })
    mkdirSync(join(s.state, 'profiles', 'ayan'), { recursive: true })
  })
  afterAll(() => s.close())

  it('an existing profile resolves to its directory', () => {
    expect(s.deps.profileHome('ayan')).toBe(join(s.state, 'profiles', 'ayan'))
  })

  it('a profile that does not exist yet still resolves under profiles/', () => {
    expect(s.deps.profileHome('newprofile')).toBe(join(s.state, 'profiles', 'newprofile'))
  })

  it('an absent profile resolves to the base home', () => {
    expect(s.deps.profileHome(null as unknown as string)).toBe(s.state)
  })

  it('an empty profile name resolves to the base home', () => {
    expect(s.deps.profileHome('')).toBe(s.state)
  })

  it('a real named profile resolves to profiles/<name>', () => {
    expect(s.deps.profileHome('haku')).toBe(join(s.state, 'profiles', 'haku'))
  })

  it('deleting a renamed root profile is refused', async () => {
    sidecar.respond('profiles.list', () => ({ profiles: [row('kinni', { is_default: true }), row('haku')] as never[] }))
    s.deps.profiles.invalidate()
    await s.deps.profiles.warmRootAliases()
    const res = await post(s, '/api/profile/delete', { name: 'kinni' })
    expect(res.status).toBe(400)
    expect(String((await json(res)).error)).toContain('Cannot delete the default profile')
  })
})

describe('per-profile system projects', () => {
  let dir = ''
  let indexRows: Json[] = []
  const store = (isRoot: (n: string) => boolean = (n) => n === 'default'): ProjectStore => new ProjectStore(join(dir, 'projects.json'), () => indexRows, isRoot)
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'talaria-projects-')) })
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); })
  const reset = (projects: Json[] = []): void => { writeFileSync(join(dir, 'projects.json'), JSON.stringify(projects)); indexRows = [] }

  it('each profile gets its own Cron Jobs project', () => {
    reset()
    const p = store()
    const haku = p.ensureSystemProject('cron', 'haku')
    const kinni = p.ensureSystemProject('cron', 'kinni')
    expect(haku).not.toBe(kinni)
    const rows = p.load().filter((r) => r.name === 'Cron Jobs')
    expect(rows.map((r) => r.profile).sort()).toEqual(['haku', 'kinni'])
  })

  it('repeat calls within one profile answer the same id', () => {
    reset()
    const p = store()
    expect(p.ensureSystemProject('cron', 'haku')).toBe(p.ensureSystemProject('cron', 'haku'))
    expect(p.load()).toHaveLength(1)
  })

  it('a legacy untagged Cron Jobs row is reused and tagged with the caller', () => {
    reset([{ project_id: 'legacy123456', name: 'Cron Jobs', color: '#6366f1' }])
    const p = store()
    expect(p.ensureSystemProject('cron', 'haku')).toBe('legacy123456')
    expect(p.load({ migrate: false })[0]).toMatchObject({ project_id: 'legacy123456', profile: 'haku' })
  })

  it('under a renamed root the default-tagged cron project is reused', () => {
    reset([{ project_id: 'rootcron1234', name: 'Cron Jobs', color: '#6366f1', profile: 'default' }])
    const p = store((n) => n === 'default' || n === 'kinni')
    expect(p.ensureSystemProject('cron', 'kinni')).toBe('rootcron1234')
    expect(p.load()).toHaveLength(1)
  })

  it('untagged projects inherit the profile of an assigned session and the backfill persists', () => {
    reset([{ project_id: 'proj00000001', name: 'Work', color: '#fff' }])
    indexRows = [{ session_id: 's1', project_id: 'proj00000001', profile: 'haku' }]
    const p = store()
    expect(p.load()[0]).toMatchObject({ profile: 'haku' })
    expect((JSON.parse(readFileSync(join(dir, 'projects.json'), 'utf8')) as Json[])[0]).toMatchObject({ profile: 'haku' })
  })

  it('an orphan untagged project falls back to default', () => {
    reset([{ project_id: 'proj00000002', name: 'Orphan', color: '#fff' }])
    expect(store().load()[0]).toMatchObject({ profile: 'default' })
  })

  it('a fully tagged projects.json is not rewritten', async () => {
    reset([{ project_id: 'proj00000003', name: 'Tagged', color: '#fff', profile: 'haku' }])
    const before = statSync(join(dir, 'projects.json')).mtimeMs
    await new Promise((r) => setTimeout(r, 20))
    const p = store()
    p.load()
    p.load()
    expect(statSync(join(dir, 'projects.json')).mtimeMs).toBe(before)
  })
})

describe('profiles, crons, workspaces, skills, and sessions across profiles', () => {
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
    sidecar.respond('skills.list', (params) => ({ success: true, skills: (skillRows.get(params.profile_home) ?? []) as never[], categories: [], count: (skillRows.get(params.profile_home) ?? []).length }))
    sidecar.respond('skills.find', (params) => { const dir = join(params.profile_home, 'skills', params.name); return { found: existsSync(dir), skill_dir: existsSync(dir) ? dir : null, skill_md: existsSync(dir) ? join(dir, 'SKILL.md') : null } })
    s = await bootTestServer({ sidecar })
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
      await new Promise((r) => setTimeout(r, 200))
      expect(homes).toEqual([])
      expect(s.logs.some((line) => line.includes(`wakeup retained for session ${sid}`) && line.includes('outside the profiles directory'))).toBe(true)
    } finally {
      rmSync(home, { force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('foreign cron jobs are hidden by default and counted; all_profiles shows them read-only', async () => {
    cronJobs.clear()
    cronJobs.set(s.state, [{ id: 'd1', name: 'mine', profile: null, toast_notifications: true, monitor: '', continuity: false }])
    cronJobs.set(join(s.state, 'profiles', 'research'), [{ id: 'r1', name: 'theirs', profile: 'research', toast_notifications: true, monitor: '', continuity: false }])
    let body = await json(await s.get('/api/crons'))
    expect(body).toMatchObject({ all_profiles: false, active_profile: 'default', other_profile_count: 1 })
    expect((body.jobs as Json[]).map((j) => j.id)).toEqual(['d1'])
    expect((body.jobs as Json[])[0]).toMatchObject({ owner_profile: 'default', read_only: false })
    body = await json(await s.get('/api/crons?all_profiles=1'))
    expect(body).toMatchObject({ all_profiles: true, other_profile_count: 0 })
    expect((body.jobs as Json[]).find((j) => j.id === 'r1')).toMatchObject({ owner_profile: 'research', read_only: true })
  })

  it('root aliases resolving to one home are read once', async () => {
    sidecar.respond('profiles.list', () => ({ profiles: [row('rootalias', { is_default: true, path: s.state }), row('default', { is_default: true, path: s.state }), row('research', { path: join(s.state, 'profiles', 'research') })] as never[] }))
    s.deps.profiles.invalidate()
    await s.deps.profiles.warmRootAliases()
    const start = sidecar.calls.length
    const body = await json(await s.get('/api/crons?all_profiles=1'))
    const listed = sidecar.calls.slice(start).filter((c) => c.method === 'cron.list').map((c) => (c.params as Json).profile_home)
    expect(listed.filter((h) => h === s.state)).toHaveLength(1)
    expect((body.jobs as Json[]).filter((j) => j.id === 'd1')).toHaveLength(1)
    sidecar.respond('profiles.list', () => ({ profiles: [row('default', { is_default: true, path: s.state }), row('work', { path: workHome }), row('research', { path: join(s.state, 'profiles', 'research') }), row('hidden', { visible: false, path: join(s.state, 'profiles', 'hidden') })] as never[] }))
    s.deps.profiles.invalidate()
  })

  it('a hidden inactive profile is skipped even under all_profiles', async () => {
    cronJobs.clear()
    cronJobs.set(s.state, [{ id: 'd2', name: 'mine', profile: null, toast_notifications: true, monitor: '', continuity: false }])
    cronJobs.set(join(s.state, 'profiles', 'hidden'), [{ id: 'h1', name: 'hidden job', profile: 'hidden', toast_notifications: true, monitor: '', continuity: false }])
    const body = await json(await s.get('/api/crons?all_profiles=1'))
    expect((body.jobs as Json[]).map((j) => j.id)).toEqual(['d2'])
    expect(body.other_profile_count).toBe(0)
  })

  it('a legacy job without a profile serialises profile: null', () => {
    const legacy = { id: 'legacy1', name: 'old', toast_notifications: true, monitor: '', continuity: false }
    expect(jobForApi(legacy)).toMatchObject({ id: 'legacy1', profile: null })
    expect('profile' in legacy).toBe(false)
  })

  it('creating a job with a known profile persists and returns it', async () => {
    cronJobs.clear()
    const res = await post(s, '/api/crons/create', { schedule: 'every 1h', prompt: 'hi', profile: 'research' })
    expect(res.status).toBe(200)
    expect(((await json(res)).job as Json).profile).toBe('research')
  })

  it('an unknown profile is refused before anything is created', async () => {
    cronJobs.clear()
    const before = sidecar.calls.filter((c) => c.method === 'cron.create').length
    const res = await post(s, '/api/crons/create', { schedule: 'every 1h', prompt: 'hi', profile: 'missing' })
    expect(res.status).toBe(400)
    expect(String((await json(res)).error)).toBe('Unknown profile: missing')
    expect(sidecar.calls.filter((c) => c.method === 'cron.create').length).toBe(before)
  })

  it('update clears the stored profile override, reports the execution store profile, and refuses an unknown one', async () => {
    cronJobs.clear()
    const created = (await json(await post(s, '/api/crons/create', { schedule: 'every 1h', prompt: 'hi', profile: 'research' }))).job as Json
    let res = await post(s, '/api/crons/update', { job_id: created.id, profile: '' })
    expect(res.status).toBe(200)
    expect(((await json(res)).job as Json).profile).toBe('research')
    expect(cronJobs.get(join(s.state, 'profiles', 'research'))?.[0]?.profile).toBeNull()
    const before = sidecar.calls.filter((c) => c.method === 'cron.update').length
    res = await post(s, '/api/crons/update', { job_id: created.id, profile: 'ghost' })
    expect(res.status).toBe(400)
    expect(String((await json(res)).error)).toBe('Unknown profile: ghost')
    expect(sidecar.calls.filter((c) => c.method === 'cron.update').length).toBe(before)
  })

  it('profile/active carries the resolved default workspace', async () => {
    const body = await json(await s.get('/api/profile/active'))
    expect(body).toMatchObject({ name: 'default', is_default: true })
    expect(typeof body.default_workspace).toBe('string')
    expect(String(body.default_workspace).length).toBeGreaterThan(0)
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
    const global = join(s.state, 'workspace', 'global-ws')
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
    expect((body.workspaces as { path: string; name: string }[]).map((w) => ({ ...w, path: realpathSync(w.path) }))).toEqual([{ path: realpathSync(join(workHome, 'ws-config')), name: 'Home' }])
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
    let releaseTitle: () => void = () => undefined
    sidecar.respond('aux.complete', () => new Promise((resolve) => { releaseTitle = () => { resolve({ model: 'aux', text: 'Titled', usage: null }) } }))
    sidecar.respond('chat.start', (params) => ({ status: 'completed', messages: [{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'done' }], final_response: 'done', error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '', usage: { prompt_tokens: 0, completion_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: null }, context: {}, model: 'm', provider: 'p', compressed: false, agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [] }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'hello there' }, { cookie }))
    await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}`, (f) => f.event === 'done', { headers: { cookie } })
    // Admission is released at `done`, but the title prompt is still parked on the profile's aux route.
    sidecar.respond('profiles.delete', () => ({ ok: true }))
    const refused = await post(s, '/api/profile/delete', { name: 'titling' }, asWork())
    expect(refused.status).toBe(409)
    expect(String((await json(refused)).error)).toContain('while an agent is running')
    releaseTitle()
    await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}&after_event_id=${String(start.stream_id)}:0`, (f) => f.event === 'stream_end', { headers: { cookie } })
    await new Promise((r) => setTimeout(r, 50))
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
    let releaseDelete: () => void = () => undefined
    sidecar.respond('profiles.delete', (params) => new Promise((resolve) => { releaseDelete = () => { rmSync(join(s.state, 'profiles', params.name), { recursive: true, force: true }); resolve({ ok: true }) } }))
    sidecar.respond('chat.start', (params) => ({ status: 'completed', messages: [{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'late' }], final_response: 'late', error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '', usage: { prompt_tokens: 0, completion_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: null }, context: {}, model: 'm', provider: 'p', compressed: false, agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [] }))
    const deletion = post(s, '/api/profile/delete', { name: 'doomed' }, asWork())
    const until = Date.now() + 5000
    while (!s.deps.profiles.isDeleting('doomed') && Date.now() < until) await new Promise((r) => setTimeout(r, 10))
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
    releaseDelete()
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
    const until = Date.now() + 5000
    while (!sidecar.calls.some((c) => c.method === 'config.get' && str((c.params as Json).profile_home).endsWith('wobbly')) && Date.now() < until) await new Promise((r) => setTimeout(r, 10))
    const deleting = post(s, '/api/profile/delete', { name: 'wobbly' }, asWork())
    await new Promise((r) => setTimeout(r, 80))
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
    const until = Date.now() + 5000
    while (!sidecar.calls.some((c) => c.method === 'config.set' && str((c.params as Json).profile_home).endsWith('fleeting')) && Date.now() < until) await new Promise((r) => setTimeout(r, 10))
    // The write is parked inside the sidecar; the delete must wait for it instead of removing the home underneath.
    const deletion = post(s, '/api/profile/delete', { name: 'fleeting' }, asWork())
    await new Promise((r) => setTimeout(r, 100))
    expect(order).toEqual([])
    expect(s.deps.profiles.isDeleting('fleeting')).toBe(true)
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
    const started = Date.now()
    const res = await post(s, '/api/profile/delete', { name: 'selfie' }, { cookie })
    expect(res.status, await res.clone().text()).toBe(200)
    expect(Date.now() - started).toBeLessThan(5000)
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
    const restarted = new ProfileService({ ...(s.deps.profiles as unknown as { deps: ConstructorParameters<typeof ProfileService>[0] }).deps })
    expect(restarted.beginWrite('ephemeral')).toBe('missing')
    expect(typeof restarted.beginWrite('work')).toBe('function')
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
    const until = Date.now() + 5000
    while (!sidecar.calls.some((c) => c.method === 'profiles.create' && (c.params as Json).name === 'copy') && Date.now() < until) await new Promise((r) => setTimeout(r, 10))
    const deleting = post(s, '/api/profile/delete', { name: 'source' }, asWork())
    await new Promise((r) => setTimeout(r, 80))
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
    let finishCommit: () => void = () => undefined
    sidecar.respond('chat.commit_memory', () => new Promise((resolve) => { finishCommit = () => { resolve({ committed: true }) } }))
    expect((await post(s, '/api/session/new', { profile: 'memo', prev_session_id: first }, { cookie })).status).toBe(200)
    expect(sidecar.calls.filter((c) => c.method === 'chat.commit_memory').at(-1)?.params).toEqual({ profile_home: join(s.state, 'profiles', 'memo'), session_id: first })
    sidecar.respond('profiles.delete', (params) => { rmSync(join(s.state, 'profiles', params.name), { recursive: true, force: true }); return { ok: true } })
    const refused = await post(s, '/api/profile/delete', { name: 'memo' }, asWork())
    expect(refused.status).toBe(409)
    finishCommit()
    await new Promise((r) => setTimeout(r, 50))
    expect(await json(await post(s, '/api/profile/delete', { name: 'memo' }, asWork()))).toEqual({ ok: true, name: 'memo' })
  })

  it('deletion re-checks profile activity after draining writers, so a commit started by a draining request still blocks it', async () => {
    mkdirSync(join(s.state, 'profiles', 'memo2'), { recursive: true })
    writeFileSync(join(s.state, 'profiles', 'memo2', 'config.yaml'), '# seed\n')
    s.deps.profiles.invalidate()
    const switched = await post(s, '/api/profile/switch', { name: 'memo2' })
    const cookie = (switched.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const first = String(((await json(await post(s, '/api/session/new', { profile: 'memo2' }, { cookie }))).session as Json).session_id)
    // An admitted request holds its write lease...
    const release = s.deps.profiles.beginWrite('memo2')
    expect(typeof release).toBe('function')
    sidecar.respond('profiles.delete', (params) => { rmSync(join(s.state, 'profiles', params.name), { recursive: true, force: true }); return { ok: true } })
    const deleting = post(s, '/api/profile/delete', { name: 'memo2' }, asWork())
    await new Promise((r) => setTimeout(r, 60))
    expect(s.deps.profiles.isDeleting('memo2')).toBe(true)
    // ...starts a detached memory commit on its way out, then releases the lease.
    let finishCommit: () => void = () => undefined
    sidecar.respond('chat.commit_memory', () => new Promise((resolve) => { finishCommit = () => { resolve({ committed: true }) } }))
    s.deps.sessions.deps.commitSessionMemory?.(first)
    if (typeof release === 'function') release()
    const refused = await deleting
    expect(refused.status).toBe(409)
    expect(existsSync(join(s.state, 'profiles', 'memo2'))).toBe(true)
    finishCommit()
    await new Promise((r) => setTimeout(r, 50))
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
      expect(typeof s.deps.profiles.beginWrite('sticky')).toBe('function')
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
      expect(s.deps.profiles.beginWrite('phoenix')).toBe('missing')
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
    expect(typeof s.deps.profiles.beginWrite('phoenix')).toBe('function')
    expect(JSON.parse(readFileSync(file, 'utf8')) as string[]).not.toContain('phoenix')
  })

  it('an unreadable tombstone record fails named-profile writes closed until it can be read again', () => {
    const file = join(s.deps.config.stateDir, 'deleted-profiles.json')
    const previous = existsSync(file) ? readFileSync(file, 'utf8') : null
    writeFileSync(file, '{not json')
    const broken = new ProfileService({ ...(s.deps.profiles as unknown as { deps: ConstructorParameters<typeof ProfileService>[0] }).deps })
    expect(broken.beginWrite('work')).toBe('unreadable')
    expect(typeof broken.beginWrite('default')).toBe('function')
    // Repaired record: the next lease attempt re-reads it and honours its contents.
    writeFileSync(file, JSON.stringify(['gone-profile']))
    expect(typeof broken.beginWrite('work')).toBe('function')
    expect(broken.beginWrite('gone-profile')).toBe('missing')
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
      expect(s.deps.sessionStore.get(sid)).toMatchObject({ profile: 'research', model: 'research-model', model_provider: 'anthropic' })
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
      expect(s.deps.sessionStore.get(sid)).toMatchObject({ profile: 'research', model: 'work-default-model', model_provider: 'anthropic' })
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

  it('all_profiles=1 aggregates in normal mode', async () => {
    expect((await json(await s.get('/api/sessions?all_profiles=1'))).all_profiles).toBe(true)
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
