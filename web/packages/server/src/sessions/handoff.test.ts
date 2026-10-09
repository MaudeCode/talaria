/**
 * TAL-258: the handoff dock routes, `POST /api/session/conversation-rounds` and `POST /api/session/handoff-summary`,
 * against a synthetic state.db and a fake `aux.complete` / `state_db.append_message`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { bootTestServer, type TestServer } from '../test/harness.js'

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json
const COMPLETE = '- You decided to ship the parser.\n- The migration still needs a reviewer.'

/** `n` answered rounds; the first user message of each round is followed by a second one, which merges into it. */
const roundRows = (n: number, start = 1000): [string, string, number | null][] => {
  const rows: [string, string, number | null][] = []
  for (let i = 0; i < n; i += 1) {
    const t = start + i * 10
    rows.push(['user', `question ${i}`, t], ['user', `more on ${i}`, t + 1], ['assistant', `answer ${i}`, t + 2])
  }
  return rows
}

describe('handoff dock routes', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let completions: Json[]
  let appended: Json[]
  let answers: ({ text: string; finish_reason: string | null } | Error)[]

  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
  })
  afterAll(() => s.close())

  const dbPath = (profile?: string): string => (profile ? join(s.state, 'profiles', profile, 'state.db') : join(s.state, 'state.db'))
  /** A state.db holding `rows` for `sid`, as the Agent and gateway committed them. */
  function seedStateDb(sid: string, rows: [string, string, number | null][], opts: { profile?: string; source?: string } = {}): void {
    if (opts.profile) mkdirSync(join(s.state, 'profiles', opts.profile), { recursive: true })
    const db = new DatabaseSync(dbPath(opts.profile))
    db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, title TEXT, model TEXT, started_at REAL, message_count INTEGER DEFAULT 0, parent_session_id TEXT, ended_at REAL, end_reason TEXT); CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL)')
    db.prepare('INSERT OR REPLACE INTO sessions (id, source, started_at, message_count) VALUES (?, ?, ?, ?)').run(sid, opts.source ?? 'webui', 1, rows.length)
    for (const [role, content, ts] of rows) db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(sid, role, content, ts)
    db.close()
  }
  function stateRows(sid: string, profile?: string): Json[] {
    const db = new DatabaseSync(dbPath(profile))
    try { return db.prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY id').all(sid) } finally { db.close() }
  }
  function messageCount(sid: string, profile?: string): number {
    const db = new DatabaseSync(dbPath(profile))
    try { return Number((db.prepare('SELECT message_count FROM sessions WHERE id = ?').get(sid) as Json).message_count) } finally { db.close() }
  }
  async function webSession(extra: Json = {}): Promise<string> {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const session = s.deps.sessionStore.get(sid)
    Object.assign(session, { model: 'openai/gpt-5', model_provider: 'openrouter', ...extra })
    s.deps.sessionStore.save(session)
    return sid
  }
  const markers = (rows: Json[]): Json[] => rows.flatMap((m) => {
    if (m.role !== 'tool') return []
    const card = JSON.parse(String(m.content)) as Json
    return card._handoff_summary_card === true ? [card] : []
  })

  beforeEach(() => {
    rmSync(join(s.state, 'state.db'), { force: true })
    rmSync(join(s.state, 'profiles'), { recursive: true, force: true })
    completions = []
    appended = []
    answers = [{ text: COMPLETE, finish_reason: 'stop' }]
    sidecar.respond('runtime.ensure_current', () => ({ current: true as const, agent_revision: null }))
    sidecar.respond('aux.complete', (params) => {
      completions.push(params)
      const next = answers.length > 1 ? answers.shift()! : answers[0]!
      if (next instanceof Error) throw next
      return { model: String(params.model), text: next.text, usage: null, finish_reason: next.finish_reason }
    })
    // The Agent's `SessionDB.append_message`: one row plus the session's message_count.
    sidecar.respond('state_db.append_message', (params) => {
      appended.push(params)
      const db = new DatabaseSync(join(params.profile_home, 'state.db'))
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(params.session_id, params.role, params.content, params.timestamp ?? null)
      db.prepare('UPDATE sessions SET message_count = message_count + 1 WHERE id = ?').run(params.session_id)
      db.close()
      return { ok: true }
    })
  })

  describe('conversation-rounds', () => {
    it('requires session_id and a numeric since', async () => {
      const missing = await post(s, '/api/session/conversation-rounds', {})
      expect(missing.status).toBe(400)
      expect((await json(missing)).error).toBe('Missing required field(s): session_id')
      const bad = await post(s, '/api/session/conversation-rounds', { session_id: 'gw-1', since: 'yesterday' })
      expect(bad.status).toBe(400)
      expect((await json(bad)).error).toBe('since must be a unix timestamp (number)')
    })

    it('counts answered rounds, merging consecutive user messages, against the threshold', async () => {
      seedStateDb('gw-rounds', [...roundRows(9), ['user', 'unanswered', 2000]], { source: 'telegram' })
      const res = await post(s, '/api/session/conversation-rounds', { session_id: 'gw-rounds' })
      expect(res.status).toBe(200)
      expect(await json(res)).toEqual({ ok: true, rounds: 9, threshold: 10, should_show: false })
      seedStateDb('gw-rounds', [['assistant', 'answered', 2001]], { source: 'telegram' })
      expect(await json(await post(s, '/api/session/conversation-rounds', { session_id: 'gw-rounds' }))).toEqual({ ok: true, rounds: 10, threshold: 10, should_show: true })
    })

    it('counts only rows after since, given as a number or a numeric string', async () => {
      seedStateDb('gw-since', roundRows(12), { source: 'telegram' })
      // Rounds 0-4 are stamped 1000..1042; the rows after 1042.5 are rounds 5-11.
      expect((await json(await post(s, '/api/session/conversation-rounds', { session_id: 'gw-since', since: 1042.5 }))).rounds).toBe(7)
      expect((await json(await post(s, '/api/session/conversation-rounds', { session_id: 'gw-since', since: '1042.5' }))).rounds).toBe(7)
    })

    it('answers zero rounds without a state.db', async () => {
      expect(await json(await post(s, '/api/session/conversation-rounds', { session_id: 'gw-none' }))).toEqual({ ok: true, rounds: 0, threshold: 10, should_show: false })
    })
  })

  describe('handoff-summary', () => {
    it('refuses a session under the round threshold or without two messages after since', async () => {
      seedStateDb('gw-short', roundRows(9), { source: 'telegram' })
      const short = await post(s, '/api/session/handoff-summary', { session_id: 'gw-short' })
      expect(short.status).toBe(400)
      expect((await json(short)).error).toBe('Not enough conversation rounds to generate a summary.')
      // Unstamped rows count as rounds but never pass the message filter.
      seedStateDb('gw-unstamped', roundRows(10).map(([role, content]) => [role, content, null]), { source: 'telegram' })
      const empty = await post(s, '/api/session/handoff-summary', { session_id: 'gw-unstamped', since: 0 })
      expect(empty.status).toBe(400)
      expect((await json(empty)).error).toBe('Not enough messages to summarize.')
      const bad = await post(s, '/api/session/handoff-summary', { session_id: 'gw-short', since: [] })
      expect(bad.status).toBe(400)
      expect(completions).toEqual([])
    })

    it('refuses a subagent view', async () => {
      const sid = await webSession({ source_tag: 'subagent' })
      seedStateDb(sid, roundRows(10))
      const res = await post(s, '/api/session/handoff-summary', { session_id: sid })
      expect(res.status).toBe(400)
      expect((await json(res)).error).toBe('Subagent sessions are view-only and cannot be summarized from WebUI')
    })

    it('summarizes on the session\'s main model and appends the card to its WebUI transcript once', async () => {
      const sid = await webSession()
      seedStateDb(sid, roundRows(30))
      const res = await post(s, '/api/session/handoff-summary', { session_id: sid })
      expect(res.status).toBe(200)
      expect(await json(res)).toEqual({ ok: true, summary: COMPLETE, message_count: 50, rounds: 30, fallback: false })
      expect(completions).toHaveLength(1)
      expect(completions[0]).toMatchObject({ task: 'handoff_summary', model: 'openai/gpt-5', provider: 'openrouter', max_tokens: 700, temperature: 0.2 })
      const prompt = completions[0]!.messages as Json[]
      expect(prompt[0]).toMatchObject({ role: 'system' })
      expect(String(prompt[0]!.content)).toContain('English: speak using “you”.')
      // The last 50 rows: rounds 14..29 plus round 13's merged follow-up and answer.
      expect(String(prompt[1]!.content)).toBe(`Conversation transcript:\n${roundRows(30).slice(-50).map(([, content]) => content).join('\n')}`)
      const after = s.deps.sessionStore.get(sid).messages
      expect(after.at(-1)).toMatchObject({ role: 'tool', name: 'handoff_summary', tool_call_id: '' })
      expect(markers(after)).toEqual([expect.objectContaining({ session_id: sid, summary: COMPLETE, rounds: 30, fallback: false, channel: null })])
      // A WebUI session keeps the card out of state.db.
      expect(appended).toEqual([])
      // The same summary again is deduplicated against the transcript's tail.
      expect((await post(s, '/api/session/handoff-summary', { session_id: sid })).status).toBe(200)
      expect(markers(s.deps.sessionStore.get(sid).messages)).toHaveLength(1)
    })

    it('retries a cut-off answer at 1400 tokens', async () => {
      const sid = await webSession()
      seedStateDb(sid, roundRows(10))
      answers = [{ text: '- You decided to ship', finish_reason: 'length' }, { text: COMPLETE, finish_reason: 'stop' }]
      const payload = await json(await post(s, '/api/session/handoff-summary', { session_id: sid }))
      expect(payload).toMatchObject({ summary: COMPLETE, fallback: false })
      expect(completions.map((c) => c.max_tokens)).toEqual([700, 1400])
    })

    it('retries text that looks truncated even when the provider reports a clean stop', async () => {
      const sid = await webSession()
      seedStateDb(sid, roundRows(10))
      answers = [{ text: '- You decided to ship the parser and', finish_reason: 'stop' }, { text: COMPLETE, finish_reason: null }]
      expect(await json(await post(s, '/api/session/handoff-summary', { session_id: sid }))).toMatchObject({ summary: COMPLETE, fallback: false })
      expect(completions.map((c) => c.max_tokens)).toEqual([700, 1400])
    })

    it('falls back to the local summary when the retry is still cut off', async () => {
      const sid = await webSession()
      seedStateDb(sid, roundRows(10))
      answers = [{ text: 'cut', finish_reason: 'length' }]
      const payload = await json(await post(s, '/api/session/handoff-summary', { session_id: sid }))
      expect(payload).toEqual({ ok: true, summary: '- You asked: more on 9.\n- The assistant responded: answer 9.\n- There is pending context to continue next.', message_count: 30, rounds: 10, fallback: true })
      expect(completions).toHaveLength(2)
      expect(markers(s.deps.sessionStore.get(sid).messages)).toEqual([expect.objectContaining({ fallback: true })])
    })

    it('falls back without a warning when the model has no credential, and with one when the call fails', async () => {
      const sid = await webSession()
      seedStateDb(sid, roundRows(10))
      answers = [new SidecarError('no credential for model', { condition: 'credential_missing' })]
      const missing = await json(await post(s, '/api/session/handoff-summary', { session_id: sid }))
      expect(missing).toMatchObject({ ok: true, fallback: true })
      expect(missing).not.toHaveProperty('warning')
      answers = [new SidecarError('provider error at /Users/someone/.hermes/auth.json', { condition: 'sidecar_error' })]
      const failed = await json(await post(s, '/api/session/handoff-summary', { session_id: sid }))
      expect(failed).toMatchObject({ ok: true, fallback: true, warning: 'Summary generation used local fallback: provider error at <path>' })
    })

    it('answers the Chinese fallback for a Chinese conversation', async () => {
      const sid = await webSession()
      seedStateDb(sid, roundRows(10).map(([role, content, ts]) => [role, role === 'user' ? `问题 ${content}` : `回答 ${content}`, ts]))
      answers = [new SidecarError('down', { condition: 'sidecar_error' })]
      expect((await json(await post(s, '/api/session/handoff-summary', { session_id: sid }))).summary).toBe('- 你刚讨论了：问题 more on 9。\n- 助手已回复：回答 answer 9。\n- 当前对话存在尚未确认的后续动作。')
    })

    it('answers a typed 409 for a stale Agent runtime and persists nothing', async () => {
      const sid = await webSession()
      seedStateDb(sid, roundRows(10))
      sidecar.respond('runtime.ensure_current', () => { throw new SidecarError('restart required', { condition: 'agent_runtime_stale' }) })
      const res = await post(s, '/api/session/handoff-summary', { session_id: sid })
      expect(res.status).toBe(409)
      expect(await json(res)).toMatchObject({ type: 'agent_runtime_stale', retryable: true })
      expect(completions).toEqual([])
      expect(markers(s.deps.sessionStore.get(sid).messages)).toEqual([])
    })

    it('answers 409 while the session streams, before and after the summary is generated', async () => {
      const sid = await webSession({ active_stream_id: 'st-1' })
      seedStateDb(sid, roundRows(10))
      const busy = await post(s, '/api/session/handoff-summary', { session_id: sid })
      expect(busy.status).toBe(409)
      expect((await json(busy)).error).toBe('Session is still streaming; wait for the current turn to finish.')
      expect(completions).toEqual([])
      // A turn that starts while the model writes the summary.
      const idle = s.deps.sessionStore.get(sid)
      idle.active_stream_id = null
      s.deps.sessionStore.save(idle)
      sidecar.respond('aux.complete', (params) => {
        completions.push(params)
        const live = s.deps.sessionStore.get(sid)
        live.active_stream_id = 'st-2'
        s.deps.sessionStore.save(live)
        return { model: 'm', text: COMPLETE, usage: null, finish_reason: 'stop' }
      })
      expect((await post(s, '/api/session/handoff-summary', { session_id: sid })).status).toBe(409)
      expect(markers(s.deps.sessionStore.get(sid).messages)).toEqual([])
      expect(appended).toEqual([])
    })

    it('appends a messaging session\'s card to both its WebUI record and state.db, each once', async () => {
      const sid = await webSession({ source_tag: 'telegram', raw_source: 'telegram', session_source: 'messaging', source_label: 'Telegram' })
      seedStateDb(sid, roundRows(10), { source: 'telegram' })
      expect((await post(s, '/api/session/handoff-summary', { session_id: sid })).status).toBe(200)
      expect((await post(s, '/api/session/handoff-summary', { session_id: sid })).status).toBe(200)
      expect(markers(s.deps.sessionStore.get(sid).messages)).toEqual([expect.objectContaining({ session_id: sid, summary: COMPLETE, channel: 'Telegram', rounds: 10 })])
      expect(markers(stateRows(sid))).toEqual([expect.objectContaining({ session_id: sid, summary: COMPLETE, channel: 'Telegram' })])
      expect(appended).toHaveLength(1)
      expect(appended[0]).toMatchObject({ session_id: sid, role: 'tool', tool_name: 'handoff_summary' })
      expect(messageCount(sid)).toBe(31)
    })

    it('appends the same card again once newer messages follow the state.db marker', async () => {
      seedStateDb('gw-tail', roundRows(10), { source: 'telegram' })
      expect((await post(s, '/api/session/handoff-summary', { session_id: 'gw-tail' })).status).toBe(200)
      // An unanswered message keeps the round count, so the model writes the same card again.
      seedStateDb('gw-tail', [['user', 'one more thing', 5000]], { source: 'telegram' })
      expect((await post(s, '/api/session/handoff-summary', { session_id: 'gw-tail' })).status).toBe(200)
      const rows = stateRows('gw-tail')
      expect(markers(rows)).toHaveLength(2)
      expect(rows.at(-1)).toMatchObject({ role: 'tool' })
    })

    it('answers 503 when the card is saved nowhere', async () => {
      seedStateDb('gw-unsaved', roundRows(10), { source: 'telegram' })
      sidecar.respond('state_db.append_message', (params) => { appended.push(params); return { ok: false } })
      const res = await post(s, '/api/session/handoff-summary', { session_id: 'gw-unsaved' })
      expect(res.status).toBe(503)
      expect((await json(res)).error).toBe('The handoff summary could not be saved; please retry.')
      expect(appended).toHaveLength(1)
      expect(markers(stateRows('gw-unsaved'))).toEqual([])
    })

    it('appends a state.db-only session\'s card to state.db', async () => {
      seedStateDb('gw-only', roundRows(10), { source: 'telegram' })
      const payload = await json(await post(s, '/api/session/handoff-summary', { session_id: 'gw-only' }))
      expect(payload).toMatchObject({ ok: true, rounds: 10, fallback: false })
      // No WebUI record: the session's model is the profile default the sidecar resolves.
      expect(completions[0]).toMatchObject({ model: '', provider: null })
      expect(markers(stateRows('gw-only'))).toEqual([expect.objectContaining({ session_id: 'gw-only', summary: COMPLETE, fallback: false })])
    })

  })

  it('reads and writes the state.db of the session\'s own profile', async () => {
    const base = mkdtempSync(join(tmpdir(), 'talaria-handoff-profile-'))
    writeFileSync(join(base, 'active_profile'), 'work\n')
    const work = new FakeSidecar()
    work.respond('runtime.ensure_current', () => ({ current: true as const, agent_revision: null }))
    const homes: string[] = []
    work.respond('aux.complete', (params) => { homes.push(params.profile_home); return { model: 'm', text: COMPLETE, usage: null, finish_reason: 'stop' } })
    work.respond('state_db.append_message', (params) => {
      homes.push(params.profile_home)
      const db = new DatabaseSync(join(params.profile_home, 'state.db'))
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(params.session_id, params.role, params.content, params.timestamp ?? null)
      db.close()
      return { ok: true }
    })
    const server = await bootTestServer({ sidecar: work, env: { HERMES_BASE_HOME: base } })
    try {
      const sid = String(((await json(await post(server, '/api/session/new', {}))).session as Json).session_id)
      const session = server.deps.sessionStore.get(sid)
      expect(session.profile).toBe('work')
      Object.assign(session, { source_tag: 'telegram', session_source: 'messaging' })
      server.deps.sessionStore.save(session)
      const workHome = join(base, 'profiles', 'work')
      mkdirSync(workHome, { recursive: true })
      const seed = (path: string, rows: [string, string, number | null][]): void => {
        const db = new DatabaseSync(path)
        db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL, message_count INTEGER DEFAULT 0); CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL)')
        for (const [role, content, ts] of rows) db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(sid, role, content, ts)
        db.close()
      }
      seed(join(workHome, 'state.db'), roundRows(10))
      // The base home's state.db holds an unrelated count for the same id.
      seed(join(base, 'state.db'), roundRows(3))
      expect((await json(await post(server, '/api/session/conversation-rounds', { session_id: sid }))).rounds).toBe(10)
      expect((await post(server, '/api/session/handoff-summary', { session_id: sid })).status).toBe(200)
      expect(homes).toEqual([workHome, workHome])
      const db = new DatabaseSync(join(workHome, 'state.db'))
      try { expect(markers(db.prepare("SELECT role, content FROM messages WHERE role = 'tool'").all() as Json[])).toHaveLength(1) } finally { db.close() }
    } finally {
      await server.close()
      rmSync(base, { recursive: true, force: true })
    }
  })
})
