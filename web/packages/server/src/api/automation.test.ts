import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { deflateRawSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { bootTestServer, type SseFrame, type TestServer } from '../test/harness.js'
import { completedAtSeconds, jobForApi, jobFieldUpdates } from '../tools/crons.js'
import { readZip } from '../workspace/unzip.js'
import { ExtensionService, normalizeLoopbackOrigin, normalizeProxyPath, isSafeRelativePath } from '../tools/extensions.js'
import type { PtyModuleLike, PtyProcessLike } from '../tools/terminal.js'
import { CLOSED_RETENTION_MS, TerminalRegistry } from '../tools/terminal.js'
import { crc32 } from '../workspace/zip.js'

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown, method = 'POST', headers: Record<string, string> = {}): Promise<Response> => s.get(path, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

class FakePtyProcess implements PtyProcessLike {
  pid = 4242
  written: string[] = []
  size = { cols: 0, rows: 0 }
  private dataCb: ((data: string) => void) | null = null
  private exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null
  killed: string[] = []
  write(data: string): void { this.written.push(data); this.dataCb?.(`echo:${data}`) }
  resize(cols: number, rows: number): void { this.size = { cols, rows } }
  kill(signal?: string): void { this.killed.push(signal ?? 'SIGTERM') }
  onData(cb: (data: string) => void): void { this.dataCb = cb }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void { this.exitCb = cb }
  emit(text: string): void { this.dataCb?.(text) }
  exit(code: number, signal?: number): void { this.exitCb?.(signal === undefined ? { exitCode: code } : { exitCode: code, signal }) }
}

function fakePty(): PtyModuleLike & { spawned: FakePtyProcess[]; opts: Json[] } {
  const spawned: FakePtyProcess[] = []
  const opts: Json[] = []
  return { spawned, opts, spawn: (_file, _args, o) => { const p = new FakePtyProcess(); spawned.push(p); opts.push(o); return p } }
}

/** A minimal stored/deflate zip with a central directory, for install tests. */
function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const compressed = deflateRawSync(data)
    const nameBuf = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, compressed)
    centrals.push(central, nameBuf)
    offset += local.length + nameBuf.length + compressed.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

describe('crons, kanban, extensions, terminal', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let pty: ReturnType<typeof fakePty>
  let zip: Buffer
  let sha: string
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    pty = fakePty()
    zip = makeZip({ 'ext-one/manifest.json': JSON.stringify({ version: '1.2.3', name: 'Ext One', scripts: ['main.js'], sidecar: { type: 'loopback', origin: 'http://127.0.0.1:4567' } }), 'ext-one/main.js': 'console.log(1)' })
    sha = (await import('node:crypto')).createHash('sha256').update(zip).digest('hex')
    const fakeFetch: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/registry.json')) return Promise.resolve(new Response(JSON.stringify({ extensions: [{ id: 'ext-one' }] }), { status: 200 }))
      if (url.endsWith('/ext-one.zip')) return Promise.resolve(new Response(zip, { status: 200 }))
      if (url.endsWith('/big.zip')) return Promise.resolve(new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024)) } }), { status: 200 }))
      if (url === 'http://127.0.0.1:4567/redirect') return Promise.resolve(new Response(null, { status: 302, headers: { location: '/ping?via=redirect' } }))
      if (url === 'http://127.0.0.1:4567/redirect-out') return Promise.resolve(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9999/ping' } }))
      if (url === 'http://127.0.0.1:4567/loop') return Promise.resolve(new Response(null, { status: 302, headers: { location: '/loop' } }))
      if (url === 'http://127.0.0.1:4567/big') return Promise.resolve(new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(64 * 1024)) } }), { status: 200, headers: { 'content-type': 'application/octet-stream' } }))
      if (url.startsWith('http://127.0.0.1:4567/')) {
        const sent = new Headers(init?.headers ?? {})
        return Promise.resolve(new Response(`proxied ${init?.method ?? 'GET'} ${url.slice('http://127.0.0.1:4567'.length)}${sent.has('x-client-hop') ? ` hop=${sent.get('x-client-hop') ?? ''}` : ''}`, { status: 200, headers: { 'content-type': 'text/plain', 'set-cookie': 'leak=1', 'x-hermes-secret': 'x' } }))
      }
      return Promise.resolve(new Response('nope', { status: 404 }))
    }
    s = await bootTestServer({ sidecar, deps: (deps) => { (deps as { fetch: typeof fetch }).fetch = fakeFetch } })
    ;(s.deps as { terminals: TerminalRegistry }).terminals = new TerminalRegistry({ env: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', HOME: s.state, SECRET: 'no' }, now: () => Date.now(), log: () => undefined, pty })
    writeFileSync(join(s.state, 'config.yaml'), '# seed\n')
    sidecar.respond('config.get', (params) => ({ path: join(params.profile_home, 'config.yaml'), exists: true, config: {} }))
    sidecar.respond('config.set', (params) => ({ ok: true as const, path: join(params.profile_home, 'config.yaml') }))
  })
  afterAll(() => s.close())

  it('cron create/update split a picked `@provider:model` id exactly as a chat request does (TAL-301)', async () => {
    const jobs = new Map<string, Json>()
    sidecar.respond('cron.list', () => ({ jobs: [...jobs.values()] as never[] }))
    sidecar.respond('cron.create', (params) => { const job = { id: `m${String(jobs.size + 1)}`, name: null, profile: null, toast_notifications: true, monitor: '', continuity: false, ...(params.job as Json), context_from: [] }; jobs.set(job.id, job); return { job: job } })
    sidecar.respond('cron.get', (params) => ({ job: (jobs.get(params.job_id) ?? null) as never }))
    sidecar.respond('cron.update', (params) => { const job = jobs.get(params.job_id); if (!job) throw new SidecarError('Job not found', { condition: 'not_found' }); Object.assign(job, params.updates); return { job: job as never } })
    const chat = (id: string): [string | null, string | null] => s.deps.sessions.deps.modelStateFromRequest(id, undefined, null)
    for (const id of ['@ollama:llama3:8b', '@custom:localhost:8080:m', '@gemini:gemini-2.5-flash']) {
      const created = (await json(await post(s, '/api/crons/create', { schedule: 'every 1h', prompt: 'hi', model: id, provider: 'stale' }))).job as Json
      const [model, provider] = chat(id)
      expect(jobs.get(String(created.id))).toMatchObject({ model, provider })
      expect(created).toMatchObject({ model, provider })
    }
    expect(jobs.get('m1')).toMatchObject({ model: 'llama3:8b', provider: 'ollama' })
    expect(jobs.get('m2')).toMatchObject({ model: 'm', provider: 'custom:localhost:8080' })
    // A bare id keeps its explicit provider.
    await post(s, '/api/crons/update', { job_id: 'm1', model: 'gemini-2.5-flash', provider: 'google' })
    expect(jobs.get('m1')).toMatchObject({ model: 'gemini-2.5-flash', provider: 'google' })
    await post(s, '/api/crons/update', { job_id: 'm1', model: '@ollama:llama3:8b' })
    expect(jobs.get('m1')).toMatchObject({ model: 'llama3:8b', provider: 'ollama' })
    // A job an older client stored with a qualified id reads back as a bare model and its provider.
    jobs.set('legacy', { id: 'legacy', name: 'legacy', profile: null, schedule: 'every 1h', prompt: 'x', toast_notifications: true, monitor: '', continuity: false, context_from: [], model: '@custom:localhost:8080:m', provider: 'custom' })
    const listed = ((await json(await s.get('/api/crons'))).jobs as Json[]).find((j) => j.id === 'legacy')
    expect(listed).toMatchObject({ model: 'm', provider: 'custom:localhost:8080' })
  })

  it('crons list merges profiles, create/update translate the form fields, and run-now answers on started', async () => {
    const jobs = new Map<string, Json>()
    sidecar.respond('cron.list', () => ({ jobs: [...jobs.values()] as never[] }))
    sidecar.respond('cron.create', (params) => { const job = { id: 'job1', name: null, profile: null, toast_notifications: true, monitor: '', continuity: false, ...(params.job as Json), context_from: (params.job as Json).context_from ?? [] }; jobs.set('job1', job); return { job: job } })
    sidecar.respond('cron.get', (params) => ({ job: (jobs.get(params.job_id) ?? null) as never }))
    sidecar.respond('cron.update', (params) => { const job = jobs.get(params.job_id); if (!job) throw new SidecarError('Job not found', { condition: 'not_found' }); Object.assign(job, params.updates); return { job: job as never } })
    let res = await post(s, '/api/crons/create', { schedule: 'every 1h', prompt: 'hi', monitor: 'https://x.example/m', continuity: true, toast_notifications: false })
    expect(res.status).toBe(200)
    let body = await json(res)
    expect(body.job).toMatchObject({ id: 'job1', monitor: 'https://x.example/m', continuity: true, toast_notifications: false })
    expect(jobs.get('job1')).toMatchObject({ monitor_url: 'https://x.example/m', monitor_script: '', context_from: ['self'] })
    res = await post(s, '/api/crons/create', { prompt: 'x' })
    expect(res.status).toBe(400)
    res = await post(s, '/api/crons/update', { job_id: 'job1', name: 'renamed', continuity: false, model: '' })
    body = await json(res)
    expect(body.job).toMatchObject({ name: 'renamed', continuity: false })
    expect(jobs.get('job1')).toMatchObject({ context_from: [], model: null })
    res = await post(s, '/api/crons/update', { job_id: 'ghost' })
    expect(res.status).toBe(404)
    res = await s.get('/api/crons')
    body = await json(res)
    expect(body.active_profile).toBe('default')
    expect((body.jobs as Json[])[0]).toMatchObject({ id: 'job1', owner_profile: 'default', read_only: false })
    sidecar.respond('cron.status', (params) => (params.job_id ? { job_id: params.job_id, running: false, elapsed: 0 } : { running: {} }))
    sidecar.respond('cron.run', (params, emit) => { emit({ event: 'started', data: { job_id: params.job_id } }); return new Promise((resolve) => setTimeout(() => { resolve({ job_id: params.job_id, status: 'completed', success: true, error: null, delivery_error: null }) }, 50)) })
    const feed = s.deps.events.subscribe()
    res = await post(s, '/api/crons/run', { job_id: 'job1' })
    expect(await json(res)).toEqual({ ok: true, job_id: 'job1', status: 'running' })
    // While the run is live the session list stamps `cron_running`; completion publishes `cron_complete`.
    expect(s.deps.sessions.deps.runtime.runningCronJobs.has('job1')).toBe(true)
    expect(s.deps.updates.blockedResponse('webui')).toMatchObject({ restart_blocked: true, active_cron_jobs: 1 })
    const event = await feed.next(AbortSignal.timeout(2000))
    feed.close()
    expect(event?.reason).toBe('cron_complete')
    expect(s.deps.sessions.deps.runtime.runningCronJobs.has('job1')).toBe(false)
    expect(s.deps.updates.blockedResponse('webui')).toBeNull()
    res = await post(s, '/api/crons/run', { job_id: 'nope' })
    expect(res.status).toBe(404)
    // A run that never starts is an error response, not `{ok:false,status:"error"}` behind a 200.
    sidecar.respond('cron.run', () => { throw new SidecarError('sidecar busy', { condition: 'sidecar_busy' }) })
    res = await post(s, '/api/crons/run', { job_id: 'job1' })
    expect(res.status).toBe(500)
    expect((await json(res)).error).toBe('sidecar busy')
    expect(s.deps.updates.blockedResponse('webui')).toBeNull()
    let dispatched!: () => void
    const dispatch = new Promise<void>((resolve) => { dispatched = resolve })
    let rejectRun!: (error: Error) => void
    sidecar.respond('cron.run', () => { dispatched(); return new Promise((_resolve, reject) => { rejectRun = reject }) })
    const pending = post(s, '/api/crons/run', { job_id: 'job1' })
    await dispatch
    // The RPC owns work before its started event, too; a failed start releases it.
    try {
      expect(s.deps.updates.blockedResponse('webui')).toMatchObject({ restart_blocked: true, active_cron_jobs: 1 })
      expect(await json(await post(s, '/api/crons/run', { job_id: 'job1' }))).toMatchObject({ status: 'already_running' })
    } finally {
      rejectRun(new Error('synthetic start failure'))
      expect((await pending).status).toBe(500)
    }
    expect(s.deps.updates.blockedResponse('webui')).toBeNull()
    let validating!: () => void
    const validation = new Promise<void>((resolve) => { validating = resolve })
    let rejectValidation!: (error: Error) => void
    sidecar.respond('cron.get', () => { validating(); return new Promise((_resolve, reject) => { rejectValidation = reject }) })
    const pendingValidation = post(s, '/api/crons/run', { job_id: 'job1' })
    await validation
    try {
      expect(s.deps.updates.blockedResponse('webui')).toMatchObject({ restart_blocked: true, active_cron_jobs: 1 })
    } finally {
      rejectValidation(new Error('synthetic validation failure'))
      expect((await pendingValidation).status).toBe(404)
    }
    expect(s.deps.updates.blockedResponse('webui')).toBeNull()
    res = await s.get('/api/crons/history?job_id=../x')
    expect(res.status).toBe(400)
    res = await s.get('/api/crons/delivery-options')
    expect(((await json(res)).platforms as Json[]).map((p) => p.value)).toContain('local')
    expect(jobForApi({ id: 'a', monitor_script: 'run.sh', context_from: ['other', 'SELF'] })).toMatchObject({ profile: null, monitor: 'run.sh', continuity: true })
    expect(jobFieldUpdates({ monitor: '', continuity: true }, ['x'])).toEqual({ monitor_script: '', monitor_url: '', context_from: ['x', 'self'] })
  })

  it('crons/recent answers each active-profile job\'s latest completion, newest first, with the server outcome and newest cron session', async () => {
    const home = s.deps.profileHome('default')
    const db = new DatabaseSync(join(home, 'state.db'))
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL, message_count INTEGER)')
    const insert = db.prepare('INSERT INTO sessions (id, source, started_at, message_count) VALUES (?, ?, ?, ?)')
    insert.run('cron_a_1', 'cron', 10, 2)
    insert.run('cron_a_2', 'cron', 20, 4)
    // `a_b` owns its own sessions even though they also start with `cron_a_`.
    insert.run('cron_a_b_1', 'cron', 30, 9)
    insert.run('cron_b_1', 'CLI', 40, 1)
    db.close()
    const job = (fields: Json): Json => ({ profile: null, toast_notifications: true, monitor: '', continuity: false, ...fields })
    sidecar.respond('cron.list', () => ({ jobs: ([
      { id: 'a', name: 'A', last_status: 'ok', last_run_at: '2026-01-02T00:00:00Z' },
      { id: 'b', name: 'B', last_status: 'error', last_run_at: 1767312000 },
      { id: 'c', name: 'C', last_status: 'mystery', last_run_at: 100 },
      { id: 'f', toast_notifications: false, last_run_at: 1767398400 },
      { id: 'g', name: null, last_status: 'Completed', last_run_at: '2026-01-01T00:00:00+00:00' },
      { id: 'a_b', name: 'never ran', last_run_at: null },
      { id: 'd', name: 'bad date', last_run_at: 'not a date' },
      { id: '', name: 'no id', last_run_at: 1767398400 },
    ] as Json[]).map(job) as never[] }))
    try {
      const calls = sidecar.calls.length
      let res = await s.get('/api/crons/recent')
      let body = await json(res)
      expect(sidecar.calls.slice(calls).filter((c) => c.method === 'cron.list').map((c) => c.params)).toEqual([{ profile_home: home }])
      expect(body.since).toBe(0)
      expect(body.completions).toEqual([
        { job_id: 'f', name: 'Unknown', status: 'unknown', outcome: 'unknown', completed_at: 1767398400, toast_notifications: false, session_id: '' },
        { job_id: 'a', name: 'A', status: 'ok', outcome: 'succeeded', completed_at: 1767312000, toast_notifications: true, session_id: 'cron_a_2', message_count: 4 },
        { job_id: 'b', name: 'B', status: 'error', outcome: 'failed', completed_at: 1767312000, toast_notifications: true, session_id: '' },
        { job_id: 'g', name: null, status: 'Completed', outcome: 'succeeded', completed_at: 1767225600, toast_notifications: true, session_id: '' },
        { job_id: 'c', name: 'C', status: 'mystery', outcome: 'unknown', completed_at: 100, toast_notifications: true, session_id: '' },
      ])
      body = await json(await s.get('/api/crons/recent?since=1767300000'))
      expect((body.completions as Json[]).map((c) => c.job_id)).toEqual(['f', 'a', 'b'])
      res = await s.get('/api/crons/recent?since=abc')
      expect(res.status).toBe(200)
      body = await json(res)
      expect(body.since).toBe(0)
      expect(body.completions).toHaveLength(5)
      sidecar.respond('cron.list', () => { throw new SidecarError('cron unavailable', { condition: 'cron_unavailable' }) })
      expect(await json(await s.get('/api/crons/recent?since=5'))).toEqual({ completions: [], since: 5 })
    } finally {
      rmSync(join(home, 'state.db'), { force: true })
    }
  })

  it('crons/recent reads only ISO or numeric completion times, server-local when no offset is given', () => {
    expect(completedAtSeconds('2026-01-02T00:00:00Z')).toBe(1767312000)
    expect(completedAtSeconds('2026-01-02T01:30:00+01:30')).toBe(1767312000)
    expect(completedAtSeconds('2026-01-02T01:30:00.250+0130')).toBe(1767312000.25)
    expect(completedAtSeconds('2026-01-02 00:00:00')).toBe(new Date(2026, 0, 2).getTime() / 1000)
    expect(completedAtSeconds('2026-01-02')).toBe(new Date(2026, 0, 2).getTime() / 1000)
    expect(completedAtSeconds(1767312000.5)).toBe(1767312000.5)
    for (const bad of ['Jan 2 2026', '2026', '2026-02-30', '2026-13-01', '2026-01-02T24:00', 'garbage', '', 0, null, true]) expect(completedAtSeconds(bad), String(bad)).toBeNull()
  })

  it('context-source HTTP responses are computed for the selected execution store', async () => {
    const fixture = new FakeSidecar()
    fixture.respond('profiles.list', ({ base_home }) => ({ profiles: [
      { name: 'default', path: base_home, is_default: true, gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0 },
      { name: 'research', path: join(base_home, 'profiles', 'research'), is_default: false, gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0 },
    ] }))
    const server = await bootTestServer({ sidecar: fixture })
    fixture.respond('cron.list', ({ profile_home }) => ({ jobs: (profile_home === server.state ? [
      { id: 'local', name: 'Local' },
    ] : [
      { id: 'editor', name: 'Editor', owner_profile: 'default' }, { id: 'source', name: 'Source', owner_profile: 'default' },
    ]).map((job) => ({ ...job, profile: null, toast_notifications: true, monitor: '', continuity: false })) }))
    try {
      const response = await post(server, '/api/crons/context-sources', { editing_job_id: 'editor', exclude_job_id: 'editor', selected_refs: ['local'] })
      expect(response.status).toBe(200)
      expect(await json(response)).toEqual({ profile: 'research', sources: [{ job_id: 'source', label: 'Source', selectable: true }, { job_id: 'local', label: 'Local', selectable: false }] })
    } finally { await server.close() }
  })

  it('crons/recent reads the request profile\'s cron store and state.db', async () => {
    const defaultHome = s.deps.profileHome('default')
    const workHome = join(defaultHome, 'profiles', 'work')
    const profile = (name: string, path: string, isDefault: boolean): Json => ({ name, path, is_default: isDefault, gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0 })
    sidecar.respond('profiles.list', () => ({ profiles: [profile('default', defaultHome, true), profile('work', workHome, false)] as never[] }))
    s.deps.profiles.invalidate()
    expect(s.deps.profileHome('work')).toBe(workHome)
    mkdirSync(workHome, { recursive: true })
    const db = new DatabaseSync(join(workHome, 'state.db'))
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL, message_count REAL); INSERT INTO sessions VALUES ('cron_w_1', 'cron', 1, 3.7)")
    db.close()
    sidecar.respond('cron.list', (params) => ({ jobs: (params.profile_home === workHome ? [{ id: 'w', name: 'Work', last_status: 'ok', last_run_at: 10 }] : [{ id: 'd', name: 'Default', last_status: 'ok', last_run_at: 10 }]).map((job) => ({ profile: null, toast_notifications: true, monitor: '', continuity: false, ...job })) }))
    try {
      const switched = await post(s, '/api/profile/switch', { name: 'work' })
      expect(switched.status).toBe(200)
      const cookie = (switched.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
      const calls = sidecar.calls.length
      const body = await json(await s.get('/api/crons/recent', { headers: { cookie } }))
      expect(sidecar.calls.slice(calls).filter((c) => c.method === 'cron.list').map((c) => c.params)).toEqual([{ profile_home: workHome }, { profile_home: defaultHome }])
      expect(body.completions).toEqual([{ job_id: 'w', name: 'Work', status: 'ok', outcome: 'succeeded', completed_at: 10, toast_notifications: true, session_id: 'cron_w_1', message_count: 3 }])
      expect(((await json(await s.get('/api/crons/recent'))).completions as Json[]).map((c) => c.job_id)).toEqual(['d'])
    } finally {
      rmSync(workHome, { recursive: true, force: true })
      sidecar.respond('profiles.list', () => ({ profiles: [profile('default', defaultHome, true)] as never[] }))
      s.deps.profiles.invalidate()
    }
  })

  it('blocks Web updates while an embedded terminal is alive and releases the blocker on exit', () => {
    const term = s.deps.terminals.start('update-blocker', s.state)
    const process = pty.spawned.at(-1)!
    expect(s.deps.updates.blockedResponse('webui')).toMatchObject({ restart_blocked: true, active_terminals: 1 })
    expect(process.killed).toEqual([])
    process.exit(0)
    expect(term.isAlive).toBe(false)
    expect(s.deps.updates.blockedResponse('webui')).toBeNull()
    s.deps.terminals.close('update-blocker')
  })

  it('kanban routes map to the sidecar, including path-parameter actions and the event stream', async () => {
    let res = await s.get('/api/kanban/boards')
    expect(res.status).toBe(200)
    expect(((await json(res)).boards as Json[])[0]).toMatchObject({ slug: 'default', is_current: true })
    res = await s.get('/api/kanban/board?only_mine=1&since=0')
    const body = await json(res)
    expect(body.changed).toBe(true)
    expect(sidecar.calls.find((c) => c.method === 'kanban.board')?.params).toMatchObject({ only_mine: true, since: 0, profile: 'default' })
    sidecar.respond('kanban.task', (params) => { if (params.task_id !== 't_1') throw new SidecarError('task not found', { condition: 'not_found' }); return { task: { id: 't_1', title: 'T', status: 'ready', priority: 1, claim_live: false, has_completion_evidence: false }, comments: [], events: [], links: { parents: [], children: [] }, runs: [], read_only: false } })
    res = await s.get('/api/kanban/tasks/t_1')
    expect((await json(res)).task).toMatchObject({ id: 't_1' })
    res = await s.get('/api/kanban/tasks/missing')
    expect(res.status).toBe(404)
    res = await post(s, '/api/kanban/tasks', { title: 'new', priority: 2 })
    expect(res.status).toBe(200)
    expect(sidecar.calls.some((c) => c.method === 'kanban.create_task' && (c.params as Json).task && ((c.params as Json).task as Json).title === 'new')).toBe(true)
    sidecar.respond('kanban.patch_task', (params) => { const status = (params.patch as Json).status; return { task: { id: params.task_id, title: 'patched', status: typeof status === 'string' ? status : 'ready', priority: 1, claim_live: false, has_completion_evidence: false }, read_only: false } })
    res = await post(s, '/api/kanban/tasks/t_1/patch', { status: 'todo' })
    expect((await json(res)).task).toMatchObject({ id: 't_1', status: 'todo' })
    res = await post(s, '/api/kanban/tasks/t_1', { title: 'x' }, 'PATCH')
    expect(res.status).toBe(200)
    sidecar.respond('kanban.task_action', (params) => ({ task: { id: params.task_id, title: 'T', status: params.action === 'block' ? 'blocked' : 'ready', priority: 1, claim_live: false, has_completion_evidence: false }, read_only: false }))
    res = await post(s, '/api/kanban/tasks/t_1/block', { reason: 'waiting' })
    expect((await json(res)).task).toMatchObject({ status: 'blocked' })
    res = await post(s, '/api/kanban/tasks/t_1/comments', { body: '' })
    expect(res.status).toBe(400)
    res = await post(s, '/api/kanban/links', { parent_id: 'a' })
    expect(res.status).toBe(400)
    res = await post(s, '/api/kanban/boards', { slug: 'experiments', name: 'Experiments' })
    expect((await json(res)).board).toMatchObject({ slug: 'experiments' })
    res = await post(s, '/api/kanban/boards/experiments/switch', {})
    expect(await json(res)).toEqual({ current: 'experiments', read_only: false })
    res = await post(s, '/api/kanban/config', { lane_by_profile: 'yes' }, 'PATCH')
    expect(res.status).toBe(400)
    res = await post(s, '/api/kanban/config', { lane_by_profile: false }, 'PATCH')
    expect((await json(res)).lane_by_profile).toBe(false)
    expect(sidecar.calls.some((c) => c.method === 'config.set' && JSON.stringify(c.params).includes('"lane_by_profile":false'))).toBe(true)
    let seq = 0
    sidecar.respond('kanban.events', (params) => {
      seq += 1
      const since = params.since ?? 0
      const events = seq === 2 && since < 7 ? [{ id: 7, task_id: 't_1', run_id: null, kind: 'created', payload: null, created_at: 1 }] : []
      return { events, cursor: events.length ? 7 : since, latest_event_id: 7, read_only: false }
    })
    const frames = await s.sse('/api/kanban/events/stream?since=3', (f: SseFrame) => f.event === 'events', { timeoutMs: 5_000 })
    expect(frames[0]).toMatchObject({ event: 'hello', data: { cursor: 3, board: null } })
    // `hello` reports the normalised slug (Python `_resolve_board`), not the raw query text.
    const normalised = await s.sse('/api/kanban/events/stream?board=Default', (f: SseFrame) => f.event === 'hello', { timeoutMs: 5_000 })
    expect(normalised[0]).toMatchObject({ event: 'hello', data: { board: 'default' } })
    // Path parameters win over same-named body keys; `reason` falls back to `block_reason` when empty.
    sidecar.respond('kanban.task_action', (params) => ({ task: { id: params.task_id, title: 'T', status: 'blocked', priority: 1, block_reason: params.reason, claim_live: false, has_completion_evidence: false }, read_only: false }))
    const blocked = await json(await post(s, '/api/kanban/tasks/t_1/block', { task_id: 't_other', reason: '', block_reason: 'x' }))
    expect(blocked.task).toMatchObject({ id: 't_1', block_reason: 'x' })
    expect((await json(await s.get('/api/kanban/nope'))).error).toContain('unknown Kanban endpoint: GET /api/kanban/nope')
    sidecar.respond('kanban.board', () => { throw new SidecarError('OperationalError: database is locked', { condition: 'sidecar_error' }) })
    const locked = await s.get('/api/kanban/board')
    expect(locked.status).toBe(500)
    expect(await json(locked)).toEqual({ error: 'Internal server error' })
    const eventsFrame = frames.find((f) => f.event === 'events')
    expect(eventsFrame?.id).toBe('7')
    expect((eventsFrame?.data as Json).cursor).toBe(7)
  })

  it('kanban tasks carry the server-owned card actions and running-exit policy for their status (TAL-557)', async () => {
    const methods = ['kanban.board', 'kanban.task', 'kanban.task_action', 'kanban.patch_task', 'kanban.create_task'] as const
    const saved = methods.map((m) => [m, sidecar.responderFor(m)] as const)
    onTestFinished(() => { for (const [m, r] of saved) sidecar.respond(m, r) })
    const statuses = ['triage', 'todo', 'ready', 'running', 'blocked', 'done', 'archived', 'future']
    const task = (id: string, status: string, facts: { claim_live?: boolean; has_completion_evidence?: boolean } = {}) => ({ id, title: id, status, priority: 0, claim_live: false, has_completion_evidence: true, ...facts })
    // Each column holds the plain case; extra columns cover a running card whose worker still holds the claim and a card with no stored result.
    const columns = [...statuses.map((st) => ({ name: st, tasks: [task(st, st)] })), { name: 'running-live', tasks: [task('running-live', 'running', { claim_live: true })] }, { name: 'ready-no-result', tasks: [task('ready-no-result', 'ready', { has_completion_evidence: false })] }]
    sidecar.respond('kanban.board', () => ({ changed: true, columns, tenants: [], assignees: [], latest_event_id: 1, read_only: false, filters: { tenant: null, assignee: null, include_archived: true, only_mine: false, profile: null } }))
    const board = await json(await s.get('/api/kanban/board?include_archived=1'))
    const policy = Object.fromEntries((board.columns as Json[]).map((c) => { const t = (c.tasks as Json[])[0]!; return [String(c.name), { actions: t.available_actions, confirm: t.requires_running_exit_confirmation }] }))
    const a = (block: boolean, unblock: boolean, complete: boolean, archive: boolean, move_to: string[]) => ({ block, unblock, complete, archive, move_to })
    expect(policy).toEqual({
      triage: { actions: a(false, false, false, true, ['todo', 'ready']), confirm: false },
      todo: { actions: a(false, false, false, true, ['triage', 'ready']), confirm: false },
      ready: { actions: a(true, false, true, true, ['triage', 'todo']), confirm: false },
      running: { actions: a(true, false, true, true, ['triage', 'todo', 'ready']), confirm: true },
      blocked: { actions: a(false, true, true, true, ['triage', 'todo']), confirm: false },
      done: { actions: a(false, false, false, true, ['triage', 'todo', 'ready']), confirm: false },
      archived: { actions: a(false, false, false, false, ['triage', 'todo', 'ready']), confirm: false },
      future: { actions: a(false, false, false, false, []), confirm: false },
      'running-live': { actions: a(false, false, false, true, []), confirm: true },
      'ready-no-result': { actions: a(true, false, false, true, ['triage', 'todo']), confirm: false },
    })
    expect(board.bulk_move_targets).toEqual(['triage', 'todo', 'ready', 'blocked', 'done'])
    sidecar.respond('kanban.board', () => ({ changed: false, latest_event_id: 1, read_only: false }))
    expect((await json(await s.get('/api/kanban/board?since=1'))).bulk_move_targets).toEqual(['triage', 'todo', 'ready', 'blocked', 'done'])
    // Detail and every mutation envelope carry the policy of the status the server returned.
    // The detail names the newest Block or Unblock event, so a client whose write outcome was lost can confirm it landed.
    const events = [{ id: 3, task_id: 't_1', run_id: null, kind: 'blocked', payload: null, created_at: 1 }, { id: 7, task_id: 't_1', run_id: null, kind: 'unblocked', payload: null, created_at: 2 }, { id: 9, task_id: 't_1', run_id: null, kind: 'commented', payload: null, created_at: 3 }]
    sidecar.respond('kanban.task', () => ({ task: task('t_1', 'running'), comments: [], events, links: { parents: [], children: [] }, runs: [], read_only: false }))
    expect((await json(await s.get('/api/kanban/tasks/t_1'))).last_card_action).toEqual({ action: 'unblock', event_id: 7 })
    expect((await json(await s.get('/api/kanban/tasks/t_1'))).task).toMatchObject({ requires_running_exit_confirmation: true, available_actions: { block: true, move_to: ['triage', 'todo', 'ready'] } })
    // Unblock lands where the Agent re-gates it (here `todo`), and the actions follow that status.
    sidecar.respond('kanban.task_action', (params) => ({ task: { id: params.task_id, title: 'T', status: params.action === 'block' ? 'blocked' : 'todo', priority: 0, claim_live: false, has_completion_evidence: false }, read_only: false }))
    expect((await json(await post(s, '/api/kanban/tasks/t_1/unblock', {}))).task).toMatchObject({ status: 'todo', available_actions: a(false, false, false, true, ['triage', 'ready']) })
    expect((await json(await post(s, '/api/kanban/tasks/t_1/block', {}))).task).toMatchObject({ available_actions: { unblock: true } })
    // Leaving Running needs the client's confirmation; the sidecar judges it on the row the write sees.
    const blockCalls = () => sidecar.calls.filter((c) => c.method === 'kanban.task_action' && (c.params as Json).action === 'block').map((c) => (c.params as Json).confirm_running_exit)
    await post(s, '/api/kanban/tasks/t_1/block', { confirm_running_exit: true })
    expect(blockCalls().slice(-2)).toEqual([false, true])
    sidecar.respond('kanban.patch_task', (params) => ({ task: { id: params.task_id, title: 'T', status: String((params.patch as Json).status), priority: 0, claim_live: false, has_completion_evidence: false }, read_only: false }))
    expect((await json(await post(s, '/api/kanban/tasks/t_1/patch', { status: 'done' }))).task).toMatchObject({ available_actions: { complete: false, archive: true } })
    expect((await json(await post(s, '/api/kanban/tasks/t_1', { status: 'archived' }, 'PATCH'))).task).toMatchObject({ available_actions: { archive: false } })
    sidecar.respond('kanban.create_task', () => ({ task: { id: 't_new', title: 'N', status: 'triage', priority: 0, claim_live: false, has_completion_evidence: false }, read_only: false }))
    expect((await json(await post(s, '/api/kanban/tasks', { title: 'N' }))).task).toMatchObject({ available_actions: { move_to: ['todo', 'ready'] } })
  })

  it('kanban search, profile lanes, stats totals, removable boards and board slugs are server-owned (TAL-567)', async () => {
    const methods = ['kanban.board', 'kanban.stats', 'kanban.boards', 'kanban.create_board', 'config.get', 'config.set'] as const
    const saved = methods.map((m) => [m, sidecar.responderFor(m)] as const)
    onTestFinished(() => { for (const [m, r] of saved) sidecar.respond(m, r) })
    // The saved view lives in config.yaml; this config keeps what the PATCH writes.
    let stored: Json = {}
    sidecar.respond('config.get', (params) => ({ path: join(params.profile_home, 'config.yaml'), exists: true, config: stored }))
    sidecar.respond('config.set', (params) => { stored = params.config; return { ok: true as const, path: join(params.profile_home, 'config.yaml') } })
    const task = (id: string, status: string, extra: Json = {}) => ({ id, title: `Task ${id}`, status, priority: 0, claim_live: false, has_completion_evidence: false, ...extra })
    const columns = [
      { name: 'todo', tasks: [task('t_1', 'todo', { assignee: 'builder', body: 'Fix the Login flow' }), task('t_2', 'todo', { tenant: 'acme' })] },
      { name: 'ready', tasks: [task('t_3', 'ready', { assignee: 'reviewer' }), task('t_4', 'ready', { assignee: 'builder' })] },
    ]
    sidecar.respond('kanban.board', () => ({ changed: true, columns, tenants: ['acme'], assignees: ['builder', 'reviewer'], latest_event_id: 4, read_only: false, filters: { tenant: null, assignee: null, include_archived: false, only_mine: false, profile: null } }))
    const ids = (cols: Json[]) => cols.map((c) => [c.name, (c.tasks as Json[]).map((t) => t.id)])

    // Search matches id, title, body, assignee and tenant, case-insensitively, and keeps every column.
    await post(s, '/api/kanban/config', { lane_by_profile: false }, 'PATCH')
    let board = await json(await s.get('/api/kanban/board?search=LOGIN'))
    expect(ids(board.columns as Json[])).toEqual([['todo', ['t_1']], ['ready', []]])
    expect(ids((await json(await s.get('/api/kanban/board?search=acme'))).columns as Json[])).toEqual([['todo', ['t_2']], ['ready', []]])
    expect(ids((await json(await s.get('/api/kanban/board?search=%20t_3%20'))).columns as Json[])).toEqual([['todo', []], ['ready', ['t_3']]])
    expect(board).toMatchObject({ lane_by_profile: false, tenants: ['acme'] })
    expect(board.lanes).toBeUndefined()

    // Lanes by profile: one lane per assignee in name order, unassigned last, each with every column and its own count.
    await post(s, '/api/kanban/config', { lane_by_profile: true }, 'PATCH')
    board = await json(await s.get('/api/kanban/board'))
    expect(board.lane_by_profile).toBe(true)
    expect((board.lanes as Json[]).map((l) => [l.assignee, l.count, ids(l.columns as Json[])])).toEqual([
      ['builder', 2, [['todo', ['t_1']], ['ready', ['t_4']]]],
      ['reviewer', 1, [['todo', []], ['ready', ['t_3']]]],
      [null, 1, [['todo', ['t_2']], ['ready', []]]],
    ])
    expect(((board.lanes as Json[])[0]!.columns as Json[])[0]).toMatchObject({ tasks: [{ id: 't_1', available_actions: { archive: true } }] })
    // Lanes follow the search too.
    expect((await json(await s.get('/api/kanban/board?search=reviewer'))).lanes).toMatchObject([{ assignee: 'reviewer', count: 1 }])
    sidecar.respond('kanban.board', () => ({ changed: false, latest_event_id: 4, read_only: false }))
    expect(await json(await s.get('/api/kanban/board?since=4'))).toMatchObject({ changed: false, lane_by_profile: true })

    // Stats carry the total and the counts in board-column order, unknown statuses after.
    sidecar.respond('kanban.stats', () => ({ by_status: { done: 2, blocked: 1, triage: 3, zeta: 1 }, by_assignee: {} }))
    expect(await json(await s.get('/api/kanban/stats'))).toMatchObject({ total: 7, status_counts: [{ status: 'triage', count: 3 }, { status: 'blocked', count: 1 }, { status: 'done', count: 2 }, { status: 'zeta', count: 1 }] })

    // Every board says whether it can be removed; the default board cannot.
    sidecar.respond('kanban.boards', () => ({ boards: [{ slug: 'default', name: 'Default', is_current: true, counts: {}, total: 0 }, { slug: 'ops', name: 'Ops', is_current: false, counts: {}, total: 0 }], current: 'default', read_only: false }))
    expect(((await json(await s.get('/api/kanban/boards'))).boards as Json[]).map((b) => [b.slug, b.removable])).toEqual([['default', false], ['ops', true]])

    // A board created with only a name gets its slug from the server.
    sidecar.respond('kanban.create_board', (params) => ({ board: { slug: String((params.board_spec as Json).slug) }, current: 'x', read_only: false }))
    expect((await json(await post(s, '/api/kanban/boards', { name: '  Q3 Launch: Ops!  ' }))).board).toEqual({ slug: 'q3-launch-ops' })
    expect((await json(await post(s, '/api/kanban/boards', { name: 'Ignored', slug: 'kept' }))).board).toEqual({ slug: 'kept' })
  })

  it('extension status, registry, install, static serving, consent, proxy, and uninstall', async () => {
    let res = await s.get('/api/extensions/status')
    let body = await json(res)
    expect(body).toMatchObject({ enabled: false, extension_dir_configured: true, extension_dir_valid: false })
    res = await s.get('/api/extensions/registry')
    expect(await json(res)).toEqual({ entries: [{ id: 'ext-one' }] })
    res = await post(s, '/api/extensions/install', { id: 'ext-one', download_url: 'https://evil.example/ext-one.zip', sha256: sha })
    expect(res.status).toBe(400)
    res = await post(s, '/api/extensions/install', { id: 'ext-one', download_url: 'https://hermes-webui.github.io/x/big.zip', sha256: sha })
    expect((await json(res)).error).toBe('Download too large')
    res = await post(s, '/api/extensions/install', { id: 'ext-one', download_url: 'https://hermes-webui.github.io/x/ext-one.zip', sha256: 'f'.repeat(64) })
    expect((await json(res)).error).toBe('SHA-256 mismatch')
    res = await post(s, '/api/extensions/install', { id: 'ext-one', download_url: 'https://hermes-webui.github.io/x/ext-one.zip', sha256: sha })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ installed: true, id: 'ext-one', version: '1.2.3' })
    expect(readFileSync(join(s.state, 'extensions', 'ext-one', 'main.js'), 'utf8')).toBe('console.log(1)')
    res = await s.get('/api/extensions/status')
    body = await json(res)
    expect(body.enabled).toBe(true)
    expect((body.manifest as Json).status).toBe('gallery_installed')
    expect(body.script_urls).toEqual(['/extensions/ext-one/main.js'])
    expect((body.extensions as Json[])[0]).toMatchObject({ id: 'ext-one', name: 'Ext One', effective_enabled: true })
    expect((body.sidecars as Json[])[0]).toMatchObject({ origin: 'http://127.0.0.1:4567', proxy: { available: true, consented: false, consent_required: true } })
    res = await s.get('/extensions/ext-one/main.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/javascript; charset=utf-8')
    res = await s.get('/extensions/ext-one/../manifest.json')
    expect(res.status).toBe(404)
    // A symlink inside the extension directory never exposes its target (Python `serve_extension_static`).
    writeFileSync(join(s.state, 'secret.env'), 'TOKEN=leak\n')
    symlinkSync(join(s.state, 'secret.env'), join(s.state, 'extensions', 'ext-one', 'secret'))
    res = await s.get('/extensions/ext-one/secret')
    expect(res.status).toBe(404)
    unlinkSync(join(s.state, 'extensions', 'ext-one', 'secret'))
    res = await s.get('/api/extensions/manifests')
    body = await json(res)
    expect((body.manifests as Json[])[0]).toMatchObject({ id: 'ext-one', enabled: true, legacy_injection: false, capabilities: [] })
    const browserHeaders = { origin: s.base, referer: `${s.base}/`, 'sec-fetch-site': 'same-origin' }
    res = await post(s, '/api/extensions/ext-one/sidecar/ping', {}, 'POST', browserHeaders)
    expect(res.status).toBe(403)
    res = await post(s, '/api/extensions/sidecar-proxy-consent', { id: 'ext-one', approved: true })
    expect(res.status).toBe(200)
    expect(((await json(res)).sidecars as Json[])[0]).toMatchObject({ proxy: { consented: true } })
    res = await s.get('/api/extensions/ext-one/sidecar/ping?x=1', { headers: browserHeaders })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('proxied GET /ping?x=1')
    // An unsafe browser request to the proxy goes through the CSRF check like every other /api write.
    await s.deps.settings.save({ _set_password: 'hunter22' })
    s.deps.auth.invalidatePasswordHashCache()
    try {
      const sessionCookie = `${s.deps.auth.cookieName()}=${s.deps.auth.createSession({ authType: 'password' })}`
      const noToken = await post(s, '/api/extensions/ext-one/sidecar/ping', { a: 1 }, 'POST', { ...browserHeaders, cookie: sessionCookie })
      expect(noToken.status).toBe(403)
      expect(String((await json(noToken)).error)).toBe('Session expired - reload the page')
    } finally {
      await s.deps.settings.save({ _clear_password: true })
      s.deps.auth.invalidatePasswordHashCache()
    }
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('x-hermes-secret')).toBeNull()
    // Same-origin redirects are followed server-side; cross-origin hops, loops, and oversized bodies answer 502.
    res = await post(s, '/api/extensions/ext-one/sidecar/redirect', { a: 1 }, 'POST', browserHeaders)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('proxied GET /ping?via=redirect')
    // Python's opener raised on a cross-origin hop or the hop limit; both surfaced as the generic reach failure.
    res = await s.get('/api/extensions/ext-one/sidecar/redirect-out', { headers: browserHeaders })
    expect(res.status).toBe(502)
    expect(await json(res)).toEqual({ error: 'Failed to reach extension sidecar' })
    res = await s.get('/api/extensions/ext-one/sidecar/loop', { headers: browserHeaders })
    expect(res.status).toBe(502)
    expect(await json(res)).toEqual({ error: 'Failed to reach extension sidecar' })
    // A percent-malformed id is invalid input; an encoded spelling of a valid id is not accepted either (raw match).
    expect((await s.get('/api/extensions/%zz/sidecar/ping', { headers: browserHeaders })).status).toBe(400)
    expect((await s.get('/api/extensions/ext%2Done/sidecar/ping', { headers: browserHeaders })).status).toBe(400)
    // Request headers named in `Connection:` never reach the sidecar (fetch forbids that header, so raw HTTP).
    const hop = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: s.running.port, path: '/api/extensions/ext-one/sidecar/ping', method: 'GET', headers: { ...browserHeaders, connection: 'close, x-client-hop', 'x-client-hop': 'secret' } }, (r) => {
        let text = ''
        r.on('data', (c: Buffer) => { text += c.toString('utf8') })
        r.on('end', () => { resolve({ status: r.statusCode ?? 0, text }) })
      })
      req.on('error', reject)
      req.end()
    })
    expect(hop.status).toBe(200)
    expect(hop.text).toBe('proxied GET /ping')
    res = await s.get('/api/extensions/ext-one/sidecar/ping', { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } })
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe('Cross-origin mismatch - check reverse proxy headers')
    res = await s.get('/api/extensions/ext-one/sidecar/big', { headers: browserHeaders })
    expect(res.status).toBe(502)
    expect(await json(res)).toEqual({ error: 'Extension sidecar response too large' })
    res = await s.get('/api/extensions/ext-one/sidecar/ping')
    expect(res.status).toBe(403)
    res = await post(s, '/api/extensions/toggle', { id: 'ext-one', enabled: false })
    expect(((await json(res)).extensions as Json[])[0]).toMatchObject({ user_disabled: true, status: 'user_disabled' })
    expect(JSON.parse(readFileSync(join(s.state, 'extension-overrides.json'), 'utf8'))).toMatchObject({ disabled_extensions: ['ext-one'] })
    res = await post(s, '/api/extensions/toggle', { id: 'ghost', enabled: true })
    expect(res.status).toBe(404)
    res = await post(s, '/api/extensions/uninstall', { id: 'ext-one' })
    expect(await json(res)).toEqual({ uninstalled: true, id: 'ext-one' })
    expect(existsSync(join(s.state, 'extensions', 'ext-one'))).toBe(false)
  })

  it('a shell that exits before the viewer attaches still replays its output and exit code, and the entry is retired later', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    mkdirSync(join(s.state, 'workspace'), { recursive: true })
    expect((await post(s, '/api/terminal/start', { session_id: sid })).status).toBe(200)
    const proc = pty.spawned.at(-1)!
    proc.emit('login shell says bye\n')
    proc.exit(3)
    // Late attach: the closed terminal is still there with its backlog and exit code.
    const frames = await s.sse(`/api/terminal/output?session_id=${sid}`, (f: SseFrame) => f.event === 'terminal_closed', { timeoutMs: 5_000 })
    expect(frames.map((f) => f.event)).toEqual(['output', 'terminal_closed'])
    expect(frames[1]?.data).toEqual({ exit_code: 3 })
    expect((await post(s, '/api/terminal/input', { session_id: sid, data: 'x' })).status).toBe(404)
    const registry = s.deps.terminals
    expect(registry.get(sid)?.closed).toBe(true)
    // The reaper retires it once the retention window passes; a new start replaces it meanwhile.
    expect(registry.reapIdle(Date.now() + CLOSED_RETENTION_MS + 1)).toBeGreaterThanOrEqual(1)
    expect(registry.get(sid)).toBeNull()
    expect((await s.get(`/api/terminal/output?session_id=${sid}`)).status).toBe(404)
  })

  it('the output stream does not accumulate abort listeners across wakes', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    mkdirSync(join(s.state, 'workspace'), { recursive: true })
    expect((await post(s, '/api/terminal/start', { session_id: sid })).status).toBe(200)
    const proc = pty.spawned.at(-1)!
    const warnings: string[] = []
    const onWarning = (w: Error): void => { warnings.push(w.name) }
    process.on('warning', onWarning)
    try {
      // Hundreds of output chunks each wake the loop once; the abort listener must be removed on every wake.
      const chunks = 300
      setTimeout(() => { for (let i = 0; i < chunks; i += 1) proc.emit(`line ${String(i)}\n`); setTimeout(() => { proc.exit(0) }, 50) }, 20)
      const frames = await s.sse(`/api/terminal/output?session_id=${sid}`, (f: SseFrame) => f.event === 'terminal_closed', { timeoutMs: 10_000 })
      expect(frames.filter((f) => f.event === 'output').length).toBe(chunks)
      await new Promise((r) => setTimeout(r, 20))
      expect(warnings).not.toContain('MaxListenersExceededWarning')
    } finally {
      process.off('warning', onWarning)
      await post(s, '/api/terminal/close', { session_id: sid })
    }
  })

  it('an output viewer that falls behind holds at most the terminal backlog and receives the newest output in order', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    mkdirSync(join(s.state, 'workspace'), { recursive: true })
    expect((await post(s, '/api/terminal/start', { session_id: sid })).status).toBe(200)
    const proc = pty.spawned.at(-1)!
    // 6000 chunks land while the stream waits: its queue keeps the newest, as the 2000-line backlog does for a reconnect.
    const chunks = 6000
    setTimeout(() => { for (let i = 1; i <= chunks; i += 1) proc.emit(`${'x'.repeat(4096)}${String(i)}`); proc.exit(0) }, 20)
    const frames = await s.sse(`/api/terminal/output?session_id=${sid}`, (f: SseFrame) => f.event === 'terminal_closed', { timeoutMs: 20_000 })
    const outputs = frames.filter((f) => f.event === 'output').map((f) => Number(f.id))
    expect(frames.at(-1)?.event).toBe('terminal_closed')
    expect(outputs.length).toBeLessThanOrEqual(2000)
    expect(outputs.at(-1)).toBe(chunks)
    expect(outputs).toEqual(Array.from({ length: outputs.length }, (_, i) => chunks - outputs.length + 1 + i))
    await post(s, '/api/terminal/close', { session_id: sid })
  })

  it('closeAll({ immediate: true }) hangs up and kills every shell synchronously for process exit', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    mkdirSync(join(s.state, 'workspace'), { recursive: true })
    expect((await post(s, '/api/terminal/start', { session_id: sid })).status).toBe(200)
    const proc = pty.spawned.at(-1)!
    const killed: [number, string][] = []
    const spy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => { killed.push([pid, String(signal)]); return true })
    try {
      s.deps.terminals.closeAll({ immediate: true })
    } finally {
      spy.mockRestore()
    }
    // Python's atexit path: SIGHUP, up to 1.5 s of grace, then SIGKILL for a shell that is still running.
    expect(proc.killed).toEqual(['SIGHUP', 'SIGKILL'])
    expect(killed).toEqual([])
    expect(s.deps.terminals.get(sid)).toBeNull()
    expect((await s.get(`/api/terminal/output?session_id=${sid}`)).status).toBe(404)
  })

  it('terminal start/input/resize/output/close with the pty stub, gated to local origins', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    mkdirSync(join(s.state, 'workspace'), { recursive: true })
    const spawnedBefore = pty.spawned.length
    let res = await post(s, '/api/terminal/start', { session_id: sid, rows: 500, cols: 10 })
    expect(res.status).toBe(200)
    let body = await json(res)
    expect(body).toMatchObject({ ok: true, session_id: sid, running: true })
    const proc = pty.spawned.at(-1)!
    // Winsize is clamped; the shell's environment carries the requested size, as in Python.
    expect(pty.opts.at(-1)).toMatchObject({ rows: 80, cols: 20, env: { TERM: 'xterm-256color', HERMES_WEBUI_TERMINAL: '1', LINES: '500', COLUMNS: '10' } })
    expect((pty.opts.at(-1)?.env as Json).SECRET).toBeUndefined()
    res = await post(s, '/api/terminal/input', { session_id: sid, data: 'ls\n' })
    expect(await json(res)).toEqual({ ok: true })
    expect(proc.written).toEqual(['ls\n'])
    res = await post(s, '/api/terminal/resize', { session_id: sid, rows: 30, cols: 100 })
    expect(proc.size).toEqual({ cols: 100, rows: 30 })
    const frames = await s.sse(`/api/terminal/output?session_id=${sid}`, (f: SseFrame) => f.event === 'output' && String((f.data as Json).text).includes('ls'), { timeoutMs: 5_000 })
    expect(frames[0]).toMatchObject({ event: 'output', id: '1', data: { text: 'echo:ls\n' } })
    setTimeout(() => { proc.emit('more'); proc.exit(0) }, 20)
    const tail = await s.sse(`/api/terminal/output?session_id=${sid}`, (f: SseFrame) => f.event === 'terminal_closed', { timeoutMs: 5_000, headers: { 'last-event-id': '1' } })
    expect(tail.map((f) => f.event)).toEqual(['output', 'terminal_closed'])
    expect(tail[1]?.data).toEqual({ exit_code: 0 })
    res = await post(s, '/api/terminal/input', { session_id: sid, data: 'x' })
    expect(res.status).toBe(404)
    expect((await json(res)).error).toBe("'terminal not running'")
    res = await post(s, '/api/terminal/close', { session_id: sid })
    expect((await json(res)).ok).toBe(true)
    res = await post(s, '/api/terminal/start', { session_id: 'ghost' })
    expect(res.status).toBe(404)
    expect((await json(res)).error).toBe("'Session not found'")
    // Python `int()` on the size fields, `require()` on the body, `str(KeyError)` quoting for a closed terminal.
    res = await post(s, '/api/terminal/start', { session_id: sid, rows: 'abc' })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe("invalid literal for int() with base 10: 'abc'")
    res = await post(s, '/api/terminal/resize', { session_id: '', rows: 1 })
    expect((await json(res)).error).toBe('Missing required field(s): session_id')
    res = await post(s, '/api/terminal/start', { session_id: sid }, 'POST', { 'x-forwarded-for': '203.0.113.9' })
    expect(res.status).toBe(200)
    body = await json(res)
    expect(body.running).toBe(true)
    expect(pty.spawned).toHaveLength(spawnedBefore + 2)
  })
  it('a remote terminal backend answers the code and the message, and a signal death reports a negative exit code', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    mkdirSync(join(s.state, 'workspace'), { recursive: true })
    expect((await post(s, '/api/terminal/start', { session_id: sid })).status).toBe(200)
    const proc = pty.spawned.at(-1)!
    setTimeout(() => { proc.exit(0, 1) }, 20)
    const frames = await s.sse(`/api/terminal/output?session_id=${sid}`, (f: SseFrame) => f.event === 'terminal_closed', { timeoutMs: 5_000 })
    expect(frames.at(-1)?.data).toEqual({ exit_code: -1 })
    await post(s, '/api/terminal/close', { session_id: sid })
    const original = sidecar.responderFor('config.get')
    const previousYaml = existsSync(join(s.state, 'config.yaml')) ? readFileSync(join(s.state, 'config.yaml'), 'utf8') : null
    sidecar.respond('config.get', (params) => ({ path: params.config_path, exists: true, config: { terminal: { backend: 'ssh' } } }))
    writeFileSync(join(s.state, 'config.yaml'), 'terminal:\n  backend: ssh\n')
    s.deps.agentConfig.invalidate()
    await s.deps.agentConfig.read(s.state)
    try {
      const res = await post(s, '/api/terminal/start', { session_id: sid })
      expect(res.status).toBe(400)
      expect(await json(res)).toEqual({ error: 'remote_terminal_backend_unsupported', message: 'Embedded terminal is only supported for local terminal backends.' })
    } finally {
      if (previousYaml === null) rmSync(join(s.state, 'config.yaml'), { force: true }); else writeFileSync(join(s.state, 'config.yaml'), previousYaml)
      if (original) sidecar.respond('config.get', original); else sidecar.respond('config.get', (params) => ({ path: params.config_path, exists: existsSync(params.config_path), config: {} }))
      s.deps.agentConfig.invalidate()
    }
  })

  it('a live terminal locks its worktree, and deleting the session closes the terminal', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const worktree = join(s.state, 'workspace', 'wt-locked')
    mkdirSync(worktree, { recursive: true })
    const session = s.deps.sessionStore.get(sid)
    session.worktree_path = worktree
    s.deps.sessionStore.save(session)
    let res = await post(s, '/api/terminal/start', { session_id: sid })
    expect(res.status).toBe(200)
    expect((await json(res)).workspace).toBe(session.workspace)
    // The terminal runs in the session workspace, not the worktree: unlocked.
    let status = (await json(await s.get(`/api/session/worktree/status?session_id=${sid}`))).status as Json
    expect(status.locked_by_terminal).toBe(false)
    res = await post(s, '/api/session/update', { session_id: sid, workspace: worktree })
    expect(res.status, await res.clone().text()).toBe(200)
    expect(s.deps.terminals.get(sid)).toBeNull()
    res = await post(s, '/api/terminal/start', { session_id: sid })
    expect(res.status).toBe(200)
    status = (await json(await s.get(`/api/session/worktree/status?session_id=${sid}`))).status as Json
    expect(status.locked_by_terminal).toBe(true)
    res = await post(s, '/api/session/worktree/remove', { session_id: sid })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('Worktree is locked by an active terminal session')
    expect(existsSync(worktree)).toBe(true)
    res = await post(s, '/api/session/delete', { session_id: sid })
    expect(res.status).toBe(200)
    expect(s.deps.terminals.get(sid)).toBeNull()
  })

  it('a new session honours the profile config worktree default when the body omits worktree', async () => {
    sidecar.respond('config.get', (params) => ({ path: join(params.profile_home, 'config.yaml'), exists: true, config: { worktree: true } }))
    s.deps.agentConfig.invalidate()
    await s.deps.agentConfig.read(s.state)
    expect(s.deps.worktreeDefault(null)).toBe(true)
    sidecar.respond('worktree.create', (params) => ({ path: join(params.repo_root, '.worktrees', 'wt-default'), branch: 'wt-default', repo_root: params.repo_root, base: null }))
    const res = await post(s, '/api/session/new', {})
    const body = await json(res)
    expect(res.status, JSON.stringify(body)).toBe(200)
    expect(String((body.session as Json).worktree_path), JSON.stringify(body)).toContain('wt-default')
    sidecar.respond('config.get', (params) => ({ path: join(params.profile_home, 'config.yaml'), exists: true, config: {} }))
    s.deps.agentConfig.invalidate()
  })
})

describe('automation helpers', () => {
  it('zip reader, loopback origin, proxy path, and relative path validators', () => {
    const zip = makeZip({ 'a.txt': 'hello', 'dir/b.txt': 'world' })
    const entries = readZip(zip)
    expect(entries.map((e) => [e.name, e.read().toString()])).toEqual([['a.txt', 'hello'], ['dir/b.txt', 'world']])
    expect(() => readZip(Buffer.from('nope'))).toThrow()
    // A member whose central-directory size is understated is rejected instead of inflating past the declared budget.
    const lying = makeZip({ 'big.bin': '0'.repeat(1024 * 1024) })
    const cdOffset = lying.readUInt32LE(lying.length - 22 + 16)
    lying.writeUInt32LE(10, cdOffset + 24)
    expect(() => readZip(lying)[0]!.read()).toThrow(/big\.bin/)
    expect(normalizeLoopbackOrigin('http://localhost:8080')).toBe('http://localhost:8080')
    expect(normalizeLoopbackOrigin('http://localhost:8080/path')).toBeNull()
    expect(normalizeLoopbackOrigin('https://example.com')).toBeNull()
    expect(normalizeProxyPath('')).toBe('/')
    expect(normalizeProxyPath('api/x')).toBe('/api/x')
    expect(normalizeProxyPath('/abs')).toBeNull()
    expect(normalizeProxyPath('..%2Fetc')).toBeNull()
    expect(isSafeRelativePath('a/.hidden')).toBe(false)
    expect(isSafeRelativePath('a/b.js')).toBe(true)
  })

  it('terminal registry reaps idle terminals and enforces the cap', () => {
    const pty = fakePty()
    let now = 0
    const reg = new TerminalRegistry({ env: { PATH: '/bin' }, now: () => now, log: () => undefined, pty })
    const term = reg.start('s1', '/tmp')
    expect(term.rows).toBe(24)
    now = 1_000_000
    expect(reg.reapIdle()).toBe(1)
    expect(reg.get('s1')).toBeNull()
    const off = reg.start('s2', '/tmp').subscribe(null, () => undefined)
    now = 2_000_000
    expect(reg.reapIdle()).toBe(0)
    off()
    reg.closeAll()
    expect(pty.spawned[1]?.killed).toEqual(['SIGHUP'])
  })
})

describe('query parameters on non-GET routes (parity)', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
  })
  afterAll(async () => { await s.close() })

  it('the iOS kanban client passes board/dry_run/max only as query items on POST, PATCH and DELETE', async () => {
    sidecar.respond('kanban.dispatch', (params) => ({ dispatched: [], board: params.board, dry_run: params.dry_run, max: params.max }))
    // Body-less POST with no content-type, exactly as the iOS client sends dispatch.
    let res = await s.get('/api/kanban/dispatch?board=exp&dry_run=true&max=8', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(sidecar.calls.filter((c) => c.method === 'kanban.dispatch').at(-1)?.params).toMatchObject({ board: 'exp', dry_run: true, max: 8 })
    sidecar.respond('kanban.create_task', (params) => ({ task: { id: 't_9', title: String((params.task as Json).title), status: 'ready', priority: 1, claim_live: false, has_completion_evidence: false }, board: params.board, read_only: false }))
    res = await post(s, '/api/kanban/tasks?board=exp', { title: 'scoped' })
    expect(res.status).toBe(200)
    expect(sidecar.calls.filter((c) => c.method === 'kanban.create_task').at(-1)?.params).toMatchObject({ board: 'exp', task: { title: 'scoped' } })
    // The JSON body still wins for a key present in both.
    res = await post(s, '/api/kanban/tasks?board=exp', { title: 'body-wins', board: 'other' })
    expect(sidecar.calls.filter((c) => c.method === 'kanban.create_task').at(-1)?.params).toMatchObject({ board: 'other' })
    sidecar.respond('kanban.delete_board', (params) => ({ result: { deleted: params.delete }, current: 'default', read_only: false }))
    res = await s.get('/api/kanban/boards/exp?delete=1', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(sidecar.calls.filter((c) => c.method === 'kanban.delete_board').at(-1)?.params).toMatchObject({ slug: 'exp', delete: true })
  })

  it('a declared body over 20 MiB is refused before it is read, with the Python message', async () => {
    const declared = 21 * 1024 * 1024
    const body = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: s.running.port, path: '/api/session/rename', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(declared) } }, (res) => {
        let text = ''
        res.on('data', (c: Buffer) => { text += c.toString('utf8') })
        res.on('end', () => { resolve({ status: res.statusCode ?? 0, text }); req.destroy() })
      })
      req.on('error', reject)
      req.flushHeaders()
    })
    expect(body.status).toBe(413)
    expect(JSON.parse(body.text)).toEqual({ error: `Request body too large (${String(declared)} bytes, max 20971520)` })
  })

  it('a chunked body is cut off at 20 MiB while it streams, with the Python message', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x20)
    const body = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: s.running.port, path: '/api/session/rename', method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => {
        let text = ''
        res.on('data', (c: Buffer) => { text += c.toString('utf8') })
        res.on('end', () => { resolve({ status: res.statusCode ?? 0, text }); req.destroy() })
      })
      req.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') reject(error) })
      let sent = 0
      const pump = (): void => {
        while (sent < 22) {
          sent += 1
          if (!req.write(chunk)) { req.once('drain', pump); return }
        }
        req.end()
      }
      pump()
    })
    expect(body.status).toBe(413)
    expect(body.text).toMatch(/^\{"error":"Request body too large \(\d+ bytes, max 20971520\)"\}$/)
  })

  it('JSON responses over 1 KiB are gzipped for clients that accept gzip', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const session = s.deps.sessionStore.get(sid)
    session.messages = [{ role: 'user', content: 'x'.repeat(4096) }]
    s.deps.sessionStore.save(session)
    const res = await s.get(`/api/session?session_id=${sid}`, { headers: { 'accept-encoding': 'gzip' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBe('gzip')
    const plain = await s.get(`/api/session?session_id=${sid}`, { headers: { 'accept-encoding': 'identity' } })
    expect(plain.headers.get('content-encoding')).toBeNull()
    const plainBody = await plain.json()
    expect(await res.json()).toEqual(plainBody)
    // Small bodies stay uncompressed, like Python's 1 KiB threshold.
    expect((await s.get('/api/kanban/boards', { headers: { 'accept-encoding': 'gzip' } })).headers.get('content-encoding')).toBeNull()
    // RFC 9110 qualities: an explicit `gzip;q=0` (or `*;q=0` with gzip unlisted) declares gzip unacceptable.
    for (const header of ['gzip;q=0', 'br, gzip;q=0.0', 'identity, *;q=0']) {
      const refused = await s.get(`/api/session?session_id=${sid}`, { headers: { 'accept-encoding': header } })
      expect(refused.headers.get('content-encoding'), header).toBeNull()
      expect(await refused.json()).toEqual(plainBody)
    }
    for (const header of ['br, gzip;q=0.5', '*', 'GZIP']) {
      expect((await s.get(`/api/session?session_id=${sid}`, { headers: { 'accept-encoding': header } })).headers.get('content-encoding'), header).toBe('gzip')
    }
  })

  it('missing required fields are named the way Python require() named them', async () => {
    const res = await post(s, '/api/session/rename', {})
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('Missing required field(s): session_id, title')
  })
})

describe('extension state file limits (parity)', () => {
  it('reads at most 512 disabled ids and consents, warning `extension_state_truncated`, and a bare root counts as enabled', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'talaria-ext-'))
    const root = join(stateDir, 'ext-root')
    mkdirSync(root)
    const ids = Array.from({ length: 520 }, (_, i) => `ext-${String(i)}`)
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ extensions: ids.map((id) => ({ id, name: id, scripts: [`${id}.js`] })) }))
    writeFileSync(join(stateDir, 'extension-overrides.json'), JSON.stringify({ version: 1, disabled_extensions: ids, sidecar_proxy_consents: Object.fromEntries(ids.map((id) => [id, 'http://127.0.0.1:4567'])) }))
    const service = new ExtensionService({ env: { HERMES_WEBUI_EXTENSION_DIR: root, HERMES_WEBUI_EXTENSION_MANIFEST: 'manifest.json' }, stateDir, isAuthEnabled: () => Promise.resolve(false), fetch, log: () => undefined })
    try {
      const status = await service.status()
      expect((status.counts as Json).user_disabled).toBe(512)
      expect((status.extensions as Json[]).find((e) => e.id === 'ext-512')).toMatchObject({ user_disabled: false })
      expect(status.warnings).toEqual(expect.arrayContaining([{ code: 'extension_state_truncated', source: 'extension_state' }]))
      expect(service.enabledSync()).toBe(true)
      const bare = new ExtensionService({ env: { HERMES_WEBUI_EXTENSION_DIR: root }, stateDir, isAuthEnabled: () => Promise.resolve(false), fetch, log: () => undefined })
      expect(bare.enabledSync()).toBe(true)
      // `urlsplit` semantics for loopback origins: no path (not even `/`), verbatim port, literal hosts only.
      expect(normalizeLoopbackOrigin('http://127.0.0.1:8080/')).toBeNull()
      expect(normalizeLoopbackOrigin('http://localhost:80')).toBe('http://localhost:80')
      expect(normalizeLoopbackOrigin('http://127.1:8080')).toBeNull()
      expect(normalizeLoopbackOrigin('http://[::1]:9')).toBe('http://[::1]:9')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

describe('extension state transactions (review round 41)', () => {
  it('a toggle that lands while a consent change awaits the auth probe is not overwritten by the consent write', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'talaria-ext-'))
    const root = join(stateDir, 'ext-root')
    mkdirSync(root)
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ extensions: [{ id: 'ext-one', name: 'Ext One', sidecar: { type: 'loopback', origin: 'http://127.0.0.1:4567' } }] }))
    let releaseAuth: (v: boolean) => void = () => undefined
    const gate = new Promise<boolean>((r) => { releaseAuth = r })
    const service = new ExtensionService({ env: { HERMES_WEBUI_EXTENSION_DIR: root, HERMES_WEBUI_EXTENSION_MANIFEST: 'manifest.json' }, stateDir, isAuthEnabled: () => gate, fetch, log: () => undefined })
    try {
      const consent = service.setConsent('ext-one', true)
      const toggle = service.setEnabled('ext-one', false)
      await new Promise((r) => setTimeout(r, 20))
      releaseAuth(false)
      await Promise.all([consent, toggle])
      expect(JSON.parse(readFileSync(join(stateDir, 'extension-overrides.json'), 'utf8'))).toMatchObject({ disabled_extensions: ['ext-one'], sidecar_proxy_consents: { 'ext-one': 'http://127.0.0.1:4567' } })
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
