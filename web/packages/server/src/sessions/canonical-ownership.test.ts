import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'
import type { SidecarParams, SidecarResult } from '@maudecode/talaria-web-contracts'
import { Session } from './session.js'
import { HttpFailure, stampCompressionExhaustedRecovery } from './turn.js'
import { CONVERSATION_ROUND_THRESHOLD, readImportableAgentSessionRows, stateDbSessionSources } from './state-db.js'

const fixture = JSON.parse(readFileSync(new URL('../test/fixtures/canonical-ownership.json', import.meta.url), 'utf8')) as {
  sessions: Record<string, string>; schema: string[]; inserts: string[]
}
const json = async (res: Response): Promise<Record<string, unknown>> => await res.json() as Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('canonical Agent ownership (TAL-1036)', () => {
  let s: TestServer
  let db: DatabaseSync
  let sidecar: FakeSidecar
  beforeEach(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
    db = new DatabaseSync(join(s.state, 'state.db'))
    db.exec(fixture.schema.join('\n'))
    for (const sql of fixture.inserts) db.exec(sql)
    await s.deps.settings.save({ show_cli_sessions: true })
  })
  afterEach(async () => { db.close(); await s.close() })

  const detail = async (sid: string): Promise<Record<string, unknown>> => (await json(await s.get(`/api/session?session_id=${sid}`))).session as Record<string, unknown>
  const stored = (): unknown => ({ sessions: db.prepare('SELECT * FROM sessions').all(), messages: db.prepare('SELECT * FROM messages').all(), receipts: db.prepare('SELECT * FROM state_meta').all(), admissions: db.prepare('SELECT * FROM session_admissions').all() })
  const makeLegacy = (sid: string): void => {
    db.prepare('DELETE FROM state_meta WHERE key = ?').run(`gateway.local_policy.v1:${sid}`)
    db.prepare('DELETE FROM session_admissions WHERE target_session_id = ?').run(sid)
    db.prepare("UPDATE sessions SET source = 'cli' WHERE id = ?").run(sid)
  }
  const adopt = (sid: string): void => {
    for (const sql of fixture.inserts.filter((sql) => sql.startsWith('INSERT INTO "state_meta"') && sql.includes(sid))) db.exec(sql)
  }
  const completed = (sid: string, message: SidecarParams<'chat.start'>['user_message']): SidecarResult<'chat.start'> => ({
    status: 'completed', messages: [{ role: 'user', content: message }, { role: 'assistant', content: 'done' }], final_response: 'done', error: null,
    failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '',
    usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: null }, context: { context_length: 1000 },
    model: 'fixture', provider: 'custom', compressed: false, agent_session_id: sid, token_sent: true, pending_steer: '', live_tool_calls: [],
  })
  const cache = (sid: string): Session => {
    const session = new Session({ session_id: sid, title: 'Saved conversation', source_tag: 'cli', messages: [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' }] }, { workspace: join(s.state, 'workspace'), model: 'fixture' })
    s.deps.sessionStore.save(session)
    return session
  }


  it.each(['detail', 'metadata', 'status', 'direct'] as const)('keeps canonical stale-run recovery read-only through %s', async (route) => {
    const sid = fixture.sessions.cli!
    const session = cache(sid)
    const stream = 'dead-owned-stream'
    session.active_stream_id = stream
    session.pending_user_message = 'unsettled Talaria prompt'
    session.pending_started_at = s.deps.sessions.deps.now() - 120
    s.deps.sessionStore.save(session)
    const writer = s.deps.journal.writer(sid, stream)
    writer.appendSseEvent('token', { text: 'unsettled Talaria output' })
    writer.close()
    const before = stored()
    const file = readFileSync(join(s.state, 'sessions', `${sid}.json`), 'utf8')
    s.deps.sessionStore.sessions.delete(sid)
    if (route === 'direct') expect(s.deps.sessions.clearStaleStreamState(s.deps.sessionStore.get(sid))).toBe(false)
    else {
      const response = await s.get(route === 'status' ? `/api/session/status?session_id=${sid}` : `/api/session?session_id=${sid}${route === 'metadata' ? '&messages=0' : ''}`)
      expect(response.status).toBe(200)
      const body = await json(response)
      const row = route === 'status' ? body : body.session as Record<string, unknown>
      expect(row).toMatchObject({ read_only: true })
      expect(row.read_only_reason).toContain('gateway')
    }
    expect(readFileSync(join(s.state, 'sessions', `${sid}.json`), 'utf8')).toBe(file)
    expect(stored()).toEqual(before)
    const current = s.deps.sessionStore.get(sid)
    expect(current.active_stream_id).toBe(stream)
    expect(current.pending_user_message).toBe('unsettled Talaria prompt')
    expect(current.messages).toEqual(session.messages)
    expect(sidecar.calls.filter((c) => ['chat.start', 'state_db.sync_usage', 'state_db.sync_title'].includes(c.method))).toEqual([])
  })

  it.each(['incoming', 'formatter', 'deferred', 'claim'] as const)('leaves canonical delegation completion writes to the owner at %s', async (phase) => {
    const sid = fixture.sessions.cli!
    if (phase !== 'incoming') makeLegacy(sid)
    cache(sid)
    const path = join(s.state, 'sessions', `${sid}.json`)
    let file = readFileSync(path, 'utf8')
    let before = stored()
    const adoptAndCapture = (): void => { adopt(sid); file = readFileSync(path, 'utf8'); before = stored() }
    const event = { type: 'async_delegation', process_id: 'deleg_owned', delegation_id: 'deleg_owned', origin_ui_session_id: sid, consumed: false }
    sidecar.respond('process.format_notification', () => { if (phase === 'formatter') adoptAndCapture(); return { text: '[Result deleg_owned]' } })
    sidecar.respond('process.claim_delivery', () => { if (phase === 'claim') adoptAndCapture(); return { claim_id: 'owned-claim' } })
    sidecar.respond('process.defer_delivery', () => ({ ok: true }))
    sidecar.respond('process.requeue', () => ({ requeued: 1 }))
    if (phase === 'deferred') {
      s.deps.completions.recordDeferred(sid, 'deleg_owned', '[Result deleg_owned]', event)
      adoptAndCapture()
      expect(await s.deps.completions.drainDeferred(sid)).toBe(0)
    } else await s.deps.completions.processOne(event)
    expect(readFileSync(path, 'utf8')).toBe(file)
    expect(stored()).toEqual(before)
    expect(s.deps.completions.deferredCount(sid)).toBe(0)
    expect(sidecar.calls.filter((c) => c.method === 'chat.start' || c.method === 'process.complete_delivery')).toEqual([])
    if (phase !== 'claim') expect(sidecar.calls.filter((c) => c.method === 'process.claim_delivery')).toEqual([])
  })

  it.each(['live', 'orphan', 'materialize'] as const)('keeps canonical %s recovery candidates unsafe and unchanged', async (kind) => {
    const sid = fixture.sessions.cli!
    const session = cache(sid)
    const path = join(s.state, 'sessions', `${sid}.json`)
    const file = readFileSync(path, 'utf8')
    const backup = JSON.stringify({ ...session.toDocument(), messages: [...session.messages, { role: 'assistant', content: 'longer backup' }] })
    if (kind !== 'materialize') writeFileSync(`${path}.bak`, backup)
    if (kind !== 'live') { rmSync(path); s.deps.sessionStore.sessions.delete(sid) }
    if (kind === 'materialize') db.prepare("UPDATE sessions SET source = 'webui' WHERE id = ?").run(sid)
    const before = stored()
    const response = await post(s, '/api/session/recovery/repair-safe', {})
    expect(kind === 'live' ? readFileSync(path, 'utf8') : existsSync(path)).toBe(kind === 'live' ? file : false)
    expect(response.status).toBe(409)
    const result = await json(response)
    expect((result.after as { items: Record<string, unknown>[] }).items).toContainEqual(expect.objectContaining({ session_id: sid, category: 'unsafe_to_repair', recommendation: 'manual_review' }))
    expect(stored()).toEqual(before)
    if (kind !== 'materialize') expect(readFileSync(`${path}.bak`, 'utf8')).toBe(backup)
  })

  it('rechecks safe recovery ownership after its session lock wait', async () => {
    const sid = fixture.sessions.cli!
    makeLegacy(sid)
    const session = cache(sid)
    const path = join(s.state, 'sessions', `${sid}.json`)
    const file = readFileSync(path, 'utf8')
    writeFileSync(`${path}.bak`, JSON.stringify({ ...session.toDocument(), messages: [...session.messages, { role: 'assistant', content: 'longer backup' }] }))
    let entered!: () => void
    let release!: () => void
    const acquired = new Promise<void>((resolve) => { entered = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    const lock = s.deps.sessionStore.withLock(sid, () => { entered(); return held })
    await acquired
    const pending = s.deps.sessions.recoveryRepairSafe()
    try {
      await Promise.resolve()
      adopt(sid)
      release()
      await lock
      await pending
      expect(readFileSync(path, 'utf8')).toBe(file)
    } finally { release(); await lock; await pending }
  })

  it.each(['cleanup', 'cleanup_zero_message'])('keeps canonical sidecars during %s maintenance', async (action) => {
    const sid = fixture.sessions.cli!
    const session = cache(sid)
    session.title = 'Untitled'
    session.messages = []
    s.deps.sessionStore.save(session)
    const path = join(s.state, 'sessions', `${sid}.json`)
    const file = readFileSync(path, 'utf8')
    expect((await post(s, `/api/sessions/${action}`, {})).status).toBe(200)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(file)
  })

  it('does not prune a canonical read-only import whose transcript row was retired', async () => {
    const sid = fixture.sessions.cli!
    const session = cache(sid)
    session.read_only = true
    s.deps.sessionStore.save(session)
    db.prepare('DELETE FROM session_admissions WHERE target_session_id = ?').run(sid)
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(sid)
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sid)
    const path = join(s.state, 'sessions', `${sid}.json`)
    const file = readFileSync(path, 'utf8')
    expect((await s.get('/api/sessions')).status).toBe(200)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(file)
  })

  it('refuses the real candidate queued-local reproduction before independent chat dispatch', async () => {
    const sid = fixture.sessions.cli!
    const before = stored()
    const response = await post(s, '/api/chat/start', { session_id: sid, message: 'unsafe second execution' })
    expect(response.status).toBe(403)
    expect(sidecar.calls.filter((c) => c.method === 'chat.start')).toEqual([])
    expect(stored()).toEqual(before)
    expect(s.deps.sessionStore.loadMetadataOnly(sid)).toBeNull()
  })

  it.each(['queued', 'started', 'unknown', 'terminal'])('retains %s ownership and original surface on all read routes and capability flags', async (status) => {
    db.prepare('UPDATE session_admissions SET status = ?, owner_epoch = 1, generation = 0').run(status)
    db.prepare("UPDATE sessions SET source = 'tui' WHERE id = ?").run(fixture.sessions.tui!)
    db.prepare("UPDATE sessions SET source = 'acp' WHERE id = ?").run(fixture.sessions.acp!)
    const rows = (await json(await s.get('/api/sessions'))).sessions as Record<string, unknown>[]
    for (const [surface, sid] of Object.entries(fixture.sessions)) {
      for (const row of [await detail(sid), await detail(sid), rows.find((r) => r.session_id === sid)]) {
        expect(row, surface).toMatchObject({ read_only: true, source_kind: 'cli', source_label: surface.toUpperCase(), can_pin: false, can_delete: false, can_branch: false })
      }
      expect((await json(await s.get(`/api/session/status?session_id=${sid}`))).read_only).toBe(true)
      expect((await detail(sid)).can_compress).not.toBe(true)
    }
  })

  it('filters native LOCAL transport rows by their recorded CLI/TUI/ACP surface', () => {
    for (const [surface, sid] of Object.entries(fixture.sessions)) {
      expect(readImportableAgentSessionRows(join(s.state, 'state.db'), { includeSources: [surface] }).map((r) => r.id)).toEqual([sid])
    }
  })

  it('locks stale sidecars, including ones persisted as webui/fork, before transcript or compression writes', async () => {
    for (const [i, sid] of Object.values(fixture.sessions).entries()) {
      s.deps.sessionStore.save(new Session({ session_id: sid, source_tag: ['cli', 'webui', 'fork'][i], messages: [{ role: 'user', content: 'cached', timestamp: 1 }] }, { workspace: s.state, model: null }))
      const before = stored()
      const file = readFileSync(join(s.state, 'sessions', `${sid}.json`), 'utf8')
      for (const path of ['/api/chat/start', '/api/session/rename', '/api/session/compress', '/api/session/compress/start', '/api/session/clear', '/api/session/truncate', '/api/session/pin', '/api/session/archive', '/api/session/duplicate', '/api/session/branch']) {
        const res = await post(s, path, { session_id: sid, message: 'unsafe', title: 'unsafe', keep_count: 0 })
        expect(res.status, path).toBe(403)
      }
      expect((await detail(sid)).read_only).toBe(true)
      expect(stored()).toEqual(before)
      expect(readFileSync(join(s.state, 'sessions', `${sid}.json`), 'utf8')).toBe(file)
    }
    expect(sidecar.calls.filter((c) => ['chat.start', 'chat.compress', 'sessions.clear', 'sessions.truncate'].includes(c.method))).toEqual([])
  })

  it.each([['deferred', 'yolo'], ['eager', 'yolo'], ['deferred', 'profile'], ['eager', 'profile']] as const)('rechecks ownership after asynchronous setup and retires the %s pending turn during %s setup without transcript writes', async (mode, barrier) => {
    const sid = fixture.sessions.cli!
    makeLegacy(sid)
    const messages = [{ role: 'user', content: 'earlier question', timestamp: 1 }, { role: 'assistant', content: 'earlier answer', timestamp: 2 }]
    s.deps.sessionStore.save(new Session({ session_id: sid, source_tag: 'cli', messages }, { workspace: join(s.state, 'workspace'), model: 'fixture' }))
    s.deps.turns.deps.saveMode = () => mode
    let entered!: () => void
    let release!: () => void
    const setup = new Promise<void>((resolve) => { entered = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    const previousConfig = s.deps.turns.deps.profileConfig
    if (barrier === 'profile') s.deps.turns.deps.profileConfig = async () => { entered(); await held; return {} }
    sidecar.respond('approval.set_yolo', async () => { if (barrier === 'yolo') { entered(); await held } return { yolo_enabled: false, released: 0 } })
    let stream = ''
    try {
      const response = await post(s, '/api/chat/start', { session_id: sid, message: 'must never reach the Agent' })
      expect(response.status).toBe(200)
      stream = String((await json(response)).stream_id)
      await setup
      // The gateway adopts this id while Talaria awaits its final asynchronous setup operation.
      adopt(sid)
      const before = stored()
      release()
      await s.deps.turns.finished(stream)
      expect(sidecar.calls.filter((c) => c.method === 'chat.start')).toEqual([])
      expect(stored()).toEqual(before)
      const session = s.deps.sessionStore.get(sid)
      expect(session.messages).toEqual(messages)
      expect(session.active_stream_id).toBeNull()
      expect(session.hasPendingPrompt).toBe(false)
      expect(s.deps.registry.activeRuns.has(stream)).toBe(false)
      expect(s.deps.registry.writebackOwners.has(sid)).toBe(false)
      const frames = await s.sse(`/api/chat/stream?stream_id=${stream}`, (f) => ['done', 'apperror', 'cancel'].includes(f.event))
      const terminal = frames.find((f) => f.event === 'apperror')
      expect((terminal?.data as Record<string, unknown>)?.session).toMatchObject({ read_only: true })
    } finally {
      release(); if (stream) await s.deps.turns.finished(stream)
      if (previousConfig) s.deps.turns.deps.profileConfig = previousConfig; else delete s.deps.turns.deps.profileConfig
    }
  })

  it.each([false, true])('refuses compression recovery of a canonical sidecar before creating or reopening a child (existing=%s)', async (existing) => {
    const sid = fixture.sessions.cli!
    const source = new Session({ session_id: sid, source_tag: 'cli' }, { workspace: join(s.state, 'workspace'), model: 'fixture' })
    stampCompressionExhaustedRecovery(source, 'Context length exceeded.', '')
    s.deps.sessionStore.save(source)
    if (existing) s.deps.sessionStore.save(new Session({ session_id: 'earlier-recovery-child', session_source: 'fork', compression_recovery_source_session_id: sid, compression_recovery_action: 'start_focused_continuation' }, { workspace: join(s.state, 'workspace'), model: 'fixture' }))
    const ids = [...s.deps.sessionStore.persistedIds()]
    const before = stored()
    const saved = readFileSync(join(s.state, 'sessions', `${sid}.json`), 'utf8')
    const response = await post(s, '/api/session/compression-recovery/start', { session_id: sid })
    expect(response.status).toBe(403)
    expect([...s.deps.sessionStore.persistedIds()]).toEqual(ids)
    expect(stored()).toEqual(before)
    expect(readFileSync(join(s.state, 'sessions', `${sid}.json`), 'utf8')).toBe(saved)
  })

  it('refuses refine before building an Agent for a canonical sidecar', async () => {
    const sid = fixture.sessions.cli!
    cache(sid)
    const before = stored()
    sidecar.respond('chat.refine', () => ({ output: 'would launch review' }))
    const response = await post(s, '/api/commands/exec', { session_id: sid, command: '/refine' })
    expect(response.status).toBe(403)
    expect(sidecar.calls.filter((c) => c.method === 'chat.refine')).toEqual([])
    expect(stored()).toEqual(before)
  })

  it('rechecks refine ownership after its profile setup await', async () => {
    const sid = fixture.sessions.cli!
    makeLegacy(sid)
    cache(sid)
    let entered!: () => void
    let release!: () => void
    const setup = new Promise<void>((resolve) => { entered = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    const previous = s.deps.turns.deps.profileConfig
    s.deps.turns.deps.profileConfig = async () => { entered(); await held; return {} }
    sidecar.respond('chat.refine', () => ({ output: 'would launch review' }))
    const pending = post(s, '/api/commands/exec', { session_id: sid, command: '/refine' })
    try {
      await setup
      adopt(sid)
      release()
      expect((await pending).status).toBe(403)
      expect(sidecar.calls.filter((c) => c.method === 'chat.refine')).toEqual([])
    } finally { release(); if (previous) s.deps.turns.deps.profileConfig = previous; else delete s.deps.turns.deps.profileConfig; await pending }
  })

  it.each([true, false])('refuses canonical YOLO enabled=%s before RPC or local flag changes', async (enabled) => {
    const sid = fixture.sessions.cli!
    cache(sid)
    s.deps.sessions.deps.yolo.set(sid, !enabled)
    sidecar.respond('approval.set_yolo', (params) => ({ yolo_enabled: params.enabled, released: 0 }))
    const before = stored()
    const response = await post(s, '/api/session/yolo', { session_id: sid, enabled })
    expect(response.status).toBe(403)
    expect(sidecar.calls.filter((c) => c.method === 'approval.set_yolo')).toEqual([])
    expect(s.deps.sessions.yolo(sid).yolo_enabled).toBe(!enabled)
    expect(stored()).toEqual(before)
  })

  it.each([false, true])('keeps canonical approvals queued without dispatch (injected=%s)', async (injected) => {
    const sid = fixture.sessions.cli!
    cache(sid)
    const entry = s.deps.pending.submitApproval(sid, { request_id: 'owned-approval', command: 'write memory', _injected: injected })
    sidecar.respond('approval.respond', (params) => ({ ok: true, resolved: 1, choice: params.choice }))
    const response = await post(s, '/api/approval/respond', { session_id: sid, approval_id: entry.approval_id, choice: 'once' })
    expect(response.status).toBe(403)
    expect(sidecar.calls.filter((c) => c.method === 'approval.respond')).toEqual([])
    expect(s.deps.pending.approvalPending(sid).pending_count).toBe(1)
  })

  it.each([false, true])('keeps canonical clarifications queued without dispatch (injected=%s)', async (injected) => {
    const sid = fixture.sessions.cli!
    cache(sid)
    const entry = s.deps.pending.submitClarify(sid, { clarify_id: 'owned-clarify', question: 'Continue?', _injected: injected })
    sidecar.respond('clarify.respond', (params) => ({ ok: true, clarify_id: params.clarify_id }))
    const response = await post(s, '/api/clarify/respond', { session_id: sid, clarify_id: entry.clarify_id, response: 'yes' })
    expect(response.status).toBe(403)
    expect(sidecar.calls.filter((c) => c.method === 'clarify.respond')).toEqual([])
    expect(s.deps.pending.clarifyPending(sid).pending_count).toBe(1)
  })

  it('does not flush a canonical cached Agent memory when leaving the conversation', async () => {
    const sid = fixture.sessions.cli!
    cache(sid)
    const before = stored()
    expect((await post(s, '/api/session/new', { prev_session_id: sid })).status).toBe(200)
    expect(sidecar.calls.filter((c) => c.method === 'chat.commit_memory')).toEqual([])
    expect(stored()).toEqual(before)
  })

  it.each(['initial', 'refresh'] as const)('does not dispatch %s title work after a turn becomes canonical-owned', async (kind) => {
    const sid = fixture.sessions.cli!
    makeLegacy(sid)
    const session = cache(sid)
    const title = kind === 'initial' ? 'CLI Session' : 'Earlier generated title'
    session.title = title
    session.llm_title_generated = kind === 'refresh'
    s.deps.sessionStore.save(session)
    s.deps.turns.deps.titleRefreshEvery = () => 1
    sidecar.respond('chat.start', (params) => { adopt(sid); return completed(sid, params.user_message) })
    sidecar.respond('aux.complete', () => ({ model: 'fixture', usage: null, text: 'New generated title', finish_reason: 'stop' }))
    const response = await post(s, '/api/chat/start', { session_id: sid, message: 'a permitted legacy turn' })
    expect(response.status).toBe(200)
    await s.deps.turns.finished(String((await json(response)).stream_id))
    expect(sidecar.calls.filter((c) => c.method === 'aux.complete')).toEqual([])
    expect(s.deps.sessionStore.get(sid).title).toBe(title)
  })

  it.each(['initial', 'refresh'] as const)('does not save a %s title after adoption during its model await', async (kind) => {
    const sid = fixture.sessions.cli!
    makeLegacy(sid)
    const session = cache(sid)
    const title = kind === 'initial' ? 'CLI Session' : 'Earlier generated title'
    session.title = title
    session.llm_title_generated = kind === 'refresh'
    s.deps.sessionStore.save(session)
    s.deps.turns.deps.titleRefreshEvery = () => 1
    sidecar.respond('chat.start', (params) => completed(sid, params.user_message))
    let entered!: () => void
    let release!: () => void
    const setup = new Promise<void>((resolve) => { entered = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    sidecar.respond('aux.complete', async () => { entered(); await held; return { model: 'fixture', usage: null, text: 'New generated title', finish_reason: 'stop' } })
    const response = await post(s, '/api/chat/start', { session_id: sid, message: 'a permitted legacy turn' })
    expect(response.status).toBe(200)
    const pending = s.deps.turns.finished(String((await json(response)).stream_id))
    try {
      await Promise.race([setup, pending.then(() => { throw new Error('Turn did not reach title generation') })])
      adopt(sid)
      const before = stored()
      const file = readFileSync(join(s.state, 'sessions', `${sid}.json`), 'utf8')
      release()
      await pending
      expect(s.deps.sessionStore.get(sid).title).toBe(title)
      expect(readFileSync(join(s.state, 'sessions', `${sid}.json`), 'utf8')).toBe(file)
      expect(stored()).toEqual(before)
      expect(sidecar.calls.filter((c) => c.method === 'state_db.sync_title')).toEqual([])
    } finally { release(); await pending }
  })

  it('does not retry a title prompt after adoption during an empty model response', async () => {
    const sid = fixture.sessions.cli!
    makeLegacy(sid)
    const session = cache(sid)
    const title = session.title
    sidecar.respond('aux.complete', () => { adopt(sid); return { model: 'fixture', usage: null, text: '', finish_reason: 'stop' } })
    const response = await post(s, '/api/session/title/regenerate', { session_id: sid })
    expect(response.status).toBe(403)
    expect(sidecar.calls.filter((c) => c.method === 'aux.complete')).toHaveLength(1)
    expect(s.deps.sessionStore.get(sid).title).toBe(title)
  })

  it('does not judge goals after the completed turn becomes canonical-owned', async () => {
    const sid = fixture.sessions.cli!
    makeLegacy(sid)
    cache(sid)
    sidecar.respond('chat.start', (params) => {
      adopt(sid)
      return completed(sid, params.user_message)
    })
    const response = await post(s, '/api/chat/start', { session_id: sid, message: 'a permitted legacy turn' })
    expect(response.status).toBe(200)
    await s.deps.turns.finished(String((await json(response)).stream_id))
    expect(sidecar.calls.filter((c) => c.method === 'goals.evaluate')).toEqual([])
  })

  it('refuses other session-bound commands for canonical sidecars', async () => {
    const sid = fixture.sessions.cli!
    cache(sid)
    sidecar.respond('commands.exec', () => ({ output: 'would change session state', source: 'agent' }))
    const response = await post(s, '/api/commands/exec', { session_id: sid, command: '/clear' })
    expect(response.status, JSON.stringify(await json(response))).toBe(403)
    expect(sidecar.calls.filter((c) => c.method === 'commands.exec')).toEqual([])
  })

  it('rechecks goal-command ownership after the snapshot await', async () => {
    const sid = fixture.sessions.cli!
    makeLegacy(sid)
    cache(sid)
    let entered!: () => void
    let release!: () => void
    const setup = new Promise<void>((resolve) => { entered = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    sidecar.respond('goals.snapshot', async () => { entered(); await held; return { goal: null, snapshot: null } })
    sidecar.respond('goals.command', () => ({ ok: true, action: 'clear', message: 'would mutate goal', goal: null }))
    const response = post(s, '/api/goal', { session_id: sid, args: 'clear' })
    try {
      await setup
      adopt(sid)
      release()
      expect((await response).status).toBe(403)
      expect(sidecar.calls.filter((c) => c.method === 'goals.command')).toEqual([])
    } finally { release(); await response }
  })

  it.each(['title', 'usage', 'delete', 'clear'] as const)('fences canonical %s RPC callbacks at their write boundary', async (action) => {
    const sid = fixture.sessions.cli!
    const session = cache(sid)
    await s.deps.settings.save({ sync_to_insights: true })
    const before = stored()
    if (action === 'title') await s.deps.sessions.deps.syncTitle(session)
    else if (action === 'usage') await s.deps.turns.deps.syncUsage?.(session, 'fixture')
    else if (action === 'delete') await s.deps.sessions.deps.runtime.deleteCliSession('default', sid).catch(() => undefined)
    else s.deps.sessions.deps.runtime.evictAgent(sid, true)
    const methods = ['state_db.sync_title', 'state_db.sync_usage', 'state_db.delete_cli_session', 'chat.evict_agent']
    expect(sidecar.calls.filter((c) => methods.includes(c.method))).toEqual([])
    expect(stored()).toEqual(before)
  })

  it('fences the actual callback home when the same id has different sidecar profile metadata', async () => {
    const sid = fixture.sessions.cli!
    const session = cache(sid)
    session.profile = 'work'
    s.deps.sessionStore.save(session)
    await s.deps.sessions.deps.runtime.deleteCliSession('default', sid).catch(() => undefined)
    expect(sidecar.calls.filter((c) => c.method === 'state_db.delete_cli_session')).toEqual([])
  })

  it("does not inherit another home's persisted read-only flag at an explicitly bound callback", async () => {
    const sid = fixture.sessions.cli!
    makeLegacy(sid)
    const session = cache(sid)
    session.profile = 'work'
    session.read_only = true
    s.deps.sessionStore.save(session)
    await s.deps.sessions.deps.runtime.deleteCliSession('default', sid).catch(() => undefined)
    expect(sidecar.calls.filter((c) => c.method === 'state_db.delete_cli_session')).toHaveLength(1)
    expect(s.deps.sessions.isReadOnly(session)).toBe(true)
  })

  it.each(['rename', 'pin', 'archive', 'toolsets', 'personality', 'truncate', 'clear', 'retry', 'undo', 'delete', 'update'] as const)('rechecks %s ownership after acquiring its mutation lock', async (action) => {
    const sid = fixture.sessions.cli!
    makeLegacy(sid)
    const session = cache(sid)
    mkdirSync(join(s.state, 'workspace', 'next'), { recursive: true })
    const saved = readFileSync(join(s.state, 'sessions', `${sid}.json`), 'utf8')
    let entered!: () => void
    let release!: () => void
    const acquired = new Promise<void>((resolve) => { entered = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    const lock = s.deps.sessionStore.withLock(sid, () => { entered(); return held })
    await acquired
    const actions: Record<typeof action, () => Promise<unknown>> = {
      rename: () => s.deps.sessions.rename(sid, 'changed'), pin: () => s.deps.sessions.pin(sid, true), archive: () => s.deps.sessions.archive(sid, true),
      toolsets: () => s.deps.sessions.setToolsets(sid, ['terminal']), personality: () => s.deps.sessions.setPersonality(sid, 'helper'),
      truncate: () => s.deps.sessions.truncate(sid, 0), clear: () => s.deps.sessions.clear(sid), retry: () => s.deps.sessions.retry(sid),
      undo: () => s.deps.sessions.undo(sid), delete: () => s.deps.sessions.delete(sid), update: () => s.deps.sessions.update(sid, { workspace: join(s.state, 'workspace', 'next') }),
    }
    const pending = actions[action]().then(() => 200, (error: unknown) => error instanceof HttpFailure ? error.status : 500)
    try {
      await Promise.resolve()
      adopt(sid)
      const before = stored()
      release()
      await lock
      expect(await pending).toBe(403)
      expect(stored()).toEqual(before)
      expect(readFileSync(join(s.state, 'sessions', `${sid}.json`), 'utf8')).toBe(saved)
      expect(session.messages).toEqual([{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' }])
    } finally { release(); await lock; await pending }
  })

  it.each([true, false])('rechecks handoff ownership after its model await (materialized=%s)', async (materialized) => {
    const sid = fixture.sessions.cli!
    makeLegacy(sid)
    if (materialized) cache(sid)
    for (let i = 0; i <= CONVERSATION_ROUND_THRESHOLD; i += 1) {
      db.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES (?,?,?,?)').run(sid, 'user', `question ${i}`, 2000 + i * 2)
      db.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES (?,?,?,?)').run(sid, 'assistant', `answer ${i}`, 2001 + i * 2)
    }
    let entered!: () => void
    let release!: () => void
    const setup = new Promise<void>((resolve) => { entered = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    sidecar.respond('aux.complete', async () => { entered(); await held; return { model: 'fixture', usage: null, text: '- Summary.', finish_reason: 'stop' } })
    sidecar.respond('state_db.append_message', () => ({ ok: true }))
    const file = materialized ? readFileSync(join(s.state, 'sessions', `${sid}.json`), 'utf8') : null
    const pending = post(s, '/api/session/handoff-summary', { session_id: sid })
    try {
      await setup
      adopt(sid)
      const before = stored()
      release()
      expect((await pending).status).toBe(403)
      expect(sidecar.calls.filter((c) => c.method === 'state_db.append_message')).toEqual([])
      expect(stored()).toEqual(before)
      if (file !== null) expect(readFileSync(join(s.state, 'sessions', `${sid}.json`), 'utf8')).toBe(file)
    } finally { release(); await pending }
  })

  it.each(['receipt', 'physical-alias', 'terminal-ledger', 'retired', 'api-binding'] as const)('retains %s ownership without a sessions row', async (kind) => {
    const root = fixture.sessions.cli!
    const sid = kind === 'physical-alias' ? 'pruned-canonical-tip' : root
    cache(sid)
    if (kind === 'physical-alias') {
      db.prepare("UPDATE state_meta SET value = json_set(value, '$.lineage', json(?), '$.entry.session_id', ?) WHERE key = ?").run(JSON.stringify([root, sid]), sid, `gateway.local_policy.v1:${root}`)
    } else {
      if (kind === 'terminal-ledger') {
        db.exec('PRAGMA foreign_keys=OFF')
        db.prepare("UPDATE session_admissions SET status = 'terminal' WHERE target_session_id = ?").run(sid)
      } else db.prepare('DELETE FROM session_admissions WHERE target_session_id = ?').run(sid)
      db.prepare('DELETE FROM messages WHERE session_id = ?').run(sid)
      db.prepare('DELETE FROM sessions WHERE id = ?').run(sid)
      if (kind !== 'receipt') db.prepare('DELETE FROM state_meta WHERE key = ?').run(`gateway.local_policy.v1:${sid}`)
      // Agent retire_routes keeps this identity fence outside the deleted transcript.
      if (kind === 'retired') db.prepare('INSERT INTO state_meta(key,value) VALUES (?,?)').run(`gateway.retired_session.v1.${sid}`, JSON.stringify({ retired_at: 1000 }))
      if (kind === 'api-binding') db.prepare('INSERT INTO state_meta(key,value) VALUES (?,?)').run(`gateway.api.binding.v1.${sid}`, JSON.stringify({ session_id: sid, profile_id: 'fixture' }))
    }
    const before = stored()
    const response = await post(s, '/api/chat/start', { session_id: sid, message: 'must stay display-only' })
    expect(response.status).toBe(403)
    expect(sidecar.calls.filter((c) => c.method === 'chat.start')).toEqual([])
    expect(stored()).toEqual(before)
  })

  it('rechecks model-update ownership after context lookup without mutating the cached session', async () => {
    const sid = fixture.sessions.cli!
    makeLegacy(sid)
    const session = cache(sid)
    const beforeModel = session.model
    const file = readFileSync(join(s.state, 'sessions', `${sid}.json`), 'utf8')
    let entered!: () => void
    let release!: () => void
    const setup = new Promise<void>((resolve) => { entered = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    const previous = s.deps.sessions.deps.resolveContextLength
    s.deps.sessions.deps.resolveContextLength = async () => { entered(); await held; return 1000 }
    const pending = s.deps.sessions.update(sid, { model: 'changed-model', model_provider: 'custom' }).then(() => 200, (error: unknown) => error instanceof HttpFailure ? error.status : 500)
    try {
      await Promise.race([setup, pending.then((status) => { throw new Error(`Update did not reach context lookup: ${status}`) })])
      adopt(sid)
      release()
      expect(await pending).toBe(403)
      expect(session.model).toBe(beforeModel)
      expect(readFileSync(join(s.state, 'sessions', `${sid}.json`), 'utf8')).toBe(file)
    } finally {
      release(); await pending
      if (previous) s.deps.sessions.deps.resolveContextLength = previous; else delete s.deps.sessions.deps.resolveContextLength
    }
  })

  it('aborts prepared compression if ownership changes before external finalization', async () => {
    const sid = fixture.sessions.cli!
    makeLegacy(sid)
    cache(sid)
    sidecar.respond('chat.compress', (params) => ({
      status: 'compressed', messages: [params.conversation_history[0]!, params.conversation_history.at(-1)!], before_tokens: 400, after_tokens: 120,
      message: null, agent_session_id: sid, commit_token: 'owned-compression', summary: { noop: false, headline: 'Compressed', token_line: '400 to 120', note: null },
    }))
    let entered!: () => void
    let release!: () => void
    const setup = new Promise<void>((resolve) => { entered = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    sidecar.respond('chat.evict_agent', async () => { entered(); await held; return { evicted: true } })
    const finalized: boolean[] = []
    sidecar.respond('chat.compress_finalize', (params) => { finalized.push(params.committed); return { finalized: true } })
    const pending = post(s, '/api/session/compress', { session_id: sid })
    try {
      await Promise.race([setup, pending.then(async (response) => { throw new Error(`Compression did not reach finalization: ${response.status} ${await response.text()}`) })])
      adopt(sid)
      const before = stored()
      release()
      await pending
      expect(finalized).toEqual([false])
      expect(stored()).toEqual(before)
    } finally { release(); await pending }
  })

  it('keeps a directly recorded chat owner locked without receipt lineage aliases', async () => {
    const root = fixture.sessions.cli!
    const sid = 'owner-hinted-tip'
    db.prepare('DELETE FROM session_admissions WHERE target_session_id = ?').run(root)
    db.prepare("INSERT INTO sessions(id,source,chat_id,started_at,message_count) VALUES (?, 'cli', ?, 2000, 0)").run(sid, root)
    cache(sid)
    expect((await post(s, '/api/chat/start', { session_id: sid, message: 'must remain display-only' })).status).toBe(403)
    expect(sidecar.calls.filter((c) => c.method === 'chat.start')).toEqual([])
  })

  it('reports an unreadable ownership home without dispatching or changing the transcript', async () => {
    const sid = fixture.sessions.cli!
    cache(sid)
    const previous = s.deps.sessions.deps.profileHome
    s.deps.sessions.deps.profileHome = () => { throw new Error('Ownership home is unavailable') }
    try {
      const response = await post(s, '/api/chat/start', { session_id: sid, message: 'must refuse' })
      expect(response.status).toBe(403)
      const status = await json(await s.get(`/api/session/status?session_id=${sid}`))
      expect(status.read_only_reason).toContain('ownership')
      expect(sidecar.calls.filter((c) => c.method === 'chat.start')).toEqual([])
    } finally { s.deps.sessions.deps.profileHome = previous }
  })

  it('rejects padded canonical control ids before the sidecar can normalize them', async () => {
    const sid = fixture.sessions.cli!
    cache(sid)
    sidecar.respond('approval.set_yolo', (params) => ({ yolo_enabled: params.enabled, released: 1 }))
    const response = await post(s, '/api/approval/respond', { session_id: ` ${sid} `, choice: 'once', yolo: true })
    expect(response.status).toBe(403)
    expect(sidecar.calls.filter((c) => c.method === 'approval.set_yolo')).toEqual([])
    expect(s.deps.sessions.yolo(sid).yolo_enabled).toBe(false)
  })

  it('refuses a steer into an already-materialized live sidecar before sidecar dispatch', async () => {
    const sid = fixture.sessions.cli!
    const stream = 'stale-canonical-stream'
    s.deps.sessionStore.save(new Session({ session_id: sid, source_tag: 'cli', active_stream_id: stream }, { workspace: join(s.state, 'workspace'), model: 'fixture' }))
    s.deps.registry.liveIds.add(stream)
    sidecar.respond('chat.steer', () => ({ accepted: true }))
    try {
      const response = await post(s, '/api/chat/steer', { session_id: sid, text: 'unsafe steer' })
      expect(response.status).toBe(403)
      expect(sidecar.calls.filter((c) => c.method === 'chat.steer')).toEqual([])
      expect(s.deps.turns.pendingSteers(stream)).toEqual([])
    } finally { s.deps.registry.liveIds.delete(stream) }
  })

  it('rechecks ownership before rewriting steers queued by an earlier sidecar', async () => {
    const sid = fixture.sessions.cli!
    const stream = 'previous-sidecar-stream'
    makeLegacy(sid)
    s.deps.sessionStore.save(new Session({ session_id: sid, source_tag: 'cli', active_stream_id: stream }, { workspace: join(s.state, 'workspace'), model: 'fixture' }))
    s.deps.registry.liveIds.add(stream)
    sidecar.respond('chat.steer', () => ({ accepted: true, can_redirect: true }))
    try {
      expect((await post(s, '/api/chat/steer', { session_id: sid, text: 'previously accepted', steer_id: 'earlier' })).status).toBe(200)
      adopt(sid)
      const calls = sidecar.calls.length
      for (const path of ['/api/chat/steer/withdraw', '/api/chat/steer/send-now']) {
        expect((await post(s, path, { session_id: sid, steer_id: 'earlier', reason: 'cancel' })).status, path).toBe(403)
      }
      expect(sidecar.calls.slice(calls)).toEqual([])
      expect(s.deps.turns.pendingSteers(stream)).toHaveLength(1)
    } finally { s.deps.registry.liveIds.delete(stream) }
  })

  it('does not let a stale WebUI index hide a canonical conversation after its sidecar is gone', async () => {
    const sid = fixture.sessions.cli!
    s.deps.sessionStore.save(new Session({ session_id: sid, source_tag: 'webui' }, { workspace: join(s.state, 'workspace'), model: 'fixture' }))
    s.deps.sessionStore.sessions.delete(sid)
    rmSync(join(s.state, 'sessions', `${sid}.json`))
    const response = await s.get(`/api/session?session_id=${sid}`)
    expect(response.status).toBe(200)
    expect((await json(response)).session).toMatchObject({ read_only: true, source_kind: 'cli' })
    expect((await post(s, '/api/chat/start', { session_id: sid, message: 'unsafe' })).status).toBe(403)
  })

  it('does not apply the legacy cron branch exception to a canonical owner', async () => {
    const sid = fixture.sessions.cli!
    db.prepare("UPDATE state_meta SET value = json_set(value, '$.policy.source', 'cron') WHERE key = ?").run(`gateway.local_policy.v1:${sid}`)
    s.deps.sessionStore.save(new Session({ session_id: sid, source_tag: 'cron' }, { workspace: join(s.state, 'workspace'), model: 'fixture' }))
    expect(s.deps.sessions.wireRow(s.deps.sessionStore.get(sid)).can_branch).toBe(false)
    expect((await post(s, '/api/session/branch', { session_id: sid })).status).toBe(403)
  })

  it('does not release ownership when receipts are malformed or ledger rows are terminal', async () => {
    const sid = fixture.sessions.cli!
    db.prepare("UPDATE state_meta SET value = '{bad' WHERE key = ?").run(`gateway.local_policy.v1:${sid}`)
    db.prepare("UPDATE session_admissions SET status = 'terminal'").run()
    expect((await detail(sid)).read_only).toBe(true)
    expect((await post(s, '/api/chat/start', { session_id: sid, message: 'unsafe' })).status).toBe(403)
  })
  it('protects logical owners and physical compression/reset tips, even without pending work', async () => {
    const root = fixture.sessions.cli!
    const columns = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((r) => r.name)
    const clone = (id: string, parent: string, endReason: string | null): void => {
      db.prepare(`INSERT INTO sessions (${columns.join(',')}) SELECT ${columns.map((c) => c === 'id' ? '?' : c === 'title' ? 'NULL' : c).join(',')} FROM sessions WHERE id = ?`).run(id, parent)
      db.prepare('UPDATE sessions SET source = ?, parent_session_id = ?, end_reason = ?, chat_id = ?, model_config = ? WHERE id = ?').run('cli', parent, endReason, root, JSON.stringify({ _reset_from: parent }), id)
      db.prepare("INSERT INTO messages(session_id,role,content,timestamp) VALUES (?, 'user', 'physical transcript', 2000)").run(id)
    }
    db.prepare("UPDATE sessions SET end_reason = 'compression', ended_at = 1000 WHERE id = ?").run(root)
    clone('canonical-compressed', root, 'session_reset')
    clone('canonical-reset', 'canonical-compressed', null)
    const key = `gateway.local_policy.v1:${root}`
    const receipt = JSON.parse((db.prepare('SELECT value FROM state_meta WHERE key = ?').get(key) as { value: string }).value) as Record<string, unknown>
    receipt.lineage = [root, 'canonical-compressed', 'canonical-reset']
    receipt.entry = { ...(receipt.entry as object), session_id: 'canonical-reset' }
    db.prepare('UPDATE state_meta SET value = ? WHERE key = ?').run(JSON.stringify(receipt), key)
    db.exec('DELETE FROM session_admissions')
    const before = stored()
    for (const sid of [root, 'canonical-compressed', 'canonical-reset']) {
      expect(await detail(sid)).toMatchObject({ read_only: true, source_label: 'CLI' })
      expect((await post(s, '/api/chat/start', { session_id: sid, message: 'unsafe' })).status).toBe(403)
      expect((await post(s, '/api/session/clear', { session_id: sid })).status).toBe(403)
    }
    expect(stored()).toEqual(before)
    expect(sidecar.calls.filter((c) => c.method === 'chat.start')).toEqual([])
  })

  it('uses durable admission/worker ledgers when no local receipt remains', async () => {
    db.exec("DELETE FROM state_meta WHERE key GLOB 'gateway.local_policy.v1:*'; UPDATE sessions SET source = 'cli'; UPDATE session_admissions SET status = 'terminal'")
    expect((await detail(fixture.sessions.cli!)).read_only).toBe(true)
    db.prepare("UPDATE sessions SET chat_id = NULL, parent_session_id = NULL WHERE id = ?").run(fixture.sessions.acp!)
    db.prepare('UPDATE session_admissions SET lineage_json = ? WHERE target_session_id = ?').run(JSON.stringify([fixture.sessions.cli!, fixture.sessions.acp!]), fixture.sessions.cli!)
    db.prepare('DELETE FROM session_admissions WHERE target_session_id != ?').run(fixture.sessions.cli!)
    expect((await detail(fixture.sessions.acp!)).read_only).toBe(true)
    db.exec('DELETE FROM session_admissions')
    db.prepare("INSERT INTO worker_executions(execution_id,session_id,kind,owner_epoch,generation,status,adoption_digest) VALUES ('fixture-worker',?,'compute',1,0,'terminal','synthetic')").run(fixture.sessions.tui!)
    expect((await detail(fixture.sessions.tui!)).read_only).toBe(true)
    expect((await post(s, '/api/chat/start', { session_id: fixture.sessions.tui!, message: 'unsafe' })).status).toBe(403)
  })

  it('refuses automatic continuations of previously materialized canonical sessions', () => {
    const session = new Session({ session_id: fixture.sessions.cli!, source_tag: 'webui' }, { workspace: join(s.state, 'workspace'), model: 'fixture' })
    s.deps.sessionStore.save(session)
    expect(s.deps.turns.startServerTurn(session, { msg: 'automatic', source: 'process_wakeup' })).toMatchObject({ _status: 403 })
    expect(session.active_stream_id).toBeNull()
    expect(sidecar.calls.filter((c) => c.method === 'chat.start')).toEqual([])
  })

  it('keeps legacy CLI and Talaria chats editable and isolates the same id in another home', async () => {
    const sid = fixture.sessions.cli!
    const otherPath = join(s.state, 'profiles', 'work', 'state.db')
    mkdirSync(join(otherPath, '..'), { recursive: true })
    const other = new DatabaseSync(otherPath)
    try {
      other.exec(fixture.schema.join('\n'))
      for (const sql of fixture.inserts) other.exec(sql)
      other.exec("DELETE FROM state_meta WHERE key GLOB 'gateway.local_policy.v1:*'; DELETE FROM session_admissions; UPDATE sessions SET source = 'cli'")
      expect(stateDbSessionSources(otherPath, [sid])?.get(sid)).toBe('cli')
      expect(stateDbSessionSources(join(s.state, 'state.db'), [sid])?.get(sid)).toMatchObject({ canonical: true })
      // The sidecar belongs to work, not the active default home's canonical id.
      const work = new Session({ session_id: sid, profile: 'work', source_tag: 'cli' }, { workspace: join(s.state, 'workspace'), model: 'fixture' })
      expect(s.deps.sessions.isReadOnly(work)).toBe(false)
      expect(s.deps.sessions.wireRow(work)).toMatchObject({ read_only: false })
    } finally { other.close() }
    db.exec("DELETE FROM state_meta WHERE key GLOB 'gateway.local_policy.v1:*'; DELETE FROM session_admissions; UPDATE sessions SET source = 'cli'")
    s.deps.cliSessions.invalidate()
    expect((await post(s, '/api/session/rename', { session_id: sid, title: 'Legacy import' })).status).toBe(200)
    const created = await json(await post(s, '/api/session/new', {}))
    const local = (created.session as Record<string, unknown>).session_id
    expect((await post(s, '/api/session/rename', { session_id: local, title: 'Talaria chat' })).status).toBe(200)
  })

  it('fails closed with a server-owned recovery reason when ownership storage is unreadable', async () => {
    const sid = fixture.sessions.cli!
    s.deps.sessionStore.save(new Session({ session_id: sid, source_tag: 'webui' }, { workspace: s.state, model: null }))
    db.exec('DROP TABLE state_meta; CREATE TABLE state_meta (unrecognized TEXT)')
    const row = await detail(sid)
    expect(row.read_only).toBe(true)
    expect(row.read_only_reason).toContain('could not be verified')
    const refused = await post(s, '/api/session/clear', { session_id: sid })
    expect(refused.status).toBe(403)
    expect(await refused.text()).toContain('could not be verified')
  })

})
