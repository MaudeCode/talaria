import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextDetailSchema, SessionEnvelopeSchema, type GatewaySnapshot, type GatewaySessionResult } from '@maudecode/talaria-web-contracts'
import type { StreamFrame } from '../sidecar/client.js'
import { bootTestServer, type TestServer, openStateDb } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { CANONICAL_READ_ONLY_REASON, type StateDbWorkerRequest } from './state-db.js'
import { GatewaySessions } from './gateway-sessions.js'
import { TerminalSession } from '../tools/terminal.js'
import { admission, attached, bootOwnerAttachment, fixture, nativeNotices, ownerHelpers, sid, snapshot } from '../test/gateway-owner.js'

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
  beforeEach(async () => { ({ s, db, sidecar } = await bootOwnerAttachment()) })
  afterEach(async () => { db.close(); await s.close() })
  const { post } = ownerHelpers(() => ({ s, sidecar }))

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

  it('refuses a diagnostic chat in a project, whose owner chat Web could not file there (TAL-1032)', async () => {
    await s.deps.projects.mutate((rows) => { rows.push({ project_id: 'diagproject1', name: 'Diagnostic', profile: 'default', model: 'fixture', model_provider: 'custom' }) })
    const response = await post('/api/session/new', { execution_mode: 'safe', project_id: 'diagproject1' })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'A diagnostic chat cannot start in a project' })
    expect(sidecar.calls.some((c) => c.method === 'gateway.create')).toBe(false)
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

describe('diagnostic chats under person isolation (TAL-48)', () => {
  it('belong to the person who started them, not to other people or owners', async () => {
    const issuer = 'https://identity.invalid'
    const sidecar = new FakeSidecar()
    const s = await bootTestServer({ sidecar, env: {
      HERMES_WEBUI_PERSON_ISOLATION: '1', HERMES_WEBUI_OIDC_ISSUER: issuer, HERMES_WEBUI_OIDC_CLIENT_ID: 'synthetic-client',
      HERMES_WEBUI_OIDC_ALLOW_CLAIM: 'email_verified', HERMES_WEBUI_OIDC_ALLOW_VALUES: 'true', HERMES_WEBUI_OIDC_OWNER_CLAIM: 'groups', HERMES_WEBUI_OIDC_OWNER_VALUES: 'admins',
    }, deps: (deps) => { deps.oidc.sessionBindingIsCurrent = () => Promise.resolve(true) } })
    const db = openStateDb(join(s.state, 'state.db'))
    try {
      db.exec(fixture.schema.join('\n'))
      for (const sql of fixture.inserts) db.exec(sql)
      const created = fixture.diagnostic.safe
      const fresh = snapshot({ session_id: created, stored_session_id: created, messages: [], message_count: 0, revision: 1, execution_generation: 0, info: { model: 'fixture', source: 'cli' } })
      sidecar.respond('gateway.session', () => attached(fresh))
      sidecar.respond('gateway.create', () => attached(fresh))
      const signIn = (subject: string, owner = false) => {
        const cookie = s.deps.auth.createSession({ authType: 'oidc', username: subject, oidcBinding: { issuer, subject, ...(owner ? { owner: true } : {}) } })
        return { cookie: `${s.deps.auth.cookieName()}=${cookie}`, origin: s.base, 'X-Hermes-CSRF-Token': s.deps.auth.csrfTokenForSession(cookie)!, 'content-type': 'application/json' }
      }
      const alice = signIn('alice')
      const bob = signIn('bob')
      const start = (headers: Record<string, string>) => s.get('/api/session/new', { method: 'POST', headers, body: JSON.stringify({ execution_mode: 'safe', model: 'fixture', request_id: 'shared-retry' }) })
      const response = await start(alice)
      expect(response.status, await response.clone().text()).toBe(200)
      expect(SessionEnvelopeSchema.parse(await response.json()).session.session_id).toBe(created)
      expect((await s.get(`/api/session?session_id=${created}`, { headers: alice })).status).toBe(200)
      for (const other of [bob, signIn('olive', true)]) expect((await s.get(`/api/session?session_id=${created}`, { headers: other })).status).toBe(404)
      // The same request id from Bob is a different creation, and even an owner answering with Alice's chat never hands it over.
      expect((await start(bob)).status).toBe(404)
      const keys = sidecar.calls.filter((c) => c.method === 'gateway.create').map((c) => (c.params as { request_id: string }).request_id)
      expect(keys).toHaveLength(2)
      expect(keys[0]).not.toBe(keys[1])
      expect((await s.get(`/api/session?session_id=${created}`, { headers: alice })).status).toBe(200)
      expect((await s.get(`/api/session?session_id=${created}`, { headers: bob })).status).toBe(404)
    } finally {
      db.close()
      await s.close()
    }
  })
})
