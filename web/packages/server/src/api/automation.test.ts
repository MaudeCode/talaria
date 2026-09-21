/*
 * Regression ports (TAL-245): behaviour previously guarded by the Python cases in
 *   web/tests/test_issue6619_dotfile_archive_validator.py
 * (issues #6619) is covered here; see docs/architecture/regression-port-ledger.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { bootTestServer, type SseFrame, type TestServer } from '../test/harness.js'
import { jobForApi, jobFieldUpdates } from '../tools/crons.js'
import { readZip } from '../workspace/unzip.js'
import { normalizeLoopbackOrigin, normalizeProxyPath, isSafeRelativePath } from '../tools/extensions.js'
import type { PtyModuleLike, PtyProcessLike } from '../tools/terminal.js'
import { TerminalRegistry } from '../tools/terminal.js'
import { crc32 } from '../workspace/zip.js'

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown, method = 'POST', headers: Record<string, string> = {}): Promise<Response> => s.get(path, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

class FakePtyProcess implements PtyProcessLike {
  pid = 4242
  written: string[] = []
  size = { cols: 0, rows: 0 }
  private dataCb: ((data: string) => void) | null = null
  private exitCb: ((e: { exitCode: number }) => void) | null = null
  killed: string[] = []
  write(data: string): void { this.written.push(data); this.dataCb?.(`echo:${data}`) }
  resize(cols: number, rows: number): void { this.size = { cols, rows } }
  kill(signal?: string): void { this.killed.push(signal ?? 'SIGTERM') }
  onData(cb: (data: string) => void): void { this.dataCb = cb }
  onExit(cb: (e: { exitCode: number }) => void): void { this.exitCb = cb }
  emit(text: string): void { this.dataCb?.(text) }
  exit(code: number): void { this.exitCb?.({ exitCode: code }) }
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
      if (url.startsWith('http://127.0.0.1:4567/')) return Promise.resolve(new Response(`proxied ${init?.method ?? 'GET'} ${url.slice('http://127.0.0.1:4567'.length)}`, { status: 200, headers: { 'content-type': 'text/plain', 'set-cookie': 'leak=1', 'x-hermes-secret': 'x' } }))
      return Promise.resolve(new Response('nope', { status: 404 }))
    }
    s = await bootTestServer({ sidecar, deps: (deps) => { (deps as { fetch: typeof fetch }).fetch = fakeFetch } })
    ;(s.deps as { terminals: TerminalRegistry }).terminals = new TerminalRegistry({ env: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', HOME: s.state, SECRET: 'no' }, now: () => Date.now(), log: () => undefined, pty })
    writeFileSync(join(s.state, 'config.yaml'), '# seed\n')
    sidecar.respond('config.get', (params) => ({ path: join(params.profile_home, 'config.yaml'), exists: true, config: {} }))
    sidecar.respond('config.set', (params) => ({ ok: true as const, path: join(params.profile_home, 'config.yaml') }))
  })
  afterAll(() => s.close())

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
    res = await post(s, '/api/crons/run', { job_id: 'job1' })
    expect(await json(res)).toEqual({ ok: true, job_id: 'job1', status: 'running' })
    res = await post(s, '/api/crons/run', { job_id: 'nope' })
    expect(res.status).toBe(404)
    res = await s.get('/api/crons/history?job_id=../x')
    expect(res.status).toBe(400)
    res = await s.get('/api/crons/delivery-options')
    expect(((await json(res)).platforms as Json[]).map((p) => p.value)).toContain('local')
    expect(jobForApi({ id: 'a', monitor_script: 'run.sh', context_from: ['other', 'SELF'] })).toMatchObject({ profile: null, monitor: 'run.sh', continuity: true })
    expect(jobFieldUpdates({ monitor: '', continuity: true }, ['x'])).toEqual({ monitor_script: '', monitor_url: '', context_from: ['x', 'self'] })
  })

  it('kanban routes map to the sidecar, including path-parameter actions and the event stream', async () => {
    let res = await s.get('/api/kanban/boards')
    expect(res.status).toBe(200)
    expect(((await json(res)).boards as Json[])[0]).toMatchObject({ slug: 'default', is_current: true })
    res = await s.get('/api/kanban/board?only_mine=1&since=0')
    const body = await json(res)
    expect(body.changed).toBe(true)
    expect(sidecar.calls.find((c) => c.method === 'kanban.board')?.params).toMatchObject({ only_mine: true, since: 0, profile: 'default' })
    sidecar.respond('kanban.task', (params) => { if (params.task_id !== 't_1') throw new SidecarError('task not found', { condition: 'not_found' }); return { task: { id: 't_1', title: 'T', status: 'ready', priority: 1 }, comments: [], events: [], links: { parents: [], children: [] }, runs: [], read_only: false } })
    res = await s.get('/api/kanban/tasks/t_1')
    expect((await json(res)).task).toMatchObject({ id: 't_1' })
    res = await s.get('/api/kanban/tasks/missing')
    expect(res.status).toBe(404)
    res = await post(s, '/api/kanban/tasks', { title: 'new', priority: 2 })
    expect(res.status).toBe(200)
    expect(sidecar.calls.some((c) => c.method === 'kanban.create_task' && (c.params as Json).task && ((c.params as Json).task as Json).title === 'new')).toBe(true)
    sidecar.respond('kanban.patch_task', (params) => { const status = (params.patch as Json).status; return { task: { id: params.task_id, title: 'patched', status: typeof status === 'string' ? status : 'ready', priority: 1 }, read_only: false } })
    res = await post(s, '/api/kanban/tasks/t_1/patch', { status: 'todo' })
    expect((await json(res)).task).toMatchObject({ id: 't_1', status: 'todo' })
    res = await post(s, '/api/kanban/tasks/t_1', { title: 'x' }, 'PATCH')
    expect(res.status).toBe(200)
    sidecar.respond('kanban.task_action', (params) => ({ task: { id: params.task_id, title: 'T', status: params.action === 'block' ? 'blocked' : 'ready', priority: 1 }, read_only: false }))
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
    const eventsFrame = frames.find((f) => f.event === 'events')
    expect(eventsFrame?.id).toBe('7')
    expect((eventsFrame?.data as Json).cursor).toBe(7)
  })

  it('extension status, registry, install, static serving, consent, proxy, and uninstall [py:test_issue4746_extension_gallery.py::test_install_valid] [py:test_issue4746_extension_gallery.py::test_install_prefixed_zip] [py:test_issue4746_extension_gallery.py::test_gallery_installed_extension_becomes_runtime_manifest] [py:test_issue4746_extension_gallery.py::test_install_bootstraps_managed_default_root_without_env] [py:test_issue4746_extension_gallery.py::test_install_bad_hash] [py:test_issue4746_extension_gallery.py::test_uninstall] [py:test_issue4746_extension_gallery.py::test_gallery_registry_extensions_format]', async () => {
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
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('x-hermes-secret')).toBeNull()
    // Same-origin redirects are followed server-side; cross-origin hops, loops, and oversized bodies answer 502.
    res = await post(s, '/api/extensions/ext-one/sidecar/redirect', { a: 1 }, 'POST', browserHeaders)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('proxied GET /ping?via=redirect')
    res = await s.get('/api/extensions/ext-one/sidecar/redirect-out', { headers: browserHeaders })
    expect(res.status).toBe(502)
    expect(await json(res)).toEqual({ error: 'Extension sidecar redirect crossed declared origin' })
    res = await s.get('/api/extensions/ext-one/sidecar/loop', { headers: browserHeaders })
    expect(res.status).toBe(502)
    expect(await json(res)).toEqual({ error: 'Extension sidecar redirect limit exceeded' })
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

  it('terminal start/input/resize/output/close with the pty stub, gated to local origins', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    mkdirSync(join(s.state, 'workspace'), { recursive: true })
    let res = await post(s, '/api/terminal/start', { session_id: sid, rows: 500, cols: 10 })
    expect(res.status).toBe(200)
    let body = await json(res)
    expect(body).toMatchObject({ ok: true, session_id: sid, running: true })
    const proc = pty.spawned[0]!
    expect(pty.opts[0]).toMatchObject({ rows: 80, cols: 20, env: { TERM: 'xterm-256color', HERMES_WEBUI_TERMINAL: '1' } })
    expect((pty.opts[0]?.env as Json).SECRET).toBeUndefined()
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
    res = await post(s, '/api/terminal/close', { session_id: sid })
    expect((await json(res)).ok).toBe(true)
    res = await post(s, '/api/terminal/start', { session_id: 'ghost' })
    expect(res.status).toBe(404)
    res = await post(s, '/api/terminal/start', { session_id: sid }, 'POST', { 'x-forwarded-for': '203.0.113.9' })
    expect(res.status).toBe(200)
    body = await json(res)
    expect(body.running).toBe(true)
    expect(pty.spawned).toHaveLength(2)
  })
  it('a live terminal locks its worktree, and deleting the session closes the terminal [py:test_issue2057_worktree_status.py::test_worktree_status_reports_live_terminal_lock]', async () => {
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

  it('a new session honours the profile config worktree default when the body omits worktree [py:test_issue6022_worktree_config_default.py::test_absent_key_with_config_default_on_creates_worktree_session]', async () => {
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
