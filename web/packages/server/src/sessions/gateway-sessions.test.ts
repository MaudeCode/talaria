import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextDetailSchema, SessionEnvelopeSchema, ClarifyPendingEnvelopeSchema, ChatEventSchema, type GatewaySnapshot, type GatewaySessionResult } from '@maudecode/talaria-web-contracts'
import type { StreamFrame } from '../sidecar/client.js'
import { bootTestServer, type TestServer, openStateDb } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { CANONICAL_READ_ONLY_REASON, type StateDbWorkerRequest } from './state-db.js'
import { GatewaySessions } from './gateway-sessions.js'
import { TerminalSession } from '../tools/terminal.js'

const fixture = JSON.parse(readFileSync(new URL('../test/fixtures/canonical-ownership.json', import.meta.url), 'utf8')) as { sessions: Record<string, string>; diagnostic: Record<'safe' | 'ignore_config' | 'fresh', string>; schema: string[]; inserts: string[] }
const nativeNotices = JSON.parse(readFileSync(new URL('../../../../../contracts/fixtures/web-native-notices.json', import.meta.url), 'utf8')) as { events: Record<string, unknown>[] }
const ownerEvents = JSON.parse(readFileSync(new URL('../test/fixtures/gateway-owner-events.json', import.meta.url), 'utf8')) as { events: Record<string, unknown>[] }
const cronRefusal = JSON.parse(readFileSync(new URL('../../../../../contracts/fixtures/native-cron-refusal.json', import.meta.url), 'utf8')) as { completion: Record<string, unknown>; event: { event: string; data: Record<string, unknown> } }
const sid = fixture.sessions.cli!
const snapshot = (extra: Partial<GatewaySnapshot> = {}): GatewaySnapshot => ({ session_id: sid, stored_session_id: sid,
  messages: [{ role: 'user', content: 'native question' }, { role: 'assistant', content: 'owner answer' }], message_count: 2,
  running: false, authority_epoch: 1, replay_epoch: 'owner-epoch', last_sequence: 4, subscription_id: 'viewer', revision: 2,
  execution_generation: 1, pending: [], prompts: [], info: { title: 'Native chat', model: 'native-model' }, ...extra })
const attached = (snap: GatewaySnapshot): GatewaySessionResult => ({ state: 'attached', reason: null, receipt: null, snapshot: snap })
const admission = (status: 'queued' | 'started' | 'unknown' | 'terminal' = 'started') => ({ admission_id: 'native-input', sequence: 1, status, outcome: null, authority_epoch: 1, execution_generation: 1, text: 'native work', input_id: 'stable-input' })

describe('gateway sidebar cache', () => {
  let s: TestServer
  let db: DatabaseSync
  let now: number
  const settleDatabase = (): void => {
    for (const path of [join(s.state, 'state.db'), join(s.state, 'state.db-wal')]) if (existsSync(path)) utimesSync(path, 1, 1)
  }
  beforeEach(async () => {
    now = 100
    s = await bootTestServer({ now: () => now, gatewayPollMs: 60_000 })
    db = openStateDb(join(s.state, 'state.db'))
    db.exec(fixture.schema.join('\n'))
    db.prepare('INSERT INTO sessions (id, source, started_at, message_count, title) VALUES (?, ?, ?, ?, ?)').run(sid, 'cli', 100, 2, 'Shared session')
    for (const role of ['user', 'assistant']) db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(sid, role, 'first turn', 101)
    await s.deps.sessionStore.writeIndex([])
  })
  afterEach(async () => { db.close(); await s.close() })

  it('shares one listing worker call between a changed gateway poll and the sidebar list once settled', async () => {
    const watcher = s.deps.gatewayWatchers.get('default')
    const sub = watcher.subscribe()
    expect((await sub.next(AbortSignal.timeout(2000)))?.sessions.some((row) => row.session_id === sid)).toBe(true)
    // Let the initial poll release its in-flight guard before the explicit changed pass.
    await Promise.resolve()
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(sid, 'user', 'another turn', 9999)
    db.prepare('UPDATE sessions SET message_count = 3 WHERE id = ?').run(sid)
    settleDatabase()
    const calls = vi.spyOn(Worker.prototype, 'postMessage')
    try {
      expect(await watcher.pollOnce()).toBe(true)
      const changed = await sub.next(AbortSignal.timeout(2000))
      expect(changed?.sessions.find((row) => row.session_id === sid)).toMatchObject({ message_count: 3 })
      const response = await s.get('/api/sessions?show_cli_sessions=1')
      expect(response.status).toBe(200)
      const body = await response.json() as { sessions: Record<string, unknown>[] }
      expect(body.sessions.find((row) => row.session_id === sid)).toMatchObject({ message_count: 3 })
      const listings = calls.mock.calls.map(([request]) => (request as StateDbWorkerRequest).op).filter((op) => op === 'rows' || op === 'rowBatches')
      expect(listings).toEqual(['rowBatches'])
    } finally {
      calls.mockRestore()
      sub.close()
      watcher.stop()
    }
  })
  it.each(['cli', 'cron'])('retries failed %s row builds without publishing an empty snapshot', async (source) => {
    db.prepare('UPDATE sessions SET source = ? WHERE id = ?').run(source, sid)
    const watcher = s.deps.gatewayWatchers.get('default')
    const sub = watcher.subscribe()
    const metadata = vi.spyOn(s.deps.sessionStore, 'persistedIds')
    try {
      expect((await sub.next(AbortSignal.timeout(2000)))?.sessions.find((row) => row.session_id === sid)).toMatchObject({ message_count: 2 })
      await Promise.resolve()
      now += 5
      db.prepare('UPDATE sessions SET message_count = 3 WHERE id = ?').run(sid)
      settleDatabase()
      metadata.mockRejectedValueOnce(new Error('synthetic sidecar metadata failure'))
      expect(await watcher.pollOnce()).toBe(false)
      const failed = await s.deps.cliSessions.read('default')
      expect(failed.rows).toEqual([])
      expect(failed.storage.state).toBe('ok')
      // The cached failure is still a failed projection, not a successful empty list.
      expect(await watcher.pollOnce()).toBe(false)
      expect(await sub.next(AbortSignal.timeout(20))).toBeNull()
      expect(sub.ended).toBe(false)
      now += 5
      // No further database write: the failed pass must not have acknowledged its fingerprint.
      expect(await watcher.pollOnce()).toBe(true)
      expect((await sub.next(AbortSignal.timeout(2000)))?.sessions.find((row) => row.session_id === sid)).toMatchObject({ message_count: 3 })
    } finally { metadata.mockRestore(); sub.close(); watcher.stop() }
  })
})

describe('canonical owner attachment', () => {
  let s: TestServer
  let db: DatabaseSync
  let sidecar: FakeSidecar
  beforeEach(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
    db = openStateDb(join(s.state, 'state.db'))
    db.exec(fixture.schema.join('\n'))
    for (const sql of fixture.inserts) db.exec(sql)
    await s.deps.settings.save({ show_cli_sessions: true })
  })
  afterEach(async () => { db.close(); await s.close() })
  const post = (path: string, body: unknown) => s.get(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  it('reconciles queue steps through the exact native admission receipt without submitting', async () => {
    sidecar.respond('gateway.session', (params) => {
      expect(params.action).toBe('receipt')
      expect(params.admission_id).toBe('synthetic-queue-admission')
      expect(params.request_id).toBeUndefined()
      return { ...attached(snapshot()), receipt: { ...admission('terminal'), admission_id: 'synthetic-queue-admission', outcome: 'completed' } }
    })
    const result = await s.deps.sessions.owner!.queueReceipt(sid, 'synthetic-queue-admission')
    expect(result?.receipt).toMatchObject({ admission_id: 'synthetic-queue-admission', status: 'terminal', outcome: 'completed' })
    expect(sidecar.calls.some((call) => call.method === 'chat.start')).toBe(false)
  })

  it.each(['unreadable', 'refused'])('never releases a %s native target to the host terminal', async (boundary) => {
    const sources = vi.spyOn(s.deps.sessions, 'stateDbSources').mockResolvedValue(boundary === 'unreadable' ? null : new Map([[sid, { source: 'cli', canonical: true, reason: 'owner unverified' }]]))
    try { await expect(s.deps.sessions.owner!.terminal(sid)).rejects.toMatchObject({ status: boundary === 'unreadable' ? 503 : 403 }) }
    finally { sources.mockRestore() }
  })

  it.each([false, true])('releases the previous Web PTY when selecting native mode (restart=%s)', async (restart) => {
    sidecar.respond('gateway.session', () => attached(snapshot({ info: { cwd: '/frozen/native' } })))
    for (const id of [sid, 'other-host']) {
      const proc = { pid: 4242, write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: vi.fn(), onExit: vi.fn() }
      s.deps.terminals.terminals.set(id, new TerminalSession(id, s.state, proc, () => 100))
    }
    const previous = s.deps.terminals.get(sid)!
    const other = s.deps.terminals.get('other-host')!
    const response = await post('/api/terminal/start', { session_id: sid, restart })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ mode: 'owner_command', running: false })
    expect(s.deps.terminals.get(sid)).toBeNull()
    expect(previous.proc.kill).toHaveBeenCalledWith('SIGHUP')
    expect(previous.closed).toBe(true)
    expect(s.deps.terminals.get('other-host')).toBe(other)
    expect(other.proc.kill).not.toHaveBeenCalled()
  })

  it('offers captured commands for native owners without spawning a Web PTY, and fences execution', async () => {
    let snap = snapshot({ info: { cwd: '/frozen/native' } })
    sidecar.respond('gateway.session', (params) => ({ ...attached(snap), ...(params.action === 'shell_exec' ? { shell: { stdout: 'native output', stderr: 'warning', code: 7 } } : {}) }))
    const spawn = vi.spyOn(s.deps.terminals, 'start')
    const before = db.prepare('SELECT * FROM messages').all()
    const started = await post('/api/terminal/start', { session_id: sid })
    expect(started.status).toBe(200)
    const target = await started.json() as { mode: string; target_key: string }
    expect(target).toMatchObject({ mode: 'owner_command', workspace: '/frozen/native' })
    const body = { session_id: sid, mode: 'owner_command', target_key: target.target_key, command: 'printf native' }
    const result = await post('/api/terminal/exec', body)
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({ stdout: 'native output', stderr: 'warning', code: 7 })
    expect(sidecar.calls.filter((c) => c.method === 'gateway.session' && (c.params as { action?: string }).action === 'shell_exec')).toHaveLength(1)
    snap = snapshot({ authority_epoch: 2 })
    expect((await post('/api/terminal/exec', body)).status).toBe(409)
    expect(spawn).not.toHaveBeenCalled()
    expect(db.prepare('SELECT * FROM messages').all()).toEqual(before)
    expect(await s.deps.sessionStore.persistedIds()).not.toContain(sid)
  })


  it('adds, toggles and removes canonical reactions and reads them on reconnect', async () => {
    let reactions: { author: string; emoji: string }[] = []
    const current = () => snapshot({ reactions_supported: true, messages: [{ role: 'assistant', row_id: 42, content: 'Owner answer', reactions }] })
    sidecar.respond('gateway.session', (params) => {
      if (params.action === 'react') {
        expect(params).not.toHaveProperty('author')
        expect(params.row_id).toBe(42)
        const emoji = params.emoji
        reactions = emoji && reactions[0]?.emoji !== emoji ? [{ author: 'user', emoji }] : []
      }
      return attached(current())
    })
    const detail = async () => SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json()).session
    expect((await detail()).messages?.[0]?.reaction_view).toMatchObject({ row_id: 42, state: { items: [], selected: null } })
    for (const [emoji, count] of [['👍', 1], ['👍', 0], ['❤️', 1], [null, 0]] as const) {
      const response = await post('/api/chat/owner-action', { session_id: sid, action: 'react', row_id: 42, emoji })
      expect(response.status).toBe(200)
      expect((await detail()).messages?.[0]?.reaction_view).toMatchObject({ state: { items: count ? [{ emoji, count: 1, mine: true }] : [] } })
    }
    expect(sidecar.calls.some((c) => c.method === 'chat.start')).toBe(false)
  })

  it('refuses foreign rows, forged authors and malformed reactions without owner mutation', async () => {
    sidecar.respond('gateway.session', () => attached(snapshot({ reactions_supported: true, messages: [{ role: 'assistant', row_id: 42, content: 'answer', reactions: [] }] })))
    const request = { session_id: sid, action: 'react', row_id: 42, emoji: '👍' }
    for (const extra of [{ row_id: 99 }, { author: 'agent' }, { emoji: 'not an emoji' }, { row_id: -1 }]) {
      expect((await post('/api/chat/owner-action', { ...request, ...extra })).status).toBeGreaterThanOrEqual(400)
    }
    expect(sidecar.calls.filter((c) => c.method === 'gateway.session' && (c.params as { action: string }).action === 'react')).toEqual([])
  })

  it('reads back an ambiguous reaction without replaying the toggle', async () => {
    let writes = 0
    sidecar.respond('gateway.session', (params) => {
      if (params.action === 'react') { writes++; throw new Error('ACK lost after write') }
      return attached(snapshot({ reactions_supported: true, messages: [{ role: 'assistant', row_id: 42, content: 'answer', reactions: writes ? [{ author: 'user', emoji: '👍' }] : [] }] }))
    })
    const response = await post('/api/chat/owner-action', { session_id: sid, action: 'react', row_id: 42, emoji: '👍' })
    expect(response.status).toBe(200)
    expect(writes).toBe(1)
    expect((await response.json() as { session: { messages: { reaction_view: unknown }[] } }).session.messages[0]?.reaction_view).toMatchObject({ state: { selected: '👍' } })
  })

  it('deduplicates owner authors and keeps older owners and foreign profiles read only', async () => {
    let supported = true
    sidecar.respond('gateway.session', () => attached(snapshot({ reactions_supported: supported, messages: [{ role: 'assistant', row_id: 42, content: 'answer', reactions: [{ author: 'user', emoji: '👍' }, { author: 'user', emoji: '👍' }, { author: 'agent', emoji: '👍' }] }] })))
    const detail = async () => SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json()).session
    expect((await detail()).messages?.[0]?.reaction_view?.state.items).toEqual([{ emoji: '👍', count: 2, mine: true }])
    supported = false
    expect((await detail()).messages?.[0]?.reaction_view?.actions).toEqual([])
    sidecar.calls.length = 0
    expect((await s.get('/api/chat/owner-action', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'hermes_profile=work' }, body: JSON.stringify({ session_id: sid, action: 'react', row_id: 42, emoji: '👍' }) })).status).toBe(403)
    expect(sidecar.calls.filter((c) => c.method === 'gateway.session')).toEqual([])
  })

  it.each(['epoch', 'replay', 'model', 'workspace'])('rejects a stale rendered context identity after native %s replacement', async (change) => {
    const detail = ContextDetailSchema.parse((JSON.parse(readFileSync(new URL('../../../contracts/fixtures/sidecar/context-detail.json', import.meta.url), 'utf8')) as Record<string, { result: unknown }[]>)['chat.context_detail']![0]!.result)
    let current = snapshot()
    sidecar.respond('gateway.session', () => ({ ...attached(current), context_detail: detail }))
    const row = await s.deps.sessions.detail(sid, {})
    if (change === 'epoch') current = snapshot({ authority_epoch: 2 })
    else if (change === 'replay') current = snapshot({ replay_epoch: 'successor' })
    else current = snapshot({ info: { ...current.info, [change === 'model' ? 'model' : 'cwd']: 'replacement' } })
    const res = await s.get(`/api/session/context-detail?session_id=${sid}&context_detail_key=${String(row.context_detail_key)}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ available: false, reason: 'changed', files: [] })
  })

  it('context metadata uses the native authorized action without resident fallback', async () => {
    const detail = ContextDetailSchema.parse((JSON.parse(readFileSync(new URL('../../../contracts/fixtures/sidecar/context-detail.json', import.meta.url), 'utf8')) as Record<string, { result: unknown }[]>)['chat.context_detail']![0]!.result)
    sidecar.respond('gateway.session', (params) => {
      expect(['snapshot', 'context_detail']).toContain(params.action)
      expect(params.session_id).toBe(sid)
      return { ...attached(snapshot()), context_detail: detail }
    })
    const row = await s.deps.sessions.detail(sid, {})
    const res = await s.get(`/api/session/context-detail?session_id=${sid}&context_detail_key=${String(row.context_detail_key)}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(detail)
    expect(sidecar.calls.some((c) => c.method === 'chat.context_detail' || c.method === 'chat.start')).toBe(false)
  })

  it.each(['high', ''])('refuses native reasoning effort %j without touching profile bytes or dispatching a control', async (effort) => {
    const path = join(s.state, 'config.yaml')
    const bytes = '# synthetic profile\nagent:\n  reasoning_effort: low\n'
    writeFileSync(path, bytes)
    sidecar.respond('config.get', () => ({ path, exists: true, config: { agent: { reasoning_effort: 'low' } } }))
    sidecar.respond('config.set', (params) => { writeFileSync(path, JSON.stringify(params.config)); return { ok: true, path } })
    for (const state of ['attached', 'unavailable'] as const) {
      sidecar.respond('gateway.session', () => state === 'attached' ? attached(snapshot()) : { state, reason: 'owner_unavailable', snapshot: null, receipt: null })
      const start = sidecar.calls.length
      const response = await post('/api/reasoning', { session_id: sid, effort })
      expect.soft(response.status).toBe(409)
      expect.soft(await response.json()).toMatchObject({ code: 'reasoning_unsupported' })
      expect.soft(readFileSync(path, 'utf8')).toBe(bytes)
      expect.soft(sidecar.calls.slice(start).filter((c) => c.method === 'config.set' || c.method === 'gateway.session')).toEqual([])
    }
  })

  it('restores a native session config warning without admitting or starting a turn', async () => {
    sidecar.respond('gateway.session', () => attached(snapshot({ info: { config_warning: 'Project plugins were skipped' } })))
    const source = vi.spyOn(s.deps.sessions, 'stateDbSources').mockResolvedValue(new Map([[sid, { source: 'cli', canonical: true }]]))
    try {
      const detail = await s.deps.sessions.owner!.project({ session_id: sid, title: 'Native chat', read_only_reason: CANONICAL_READ_ONLY_REASON })
      expect(detail.notices).toEqual([expect.objectContaining({ level: 'warn', text: 'Project plugins were skipped', expires_at: null })])
      expect(detail.active_stream_id).toBeNull()
      expect(detail.agent_running).toBe(false)
      expect(sidecar.calls.some((call) => call.method === 'chat.start')).toBe(false)
    } finally { source.mockRestore() }
  })

  it('cancels the initial owner snapshot when its viewer disconnects before attachment', async () => {
    const controller = new AbortController()
    const source = vi.spyOn(s.deps.sessions, 'stateDbSources').mockResolvedValue(new Map([[sid, { source: 'cli', canonical: true }]]))
    const detail = vi.spyOn(s.deps.sessions, 'detail').mockResolvedValue({ session_id: sid, title: 'Native chat' })
    let received: AbortSignal | undefined
    let release!: (result: GatewaySessionResult) => void
    const snapshotRead = new Promise<GatewaySessionResult>((resolve) => { release = resolve })
    sidecar.respond('gateway.session', (_params, _emit, opts) => { received = opts.signal; return snapshotRead })
    const viewing = s.deps.sessions.owner!.observe(sid, 'default', controller.signal)
    try {
      await vi.waitFor(() => { expect(sidecar.calls.some((call) => call.method === 'gateway.session')).toBe(true) })
      controller.abort()
      expect(received).toBe(controller.signal)
      release(attached(snapshot()))
      expect(await viewing).toBeNull()
      expect(sidecar.calls.some((call) => call.method === 'gateway.session' && (call.params as { action: string }).action === 'watch')).toBe(false)
    } finally { controller.abort(); release(attached(snapshot())); await viewing; source.mockRestore(); detail.mockRestore() }
  })

  it('claims the HTTP stream slot and validates visibility before attaching a native viewer', async () => {
    sidecar.calls.length = 0
    expect((await s.get('/api/session/stream?session_id=bad%2Fsession')).status).toBe(404)
    const claim = vi.spyOn(s.deps.streamSlots, 'claim').mockReturnValue(null)
    try { expect((await s.get(`/api/session/stream?session_id=${sid}`)).status).toBe(503) }
    finally { claim.mockRestore() }
    expect(sidecar.calls.filter((call) => call.method === 'gateway.session')).toEqual([])
    expect(s.deps.channels.subscriberCount(sid)).toBe(0)
  })

  it('keeps a settling native stream attachable while its activity phase is reconciled (TAL-1520)', async () => {
    let emit: ((frame: Omit<StreamFrame, 'seq'>) => void) | undefined
    let snap = snapshot({ running: true, pending: [admission()] })
    sidecar.respond('gateway.session', (params, send, opts) => {
      if (params.action !== 'watch') return { ...attached(snap), receipt: params.action === 'receipt' ? { ...admission('terminal'), outcome: 'completed' } : null }
      emit = send
      send({ event: 'snapshot', data: attached(snap) })
      return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached(snap)) }, { once: true }) })
    })
    const activity = s.deps.sessions.deps.sessionActivity!
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const held = new Promise<void>((resolve) => { entered = resolve })
    s.deps.sessions.deps.sessionActivity = async (...args) => {
      if (args[2]?.terminalPhase) { entered(); await gate }
      return activity(...args)
    }
    try {
      await s.deps.sessions.detail(sid, {})
      await vi.waitFor(() => { expect(emit).toBeDefined(); expect(s.deps.registry.activeRunStreamForSession(sid)).not.toBeNull() })
      const stream = s.deps.registry.activeRunStreamForSession(sid)!
      snap = snapshot({ last_sequence: 7 })
      emit!({ event: 'event', data: { type: 'session.info', payload: { authority_epoch: 1, execution_generation: 1, running: false, pending: [] } } })
      await held
      const channel = s.deps.registry.peek(stream)
      expect(channel, 'a settling stream remains attachable until terminal frames are ready').toBeDefined()
      const read = s.sse(`/api/chat/stream?stream_id=${stream}&replay=1&after_seq=0`, (frame) => frame.event === 'stream_end')
      await vi.waitFor(() => { expect(channel!.subscriberCount).toBe(1) })
      release()
      const frames = await read
      expect(frames.filter((frame) => frame.event === 'done' || frame.event === 'stream_end').map((frame) => frame.event)).toEqual(['done', 'stream_end'])
    } finally { release(); s.deps.sessions.deps.sessionActivity = activity }
  })

  it('shares idle native observation between viewers and delivers keyed edits after a turn settles', async () => {
    let emit: ((frame: Omit<StreamFrame, 'seq'>) => void) | undefined
    let aborted = false
    let snap = snapshot({ info: { config_warning: 'Launch warning' } })
    sidecar.respond('gateway.session', (params, send, opts) => {
      if (params.action !== 'watch') return { ...attached(snap), receipt: params.action === 'receipt' ? { ...admission('terminal'), outcome: 'completed' } : null }
      emit = send
      send({ event: 'snapshot', data: attached(snap) })
      return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { aborted = true; resolve(attached(snap)) }, { once: true }) })
    })
    let viewers = 0
    const streams = [0, 1].map((index) => s.sse(`/api/session/stream?session_id=${sid}`, (frame) => {
      if (frame.event === 'initial') viewers++
      return frame.event === 'test-end' || index === 0 && frame.event === 'test-first'
    }))
    const detail = async () => SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json()).session
    const notice = (seq: number, text: string, stamps: Record<string, unknown> = {}) => { emit!({ event: 'event', data: {
      type: 'notification.show', session_id: sid, replay_epoch: snap.replay_epoch, seq, payload: { key: 'plugin-message:fixture:job', text, level: 'success' }, ...stamps,
    } }) }
    try {
      await vi.waitFor(() => { expect(viewers).toBe(2) }, { timeout: 10_000 })
      await vi.waitFor(() => { expect(sidecar.calls.filter((call) => call.method === 'gateway.session' && (call.params as { action: string }).action === 'watch')).toHaveLength(1) }, { timeout: 10_000 })
      await vi.waitFor(() => { expect(emit).toBeDefined() })
      expect(s.deps.registry.activeRunStreamForSession(sid)).toBeNull()
      for (const event of nativeNotices.events) emit!({ event: 'event', data: event })
      notice(5, 'Plugin started')
      notice(6, 'Plugin finished')
      notice(6, 'Duplicate replay must not replace the edit')
      notice(7, 'Other session', { session_id: 'other-session' })
      await vi.waitFor(async () => { expect((await detail()).notices).toEqual([expect.objectContaining({ text: 'Launch warning' }), expect.objectContaining({ text: 'Plugin finished', level: 'success' })]) })
      expect((await detail()).is_streaming).toBe(false)
      snap = snapshot({ running: true, pending: [admission()], last_sequence: 6 })
      emit!({ event: 'snapshot', data: attached(snap) })
      await vi.waitFor(() => { expect(s.deps.registry.activeRunStreamForSession(sid)).not.toBeNull() })
      const stream = s.deps.registry.activeRunStreamForSession(sid)!
      const run = s.sse(`/api/chat/stream?stream_id=${stream}&replay=1&after_seq=0`, (frame) => frame.event === 'stream_end')
      snap = snapshot({ last_sequence: 7 })
      emit!({ event: 'event', data: { type: 'session.info', payload: { authority_epoch: 1, execution_generation: 1, running: false, pending: [] } } })
      const frames = await run
      expect(frames.some((frame) => frame.event === 'done')).toBe(true)
      const projections = frames.filter((frame) => frame.event === 'session_snapshot' || frame.event === 'done').map((frame) => (frame.data as { session: { notices: { text: string }[] } }).session.notices)
      expect(projections.length).toBeGreaterThan(0)
      for (const notices of projections) expect(notices.filter((notice) => notice.text === 'Launch warning')).toHaveLength(1)
      await vi.waitFor(() => { expect(s.deps.registry.activeRunStreamForSession(sid)).toBeNull() })
      expect(aborted).toBe(false)
      notice(8, 'Idle edit after completion')
      await vi.waitFor(async () => { expect((await detail()).notices?.map((notice) => notice.text)).toEqual(['Launch warning', 'Idle edit after completion']) })
      s.deps.channels.emit(sid, 'test-first', {})
      expect((await streams[0]!).some((frame) => frame.event === 'session-updated')).toBe(true)
      expect(aborted).toBe(false)
      expect(sidecar.calls.filter((call) => call.method === 'gateway.session' && (call.params as { action: string }).action === 'watch')).toHaveLength(1)
    } finally { s.deps.channels.emit(sid, 'test-end', {}); await Promise.all(streams) }
    for (const frames of await Promise.all(streams)) expect(frames.some((frame) => frame.event === 'session-updated')).toBe(true)
    await vi.waitFor(() => { expect(aborted).toBe(true) })
    expect(sidecar.calls.some((call) => call.method === 'chat.start')).toBe(false)
  })

  it('resets only native notices on an owner epoch or replay gap and rejects late old frames', async () => {
    let emit!: (frame: Omit<StreamFrame, 'seq'>) => void
    let snap = snapshot({ info: { config_warning: 'Launch warning' } })
    sidecar.respond('gateway.session', (params, send, opts) => {
      if (params.action !== 'watch') return attached(snap)
      emit = send
      send({ event: 'snapshot', data: attached(snap) })
      return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached(snap)) }, { once: true }) })
    })
    const controller = new AbortController()
    const lease = await s.deps.sessions.owner!.observe(sid, 'default', controller.signal)
    const base = { session_id: sid, read_only_reason: CANONICAL_READ_ONLY_REASON, notices: [{ key: 'unrelated', text: 'Direct notice', level: 'info', expires_at: null }] }
    const direct = vi.spyOn(s.deps.sessions.deps.runtime, 'sessionNotices').mockReturnValue([{ key: 'unrelated', text: 'Direct notice', level: 'info', expires_at: null }])
    const detail = () => s.deps.sessions.owner!.project(base)
    try {
      await vi.waitFor(() => { expect(emit).toBeDefined() })
      const event = (type: string, seq: number, epoch = snap.replay_epoch) => { emit({ event: 'event', data: { type, seq, session_id: sid, replay_epoch: epoch, payload: { key: 'plugin', text: 'Plugin notice' } } }) }
      event('notification.show', 5)
      const projected = await detail()
      expect(projected.notices).toHaveLength(3)
      event('notification.clear', 6)
      expect((await detail()).notices).toHaveLength(2)
      expect((await s.deps.sessions.owner!.project(projected)).notices).toHaveLength(2)
      event('notification.show', 7)
      emit({ event: 'snapshot', data: { ...attached(snap), replay_gap: true } })
      expect((await detail()).notices).toEqual([base.notices[0], expect.objectContaining({ text: 'Launch warning' })])
      snap = snapshot({ authority_epoch: 2, replay_epoch: 'replacement', info: { config_warning: 'Replacement warning' } })
      emit({ event: 'snapshot', data: attached(snap) })
      event('notification.show', 100, 'owner-epoch')
      expect((await detail()).notices).toEqual([base.notices[0], expect.objectContaining({ text: 'Replacement warning' })])
      event('notification.show', 1)
      expect((await detail()).notices).toHaveLength(3)
    } finally { controller.abort(); lease?.release(); await lease?.ended; direct.mockRestore() }
  })

  it('isolates idle transports and channels by profile/session and reattaches after disconnect', async () => {
    const home = join(s.state, 'profiles', 'work')
    mkdirSync(home, { recursive: true })
    const other = openStateDb(join(home, 'state.db'))
    other.exec(fixture.schema.join('\n'))
    for (const sql of fixture.inserts) other.exec(sql)
    const connections = new Map<string, { send: (frame: Omit<StreamFrame, 'seq'>) => void; stop: () => void; signal: AbortSignal }>()
    sidecar.respond('gateway.session', (params, send, opts) => {
      const snap = snapshot({ session_id: params.session_id, stored_session_id: params.session_id, info: { config_warning: 'Restored warning' } })
      if (params.action !== 'watch') return attached(snap)
      return new Promise((resolve) => {
        connections.set(JSON.stringify([params.profile_home, params.session_id]), { send, stop: () => { resolve(attached(snap)) }, signal: opts.signal! })
        opts.signal!.addEventListener('abort', () => { resolve(attached(snap)) }, { once: true })
        send({ event: 'snapshot', data: attached(snap) })
      })
    })
    const held: { controller: AbortController; lease: Awaited<ReturnType<GatewaySessions['observe']>> }[] = []
    const subs = [['default', sid], ['work', sid], ['default', fixture.sessions.tui!]].map(([profile, session]) => ({ profile: profile!, sid: session!, sub: s.deps.channels.subscribe(session!, profile) }))
    try {
      for (const item of subs) {
        const controller = new AbortController()
        const lease = await s.deps.sessions.owner!.observe(item.sid, item.profile, controller.signal)
        held.push({ controller, lease })
      }
      await vi.waitFor(() => { expect(connections.size).toBe(3) })
      for (const item of subs) item.sub.queue.length = 0
      const key = JSON.stringify([s.state, sid])
      const first = connections.get(key)!
      const event = { type: 'notification.show', session_id: sid, replay_epoch: 'owner-epoch', seq: 5, payload: { key: 'same-plugin-key', text: 'Root only' } }
      first.send({ event: 'event', data: event })
      expect(subs.map((item) => item.sub.queue.length)).toEqual([1, 0, 0])
      for (const [index, item] of subs.entries()) {
        const view = await s.deps.sessions.owner!.project({ session_id: item.sid, profile: item.profile, read_only_reason: CANONICAL_READ_ONLY_REASON })
        expect((view.notices as { text: string }[]).map((notice) => notice.text)).toEqual(index === 0 ? ['Restored warning', 'Root only'] : ['Restored warning'])
      }
      first.stop()
      await held[0]!.lease!.ended
      const controller = new AbortController()
      const lease = await s.deps.sessions.owner!.observe(sid, 'default', controller.signal)
      held.push({ controller, lease })
      await vi.waitFor(() => { expect(connections.get(key)).not.toBe(first) })
      first.send({ event: 'event', data: { ...event, seq: 100, payload: { ...event.payload, text: 'Late detached frame' } } })
      connections.get(key)!.send({ event: 'event', data: event })
      const view = await s.deps.sessions.owner!.project({ session_id: sid, read_only_reason: CANONICAL_READ_ONLY_REASON })
      expect((view.notices as { text: string }[]).map((notice) => notice.text)).toEqual(['Restored warning', 'Root only'])
      expect(sidecar.calls.filter((call) => call.method === 'gateway.session' && (call.params as { action: string }).action === 'watch')).toHaveLength(4)
    } finally {
      for (const item of held) { item.controller.abort(); item.lease?.release() }
      await Promise.all(held.flatMap((item) => item.lease ? [item.lease.ended] : []))
      for (const item of subs) s.deps.channels.unsubscribe(item.sid, item.sub)
      other.close()
    }
    for (const connection of connections.values()) expect(connection.signal.aborted).toBe(true)
  })

  it('reads native checkpoint diffs through the owner without touching host checkpoints', async () => {
    const comparison = { provenance: 'native_owner', baseline: 'earliest_retained_project_checkpoint', available: true, reason: null, truncated: false } as const
    sidecar.respond('gateway.session', () => ({ state: 'attached', reason: null, snapshot: null, receipt: null,
      checkpoint_diff: { comparison, stat: '1 file changed', diff: 'diff --git a/old.txt b/old.txt\n--- a/old.txt\n+++ b/old.txt\n@@ -1 +1 @@\n-before\n+after\n' } }))
    for (const path of ['list', 'diff']) {
      const res = await s.get(`/api/rollback/${path}?session_id=${sid}`)
      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      const diff = path === 'list' ? body.session_diff : body
      expect(diff).toMatchObject({ comparison, files_changed: [{ file: 'old.txt', status: 'modified' }], total_changes: 1 })
    }
    expect(sidecar.calls.filter((c) => c.method.startsWith('checkpoints.'))).toEqual([])
    expect(sidecar.calls.filter((c) => c.method === 'gateway.session').every((c) => (c.params as Record<string, unknown>).action === 'checkpoint_diff')).toBe(true)
    expect((await post('/api/rollback/restore', { session_id: sid, checkpoint: 'earliest-retained' })).status).toBe(409)
    expect((await s.get(`/api/rollback/diff?session_id=${sid}`, { headers: { cookie: 'hermes_profile=work' } })).status).toBe(404)
  })

  it.each(['stopped', 'refused', 'oversized'] as const)('keeps a native checkpoint read unavailable on %s without host fallback', async (failure) => {
    sidecar.respond('gateway.session', () => failure === 'oversized'
      ? { state: 'attached', reason: null, snapshot: null, receipt: null, checkpoint_diff: {
        diff: '\u0001'.repeat(700_000), stat: '', comparison: { provenance: 'native_owner', baseline: 'earliest_retained_project_checkpoint', available: true, reason: null, truncated: false },
      } }
      : { state: failure, reason: 'owner refused', snapshot: null, receipt: null })
    const res = await s.get(`/api/rollback/diff?session_id=${sid}&workspace=${encodeURIComponent(s.state)}&checkpoint=unrelated-host-hash`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ diff: '', files_changed: [], comparison: { available: false, reason: failure === 'oversized' ? 'payload_too_large' : 'owner_unavailable' } })
    expect(sidecar.calls.filter((c) => c.method.startsWith('checkpoints.'))).toEqual([])
  })

  it.each(['json', 'markdown', 'html'] as const)('hides owner reasoning before rendering %s exports (TAL-996)', async (format) => {
    writeFileSync(join(s.state, 'config.yaml'), '# synthetic preference\n')
    sidecar.respond('config.get', () => ({ path: join(s.state, 'config.yaml'), exists: true, config: { display: { platforms: { webui: { show_reasoning: false } } } } }))
    sidecar.respond('gateway.session', (params) => {
      expect(params).toMatchObject({ action: 'export', format: 'json' })
      return { state: 'attached', reason: null, snapshot: null, receipt: null, export: { format: 'json', filename: 'owner.json', content: JSON.stringify({ messages: [
        { role: 'assistant', content: '<thinking>PRIVATE_NATIVE_THOUGHT</thinking>Public answer', reasoning: 'PRIVATE_NATIVE_THOUGHT', _display: 'row' },
      ] }) } }
    })
    const res = await s.get(`/api/session/export?session_id=${sid}&format=${format}`)
    expect(res.status).toBe(200)
    const content = await res.text()
    expect(content).toContain('Public answer')
    expect(content).not.toContain('PRIVATE_NATIVE_THOUGHT')
  })

  it.each(['json', 'markdown', 'html'] as const)('exports a canonical owner without a local session as %s', async (format) => {
    const content = format === 'json' ? JSON.stringify({ messages: [{ role: 'user', content: 'Current owner transcript' }] })
      : format === 'html' ? '<h1>Current owner transcript</h1>' : '# Current owner transcript'
    sidecar.respond('gateway.session', () => ({ state: 'attached', reason: null, snapshot: null, receipt: null,
      export: { format, filename: '../../unsafe\r\nname', content } }))
    const res = await s.get(`/api/session/export?session_id=${sid}&format=${format}&redact=false`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Current owner transcript')
    expect(res.headers.get('content-disposition')).not.toMatch(/[\r\n/]/)
    expect(sidecar.calls.filter((call) => call.method === 'gateway.session')).toEqual([
      { method: 'gateway.session', params: { profile_home: s.state, session_id: sid, action: 'export', format, redact: true } },
    ])
    expect(await s.deps.sessionStore.persistedIds()).toEqual(new Set())
  })

  it.each(['json', 'markdown', 'html'] as const)('applies the server redaction policy to owner %s exports', async (format) => {
    const secret = 'sk-synthetic-export-private-key-123456789012345'
    const raw = `OPENAI_API_KEY=${secret}`
    const content = format === 'json' ? JSON.stringify({ messages: [{ role: 'user', content: raw }], api_key: secret })
      : format === 'html' ? `<p>${raw}</p>` : raw
    sidecar.respond('gateway.session', (params) => ({ state: 'attached', reason: null, snapshot: null, receipt: null,
      export: { format, filename: 'owner', content: params.redact ? (format === 'html' ? content.replace(secret, '***') : content) : format === 'json' ? JSON.stringify({ title: 'policy disabled' }) : 'policy disabled' } }))
    const res = await s.get(`/api/session/export?session_id=${sid}&format=${format}&redact=false`)
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain(secret)
    await s.deps.settings.save({ api_redact_enabled: false })
    const unredacted = await s.get(`/api/session/export?session_id=${sid}&format=${format}`)
    expect(unredacted.status).toBe(200)
    expect(await unredacted.text()).toContain('policy disabled')
  })

  it('preserves owner HTML already redacted before rendering', async () => {
    const content = '<!DOCTYPE html><html><body><div class="layout"><div class="message">OPENAI_API_KEY=***</div></div></body></html>'
    sidecar.respond('gateway.session', (params) => {
      expect(params.redact).toBe(true)
      return { state: 'attached', reason: null, snapshot: null, receipt: null, export: { format: 'html', filename: 'owner.html', content } }
    })
    const response = await s.get(`/api/session/export?session_id=${sid}&format=html`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(content)
  })

  it.each(['unsupported', 'timeout', 'missing', 'format', 'oversize', 'malformed'] as const)('refuses an owner export on %s without a local fallback', async (failure) => {
    const call = vi.spyOn(sidecar, 'call')
    sidecar.respond('gateway.session', () => {
      if (failure === 'timeout') throw new Error('timeout')
      if (failure === 'unsupported') return { state: 'incompatible', reason: 'native_sessions_unavailable', snapshot: null, receipt: null }
      return { state: 'attached', reason: null, snapshot: null, receipt: null,
        ...(failure === 'missing' ? {} : { export: { format: failure === 'format' ? 'html' : 'json', filename: 'owner.json',
          content: failure === 'oversize' ? '界'.repeat(1_500_000) : 'not JSON' } }) }
    })
    const res = await s.get(`/api/session/export?session_id=${sid}`)
    expect(res.status).toBe(failure === 'oversize' ? 413 : 409)
    expect(await res.text()).not.toContain('not JSON')
    expect(call).toHaveBeenCalledWith('gateway.session', expect.objectContaining({ action: 'export' }), { timeoutMs: 35_000 })
    expect(await s.deps.sessionStore.persistedIds()).toEqual(new Set())
  })

  it.each(['md', 'legacy-unknown'])('normalizes legacy format %s to one closed owner JSON request', async (format) => {
    sidecar.respond('gateway.session', (params) => {
      expect(params).toMatchObject({ action: 'export', format: 'json', redact: true })
      return { state: 'attached', reason: null, snapshot: null, receipt: null,
        export: { format: 'json', filename: 'owner.json', content: JSON.stringify({ messages: [], title: 'Current owner' }) } }
    })
    const res = await s.get(`/api/session/export?session_id=${sid}&format=${format}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await res.json()).toMatchObject({ title: 'Current owner' })
    expect(sidecar.calls.filter((call) => call.method === 'gateway.session')).toHaveLength(1)
    expect(await s.deps.sessionStore.persistedIds()).toEqual(new Set())
  })

  it('authorizes the profile before contacting the export owner', async () => {
    expect((await s.get(`/api/session/export?session_id=${sid}`, { headers: { cookie: 'hermes_profile=work' } })).status).toBe(404)
    expect(sidecar.calls.filter((call) => call.method === 'gateway.session')).toEqual([])
    const locked = await bootTestServer({ sidecar, env: { HERMES_WEBUI_PASSWORD: 'synthetic-export-password' } })
    try {
      expect((await locked.get(`/api/session/export?session_id=${sid}`)).status).toBe(401)
      expect(sidecar.calls.filter((call) => call.method === 'gateway.session')).toEqual([])
    } finally { await locked.close() }
  })

  it('projects only owner controls and never groups the active turn under a steering row', async () => {
    const pending = [
      { ...admission(), admission_id: 'steering', steering: true, text: 'Correction' },
      { ...admission(), admission_id: 'running', steering: false, text: 'Original task' },
      { ...admission('queued'), admission_id: 'editable', controls: ['steer', 'replace', 'future-control'] },
      { ...admission('queued'), admission_id: 'legacy' },
    ]
    const snap = snapshot({ running: true, messages: [], message_count: 0, pending })
    sidecar.respond('gateway.session', (params, _emit, opts) => params.action === 'watch'
      ? new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached(snap)) }, { once: true }) }) : attached(snap))
    const result = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json()).session
    expect(result.owner_attachment?.admissions).toMatchObject([
      { admission_id: 'editable', actions: ['cancel', 'steer', 'edit'] },
      { admission_id: 'legacy', actions: ['cancel'] },
    ])
    expect(result.owner_attachment?.active_admission).toMatchObject({ admission_id: 'running', steering: false })
    expect(result.messages).toEqual([expect.objectContaining({ content: 'Original task', message_id: 'running' })])
  })

  it.each(['steer_queued', 'replace_queued'] as const)('routes %s with stable ids and surfaces owner refusals', async (action) => {
    const request = { session_id: sid, action, admission_id: 'queued-native',
      ...(action === 'replace_queued' ? { submission_id: 'stable-edit', text: 'Edited prompt' } : {}) }
    sidecar.respond('gateway.session', () => attached(snapshot()))
    for (let i = 0; i < 2; i++) expect((await post('/api/chat/owner-action', request)).status).toBe(200)
    expect(sidecar.calls.filter((c) => c.method === 'gateway.session' && (c.params as { action: string }).action === action).map((c) => c.params)).toEqual([
      { ...request, profile_home: s.state }, { ...request, profile_home: s.state },
    ])
    for (const reason of ['steer_unavailable', 'admission_started', 'unsupported_control']) {
      sidecar.respond('gateway.session', () => ({ state: 'refused', reason, snapshot: null, receipt: null }))
      const response = await post('/api/chat/owner-action', request)
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ owner_attachment: { state: 'refused', reason } })
    }
    expect(sidecar.calls.some((c) => c.method === 'chat.start')).toBe(false)
  })

  /** Own one synthetic owner connection and exercise its actual journalled SSE projection. */
  const observeOwner = async (initial: GatewaySnapshot, profile = 'default') => {
    let snap = initial
    let outcome = 'completed'
    let emit: ((frame: Omit<StreamFrame, 'seq'>) => void) | undefined
    const original = sidecar.responderFor('gateway.session')
    const headers = { cookie: `hermes_profile=${profile}` }
    sidecar.respond('gateway.session', (params, send, opts) => {
      if (params.session_id !== initial.session_id || params.profile_home !== s.deps.profileHome(profile)) return original!(params, send, opts)
      if (params.action !== 'watch') return { ...attached(snap), receipt: params.action === 'receipt' ? { ...admission('terminal'), admission_id: params.admission_id!, execution_generation: snap.execution_generation, authority_epoch: snap.authority_epoch, outcome } : null }
      emit = send
      send({ event: 'snapshot', data: attached(snap) })
      return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached(snap)) }, { once: true }) })
    })
    const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${initial.session_id}`, { headers })).json())
    const stream = row.session.active_stream_id!
    const read = s.sse(`/api/chat/stream?stream_id=${stream}&replay=1&after_seq=0`, (frame) => frame.event === 'stream_end' || frame.event === 'apperror', { headers })
    await vi.waitFor(() => { expect(s.deps.registry.peek(stream)?.subscriberCount).toBe(1) })
    return { stream, read, get attached() { return Boolean(emit) },
      event: (type: string, payload: Record<string, unknown>, generation = snap.execution_generation, stamps: Record<string, unknown> = {}) => {
        emit!({ event: 'event', data: { type, payload, authority_epoch: snap.authority_epoch, replay_epoch: snap.replay_epoch, execution_generation: generation, session_id: snap.session_id, ...stamps } })
      },
      snapshot: (extra: Partial<GatewaySnapshot>, replayGap = false, notify = true) => {
        snap = { ...snap, ...extra }
        if (notify) emit!({ event: 'snapshot', data: { ...attached(snap), replay_gap: replayGap } })
      },
      reactionSnapshot: () => { emit!({ event: 'snapshot', data: { ...attached({ ...snap, running: false, pending: [] }), reaction_only: true } }) },
      replaySnapshot: () => { emit!({ event: 'snapshot', data: { ...attached(snap), replaying: true } }) },
      replayComplete: (terminalOutcome: string) => { outcome = terminalOutcome; emit!({ event: 'replay_complete', data: {} }) },
      finish: (generation = snap.execution_generation, terminalOutcome = 'completed') => {
        outcome = terminalOutcome
        snap = { ...snap, execution_generation: generation, running: false, pending: [] }
        emit!({ event: 'event', data: { type: 'session.info', payload: { authority_epoch: snap.authority_epoch, execution_generation: generation, running: false, pending: [] } } })
      },
    }
  }

  describe('native todo state (TAL-1314)', () => {
    const todoFixture = JSON.parse(readFileSync(new URL('../../../../../contracts/fixtures/web-native-todos.json', import.meta.url), 'utf8')) as { owner: Record<string, unknown>; public: Record<string, unknown> }
    const raw = todoFixture.owner
    const display = todoFixture.public
    const withTodo = (todo: unknown, extra: Partial<GatewaySnapshot> = {}) => snapshot({ ...extra, todo_state: todo } as Partial<GatewaySnapshot>)
    const detail = async () => SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json()).session

    it('restores owner todos on attach before a new tool call and clears explicit null or empty state', async () => {
      let snap = withTodo(raw)
      sidecar.respond('gateway.session', () => attached(snap))
      expect((await detail()).todo_state).toMatchObject(display)
      for (const clear of [null, { todos: [], revision: 4 }]) {
        snap = withTodo(clear, { last_sequence: 5 })
        expect((await detail()).todo_state).toMatchObject({ todos: [], display_items: [], total_count: 0 })
      }
      snap = snapshot({ messages: [{ role: 'tool', content: JSON.stringify(raw) }] })
      expect((await detail()).todo_state).toMatchObject(display)
      expect(sidecar.calls.some((call) => call.method === 'chat.start')).toBe(false)
    })

    it('streams a full normalized update from another viewer and rejects duplicate or stale owner events', async () => {
      const watch = await observeOwner(withTodo(null, { running: true, pending: [admission()] }))
      watch.event('todo.updated', raw, 1, { seq: 5 })
      for (const stamps of [{ seq: 5 }, { seq: 4 }, { seq: 6, session_id: 'other' }, { seq: 6, replay_epoch: 'obsolete' }, { seq: 6, authority_epoch: 9 }, { seq: 6, execution_generation: 0 }])
        watch.event('todo.updated', { todos: [{ content: 'Stale task' }], revision: 99 }, 1, stamps)
      await vi.waitFor(async () => { expect((await detail()).todo_state).toMatchObject(display) })
      watch.finish()
      const frames = await watch.read
      expect(frames.filter((frame) => frame.event === 'todo_state').map((frame) => frame.data)).toEqual([expect.objectContaining(display)])
    })

    it('keeps snapshot precedence across replay and replaces todos on a new execution or owner epoch', async () => {
      const watch = await observeOwner(withTodo(raw, { running: true, pending: [admission()], last_sequence: 8 }))
      watch.event('todo.updated', { todos: [{ content: 'Old replay' }], revision: 2 }, 1, { seq: 7 })
      expect((await detail()).todo_state).toMatchObject(display)
      watch.snapshot({ todo_state: null, execution_generation: 2, last_sequence: 10 }, true)
      watch.event('todo.updated', raw, 1, { seq: 11 })
      await vi.waitFor(async () => { expect((await detail()).todo_state).toMatchObject({ display_items: [], total_count: 0 }) })
      watch.snapshot({ todo_state: { todos: [{ content: 'Replacement' }], revision: 1 }, authority_epoch: 2, replay_epoch: 'new-owner', execution_generation: 1, last_sequence: 1 }, true)
      watch.event('todo.updated', raw, 2, { seq: 100, authority_epoch: 1, replay_epoch: 'owner-epoch' })
      await vi.waitFor(async () => { expect((await detail()).todo_state).toMatchObject({ display_items: [{ text: 'Replacement', state: 'pending' }], total_count: 1 }) })
      watch.finish()
      await watch.read
    })

    it('restores a newer todo revision from replay when the transcript snapshot trails it', async () => {
      const watch = await observeOwner(withTodo({ todos: [], revision: 2 }, { running: true, pending: [admission()], last_sequence: 8 }))
      try {
        watch.event('todo.updated', raw, 1, { seq: 7 })
        await vi.waitFor(async () => { expect((await detail()).todo_state).toMatchObject(display) })
      } finally { watch.finish(); await watch.read }
    })

    it('accepts a new generation todo revision after session.info without restoring old events', async () => {
      const watch = await observeOwner(withTodo(raw, { running: true, pending: [admission()] }))
      const next = { todos: [{ content: 'New generation' }], revision: 1 }
      try {
        watch.event('session.info', { authority_epoch: 1, execution_generation: 2, running: true, pending: [{ ...admission(), execution_generation: 2 }] })
        watch.event('todo.updated', next, 2, { seq: 8 })
        watch.event('todo.updated', raw, 1, { seq: 9 })
        await vi.waitFor(async () => { expect((await detail()).todo_state).toMatchObject({ display_items: [{ text: 'New generation' }] }) })
      } finally {
        watch.snapshot({ execution_generation: 2, todo_state: next, last_sequence: 8 }, false, false)
        watch.finish()
        await watch.read
      }
    })

    it('isolates same-ID idle plans by profile and invalidates both viewers without an active run', async () => {
      const otherHome = join(s.state, 'profiles', 'work')
      mkdirSync(otherHome, { recursive: true })
      const other = openStateDb(join(otherHome, 'state.db'))
      other.exec(fixture.schema.join('\n'))
      for (const sql of fixture.inserts) other.exec(sql)
      const controllers = [new AbortController(), new AbortController(), new AbortController()]
      const emitters = new Map<string, (frame: Omit<StreamFrame, 'seq'>) => void>()
      sidecar.respond('gateway.session', (params, send, opts) => {
        const snap = withTodo(null)
        if (params.action !== 'watch') return attached(snap)
        emitters.set(params.profile_home, send)
        send({ event: 'snapshot', data: attached(snap) })
        return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached(snap)) }, { once: true }) })
      })
      const changes = vi.spyOn(s.deps.channels, 'emit')
      try {
        for (const [i, profile] of ['default', 'default', 'work'].entries()) await s.deps.sessions.owner!.observe(sid, profile, controllers[i]!.signal)
        expect(emitters.size).toBe(2)
        for (const [home, send] of emitters) send({ event: 'event', data: { type: 'todo.updated', session_id: sid, authority_epoch: 1, replay_epoch: 'owner-epoch', execution_generation: 1, seq: 5, payload: { todos: [{ content: home === otherHome ? 'Work plan' : 'Default plan' }], revision: 1 } } })
        for (const [profile, text] of [['default', 'Default plan'], ['work', 'Work plan']]) {
          const response = await s.get(`/api/session?session_id=${sid}`, { headers: { cookie: `hermes_profile=${profile}` } })
          expect(SessionEnvelopeSchema.parse(await response.json()).session.todo_state).toMatchObject({ display_items: [{ text }] })
          expect(changes.mock.calls.some(([id, event, , scope]) => id === sid && event === 'session-updated' && scope === profile)).toBe(true)
        }
        expect(s.deps.registry.activeRunStreamForSession(sid)).toBeNull()
      } finally { for (const controller of controllers) controller.abort(); other.close() }
    })
  })

  it('publishes Web audio only for a live owner-confirmed successful completion', async () => {
    const changes = vi.spyOn(s.deps.events, 'publish')
    const watch = await observeOwner(snapshot({ running: true, pending: [admission()] }))
    watch.finish()
    await watch.read
    await vi.waitFor(() => { expect(changes.mock.calls.some(([reason]) => reason === 'web_completion')).toBe(true) })
  })

  it.each(['failed', 'cancelled'])('keeps native %s completions quiet', async (outcome) => {
    const changes = vi.spyOn(s.deps.events, 'publish')
    const watch = await observeOwner(snapshot({ running: true, pending: [admission()] }))
    watch.finish(1, outcome)
    await watch.read
    expect(changes.mock.calls.some(([reason]) => reason === 'web_completion')).toBe(false)
  })

  it('keeps a native completion received during replay quiet', async () => {
    const changes = vi.spyOn(s.deps.events, 'publish')
    const watch = await observeOwner(snapshot({ running: true, pending: [admission()] }))
    watch.replaySnapshot()
    watch.finish()
    watch.replayComplete('completed')
    await watch.read
    expect(changes.mock.calls.some(([reason]) => reason === 'web_completion')).toBe(false)
  })

  it('keeps reaction readback from settling before queued native completion events', async () => {
    const watch = await observeOwner(snapshot({ running: true, pending: [admission()] }))
    await vi.waitFor(() => { expect(watch.attached).toBe(true) })
    watch.reactionSnapshot()
    watch.event('message.complete', cronRefusal.completion)
    watch.finish(1, 'failed')
    const frames = await watch.read
    expect(frames.some((frame) => frame.event === 'done')).toBe(false)
    expect(frames.find((frame) => frame.event === 'apperror')?.data).toMatchObject({ type: 'cron_session_read_only', retryable: false })
  })

  it.each([false, true])('replays a cron refusal that settled before the submit acknowledgement, viewed=%s', async (viewed) => {
    const snap = snapshot()
    sidecar.respond('gateway.session', (params, send, opts) => {
      if (params.action === 'watch') {
        send({ event: 'snapshot', data: { ...attached(snap), replaying: true } })
        send({ event: 'event', data: { type: 'message.complete', payload: cronRefusal.completion, session_id: sid, authority_epoch: 1, replay_epoch: 'owner-epoch', execution_generation: 1 } })
        send({ event: 'replay_complete', data: {} })
        return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached(snap)) }, { once: true }) })
      }
      return { ...attached(snap), receipt: ['submit', 'receipt'].includes(params.action) ? { ...admission('terminal'), outcome: 'failed' } : null }
    })
    const controller = new AbortController()
    const observer = viewed ? await s.deps.sessions.owner!.observe(sid, 'default', controller.signal) : null
    try {
      const response = await post('/api/chat/start', { session_id: sid, submission_id: 'fast-refusal', message: 'ordinary input' })
      const body = await response.json() as { stream_id?: string }
      expect(body.stream_id).toBeTruthy()
      const frames = await s.sse(`/api/chat/stream?stream_id=${body.stream_id}&replay=1`, (f) => f.event === 'apperror')
      expect(frames.find((f) => f.event === 'apperror')?.data).toMatchObject(cronRefusal.event.data)
    } finally { controller.abort(); observer?.release(); await observer?.ended }
  })

  it('preserves the real cron refusal through public SSE and journal replay exactly once', async () => {
    const watch = await observeOwner(snapshot({ running: true, pending: [admission()] }))
    watch.event('message.complete', cronRefusal.completion)
    watch.event('message.complete', cronRefusal.completion)
    watch.finish(1, 'failed')
    watch.finish(1, 'failed')
    const frames = await watch.read
    const errors = frames.filter((f) => f.event === 'apperror')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.data).toMatchObject(cronRefusal.event.data)
    expect(ChatEventSchema.safeParse(errors[0]).success).toBe(true)
    const replay = await s.sse(`/api/chat/stream?stream_id=${watch.stream}&replay=1`, (f) => f.event === 'apperror')
    expect(replay.find((f) => f.event === 'apperror')?.data).toEqual(errors[0]?.data)
    expect(sidecar.calls.some((c) => c.method === 'chat.start' || c.method === 'cron.run')).toBe(false)
  })

  it('waits for retained owner events before settling an idle reconnect snapshot', async () => {
    const watch = await observeOwner(snapshot({ running: true, pending: [admission()] }))
    watch.snapshot({ running: false, pending: [] }, false, false)
    // The owner became idle between attachment and the watch's initial snapshot.
    // The sidecar marks that snapshot until its retained events have drained.
    watch.replaySnapshot()
    watch.event('message.complete', cronRefusal.completion)
    watch.replayComplete('failed')
    expect((await watch.read).find((f) => f.event === 'apperror')?.data).toMatchObject(cronRefusal.event.data)
  })

  it.each(['generation', 'authority', 'replay', 'gap'] as const)('discards a cron descriptor on %s replacement', async (replacement) => {
    const watch = await observeOwner(snapshot({ running: true, pending: [admission()] }))
    watch.event('message.complete', cronRefusal.completion)
    watch.snapshot(replacement === 'generation' ? { execution_generation: 2 } : replacement === 'authority' ? { authority_epoch: 2 } : replacement === 'replay' ? { replay_epoch: 'next' } : {}, replacement === 'gap')
    watch.finish(replacement === 'generation' ? 2 : 1, 'failed')
    expect((await watch.read).find((f) => f.event === 'apperror')?.data).toMatchObject({ type: 'owner_turn_failed', message: 'The owning Agent could not complete this turn' })
  })

  it.each([{ session_id: 'another' }, { authority_epoch: 99 }, { replay_epoch: 'stale' }, { execution_generation: 99 }])('ignores a stale cron completion %j', async (stamps) => {
    const watch = await observeOwner(snapshot({ running: true, pending: [admission()] }))
    watch.event('message.complete', cronRefusal.completion, 1, stamps)
    watch.finish(1, 'failed')
    expect((await watch.read).find((f) => f.event === 'apperror')?.data).toMatchObject({ type: 'owner_turn_failed' })
  })

  it.each([
    {},
    { ...cronRefusal.completion, error_surface: { layer: 'gateway', code: 'provider_failure', retryable: false }, text: 'private diagnostic' },
    { ...cronRefusal.completion, error_surface: { layer: 'gateway', code: 'cron_session_read_only', retryable: true } },
    { ...cronRefusal.completion, error_surface: { layer: 'gateway', code: 'cron_session_read_only' } },
    { ...cronRefusal.completion, error_surface: { code: 'cron_session_read_only', retryable: false } },
    { ...cronRefusal.completion, text: '' },
    { ...cronRefusal.completion, admission_id: 'another-input' },
    { ...cronRefusal.completion, error_surface: { layer: 'provider', code: 'cron_session_read_only', retryable: false }, text: 'private diagnostic' },
  ])('keeps an old or unrelated owner failure generic %j', async (payload) => {
    const watch = await observeOwner(snapshot({ running: true, pending: [admission()] }))
    watch.event('message.complete', payload)
    watch.finish(1, 'failed')
    const error = (await watch.read).find((f) => f.event === 'apperror')?.data
    expect(error).toMatchObject({ type: 'owner_turn_failed', message: 'The owning Agent could not complete this turn' })
    expect(error).not.toHaveProperty('retryable')
  })

  it('redacts cron refusal text and never forwards private descriptor fields', async () => {
    const watch = await observeOwner(snapshot({ running: true, pending: [admission()] }))
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456'
    watch.event('message.complete', { ...cronRefusal.completion, text: `${String(cronRefusal.completion.text)} ${secret}`, error_surface: { layer: 'gateway', code: 'cron_session_read_only', retryable: false, provider: 'private-provider', details: secret } })
    watch.finish(1, 'failed')
    const serialized = JSON.stringify(await watch.read)
    expect(serialized).toContain('Start a new chat to send it.')
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('private-provider')
  })

  const holdOwnerReceipt = () => {
    const original = sidecar.responderFor('gateway.session')!
    let resolve!: (result: GatewaySessionResult) => void
    const receipt = new Promise<GatewaySessionResult>((release) => { resolve = release })
    let requested = false
    sidecar.respond('gateway.session', (params, send, opts) => {
      if (params.action === 'receipt' && !requested) { requested = true; return receipt }
      return original(params, send, opts)
    })
    return { get requested() { return requested }, release: () => { resolve({ ...attached(snapshot()), receipt: { ...admission('terminal'), outcome: 'completed' } }) } }
  }

  it('keeps a new native turn observable while the previous projection is settling', async () => {
    const first = await observeOwner(snapshot({ running: true, pending: [admission()] }))
    const controller = new AbortController()
    const viewer = await s.deps.sessions.owner!.observe(sid, 'default', controller.signal)
    const receipt = holdOwnerReceipt()
    try {
      first.finish()
      await vi.waitFor(() => { expect(receipt.requested).toBe(true) })
      first.snapshot({ running: true, execution_generation: 2, pending: [{ ...admission(), admission_id: 'successor-input', input_id: 'successor-request', execution_generation: 2 }] })
      await vi.waitFor(() => {
        expect(s.deps.registry.activeRunStreamForSession(sid)).not.toBe(first.stream)
        expect(s.deps.registry.activeRunStreamForSession(sid)).not.toBeNull()
      })
      const next = s.deps.registry.activeRunStreamForSession(sid)!
      receipt.release()
      const previous = await first.read
      expect(previous.find((frame) => frame.event === 'done')?.data).not.toHaveProperty('session')
      const read = s.sse(`/api/chat/stream?stream_id=${next}&replay=1&after_seq=0`, (frame) => frame.event === 'stream_end')
      first.event('message.delta', { text: 'Next turn output' }, 2)
      first.finish(2)
      expect((await read).filter((frame) => frame.event === 'token').map((frame) => frame.data)).toEqual([{ text: 'Next turn output' }])
      expect(sidecar.calls.filter((call) => call.method === 'gateway.session' && (call.params as { action: string }).action === 'watch')).toHaveLength(1)
    } finally {
      receipt.release()
      first.finish(2)
      controller.abort(); viewer?.release()
      await first.read
    }
  })

  it('waits for a settling run projection during server shutdown', async () => {
    const first = await observeOwner(snapshot({ running: true, pending: [admission()] }))
    const controller = new AbortController()
    const viewer = await s.deps.sessions.owner!.observe(sid, 'default', controller.signal)
    const receipt = holdOwnerReceipt()
    first.finish()
    await vi.waitFor(() => { expect(receipt.requested).toBe(true) })
    const closing = s.deps.sessions.owner!.close()
    try {
      await viewer?.ended
      const state = await Promise.race([closing.then(() => 'closed'), new Promise<string>((resolve) => { setImmediate(() => { resolve('waiting') }) })])
      expect(state).toBe('waiting')
    } finally {
      receipt.release()
      controller.abort(); viewer?.release()
      await closing
      await first.read
    }
  })

  it('carries native MCP progress on one tool row through completion', async () => {
    const watch = await observeOwner(snapshot({ running: true, pending: [admission()] }))
    watch.event('tool.start', { tool_id: 'index-a', name: 'mcp__index', args: {} })
    watch.event('tool.progress', { tool_id: 'index-a', progress: 10, total: 50, message: 'starting' })
    watch.event('tool.progress', { tool_id: 'index-a', progress: 21, total: 50, message: 'indexing files' })
    watch.event('tool.complete', { tool_id: 'index-a', name: 'mcp__index', preview: 'done' })
    watch.event('tool.progress', { tool_id: 'index-a', percent: 80, message: 'late' })
    watch.finish()
    const frames = await watch.read
    expect(frames.filter((frame) => frame.event === 'tool')).toHaveLength(1)
    const progress = frames.filter((frame) => frame.event === 'tool_progress')
    expect(progress.map((frame) => frame.data)).toEqual([
      { id: 'index-a', progress: { percent: 20, message: 'starting' } },
      { id: 'index-a', progress: { percent: 42, message: 'indexing files' } },
    ])
    for (const frame of progress) expect(ChatEventSchema.safeParse(frame).success).toBe(true)
    expect(frames.find((frame) => frame.event === 'tool_complete')?.data).toMatchObject({ id: 'index-a', progress: null })
  })

  it('reloads only the latest active native progress, redacted before bounding and never journaled', async () => {
    const watch = await observeOwner(snapshot({ running: true, pending: [admission()] }))
    try {
      for (const id of ['a', 'b']) watch.event('tool.start', { tool_id: id, name: 'mcp__index', args: {} })
      watch.event('tool.progress', { tool_id: 'a', percent: 10, message: 'old progress' })
      watch.event('tool.progress', { tool_id: 'b', progress: 21, total: 50, message: 'indexing files' })
      const secret = 'sk-synthetic-native-progress-123456789012345'
      watch.event('tool.progress', { tool_id: 'a', percent: 200, message: `OPENAI_API_KEY=${secret} ${'x'.repeat(1200)}` })
      await vi.waitFor(() => { expect(s.deps.sessions.deps.runtime.liveToolProgress?.(watch.stream)).toHaveLength(2) })
      const detail = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json()).session
      expect(detail.tool_calls).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'a', progress: { percent: 100, message: expect.any(String) as unknown } }),
        expect.objectContaining({ id: 'b', progress: { percent: 42, message: 'indexing files' } }),
      ]))
      expect(JSON.stringify(detail.tool_calls)).not.toContain(secret)
      const replay = await s.sse(`/api/chat/stream?stream_id=${watch.stream}&replay=1`, (f) => f.event === 'tool_progress' && (f.data as { id: string }).id === 'b')
      expect(replay.filter((f) => f.event === 'tool_progress')).toHaveLength(2)
      expect(JSON.stringify(replay)).not.toContain('old progress')
      const journal = await s.deps.journal.readRunEvents(detail.composer_state_key!, watch.stream)
      expect(JSON.stringify(journal)).not.toMatch(/indexing files|tool_progress|old progress/)
      watch.event('tool.complete', { tool_id: 'a', name: 'mcp__index' })
      await vi.waitFor(() => { expect(s.deps.sessions.deps.runtime.liveToolProgress?.(watch.stream).map((call) => call.id)).toEqual(['b']) })
    } finally { watch.finish(); await watch.read }
  })

  it.each(['generation', 'authority', 'replay', 'gap'] as const)('clears native progress on %s replacement and rejects stale identities', async (replacement) => {
    const watch = await observeOwner(snapshot({ running: true, pending: [admission()] }))
    try {
      watch.event('tool.start', { tool_id: 'reused', name: 'mcp__index' })
      watch.event('tool.progress', { tool_id: 'reused', percent: 42, message: 'obsolete' })
      await vi.waitFor(() => { expect(s.deps.sessions.deps.runtime.liveToolProgress?.(watch.stream)).toHaveLength(1) })
      const changed = replacement === 'generation' ? { execution_generation: 2 } : replacement === 'authority' ? { authority_epoch: 2 } : replacement === 'replay' ? { replay_epoch: 'replacement' } : {}
      if (replacement !== 'gap') {
        // HTTP can discover a successor before the watch receives its replacement snapshot.
        watch.snapshot(changed, false, false)
        const detail = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json()).session
        expect(detail.tool_calls).toEqual([])
      }
      watch.snapshot(changed, replacement === 'gap')
      watch.event('tool.progress', { tool_id: 'reused', percent: 99, message: 'no new start' })
      await vi.waitFor(() => { expect(s.deps.sessions.deps.runtime.liveToolProgress?.(watch.stream)).toEqual([]) })
      watch.event('tool.start', { tool_id: 'reused', name: 'mcp__index' })
      watch.event('tool.progress', { tool_id: 'reused', percent: 50, message: 'current' })
      for (const stamps of [{ session_id: 'another-session' }, { authority_epoch: 99 }, { replay_epoch: 'stale' }, { execution_generation: 99 }]) {
        watch.event('tool.progress', { tool_id: 'reused', percent: 99, message: 'stale' }, undefined, stamps)
      }
      await vi.waitFor(() => { expect(s.deps.sessions.deps.runtime.liveToolProgress?.(watch.stream)[0]?.progress).toEqual({ percent: 50, message: 'current' }) })
    } finally { watch.finish(); }
    const frames = await watch.read
    expect(frames.filter((f) => f.event === 'tool_progress').map((f) => (f.data as { progress: unknown }).progress)).toEqual([
      { percent: 42, message: 'obsolete' }, null, { percent: 50, message: 'current' }, null,
    ])
  })

  it('ignores duplicate native starts/completions and old-owner omission', async () => {
    const watch = await observeOwner(snapshot({ running: true, pending: [admission()] }))
    for (let i = 0; i < 2; i++) watch.event('tool.start', { tool_id: 'a', name: 'mcp__index' })
    for (let i = 0; i < 2; i++) watch.event('tool.complete', { tool_id: 'a', name: 'mcp__index' })
    watch.event('tool.start', { tool_id: 'a', name: 'mcp__index' })
    watch.event('tool.progress', { tool_id: 'a', percent: 50, message: 'late duplicate' })
    watch.finish()
    const frames = await watch.read
    expect(frames.filter((f) => f.event === 'tool')).toHaveLength(1)
    expect(frames.filter((f) => f.event === 'tool_complete')).toHaveLength(1)
    expect(frames.filter((f) => f.event === 'tool_progress')).toEqual([])
  })

  it('clears unfinished native progress on interruption and releases the running projection', async () => {
    const watch = await observeOwner(snapshot({ running: true, pending: [admission()] }))
    watch.event('tool.start', { tool_id: 'a', name: 'mcp__index' })
    watch.event('tool.progress', { tool_id: 'a', percent: 42, message: 'unfinished' })
    watch.finish(undefined, 'interrupted')
    const frames = await watch.read
    expect(frames.find((f) => f.event === 'cancel')?.data).toMatchObject({ terminal_state: 'cancelled', session: { tool_calls: [] } })
    expect(frames.findLast((f) => f.event === 'tool_progress')?.data).toEqual({ id: 'a', progress: null })
    await vi.waitFor(() => { expect(s.deps.registry.liveToolCalls.has(watch.stream)).toBe(false) })
  })

  it('isolates native progress for concurrent calls in separate sessions and profile homes', async () => {
    const otherHome = join(s.state, 'profiles', 'work')
    mkdirSync(otherHome, { recursive: true })
    const other = openStateDb(join(otherHome, 'state.db'))
    other.exec(fixture.schema.join('\n'))
    for (const sql of fixture.inserts) other.exec(sql)
    const watches: Awaited<ReturnType<typeof observeOwner>>[] = []
    try {
      for (const [session, profile] of [[sid, 'default'], [fixture.sessions.tui!, 'default'], [sid, 'work']] as const) {
        const watch = await observeOwner(snapshot({ session_id: session, stored_session_id: session, running: true, pending: [admission()] }), profile)
        watches.push(watch)
        watch.event('tool.start', { tool_id: 'same-id', name: 'mcp__index' })
        watch.event('tool.progress', { tool_id: 'same-id', percent: watches.length * 10, message: `${profile}/${session}` })
      }
      for (const [index, watch] of watches.entries()) await vi.waitFor(() => {
        expect(s.deps.sessions.deps.runtime.liveToolProgress?.(watch.stream)[0]?.progress).toMatchObject({ percent: (index + 1) * 10 })
      })
    } finally {
      for (const watch of watches) watch.finish()
      await Promise.all(watches.map((watch) => watch.read))
      other.close()
    }
  })

  it.each([false, true])('accepts a voice stop without an admission or replacing an owner watch, running=%s', async (running) => {
    const snap = snapshot({ running, pending: running ? [admission()] : [] })
    const watch = running ? await observeOwner(snap) : null
    const original = sidecar.responderFor('gateway.session')
    sidecar.respond('gateway.session', (params, emit, opts) => params.action === 'submit'
      ? { ...attached(snap), receipt: { voice_stopped: true } }
      : original ? original(params, emit, opts) : attached(snap))
    try {
      const response = await post('/api/chat/start', { session_id: sid, message: 'stop', submission_id: 'voice-stop-once' })
      expect(response.status, await response.clone().text()).toBe(200)
      const body = await response.json()
      expect(body).toMatchObject({ ok: true, status: 'suppressed', reason: 'voice_stopped', owner_attachment: { state: 'attached' }, session: { session_id: sid } })
      expect(body).not.toHaveProperty('admission_id')
      expect(body).not.toHaveProperty('stream_id')
      expect(body).not.toHaveProperty('outcome_unknown')
      expect(s.deps.registry.activeRunStreamForSession(sid)).toBe(watch?.stream ?? null)
      expect(sidecar.calls.filter((c) => c.method === 'gateway.session' && (c.params as { action: string }).action === 'submit')).toHaveLength(1)
      expect(sidecar.calls.filter((c) => c.method === 'gateway.session' && (c.params as { action: string }).action === 'watch')).toHaveLength(running ? 1 : 0)
      expect(sidecar.calls.some((c) => c.method === 'chat.start')).toBe(false)
    } finally { if (watch) { watch.finish(); await watch.read } }
  })

  it.each([{ voice_stopped: false }, { voice_stopped: 'true' }, { voice_stopped: true, extra: 'ambiguous' }, { ...admission(), voice_stopped: true }])('keeps an invalid voice-stop receipt unknown (%j)', async (receipt) => {
    // Inject untrusted output so the fake validates it exactly as the real client does.
    sidecar.respond('gateway.session', (params) => ({ ...attached(snapshot()), receipt: params.action === 'submit' ? receipt as GatewaySessionResult['receipt'] : null }))
    const response = await post('/api/chat/start', { session_id: sid, message: 'stop', submission_id: 'invalid-stop' })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ outcome_unknown: true, owner_attachment: { state: 'unavailable' } })
    expect(sidecar.calls.filter((c) => c.method === 'gateway.session' && (c.params as { action: string }).action === 'submit')).toHaveLength(1)
  })

  it('keeps the owner watch attached when the reasoning preference is unavailable', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    s.deps.sessions.owner = new GatewaySessions({ service: s.deps.sessions, sidecar: s.deps.sidecar,
      registry: s.deps.registry, journal: s.deps.journal, events: s.deps.events, channels: s.deps.channels, profileHome: s.deps.profileHome,
      activeProfile: s.deps.activeProfile, redactEnabled: s.deps.sessions.deps.redactEnabled, now: s.deps.nowSeconds, log: s.deps.log,
      showReasoning: async () => { await gate; throw new Error('synthetic config unavailable') },
    })
    const watch = await observeOwner(snapshot({ running: true, pending: [admission()] }))
    release()
    await vi.waitFor(() => { expect(watch.attached || s.deps.registry.activeRunStreamForSession(sid) === null).toBe(true) })
    if (watch.attached) {
      watch.event('reasoning.delta', { text: 'Hidden reasoning' })
      watch.event('message.delta', { text: 'Still observable' })
      watch.finish()
    }
    const frames = await watch.read
    expect.soft(frames.filter((frame) => frame.event === 'token').map((frame) => frame.data)).toEqual([{ text: 'Still observable' }])
    expect.soft(frames.some((frame) => frame.event === 'apperror')).toBe(false)
    expect.soft(frames.some((frame) => frame.event === 'reasoning')).toBe(false)
    expect.soft(sidecar.calls.find((call) => call.method === 'gateway.session' && (call.params as { action: string }).action === 'watch')?.params).toMatchObject({ show_reasoning: true })
  })

  it('clears prior reasoning titles and usage when a queued execution advances the generation', async () => {
    const watch = await observeOwner(snapshot({ running: false, execution_generation: 1, pending: [{ ...admission('queued'), execution_generation: null }] }))
    watch.event('reasoning.delta', { text: '**Previous heading**\nPrevious execution\n' })
    watch.event('message.delta', { text: 'Previous answer' })
    watch.event('session.usage', { prompt_tokens: 100, completion_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, tokens_per_s: 20 })
    watch.event('session.info', { authority_epoch: 1, execution_generation: 2, running: true, pending: [{ ...admission(), execution_generation: 2 }] })
    watch.event('reasoning.delta', { text: '**Current heading**\nCurrent execution\n' }, 2)
    watch.event('message.delta', { text: 'Current answer' }, 2)
    watch.finish(2)
    const frames = await watch.read
    expect.soft(frames.findLast((frame) => frame.event === 'reasoning')?.data).toMatchObject({ titles: ['Current heading'] })
    expect.soft(frames.find((frame) => frame.event === 'done')?.data).not.toHaveProperty('usage')
    expect.soft(frames.some((frame) => frame.event === 'apperror')).toBe(false)
  })

  it('opens the canonical transcript through its owner while keeping direct writes fenced', async () => {
    const sid = fixture.sessions.cli!
    sidecar.respond('gateway.session', () => ({ state: 'attached', reason: null, receipt: null, snapshot: {
      session_id: sid, stored_session_id: sid, messages: [{ role: 'user', content: 'native question' }, { role: 'assistant', content: 'owner answer' }],
      message_count: 2, running: false, authority_epoch: 1, replay_epoch: 'owner-epoch', last_sequence: 4,
      subscription_id: 'viewer', revision: 2, execution_generation: 1, pending: [], prompts: [], info: { title: 'Native chat', model: 'native-model' },
    } }))
    const response = await s.get(`/api/session?session_id=${sid}`)
    const body = await response.json() as { session: Record<string, unknown> }
    expect(body.session.owner_attachment).toMatchObject({ state: 'attached', can_submit: true })
    expect(body.session.read_only).toBe(true)
    expect(body.session.composer_state_key).toMatch(/^owner-[a-f0-9]{64}$/)
    expect(body.session.messages).toEqual(expect.arrayContaining([expect.objectContaining({ content: 'owner answer' })]))
    expect(sidecar.calls.filter((c) => c.method === 'chat.start')).toEqual([])
  })

  it('preserves an explicit null provider in the owner model projection', async () => {
    const option = vi.spyOn(s.deps.sessions.deps, 'modelOptionFor').mockImplementation((model, provider) => JSON.stringify([model, provider]))
    const base = { session_id: sid, read_only_reason: CANONICAL_READ_ONLY_REASON, model: 'old-model', model_provider: 'old-backend', workspace: s.state }
    sidecar.respond('gateway.session', () => attached(snapshot({ info: { model: 'native-model', provider: null } })))
    const cleared = await s.deps.sessions.owner!.project(base)
    expect(cleared.model_provider).toBeNull()
    expect(cleared.model_option_id).toBe('["native-model",null]')
    expect(option).toHaveBeenLastCalledWith('native-model', null)
    sidecar.respond('gateway.session', () => attached(snapshot({ info: { model: 'native-model' } })))
    const absent = await s.deps.sessions.owner!.project(base)
    expect(absent.model_provider).toBe('old-backend')
    expect(absent.model_option_id).toBe('["native-model","old-backend"]')
  })

  it('retains the compatibility gate when the installed owner protocol is missing', async () => {
    sidecar.respond('gateway.session', () => ({ state: 'incompatible', reason: 'native_sessions_unavailable', snapshot: null, receipt: null }))
    const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
    expect(row.session.owner_attachment).toMatchObject({ state: 'incompatible', can_submit: false, can_interrupt: false })
    expect((await post('/api/chat/start', { session_id: sid, message: 'follow up', submission_id: 'stable' })).status).toBe(403)
    expect(sidecar.calls.filter((c) => c.method === 'chat.start')).toEqual([])
  })

  it('forwards the retained submission identity without materializing a second writer', async () => {
    sidecar.respond('gateway.session', (params) => ({ ...attached(snapshot()), receipt: params.action === 'submit' ? admission('terminal') : null }))
    for (let i = 0; i < 2; i++) {
      const response = await post('/api/chat/start', { session_id: sid, message: 'follow up', submission_id: 'same-request' })
      expect(response.status, await response.text()).toBe(200)
    }
    const calls = sidecar.calls.filter((c) => c.method === 'gateway.session' && (c.params as { action: string }).action === 'submit')
    expect(calls.map((c) => c.params)).toEqual(Array(2).fill(expect.objectContaining({ request_id: 'same-request', session_id: sid, profile_home: s.state })))
    expect(await s.deps.sessionStore.exists(sid)).toBe(false)
    expect(sidecar.calls.some((c) => c.method === 'chat.start')).toBe(false)
  })

  it('records a lost submit acknowledgement as unknown without replaying admission', async () => {
    sidecar.respond('gateway.session', (params) => params.action === 'submit'
      ? { state: 'unavailable', reason: 'owner_connection_lost', snapshot: null, receipt: null }
      : attached(snapshot()))
    const result = await post('/api/chat/start', { session_id: sid, message: 'PRIVATE_PROMPT', submission_id: 'stable-input' })
    expect(result.status).toBe(409)
    expect(await result.json()).toMatchObject({ outcome_unknown: true })
    const records = s.logs.filter((line) => line.includes('"event":"chat_start_timing"')).map((line) => JSON.parse(line.slice(line.indexOf('{'))) as unknown) as { stage: string; outcome: string; spans: Record<string, unknown> }[]
    expect(records.find((record) => record.stage === 'terminal')).toMatchObject({ outcome: 'unknown', spans: {
      owner_snapshot: { outcome: 'ok', duration_ms: (expect.any(Number) as unknown) }, owner_detail: { outcome: 'ok', duration_ms: (expect.any(Number) as unknown) }, owner_submit: { outcome: 'unknown', duration_ms: (expect.any(Number) as unknown) },
    } })
    expect(sidecar.calls.filter((c) => c.method === 'gateway.session' && (c.params as { action: string }).action === 'submit')).toHaveLength(1)
    expect(sidecar.calls.some((c) => c.method === 'chat.start')).toBe(false)
    expect(JSON.stringify(records)).not.toContain('PRIVATE_PROMPT')
  })

  it('keeps a confirmed admission successful when its post-ACK snapshot becomes unavailable', async () => {
    sidecar.respond('gateway.session', (params) => params.action === 'submit'
      ? { state: 'unavailable', reason: 'owner_connection_lost', snapshot: null, receipt: admission('queued') }
      : attached(snapshot()))
    const response = await post('/api/chat/start', { session_id: sid, message: 'accepted work', submission_id: 'retained-request' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ admission_id: 'native-input', owner_attachment: { state: 'unavailable', can_submit: false } })
    expect(sidecar.calls.some((c) => c.method === 'chat.start')).toBe(false)
  })

  it('holds unknown work until explicit recovery and returns Retry to the draft without submitting', async () => {
    const original = "native work with OPENAI_API_KEY=sk-synthetic-retry-key-123456789012345"
    let snap = snapshot({ pending: [{ ...admission('unknown'), text: original }] })
    sidecar.respond('gateway.session', (params) => {
      if (params.action === 'discard') snap = snapshot()
      return { ...attached(snap), receipt: params.action === 'discard' ? admission('terminal') : null }
    })
    const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
    expect(row.session.owner_attachment).toMatchObject({ can_submit: false, admissions: [{ actions: ['retry', 'discard'] }] })
    expect((await post('/api/chat/start', { session_id: sid, message: 'retry automatically', submission_id: 'different' })).status).toBe(409)
    const result = await post('/api/chat/owner-action', { session_id: sid, action: 'retry', admission_id: 'native-input', execution_generation: 1 })
    expect(result.status, await result.clone().text()).toBe(200)
    expect(await result.json()).toMatchObject({ draft: original, session: { owner_attachment: { can_submit: true } } })
    expect(sidecar.calls.some((c) => c.method === 'chat.start' || c.method === 'gateway.session' && (c.params as { action: string }).action === 'submit')).toBe(false)
  })

  it.each([undefined, ''])('withholds Retry without recoverable admission text (%s)', async (text) => {
    const lost: GatewaySnapshot['pending'][number] = { ...admission('unknown') }
    if (text === undefined) delete lost.text
    else lost.text = text
    sidecar.respond('gateway.session', () => attached(snapshot({ pending: [lost] })))
    const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
    expect(row.session.owner_attachment?.admissions[0]?.actions).toEqual(['discard'])
    const response = await post('/api/chat/owner-action', { session_id: sid, action: 'retry', admission_id: lost.admission_id, execution_generation: 1 })
    expect(response.status).toBe(409)
    expect(sidecar.calls.some((c) => c.method === 'gateway.session' && (c.params as { action: string }).action === 'discard')).toBe(false)
  })

  it('redacts owner input previews on admission refusals as well as session reads', async () => {
    const secret = 'sk-synthetic-unknown-preview-secret-123456789012345'
    sidecar.respond('gateway.session', () => attached(snapshot({ pending: [{ ...admission('unknown'), text: `OPENAI_API_KEY=${secret}` }] })))
    const response = await post('/api/chat/start', { session_id: sid, message: 'another input', submission_id: 'new-input' })
    expect(response.status).toBe(409)
    expect(await response.text()).not.toContain(secret)
  })

  it('refuses incomplete mutations, unsafe workspace selections, file uploads, and blocking chat before owner dispatch', async () => {
    sidecar.respond('gateway.session', () => attached(snapshot()))
    expect((await post('/api/chat/owner-action', { session_id: sid, action: 'mutate', operation: 'reset', payload: {} })).status).toBe(400)
    expect((await post('/api/chat/owner-action', { session_id: sid, action: 'mutate', operation: 'workspace', payload: { cwd: '/untrusted-owner-fixture' }, request_id: 'change-workspace', expected_revision: 2, execution_generation: 1 })).status).toBe(400)
    expect((await post('/api/chat/start', { session_id: sid, submission_id: 'image', message: 'file', attachments: [{ path: '/untrusted-owner-fixture/key', mime: 'image/png' }] })).status).toBe(400)
    expect((await post('/api/chat', { session_id: sid, message: 'blocking' })).status).toBe(409)
    expect(sidecar.calls.filter((c) => c.method === 'gateway.session').every((call) => (call.params as { action: string }).action === 'snapshot')).toBe(true)
    expect(sidecar.calls.some((c) => c.method === 'chat.start')).toBe(false)
  })

  it.each([
    [{ operation: 'model', model: 'picked', revision: 3, execution_generation: 1 }, { state: 'applied' }],
    [{ operation: 'model', status: 'deferred', model: 'picked' }, { state: 'deferred', model: 'picked' }],
    [{ operation: 'model', status: 'confirmation_required', confirm: 'owner-token', confirm_message: 'Guard warning' }, { state: 'confirmation_required', confirm: 'owner-token', message: 'Guard warning', model: 'picked' }],
    [{ operation: 'model', status: 'refused', reason: 'model_resolution_failed' }, { state: 'refused', message: 'model_resolution_failed' }],
  ])('projects a model mutation receipt to its response and subsequent view (%j)', async (receipt, change) => {
    sidecar.respond('gateway.session', (params) => ({ ...attached(snapshot()), receipt: params.action === 'mutate' ? receipt : null }))
    const response = await post('/api/chat/owner-action', { session_id: sid, action: 'mutate', operation: 'model', payload: { model: 'picked', provider: null }, request_id: 'pick', expected_revision: 2, execution_generation: 1 })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toMatchObject({ model_change: change, session: { owner_attachment: { model_change: change } } })
    const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
    expect(row.session.owner_attachment).toMatchObject({ model_change: change })
  })

  it.each([
    { operation: 'model', status: 'refused', reason: 'model_resolution_failed' },
    { operation: 'model', status: 'confirmation_required', confirm: 'later-token', confirm_message: 'Later guard', payload: { model: 'picked', provider: null } },
  ])('keeps observing a deferred pick past idle until its unstamped outcome arrives (%j)', async (outcome) => {
    let snap = snapshot({ running: true, pending: [admission()] })
    let emit: ((frame: Omit<StreamFrame, 'seq'>) => void) | undefined
    sidecar.respond('gateway.session', (params, send, opts) => {
      if (params.action !== 'watch') return { ...attached(snap), receipt: params.action === 'mutate' ? { operation: 'model', status: 'deferred', model: 'picked' } : params.action === 'receipt' ? { ...admission('terminal'), outcome: 'completed' } : null }
      emit = send
      send({ event: 'snapshot', data: attached(snap) })
      return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached(snap)) }, { once: true }) })
    })
    const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
    const stream = row.session.active_stream_id!
    await post('/api/chat/owner-action', { session_id: sid, action: 'mutate', operation: 'model', payload: { model: 'picked' }, request_id: 'pick', expected_revision: 2, execution_generation: 1 })
    const read = s.sse(`/api/chat/stream?stream_id=${stream}`, (frame) => frame.event === 'stream_end')
    await vi.waitFor(() => { expect(s.deps.registry.peek(stream)?.subscriberCount).toBe(1) })
    snap = snapshot()
    emit!({ event: 'event', data: { type: 'session.info', session_id: sid, payload: { authority_epoch: 1, execution_generation: 1, running: false, pending: [] } } })
    emit!({ event: 'event', data: { type: 'session.updated', session_id: sid, payload: outcome } })
    const frames = await read
    const change = outcome.status === 'refused' ? { state: 'refused', message: 'model_resolution_failed' } : { state: 'confirmation_required', confirm: 'later-token', model: 'picked' }
    expect(frames.find((f) => f.event === 'done')?.data).toMatchObject({ session: { owner_attachment: { model_change: change } } })
    expect(await (await s.get(`/api/session?session_id=${sid}`)).json()).toMatchObject({ session: { owner_attachment: { model_change: change } } })
  })

  it('normalizes approval and clarify through their owner with the prompt generation', async () => {
    const prompts = [
      { kind: 'approval', prompt_id: 'approval-native', execution_generation: 7, command: 'echo fixture', description: 'Approve fixture?', choices: ['once', 'deny'] },
      { kind: 'clarify', prompt_id: 'clarify-native', execution_generation: 7, question: 'Which color?', choices: ['red', 'blue'] },
    ]
    sidecar.respond('gateway.session', () => attached(snapshot({ execution_generation: 7, prompts })))
    const pending = ClarifyPendingEnvelopeSchema.parse(await (await s.get(`/api/clarify/pending?session_id=${sid}`)).json())
    expect(pending.pending?.steps).toMatchObject([{ qid: 'q0', question: 'Which color?', choices: ['red', 'blue'] }])
    expect((await post('/api/clarify/respond', { session_id: sid, clarify_id: 'clarify-native', answers: { q0: 'blue' } })).status).toBe(200)
    expect((await post('/api/approval/respond', { session_id: sid, approval_id: 'approval-native', choice: 'once' })).status).toBe(200)
    expect(sidecar.calls.filter((c) => c.method === 'gateway.session').map((c) => c.params)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'clarify', prompt_id: 'clarify-native', execution_generation: 7, text: 'blue' }),
      expect.objectContaining({ action: 'approval', prompt_id: 'approval-native', execution_generation: 7, choice: 'once' }),
    ]))
    expect(sidecar.calls.some((c) => c.method === 'approval.respond' || c.method === 'clarify.respond')).toBe(false)
    expect((await post('/api/approval/respond', { session_id: sid, approval_id: 'expired-native', choice: 'once' })).status).toBe(409)
  })

  it('projects an owner clarify batch as one card and locks each answer, keeping the owner-reported progress', async () => {
    const snap = snapshot({ running: true, pending: [admission()] })
    const questions = [{ qid: 'q0', question: 'Pick a color', choices: ['blue (Recommended)', 'green'], multi_select: false },
      { qid: 'q1', question: 'Pick sizes', choices: ['s', 'm'], multi_select: true }]
    let emit: ((frame: Omit<StreamFrame, 'seq'>) => void) | undefined
    let remaining = ['q0', 'q1']
    let failed = false
    sidecar.respond('gateway.session', (params, send, opts) => {
      if (params.action === 'clarify_lock') {
        // The second answer fails once, so the first stays locked on the owner.
        if (params.question_id === 'q1' && !failed) { failed = true; return { state: 'unavailable', reason: 'owner_connection_lost', snapshot: null, receipt: null } }
        remaining = remaining.filter((qid) => qid !== params.question_id)
        return { ...attached(snap), lock: { status: 'ok', remaining } }
      }
      if (params.action !== 'watch') return attached(snap)
      emit = send
      send({ event: 'snapshot', data: attached(snap) })
      return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached(snap)) }, { once: true }) })
    })
    const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
    const stream = row.session.active_stream_id!
    const read = s.sse(`/api/chat/stream?stream_id=${stream}`, (frame) => frame.event === 'clarify' && (frame.data as { status?: string }).status === 'resolved')
    await vi.waitFor(() => { expect(s.deps.registry.peek(stream)?.subscriberCount).toBe(1) })
    emit!({ event: 'clarify_batch', data: { request_id: 'srq-batch', questions } })
    const pendingSteps = async () => ClarifyPendingEnvelopeSchema.parse(await (await s.get(`/api/clarify/pending?session_id=${sid}`)).json()).pending?.steps?.map((step) => [step.qid, step.answered]) ?? null
    await vi.waitFor(async () => { expect(await pendingSteps()).toEqual([['q0', false], ['q1', false]]) })
    const respond = () => post('/api/clarify/respond', { session_id: sid, clarify_id: 'srq-batch', answers: { q0: 'green', q1: ['s', 'm'] } })
    // An unconfirmed lock keeps the card for a retry, with q0 answered as the owner reported.
    expect((await respond()).status).toBe(503)
    expect(await pendingSteps()).toEqual([['q0', true], ['q1', false]])
    expect((await respond()).status).toBe(200)
    expect(await pendingSteps()).toBeNull()
    const locks = sidecar.calls.filter((c) => (c.params as { action?: string }).action === 'clarify_lock').map((c) => c.params)
    expect(locks).toEqual([
      expect.objectContaining({ request_id: 'srq-batch', question_id: 'q0', answer: 'green' }),
      expect.objectContaining({ request_id: 'srq-batch', question_id: 'q1', answer: '["s","m"]' }),
      expect.objectContaining({ request_id: 'srq-batch', question_id: 'q0', answer: 'green' }),
      expect.objectContaining({ request_id: 'srq-batch', question_id: 'q1', answer: '["s","m"]' }),
    ])
    expect(sidecar.calls.some((c) => (c.params as { action?: string }).action === 'clarify')).toBe(false)
    // A batch settled elsewhere clears from the owner's own withdrawal event.
    emit!({ event: 'clarify_batch', data: { request_id: 'srq-other', questions: questions.slice(0, 1) } })
    await vi.waitFor(async () => { expect(await pendingSteps()).toEqual([['q0', false]]) })
    emit!({ event: 'event', data: { type: 'request.cancel', session_id: sid, payload: { id: 'srq-other', method: 'clarify', reason: 'resolved' } } })
    await vi.waitFor(async () => { expect(await pendingSteps()).toBeNull() })
    const frames = await read
    expect(frames.find((f) => f.event === 'clarify')?.data).toMatchObject({ clarify_id: 'srq-batch', steps: [{ qid: 'q0' }, { qid: 'q1', multi_select: true }] })
  })

  it('ships the restart wait so clients stop sending while the parked approval stays answerable', async () => {
    const prompts = [{ kind: 'approval', prompt_id: 'approval-native', execution_generation: 1, command: 'echo fixture', description: 'Approve fixture?', choices: ['once', 'deny'] }]
    sidecar.respond('gateway.session', (params) => params.action === 'submit'
      ? { state: 'refused', reason: 'gateway_restarting', snapshot: null, receipt: null }
      : { ...attached(snapshot({ prompts })), restarting: true })
    const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
    expect(row.session.owner_attachment).toMatchObject({ state: 'attached', restarting: true, can_submit: false })
    expect((await post('/api/chat/start', { session_id: sid, message: 'follow up', submission_id: 'during-restart' })).status).toBe(409)
    expect(sidecar.calls.some((c) => (c.params as { action?: string }).action === 'submit')).toBe(false)
    expect((await post('/api/approval/respond', { session_id: sid, approval_id: 'approval-native', choice: 'once' })).status).toBe(200)
    sidecar.respond('gateway.session', () => attached(snapshot()))
    const after = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
    expect(after.session.owner_attachment).toMatchObject({ restarting: false, can_submit: true })
  })

  it('pushes the restart wait an open watch observes, so clients stop sending without another read', async () => {
    const snap = snapshot({ running: true, pending: [admission()] })
    let emit: ((frame: Omit<StreamFrame, 'seq'>) => void) | undefined
    sidecar.respond('gateway.session', (params, send, opts) => {
      if (params.action !== 'watch') return attached(snap)
      emit = send
      send({ event: 'snapshot', data: attached(snap) })
      return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached(snap)) }, { once: true }) })
    })
    const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
    expect(row.session.owner_attachment).toMatchObject({ restarting: false, can_submit: true })
    const stream = row.session.active_stream_id!
    const read = s.sse(`/api/chat/stream?stream_id=${stream}`, (frame) => frame.event === 'session_snapshot' && (frame.data as { session: { owner_attachment?: { restarting?: boolean } } }).session.owner_attachment?.restarting === true)
    await vi.waitFor(() => { expect(s.deps.registry.peek(stream)?.subscriberCount).toBe(1) })
    emit!({ event: 'restarting', data: { restarting: true } })
    const pushed = (await read).at(-1)?.data as { session: { owner_attachment: unknown } }
    expect(pushed.session.owner_attachment).toMatchObject({ state: 'attached', restarting: true, can_submit: false, can_interrupt: true })
  })

  it('streams owner events, replaces a replay gap, and settles from its authoritative snapshot', async () => {
    let snap = snapshot({ running: true, pending: [admission()] })
    let emit: ((frame: Omit<StreamFrame, 'seq'>) => void) | undefined
    sidecar.respond('gateway.session', (params, send, opts) => {
      if (params.action !== 'watch') return { ...attached(snap), receipt: params.action === 'receipt' ? { ...admission('terminal'), outcome: 'completed' } : null }
      emit = send
      send({ event: 'snapshot', data: attached(snap) })
      return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached(snap)); }, { once: true }); })
    })
    const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
    const stream = row.session.active_stream_id!
    expect(stream).toMatch(/^owner-/)
    const read = s.sse(`/api/chat/stream?stream_id=${stream}&replay=1&after_seq=0`, (frame) => frame.event === 'stream_end')
    await vi.waitFor(() => { expect(s.deps.registry.peek(stream)?.subscriberCount).toBe(1); })
    const event = (type: string, payload: Record<string, unknown>) => { emit!({ event: 'event', data: { type, payload, authority_epoch: 1, execution_generation: 1, session_id: sid } }); }
    event('message.delta', { text: 'before gap' })
    emit!({ event: 'snapshot', data: { ...attached(snap), replay_gap: true } })
    event('message.delta', { text: 'after gap' })
    snap = snapshot()
    // Session-info state uses its own payload stamp after the native execution stamp was cleared.
    emit!({ event: 'event', data: { type: 'session.info', session_id: sid, payload: { authority_epoch: 1, execution_generation: 1, running: false, pending: [] } } })
    const frames = await read
    expect(frames.filter((f) => f.event === 'token').map((f) => f.data)).toEqual([{ text: 'before gap' }, { text: 'after gap' }])
    expect(frames.some((f) => f.event === 'session_snapshot' && (f.data as { replay_gap: boolean }).replay_gap)).toBe(true)
    const done = frames.find((f) => f.event === 'done')?.data as { session: { messages: { content?: unknown }[] } } | undefined
    expect(done?.session.messages.some((message) => message.content === 'owner answer')).toBe(true)
    expect(await s.deps.sessionStore.exists(sid)).toBe(false)
    expect(sidecar.calls.some((c) => c.method === 'chat.start')).toBe(false)
  })

  it('applies Show to an already-attached owner watch that started hidden (TAL-996)', async () => {
    let show = false
    writeFileSync(join(s.state, 'config.yaml'), '# synthetic display preference')
    sidecar.respond('config.get', () => ({ path: join(s.state, 'config.yaml'), exists: true, config: { display: { platforms: { webui: { show_reasoning: show } } } } }))
    const watch = await observeOwner(snapshot({ running: true, pending: [admission()] }))
    await vi.waitFor(() => { expect(watch.attached).toBe(true) })
    show = true
    s.deps.agentConfig.invalidate()
    watch.event('reasoning.delta', { text: 'Restored owner reasoning' })
    watch.finish()
    const frames = await watch.read
    expect(frames.some((frame) => frame.event === 'reasoning' && (frame.data as { text?: string }).text === 'Restored owner reasoning')).toBe(true)
  })

  it.each([true, false])('projects recorded v0.22.3 reasoning, subagent activity and usage through existing chat frames (reasoning=%s)', async (show) => {
    writeFileSync(join(s.state, 'config.yaml'), '# synthetic display preference')
    sidecar.respond('config.get', () => ({ path: join(s.state, 'config.yaml'), exists: true, config: { display: { show_reasoning: !show, platforms: { webui: { show_reasoning: show } } } } }))
    const watch = await observeOwner(snapshot({ running: true, pending: [admission()] }))
    for (const recorded of ownerEvents.events) {
      // Old executions never contaminate the current turn's reasoning, progress or counters.
      watch.event(String(recorded.type), recorded.payload as Record<string, unknown>, 0)
      watch.event(String(recorded.type), recorded.payload as Record<string, unknown>)
    }
    watch.event('session.usage', { prompt_tokens: 100, input_tokens: 20, completion_tokens: 20, cache_read_tokens: 80, cache_write_tokens: 0 })
    watch.finish()
    const frames = await watch.read
    const reasoning = frames.filter((f) => f.event === 'reasoning').map((f) => (f.data as { text: string }).text).join('')
    expect.soft(reasoning).toBe(show ? ownerEvents.events.filter((e) => e.type === 'reasoning.delta').map((e) => (e.payload as { text: string }).text).join('') : '')
    expect.soft(sidecar.calls.find((c) => c.method === 'gateway.session' && (c.params as { action: string }).action === 'watch')?.params).toMatchObject({ show_reasoning: true })
    for (const frame of frames.filter((f) => ['reasoning', 'tool', 'tool_complete', 'metering', 'done'].includes(f.event))) expect.soft(ChatEventSchema.safeParse(frame).success, JSON.stringify(frame)).toBe(true)
    const progress = frames.filter((f) => f.event === 'tool' || f.event === 'tool_complete')
    expect.soft(progress).toHaveLength(ownerEvents.events.filter((e) => String(e.type).startsWith('subagent.')).length)
    expect.soft(progress[0]?.data).toMatchObject({ id: 'owner-subagent-detail-child', name: 'subagent_progress', kind: 'delegate', target: 'Inspect the supplied facts' })
    expect.soft(progress.at(-1)?.data).toMatchObject({ id: 'owner-subagent-detail-child', is_error: false, preview: 'Owner detail complete.' })
    const usage = { input_tokens: 100, output_tokens: 20, cache_read_tokens: 80, cache_write_tokens: 0, context_length: 256000, last_prompt_tokens: 20 }
    expect.soft(frames.findLast((f) => f.event === 'metering')?.data).toMatchObject({ usage, estimated: false })
    expect.soft(frames.find((f) => f.event === 'done')?.data).toMatchObject({ usage, session: usage })
    expect.soft(await s.deps.sessionStore.exists(sid)).toBe(false)
  })

  it('keeps a later model event when a deferred HTTP receipt arrives after it', async () => {
    let snap = snapshot({ running: true, pending: [admission()] })
    let emit: ((frame: Omit<StreamFrame, 'seq'>) => void) | undefined
    let acknowledge!: (result: GatewaySessionResult) => void
    sidecar.respond('gateway.session', (params, send, opts) => {
      if (params.action === 'mutate') return new Promise((resolve) => { acknowledge = resolve })
      if (params.action !== 'watch') return attached(snap)
      emit = send
      send({ event: 'snapshot', data: attached(snap) })
      return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached(snap)) }, { once: true }) })
    })
    await s.get(`/api/session?session_id=${sid}`)
    const action = post('/api/chat/owner-action', { session_id: sid, action: 'mutate', operation: 'model', payload: { model: 'picked' }, request_id: 'racing-pick', expected_revision: 2, execution_generation: 1 })
    await vi.waitFor(() => { expect(acknowledge).toBeDefined(); expect(emit).toBeDefined() })
    snap = { ...snap, revision: 3, info: { model: 'picked' } }
    emit!({ event: 'event', data: { type: 'session.updated', session_id: sid, payload: { operation: 'model', model: 'picked', revision: 3 } } })
    await vi.waitFor(async () => { expect(await (await s.get(`/api/session?session_id=${sid}`)).json()).toMatchObject({ session: { owner_attachment: { model_change: { state: 'applied' } } } }) })
    acknowledge({ ...attached(snap), receipt: { operation: 'model', status: 'deferred', model: 'picked' } })
    expect(await (await action).json()).toMatchObject({ model_change: { state: 'applied' } })
  })

  it.each([
    [{ operation: 'model', model: 'picked', revision: 3 }, { state: 'applied' }],
    [{ operation: 'model', status: 'refused', reason: 'model_resolution_failed' }, { state: 'refused', message: 'model_resolution_failed' }],
    [{ operation: 'model', status: 'confirmation_required', confirm: 'racing-token', confirm_message: 'Guard warning', payload: { model: 'picked' } }, { state: 'confirmation_required', confirm: 'racing-token' }],
  ])('retains the owner outcome when idle precedes the mutation ACK (%j)', async (outcome, change) => {
    let snap = snapshot({ running: true, pending: [admission()] })
    let emit: ((frame: Omit<StreamFrame, 'seq'>) => void) | undefined
    let acknowledge!: (result: GatewaySessionResult) => void
    sidecar.respond('gateway.session', (params, send, opts) => {
      if (params.action === 'mutate') return new Promise((resolve) => { acknowledge = resolve })
      if (params.action !== 'watch') return { ...attached(snap), receipt: params.action === 'receipt' ? { ...admission('terminal'), outcome: 'completed' } : null }
      emit = send
      send({ event: 'snapshot', data: attached(snap) })
      return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached(snap)) }, { once: true }) })
    })
    const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
    const stream = row.session.active_stream_id!
    const read = s.sse(`/api/chat/stream?stream_id=${stream}`, (frame) => frame.event === 'stream_end')
    const action = post('/api/chat/owner-action', { session_id: sid, action: 'mutate', operation: 'model', payload: { model: 'picked' }, request_id: 'idle-before-ack', expected_revision: 2, execution_generation: 1 })
    await vi.waitFor(() => { expect(acknowledge).toBeDefined(); expect(emit).toBeDefined(); expect(s.deps.registry.peek(stream)?.subscriberCount).toBe(1) })
    snap = snapshot()
    emit!({ event: 'event', data: { type: 'session.info', session_id: sid, payload: { authority_epoch: 1, execution_generation: 1, running: false, pending: [] } } })
    emit!({ event: 'event', data: { type: 'session.updated', session_id: sid, payload: outcome } })
    let response!: Response
    try {
      await vi.waitFor(async () => { expect(await (await s.get(`/api/session?session_id=${sid}`)).json()).toMatchObject({ session: { owner_attachment: { model_change: change } } }) })
    } finally {
      acknowledge({ ...attached(snap), receipt: { operation: 'model', status: 'deferred', model: 'picked' } })
      response = await action
    }
    expect(await response.json()).toMatchObject({ model_change: change })
    expect((await read).find((f) => f.event === 'done')?.data).toMatchObject({ session: { owner_attachment: { model_change: change } } })
    await vi.waitFor(() => { expect(s.deps.registry.activeRunStreamForSession(sid)).toBeNull() })
  })

  it.each(['applied', 'refused', 'disconnect'])('releases the in-flight model fence after an idle snapshot and %s ACK', async (outcome) => {
    let snap = snapshot({ running: true, pending: [admission()] })
    let emit: ((frame: Omit<StreamFrame, 'seq'>) => void) | undefined
    let acknowledge!: () => void
    sidecar.respond('gateway.session', (params, send, opts) => {
      if (params.action === 'mutate') return new Promise((resolve, reject) => {
        acknowledge = () => {
          if (outcome === 'disconnect') reject(new Error('synthetic owner disconnect'))
          else resolve(outcome === 'refused' ? { state: 'refused', reason: 'revision_conflict', snapshot: null, receipt: null }
            : { ...attached(snap), receipt: { operation: 'model', model: 'picked', revision: 3 } })
        }
      })
      if (params.action !== 'watch') return { ...attached(snap), receipt: params.action === 'receipt' ? { ...admission('terminal'), outcome: 'completed' } : null }
      emit = send
      send({ event: 'snapshot', data: attached(snap) })
      return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached(snap)) }, { once: true }) })
    })
    const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
    const stream = row.session.active_stream_id!
    let seenIdle!: () => void
    const idle = new Promise<void>((resolve) => { seenIdle = resolve })
    const read = s.sse(`/api/chat/stream?stream_id=${stream}`, (frame) => {
      if (frame.event === 'session_snapshot' && !(frame.data as { session: { owner_attachment: { can_interrupt: boolean } } }).session.owner_attachment.can_interrupt) seenIdle()
      return frame.event === 'stream_end'
    })
    const action = post('/api/chat/owner-action', { session_id: sid, action: 'mutate', operation: 'model', payload: { model: 'picked' }, request_id: 'release-fence', expected_revision: 2, execution_generation: 1 })
    await vi.waitFor(() => { expect(acknowledge).toBeDefined(); expect(emit).toBeDefined(); expect(s.deps.registry.peek(stream)?.subscriberCount).toBe(1) })
    snap = snapshot()
    emit!({ event: 'snapshot', data: attached(snap) })
    await idle
    acknowledge()
    expect((await action).status).toBe(outcome === 'applied' ? 200 : 409)
    expect((await read).some((f) => f.event === 'done')).toBe(true)
    await vi.waitFor(() => { expect(s.deps.registry.activeRunStreamForSession(sid)).toBeNull() })
  })

  it('uses the selected home for same-id attachments and redacts pending text', async () => {
    const otherPath = join(s.state, 'profiles', 'work', 'state.db')
    mkdirSync(join(otherPath, '..'), { recursive: true })
    const other = openStateDb(otherPath)
    try {
      other.exec(fixture.schema.join('\n'))
      for (const sql of fixture.inserts) other.exec(sql)
      sidecar.respond('gateway.session', (params) => attached(snapshot({ info: { title: params.profile_home }, pending: [{ ...admission('unknown'), text: 'OPENAI_API_KEY=sk-synthetic-private-owner-secret-1234567890' }] })))
      const row = await s.deps.sessions.owner!.project({ session_id: sid, profile: 'work', read_only: true, read_only_reason: CANONICAL_READ_ONLY_REASON })
      const root = await s.deps.sessions.owner!.project({ session_id: sid, profile: 'default', read_only: true, read_only_reason: CANONICAL_READ_ONLY_REASON })
      expect(row.composer_state_key).not.toBe(root.composer_state_key)
      expect(row.title).toBe(join(s.state, 'profiles', 'work'))
      expect(JSON.stringify(row)).not.toContain('sk-synthetic-private-owner-secret-1234567890')
      expect(sidecar.calls.filter((call) => call.method === 'gateway.session' && (call.params as { profile_home: string }).profile_home.endsWith('/profiles/work')).at(-1)?.params).toMatchObject({ profile_home: join(s.state, 'profiles', 'work') })
    } finally { other.close() }
  })

  it('retires an observed queue that is cancelled before any execution starts', async () => {
    let snap = snapshot({ pending: [admission('queued')] })
    let emit: ((frame: Omit<StreamFrame, 'seq'>) => void) | undefined
    sidecar.respond('gateway.session', (params, send, opts) => {
      if (params.action !== 'watch') return { ...attached(snap), receipt: params.action === 'receipt' ? { ...admission('terminal'), outcome: 'cancelled' } : null }
      emit = send
      send({ event: 'snapshot', data: attached(snap) })
      return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached(snap)) }, { once: true }) })
    })
    const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
    const stream = row.session.active_stream_id!
    const read = s.sse(`/api/chat/stream?stream_id=${stream}`, (frame) => frame.event === 'cancel')
    await vi.waitFor(() => { expect(s.deps.registry.peek(stream)?.subscriberCount).toBe(1) })
    snap = snapshot()
    emit!({ event: 'event', data: { type: 'session.info', session_id: sid, payload: { authority_epoch: 1, execution_generation: 1, running: false, pending: [] } } })
    expect((await read).some((frame) => frame.event === 'cancel')).toBe(true)
    await vi.waitFor(() => { expect(s.deps.registry.activeRunStreamForSession(sid)).toBeNull() })
  })

  it('refuses another profile stream even when both homes contain the same session id', async () => {
    const otherPath = join(s.state, 'profiles', 'work', 'state.db')
    mkdirSync(join(otherPath, '..'), { recursive: true })
    const other = openStateDb(otherPath)
    try {
      other.exec(fixture.schema.join('\n'))
      for (const sql of fixture.inserts) other.exec(sql)
      const snap = snapshot({ running: true, pending: [admission()] })
      sidecar.respond('gateway.session', (params, _emit, opts) => params.action === 'watch'
        ? new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached(snap)) }, { once: true }) }) : attached(snap))
      const root = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
      const stream = root.session.active_stream_id!
      for (const path of ['/api/chat/stream', '/api/chat/stream/status', '/api/chat/cancel']) {
        const response = await s.get(`${path}?stream_id=${stream}`, { headers: { cookie: 'hermes_profile=work' } })
        expect(response.status, path).toBe(404)
      }
      expect(s.deps.requestScope.run({ requestProfile: 'work' }, () => s.deps.registry.activeRunStreamForSession(sid))).toBeNull()
      await s.deps.sessions.owner!.close()
      // The scope guard still holds for journal replay after the live channel has retired.
      expect((await s.get(`/api/chat/stream?stream_id=${stream}`, { headers: { cookie: 'hermes_profile=work' } })).status).toBe(404)
    } finally { other.close() }
  })
})

describe('diagnostic execution modes (TAL-1040)', () => {
  let s: TestServer
  let db: DatabaseSync
  let sidecar: FakeSidecar
  const ids = { cli: fixture.sessions.cli!, ...fixture.diagnostic }
  const fresh = (session: string): GatewaySnapshot => snapshot({ session_id: session, stored_session_id: session, messages: [], message_count: 0, revision: 1, execution_generation: 0, info: { model: 'fixture', source: 'cli' } })
  beforeEach(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
    db = openStateDb(join(s.state, 'state.db'))
    db.exec(fixture.schema.join('\n'))
    for (const sql of fixture.inserts) db.exec(sql)
    await s.deps.settings.save({ show_cli_sessions: true })
    sidecar.respond('gateway.session', (params) => attached(fresh(params.session_id)))
  })
  afterEach(async () => { db.close(); await s.close() })
  const post = (path: string, body: unknown) => s.get(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  it.each([['safe', ids.safe], ['ignore_config', ids.ignore_config]] as const)('starts a %s chat through its owner and shows the frozen mode', async (mode, created) => {
    sidecar.respond('gateway.create', () => attached(fresh(created)))
    const response = await post('/api/session/new', { execution_mode: mode, model: 'fixture', model_provider: 'custom' })
    expect(response.status, await response.clone().text()).toBe(200)
    const body = SessionEnvelopeSchema.parse(await response.json())
    expect(body.session).toMatchObject({ session_id: created, execution_mode: mode, read_only: true, owner_attachment: { state: 'attached', can_submit: true } })
    const calls = sidecar.calls.filter((c) => c.method === 'gateway.create').map((c) => c.params as Record<string, unknown>)
    expect(calls).toEqual([expect.objectContaining({ profile_home: s.state, execution_mode: mode, model: 'fixture', provider: 'custom' })])
    expect(String(calls[0]!.cwd)).toMatch(/^\//)
    expect(calls[0]!.request_id).toMatch(/^talaria-web:[0-9a-f-]{36}$/)
    expect(JSON.stringify(calls)).not.toMatch(/api_key/)
    expect(await s.deps.sessionStore.exists(created)).toBe(false)
    expect(sidecar.calls.some((c) => c.method === 'chat.start')).toBe(false)
  })

  it.each([
    ['lmstudio', 'lmstudio', 'http://127.0.0.1:1234/v1'],
    ['custom:local-box', 'custom', 'http://127.0.0.1:9000/v1'],
  ] as const)('launches %s at its configured endpoint, not only the profile default route', async (provider, sent, url) => {
    writeFileSync(join(s.state, 'config.yaml'), 'model: {}\n')
    sidecar.respond('config.get', () => ({ path: join(s.state, 'config.yaml'), exists: true, config: { model: { provider: 'openrouter', default: 'other' }, providers: { lmstudio: { base_url: 'http://127.0.0.1:1234/v1' } },
      custom_providers: [{ name: 'local box', base_url: 'http://127.0.0.1:9000/v1' }] } }))
    await s.deps.agentConfig.read(s.state)
    sidecar.respond('gateway.create', () => attached(fresh(ids.safe)))
    const response = await post('/api/session/new', { execution_mode: 'safe', model: 'fixture', model_provider: provider })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(sidecar.calls.filter((c) => c.method === 'gateway.create').map((c) => c.params)).toEqual([expect.objectContaining({ provider: sent, base_url: url })])
  })

  it('keeps Web-created diagnostic chats in the sidebar when external Agent sessions are hidden', async () => {
    await s.deps.settings.save({ show_cli_sessions: false })
    const listed = (await (await s.get('/api/sessions')).json() as { sessions: { session_id: string; execution_mode?: string }[] }).sessions
    // The Web-created chat whose first turn never ran stays discoverable too; another client's config-only chat does not.
    expect(listed.map((row) => row.session_id).sort()).toEqual([ids.safe, ids.fresh].sort())
    for (const row of listed) expect(row).toMatchObject({ execution_mode: 'safe', read_only: true })
  })

  it('reads every effective mode from the owner receipt, so it survives a server restart', async () => {
    for (const [sid, mode] of [[ids.safe, 'safe'], [ids.ignore_config, 'ignore_config'], [ids.cli, 'normal']] as const) {
      const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
      expect(row.session.execution_mode, sid).toBe(mode)
    }
  })

  it.each([
    [{ state: 'incompatible', reason: 'native_sessions_unavailable' }, 'agent_unsupported'],
    [{ state: 'incompatible', reason: 'execution_mode_unavailable' }, 'agent_unsupported'],
    [{ state: 'incompatible', reason: 'served_profile_sessions_unavailable' }, 'served_profile'],
    [{ state: 'stopped', reason: 'stopped' }, 'gateway_stopped'],
    [{ state: 'unavailable', reason: 'owner_connection_lost' }, 'gateway_unavailable'],
  ] as const)('refuses a diagnostic chat the owner cannot start (%o) without a local fallback', async (refusal, reason) => {
    sidecar.respond('gateway.create', () => ({ ...refusal, snapshot: null, receipt: null }))
    const response = await post('/api/session/new', { execution_mode: 'safe', model: 'fixture' })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'execution_mode_unavailable', reason })
    const modes = await (await s.get('/api/session/execution-modes')).json()
    expect(modes).toEqual({ modes: [{ mode: 'normal', available: true, reason: null, can_attach: true, can_reference: true }, { mode: 'ignore_config', available: false, reason, can_attach: false, can_reference: false }, { mode: 'safe', available: false, reason, can_attach: false, can_reference: false }] })
    expect(sidecar.calls.filter((c) => c.method === 'gateway.create').map((c) => c.params)).toContainEqual({ profile_home: s.state, probe: true })
    expect((await (await s.get('/api/sessions')).json() as { sessions: { session_id: string }[] }).sessions.map((row) => row.session_id).sort()).toEqual([ids.cli, fixture.sessions.tui!, fixture.sessions.acp!, ids.safe, ids.ignore_config, ids.fresh].sort())
  })

  it('reports available modes from a capable owner and keeps normal chats on the local path', async () => {
    sidecar.respond('gateway.create', () => ({ state: 'attached', reason: null, snapshot: null, receipt: null }))
    expect(await (await s.get('/api/session/execution-modes')).json()).toEqual({ modes: [
      { mode: 'normal', available: true, reason: null, can_attach: true, can_reference: true }, { mode: 'ignore_config', available: true, reason: null, can_attach: false, can_reference: false },
      { mode: 'safe', available: true, reason: null, can_attach: false, can_reference: false }] })
    const normal = await post('/api/session/new', { execution_mode: 'normal', model: 'fixture' })
    expect(normal.status).toBe(200)
    expect(SessionEnvelopeSchema.parse(await normal.json()).session).not.toHaveProperty('owner_attachment')
    expect(sidecar.calls.filter((c) => c.method === 'gateway.create').map((c) => c.params)).toEqual([{ profile_home: s.state, probe: true }])
  })

  it('reuses the client creation id so a retried creation recovers the same owner session', async () => {
    sidecar.respond('gateway.create', () => attached(fresh(ids.safe)))
    for (let i = 0; i < 2; i++) expect((await post('/api/session/new', { execution_mode: 'safe', model: 'fixture', request_id: 'stable-creation' })).status).toBe(200)
    expect(sidecar.calls.filter((c) => c.method === 'gateway.create').map((c) => (c.params as { request_id: string }).request_id)).toEqual(['talaria-web:stable-creation', 'talaria-web:stable-creation'])
    expect((await post('/api/session/new', { execution_mode: 'safe', model: 'fixture', request_id: 'bad id!' })).status).toBe(400)
  })

  it('answers with the shared App fixture: modes, a created and an existing diagnostic chat, and the refusal (TAL-1045)', async () => {
    const shared = JSON.parse(readFileSync(new URL('../../../../../contracts/fixtures/execution-modes.json', import.meta.url), 'utf8')) as Record<'available' | 'unavailable' | 'create_request' | 'created' | 'existing' | 'refusal', unknown>
    sidecar.respond('gateway.create', (params) => (params as { probe?: boolean }).probe ? { state: 'attached', reason: null, snapshot: null, receipt: null } : attached(fresh(ids.safe)))
    expect(await (await s.get('/api/session/execution-modes')).json()).toEqual(shared.available)
    const created = await post('/api/session/new', shared.create_request)
    expect(created.status, await created.clone().text()).toBe(200)
    expect(await created.json()).toMatchObject(shared.created as object)
    expect(sidecar.calls.filter((c) => c.method === 'gateway.create' && !(c.params as { probe?: boolean }).probe).map((c) => (c.params as { request_id: string }).request_id)).toEqual(['talaria-web:fixture-creation-1'])
    expect(await (await s.get(`/api/session?session_id=${ids.ignore_config}`)).json()).toMatchObject(shared.existing as object)
    sidecar.respond('gateway.create', () => ({ state: 'stopped', reason: 'stopped', snapshot: null, receipt: null }))
    expect(await (await s.get('/api/session/execution-modes')).json()).toEqual(shared.unavailable)
    const refused = await post('/api/session/new', shared.create_request)
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual(shared.refusal)
  })

  it('refuses a diagnostic chat without an explicit model or with a worktree', async () => {
    sidecar.respond('gateway.create', () => attached(fresh(ids.safe)))
    expect((await post('/api/session/new', { execution_mode: 'safe', worktree: true, model: 'fixture' })).status).toBe(400)
    expect((await post('/api/session/new', { execution_mode: 'bogus' })).status).toBe(400)
    expect(sidecar.calls.some((c) => c.method === 'gateway.create')).toBe(false)
  })
})
