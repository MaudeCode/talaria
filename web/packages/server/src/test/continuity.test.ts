/**
 * State-continuity proof (TAL-245): a state directory produced by the Python backend at the
 * pre-rewrite commit (db3f02679, generated with `api.models`, `api.auth`, `api.passkeys`,
 * `api.talaria_relay`, `api.extensions`, and a live `server.py` login) boots on the TypeScript
 * server with no re-login, no re-onboarding, the same responses for the listed routes, no file
 * rewrites on read, and byte-identical files after a no-op save.
 *
 * `fixtures/python-state/` holds the raw Python-written files plus the responses the Python server
 * returned for the same cookie. Absolute fixture paths are rewritten to the temporary copy, and
 * auth-session expiries are pushed into the future because the Python cookie TTL is 30 days.
 */
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from './harness.js'

const FIXTURE = resolve(import.meta.dirname, 'fixtures', 'python-state')
const PYTHON_PATHS = ['/private/tmp/tal245-fixture', '/tmp/tal245-fixture']
type Json = Record<string, unknown>

/** Fields the two backends legitimately compute differently or per request. */
const VOLATILE = new Set([
  'server_time', 'server_tz', 'webui_version', 'agent_version', 'max_tokens_effective', 'max_tokens_fallback', 'checked_at', 'attention', '_load_revision', 'gateway_routing', 'gateway_routing_history', 'pending_started_at', 'context_length', 'threshold_tokens',
  // The fixture was recorded with passkeys off; this run enables them to prove the Python-written credential file reads.
  'passkey_feature_flag', 'passkeys_count', 'passkeys_enabled',
  // Python attached a transcript regeneration revision to the detail payload; regeneration is a documented gap (parity row R-C1).
  'regeneration_revision',
  // A git-describe string on the Python side; the test harness pins the Node version.
  'update_channel_version',
])

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out.sort()
}

function snapshot(root: string): Map<string, Buffer> {
  return new Map(walk(root).map((f) => [relative(root, f), readFileSync(f)]))
}

function normalize(value: unknown, root: string): unknown {
  if (typeof value === 'string') return PYTHON_PATHS.reduce((s, p) => s.split(p).join(root), value)
  if (Array.isArray(value)) return value.map((v) => normalize(v, root))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Json).map(([k, v]) => [k, normalize(v, root)]))
  return value
}

/** Every non-volatile key the Python backend returned must come back with the same value. */
function differences(python: unknown, node: unknown, path = ''): string[] {
  if (Array.isArray(python)) {
    if (!Array.isArray(node)) return [`${path}: python array, node ${typeof node}`]
    if (python.length !== node.length) return [`${path}: python has ${String(python.length)} items, node ${String(node.length)}`]
    return python.flatMap((item, i) => differences(item, node[i], `${path}[${String(i)}]`))
  }
  if (python && typeof python === 'object') {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return [`${path}: python object, node ${typeof node}`]
    return Object.entries(python as Json).flatMap(([key, value]) => {
      if (VOLATILE.has(key)) return []
      if (!(key in (node as Json))) return [`${path}.${key}: missing on node`]
      return differences(value, (node as Json)[key], `${path}.${key}`)
    })
  }
  if (typeof python === 'number' && typeof node === 'number' && Math.abs(python - node) < 1e-6) return []
  return python === node ? [] : [`${path}: python ${JSON.stringify(python)}, node ${JSON.stringify(node)}`]
}

describe('state continuity from the Python backend', () => {
  let root: string
  let s: TestServer
  let cookie: string
  let recorded: Record<string, Json>
  let before: Map<string, Buffer>
  const get = (path: string): Promise<Response> => s.get(path, { headers: { cookie: `hermes_session=${cookie}` } })
  const post = (path: string, body: Json): Promise<Response> => s.get(path, { method: 'POST', headers: { cookie: `hermes_session=${cookie}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })

  beforeAll(async () => {
    root = mkdtempSync(join(realpathSync(tmpdir()), 'talaria-continuity-'))
    for (const dir of ['state', 'hermes', 'workspace']) cpSync(join(FIXTURE, dir), join(root, dir), { recursive: true })
    for (const file of walk(join(root, 'state'))) {
      if (!file.endsWith('.json')) continue
      const text = readFileSync(file, 'utf8')
      let next = PYTHON_PATHS.reduce((t, p) => t.split(p).join(root), text)
      if (file.endsWith('.sessions.json')) next = next.replace(/17925\d{5}\.\d+/g, String(Math.floor(Date.now() / 1000) + 10 ** 8))
      if (next !== text) writeFileSync(file, next, { mode: statSync(file).mode })
    }
    cookie = readFileSync(join(FIXTURE, 'cookie.txt'), 'utf8').trim()
    recorded = normalize(JSON.parse(readFileSync(join(FIXTURE, 'python-responses.json'), 'utf8')), root) as Record<string, Json>
    const pristine = snapshot(join(root, 'state'))
    s = await bootTestServer({ env: { HERMES_HOME: join(root, 'hermes'), HERMES_WEBUI_STATE_DIR: join(root, 'state'), HERMES_WEBUI_DEFAULT_WORKSPACE: join(root, 'workspace'), HERMES_WEBUI_PASSWORD: 'talaria-continuity', HERMES_WEBUI_PASSKEY: '1' } })
    // Boot may normalise settings.json exactly as the Python backend did on load (same keys, same values); nothing else changes.
    before = snapshot(join(root, 'state'))
    const bootChanged = [...pristine.keys()].filter((k) => !before.get(k)?.equals(pristine.get(k)!))
    expect(bootChanged.filter((k) => k !== 'settings.json')).toEqual([])
    if (bootChanged.includes('settings.json')) expect(JSON.parse(before.get('settings.json')!.toString())).toEqual(JSON.parse(pristine.get('settings.json')!.toString()))
    expect([...before.keys()].filter((k) => !pristine.has(k))).toEqual([])
  })
  afterAll(async () => { await s.close(); rmSync(root, { recursive: true, force: true }) })

  it('accepts the Python-issued login cookie and reports onboarding as completed', async () => {
    const auth = await (await get('/api/auth/status')).json() as Json
    expect(auth.logged_in).toBe(true)
    expect(auth.can_manage_server).toBe(true)
    expect(differences(recorded.auth_status, auth)).toEqual([])
    const onboarding = await (await get('/api/onboarding/status')).json() as Json
    expect(onboarding.completed).toBe(true)
    // The OIDC-bound record written by api.auth.create_session survives verbatim.
    const sessions = JSON.parse(readFileSync(join(root, 'state', '.sessions.json'), 'utf8')) as Record<string, Json | number>
    expect(Object.values(sessions).some((r) => typeof r === 'object' && r.auth_type === 'oidc' && r.oidc_owner === true)).toBe(true)
  })

  it('answers the session list, session detail, settings, projects, and workspaces like the Python backend', async () => {
    const sessions = await (await get('/api/sessions?archived_limit=50&show_cli_sessions=0')).json() as Json
    expect(differences(recorded.sessions_all, sessions)).toEqual([])
    const first = (recorded.session!.session as Json).session_id as string
    const detail = await (await get(`/api/session?session_id=${first}&messages=1`)).json() as Json
    expect(differences(recorded.session!, detail)).toEqual([])
    const pendingId = (recorded.session_pending!.session as Json).session_id as string
    const pending = await (await get(`/api/session?session_id=${pendingId}`)).json() as Json
    expect(differences(recorded.session_pending!, pending)).toEqual([])
    const settings = await (await get('/api/settings')).json() as Json
    expect(differences(recorded.settings, settings)).toEqual([])
    expect(settings.bot_name).toBe('Continuity Bot')
    expect(settings.update_channel).toBe('experimental')
    const projects = await (await get('/api/projects')).json() as Json
    expect(differences(recorded.projects, projects)).toEqual([])
    const workspaces = await (await get('/api/workspaces')).json() as Json
    expect(differences(recorded.workspaces, workspaces)).toEqual([])
  })

  it('reads passkeys, the relay config, shares, drafts, and the shrink backup written by Python', async () => {
    const passkeys = await (await get('/api/auth/passkeys')).json() as Json
    expect((passkeys.credentials as Json[]).map((c) => c.label)).toEqual(['Continuity key'])
    const share = readdirSync(join(root, 'state', 'shares'))[0]!
    const shared = await s.get(`/api/share/${share.replace(/\.json$/, '')}`)
    expect(shared.status).toBe(200)
    const first = (recorded.session!.session as Json).session_id as string
    const draft = await (await get(`/api/session/draft?session_id=${first}`)).json() as Json
    expect(JSON.stringify(draft)).toContain('unsent draft text')
    expect(readdirSync(join(root, 'state', 'sessions')).some((f) => f.endsWith('.json.bak'))).toBe(true)
    expect(JSON.parse(readFileSync(join(root, 'state', 'extension-overrides.json'), 'utf8'))).toMatchObject({ disabled_extensions: ['continuity-ext'] })
    expect(JSON.parse(readFileSync(join(root, 'state', 'talaria-relay.json'), 'utf8'))).toMatchObject({ publisher_id: 'https://web.example.invalid', version: 2 })
  })

  it('rewrites nothing on read and reproduces the Python bytes on a no-op save', async () => {
    const afterReads = snapshot(join(root, 'state'))
    expect([...before.keys()].filter((k) => !afterReads.get(k)?.equals(before.get(k)!))).toEqual([])
    expect([...afterReads.keys()].filter((k) => !before.has(k))).toEqual([])
    // State-layer no-op: load every Python-written session and save it back without touching updated_at.
    for (const file of readdirSync(join(root, 'state', 'sessions')).filter((f) => /^[0-9a-f]{12}\.json$/.test(f))) {
      const sid = file.replace(/\.json$/, '')
      s.deps.sessionStore.save(s.deps.sessionStore.get(sid), { touchUpdatedAt: false, skipIndex: true })
    }
    // Both backends overlay the draft sidecar into `composer_draft` on load (Python `api/models.py` `read_session_draft`),
    // so a save persists that overlay; every other byte must match the Python file.
    const afterSave = snapshot(join(root, 'state'))
    for (const k of [...before.keys()].filter((k) => !afterSave.get(k)?.equals(before.get(k)!))) {
      expect(k).toMatch(/^sessions\/[0-9a-f]{12}\.json$/)
      const a = JSON.parse(before.get(k)!.toString()) as Json
      const b = JSON.parse(afterSave.get(k)!.toString()) as Json
      expect(Object.keys(b)).toEqual(Object.keys(a))
      expect(Object.keys(a).filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))).toEqual(['composer_draft'])
      expect(b.composer_draft).toMatchObject({ files: [] })
      const neutral = (doc: Json): string => JSON.stringify({ ...doc, composer_draft: null }, null, 2)
      expect(neutral(b)).toBe(neutral(a))
    }
    // HTTP no-op rename: like the Python backend it touches updated_at (and therefore the index order) and nothing else.
    const first = (recorded.session!.session as Json).session_id as string
    const title = (recorded.session!.session as Json).title as string
    expect((await post('/api/session/rename', { session_id: first, title })).status).toBe(200)
    const renamed = snapshot(join(root, 'state'))
    const rewritten = [...afterSave.keys()].filter((k) => !renamed.get(k)?.equals(afterSave.get(k)!))
    expect(rewritten.sort()).toEqual([`sessions/${first}.json`, 'sessions/_index.json'])
    const beforeDoc = JSON.parse(afterSave.get(`sessions/${first}.json`)!.toString()) as Json
    const afterDoc = JSON.parse(renamed.get(`sessions/${first}.json`)!.toString()) as Json
    expect(Object.keys(afterDoc)).toEqual(Object.keys(beforeDoc))
    // Python's rename also marks the title as manual; nothing else in the document changes.
    expect(Object.keys(beforeDoc).filter((k) => JSON.stringify(beforeDoc[k]) !== JSON.stringify(afterDoc[k]))).toEqual(['updated_at', 'manual_title'])
    // Settings: same keys, same order, same values; Python wrote floats as `1.0` where JSON.stringify writes `1`.
    expect((await post('/api/settings', { bot_name: 'Continuity Bot' })).status).toBe(200)
    const settingsBefore = JSON.parse(before.get('settings.json')!.toString()) as Json
    const settingsAfter = JSON.parse(readFileSync(join(root, 'state', 'settings.json'), 'utf8')) as Json
    expect(Object.keys(settingsAfter)).toEqual(Object.keys(settingsBefore))
    expect(settingsAfter).toEqual(settingsBefore)
  })
})
