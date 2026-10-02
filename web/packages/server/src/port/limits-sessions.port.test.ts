/**
 * Extension-install, pin-cap, and state.db window regressions.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { crc32 } from '../workspace/zip.js'
import { agentSessionRowsExisting } from '../sessions/state-db.js'

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

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
const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

describe('extension gallery installs', () => {
  let s: TestServer
  const zips: Record<string, Buffer> = {
    'slip.zip': makeZip({ '../../evil.txt': 'evil' }),
    'nested.zip': makeZip({ 'deep-ext/manifest.json': '{"version":"1.0.0","scripts":["sub/a/b.js"]}', 'deep-ext/sub/a/b.js': 'x' }),
    'settings.zip': makeZip({ 'set-ext/manifest.json': JSON.stringify({ version: '2.0.0', name: 'Set Ext', permissions: { storage: { owned: true } }, settings_schema: [{ key: 'greeting', type: 'string', label: 'Greeting', description: 'd', default: 'hi' }, { key: 'bad' }] }) }),
    'roll.zip': makeZip({ 'roll-ext/a.txt': 'a', 'roll-ext/sub/b.txt': 'b' }),
    'link.zip': makeZip({ 'linked-ext/manifest.json': '{"version":"1.0.0"}' }),
    'inside.zip': makeZip({ 'inside-ext/manifest.json': '{"version":"1.0.0"}' }),
    'assets.zip': makeZip({ 'assets-ext/manifest.json': '{"version":"1.0.0"}', 'assets-ext/assets/config': 'pwned' }),
  }
  beforeAll(async () => {
    const fakeFetch: typeof fetch = (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/registry.json')) return Promise.resolve(new Response(JSON.stringify([{ id: 'zeta' }, { id: 'alpha' }]), { status: 200 }))
      if (url.endsWith('/redirect.zip')) return Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://evil.example/ext.zip' } }))
      const name = url.split('/').pop() ?? ''
      const zip = zips[name]
      if (zip) return Promise.resolve(new Response(zip, { status: 200 }))
      return Promise.resolve(new Response('nope', { status: 404 }))
    }
    s = await bootTestServer({ sidecar: new FakeSidecar(), deps: (deps) => { (deps as { fetch: typeof fetch }).fetch = fakeFetch } })
  })
  afterAll(() => s.close())
  const root = (): string => join(s.state, 'extensions')
  const install = (id: string, file: string): Promise<Response> => post(s, '/api/extensions/install', { id, download_url: `https://hermes-webui.github.io/x/${file}`, sha256: sha(zips[file] ?? Buffer.alloc(0)) })

  it('a top-level JSON array registry keeps its order', async () => {
    const body = await json(await s.get('/api/extensions/registry'))
    expect((body.entries as Json[]).map((e) => e.id)).toEqual(['zeta', 'alpha'])
  })

  it('a zip-slip member is refused and nothing escapes the root', async () => {
    const res = await install('slip-ext', 'slip.zip')
    expect(res.status).toBe(400)
    expect(existsSync(join(s.state, 'evil.txt'))).toBe(false)
    expect(existsSync(join(s.state, '..', 'evil.txt'))).toBe(false)
    expect(existsSync(join(root(), 'slip-ext'))).toBe(false)
  })

  it('uninstall removes nested empty directories too', async () => {
    expect((await install('deep-ext', 'nested.zip')).status).toBe(200)
    expect(existsSync(join(root(), 'deep-ext', 'sub', 'a', 'b.js'))).toBe(true)
    const res = await post(s, '/api/extensions/uninstall', { id: 'deep-ext' })
    expect(await json(res)).toEqual({ uninstalled: true, id: 'deep-ext' })
    expect(existsSync(join(root(), 'deep-ext'))).toBe(false)
  })

  it('a settings-only manifest becomes a storage-owned runtime entry with a normalized schema', async () => {
    expect((await install('set-ext', 'settings.zip')).status).toBe(200)
    // Python `get_extension_config()` entry: storage ownership and the normalized schema live on the status payload.
    const status = await json(await s.get('/api/extensions/status'))
    const entry = (status.extensions as Json[]).find((m) => m.id === 'set-ext')
    expect(entry, JSON.stringify(status)).toMatchObject({ storage_owned: true, effective_enabled: true })
    expect(entry?.settings_schema).toEqual([{ key: 'greeting', type: 'string', label: 'Greeting', description: 'd', default: 'hi' }])
    const manifests = (await json(await s.get('/api/extensions/manifests'))).manifests as Json[]
    const manifest = manifests.find((m) => m.id === 'set-ext')
    expect(manifest?.settings_schema).toEqual([{ key: 'greeting', type: 'string', label: 'Greeting', description: 'd', default: 'hi' }])
  })

  it('a write failure mid-extraction leaves no partial extension behind', async () => {
    const dir = join(root(), 'roll-ext')
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o500)
    try {
      const res = await install('roll-ext', 'roll.zip')
      expect(res.status).toBe(500)
      expect(String((await json(res)).error)).toContain('Extraction failed')
    } finally {
      if (existsSync(dir)) chmodSync(dir, 0o700)
    }
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([])
  })

  it('a pre-existing symlink out of the root is refused and nothing is written at its target', async () => {
    const outside = join(s.state, 'outside-target')
    mkdirSync(outside, { recursive: true })
    mkdirSync(root(), { recursive: true })
    symlinkSync(outside, join(root(), 'linked-ext'))
    const res = await install('linked-ext', 'link.zip')
    expect(res.status).toBe(400)
    expect(String((await json(res)).error).toLowerCase()).toContain('symlink')
    expect(readdirSync(outside)).toEqual([])
  })

  it('a symlinked subdirectory already inside the extension is never followed: nothing lands outside, and a clean reinstall succeeds', async () => {
    const outside = join(s.state, 'ssh-target')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'config'), 'original')
    const dir = join(root(), 'assets-ext')
    mkdirSync(dir, { recursive: true })
    symlinkSync(outside, join(dir, 'assets'))
    const res = await install('assets-ext', 'assets.zip')
    expect(res.status).toBe(500)
    expect(readFileSync(join(outside, 'config'), 'utf8')).toBe('original')
    expect(existsSync(join(dir, 'manifest.json'))).toBe(false)
    unlinkSync(join(dir, 'assets'))
    expect((await install('assets-ext', 'assets.zip')).status).toBe(200)
    expect(readFileSync(join(dir, 'assets', 'config'), 'utf8')).toBe('pwned')
    // Reinstall overwrites in place through the anchored write path.
    expect((await install('assets-ext', 'assets.zip')).status).toBe(200)
    expect((await post(s, '/api/extensions/uninstall', { id: 'assets-ext' })).status).toBe(200)
    expect(existsSync(dir)).toBe(false)
  })

  it('uninstall never follows an extension directory that was replaced by a symlink: outside empty directories survive', async () => {
    expect((await install('assets-ext', 'assets.zip')).status).toBe(200)
    const dir = join(root(), 'assets-ext')
    const outside = join(s.state, 'victim-tree')
    mkdirSync(join(outside, 'assets'), { recursive: true })
    mkdirSync(join(outside, 'empty'), { recursive: true })
    // The installed files are moved aside and the extension directory itself becomes a link into the victim tree.
    renameSync(dir, join(root(), 'assets-ext-real'))
    symlinkSync(outside, dir)
    expect((await post(s, '/api/extensions/uninstall', { id: 'assets-ext' })).status).toBe(200)
    expect(existsSync(join(outside, 'assets'))).toBe(true)
    expect(existsSync(join(outside, 'empty'))).toBe(true)
    expect(existsSync(outside)).toBe(true)
    expect(readFileSync(join(root(), 'assets-ext-real', 'assets', 'config'), 'utf8')).toBe('pwned')
    unlinkSync(dir)
    rmSync(join(root(), 'assets-ext-real'), { recursive: true })
  })

  it('a symlink that stays inside the root is refused too', async () => {
    mkdirSync(join(root(), 'real-inside'), { recursive: true })
    symlinkSync(join(root(), 'real-inside'), join(root(), 'inside-ext'))
    const res = await install('inside-ext', 'inside.zip')
    expect(res.status).toBe(400)
    expect(String((await json(res)).error).toLowerCase()).toContain('symlink')
  })

  it('a download that redirects off the gallery host is refused', async () => {
    const res = await post(s, '/api/extensions/install', { id: 'redir-ext', download_url: 'https://hermes-webui.github.io/x/redirect.zip', sha256: 'a'.repeat(64) })
    expect(res.status).toBe(400)
    expect(String((await json(res)).error).toLowerCase()).toContain('disallowed host')
  })
})

describe('pin cap and hidden snapshots', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer() })
  afterAll(() => s.close())
  const newSession = async (): Promise<string> => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const session = s.deps.sessionStore.get(sid)
    session.messages = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]
    s.deps.sessionStore.save(session)
    return sid
  }

  it('a pinned hidden pre-compression snapshot does not consume pin quota', async () => {
    const hidden = s.deps.sessionStore.get(await newSession())
    hidden.pre_compression_snapshot = true
    hidden.pinned = true
    s.deps.sessionStore.save(hidden)
    for (let i = 0; i < 3; i += 1) {
      const res = await post(s, '/api/session/pin', { session_id: await newSession(), pinned: true })
      expect(res.status, String(i)).toBe(200)
    }
    const fourth = await post(s, '/api/session/pin', { session_id: await newSession(), pinned: true })
    expect(fourth.status).toBe(400)
  })
})

function createStateDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, model TEXT, started_at REAL NOT NULL, message_count INTEGER DEFAULT 0, title TEXT,
    chat_id TEXT, chat_type TEXT, thread_id TEXT, session_key TEXT, origin_chat_id TEXT, origin_user_id TEXT, platform TEXT, parent_session_id TEXT, ended_at REAL, end_reason TEXT);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp)`)
  return db
}
function insertSession(db: DatabaseSync, row: { id: string; source: string; started_at: number; messages?: [string, number][] }): void {
  const messages = row.messages ?? []
  db.prepare('INSERT INTO sessions (id, source, started_at, message_count) VALUES (?, ?, ?, ?)').run(row.id, row.source, row.started_at, messages.length)
  for (const [role, ts] of messages) db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(row.id, role, `${role} says`, ts)
}

describe('state.db windows and probes', () => {
  let s: TestServer
  let dbPath = ''
  beforeAll(async () => {
    s = await bootTestServer()
    dbPath = join(s.state, 'state.db')
    // Python gates the Cron Jobs chip on the profile having opted into projects (#5379).
    expect((await post(s, '/api/projects/create', { name: 'User project' })).status).toBe(200)
    const db = createStateDb(dbPath)
    insertSession(db, { id: 'cron_old_1', source: 'cron', started_at: 10, messages: [['user', 11], ['assistant', 12]] })
    insertSession(db, { id: 'cron_empty', source: 'cron', started_at: 20 })
    for (let i = 0; i < 25; i += 1) insertSession(db, { id: `cli-${String(i)}`, source: 'cli', started_at: 100 + i, messages: [['user', 100 + i]] })
    db.close()
    await s.deps.settings.save({ show_cli_sessions: true })
    s.deps.cliSessions.invalidate()
  })
  afterAll(() => s.close())

  it('an older cron session outnumbered by newer CLI rows is still listed with a project', async () => {
    const rows = (await json(await s.get('/api/sessions?show_cron_sessions=1'))).sessions as Json[]
    const cron = rows.find((r) => r.session_id === 'cron_old_1')
    expect(cron, JSON.stringify(rows.map((r) => r.session_id))).toBeDefined()
    expect(cron?.source_tag).toBe('cron')
    expect(cron?.project_id).toBeTruthy()
  })

  it('each cron id appears exactly once', async () => {
    const rows = (await json(await s.get('/api/sessions?show_cron_sessions=1'))).sessions as Json[]
    expect(rows.filter((r) => r.session_id === 'cron_old_1')).toHaveLength(1)
  })

  it('a message-less cron row is not surfaced', async () => {
    const rows = (await json(await s.get('/api/sessions?show_cron_sessions=1'))).sessions as Json[]
    expect(rows.map((r) => r.session_id)).not.toContain('cron_empty')
  })

  it('a missing state.db reports every probed id as present', () => {
    expect(agentSessionRowsExisting(join(s.state, 'missing', 'state.db'), ['a', 'b'])).toEqual(new Set(['a', 'b']))
  })

  it('600 probe ids against 300 present rows answer exactly those 300', () => {
    const path = join(s.state, 'batch.db')
    const db = createStateDb(path)
    for (let i = 0; i < 300; i += 1) insertSession(db, { id: `b-${String(i)}`, source: 'cli', started_at: i })
    db.close()
    const probe = Array.from({ length: 600 }, (_, i) => `b-${String(i)}`)
    const present = agentSessionRowsExisting(path, probe)
    expect(present.size).toBe(300)
    expect(present.has('b-299')).toBe(true)
    expect(present.has('b-300')).toBe(false)
  })

  it('probe ids are trimmed', () => {
    const path = join(s.state, 'trim.db')
    const db = createStateDb(path)
    insertSession(db, { id: 'cli-padded', source: 'cli', started_at: 1 })
    db.close()
    expect(agentSessionRowsExisting(path, ['  cli-padded  '])).toEqual(new Set(['cli-padded']))
  })

  it('a sidecar that claims CLI but whose state.db row says webui lists as a WebUI session', async () => {
    const db = new DatabaseSync(dbPath)
    insertSession(db, { id: 'stale-json', source: 'webui', started_at: 500, messages: [['user', 501]] })
    db.close()
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const session = s.deps.sessionStore.get(sid)
    session.session_id = 'stale-json'
    session.messages = [{ role: 'user', content: 'hi' }]
    Object.assign(session, { is_cli_session: true, session_source: 'cli', raw_source: 'cli' })
    s.deps.sessionStore.save(session)
    s.deps.cliSessions.invalidate()
    const rows = (await json(await s.get('/api/sessions'))).sessions as Json[]
    const row = rows.find((r) => r.session_id === 'stale-json')
    expect(row, JSON.stringify(rows.map((r) => r.session_id))).toBeDefined()
    expect(row).toMatchObject({ is_cli_session: false, session_source: 'webui' })
  })

  it('state.db source metadata applies to every row regardless of position', async () => {
    const rows = (await json(await s.get('/api/sessions'))).sessions as Json[]
    expect(rows.find((r) => r.session_id === 'stale-json')).toMatchObject({ is_cli_session: false })
  })
})

describe('sidebar automated-session counts (TAL-482)', () => {
  let s: TestServer
  beforeAll(async () => {
    s = await bootTestServer()
    const db = createStateDb(join(s.state, 'state.db'))
    // One past the server's 200-row per-kind window, so the count has to say more exist.
    for (let i = 0; i < 201; i += 1) insertSession(db, { id: `cron_job_${String(i)}`, source: 'cron', started_at: 1_000 + i, messages: [['user', 1_000 + i]] })
    for (let i = 0; i < 3; i += 1) insertSession(db, { id: `hook-${String(i)}`, source: 'webhook', started_at: 2_000 + i, messages: [['user', 2_000 + i]] })
    db.close()
    s.deps.cliSessions.invalidate()
  })
  afterAll(() => s.close())

  it('counts listed scheduled and webhook sessions and flags the capped kind', async () => {
    const body = await json(await s.get('/api/sessions?show_cron_sessions=1&show_webhook_sessions=1'))
    expect(body).toMatchObject({ scheduled_session_count: 200, scheduled_sessions_truncated: true, webhook_session_count: 3, webhook_sessions_truncated: false })
  })

  it('leaves archived sessions out of the count', async () => {
    expect((await post(s, '/api/session/archive', { session_id: 'hook-0', archived: true })).status).toBe(200)
    s.deps.cliSessions.invalidate()
    const body = await json(await s.get('/api/sessions?show_cron_sessions=1&show_webhook_sessions=1'))
    expect(body).toMatchObject({ webhook_session_count: 2, webhook_sessions_truncated: false })
  })
})
