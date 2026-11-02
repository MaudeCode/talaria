import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionEnvelopeSchema, ChatEventSchema, type GatewaySnapshot } from '@maudecode/talaria-web-contracts'
import type { StreamFrame } from '../sidecar/client.js'
import { type TestServer, openStateDb } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { admission, attached, bootOwnerAttachment, cronRefusal, fixture, ownerHelpers, sid, snapshot } from '../test/gateway-owner.js'

describe('canonical owner attachment', () => {
  let s: TestServer
  let db: DatabaseSync
  let sidecar: FakeSidecar
  beforeEach(async () => { ({ s, db, sidecar } = await bootOwnerAttachment()) })
  afterEach(async () => { db.close(); await s.close() })
  const { post, observeOwner, holdOwnerReceipt } = ownerHelpers(() => ({ s, sidecar }))

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

  it('lights the sidebar row while a native watch runs and announces its start (TAL-1564)', async () => {
    const changes = vi.spyOn(s.deps.events, 'publish')
    const row = async () => ((await (await s.get('/api/sessions')).json() as { sessions: Record<string, unknown>[] }).sessions).find((r) => r.session_id === sid)
    const watch = await observeOwner(snapshot({ running: true, pending: [admission()] }))
    expect(changes.mock.calls.some(([, opts]) => opts?.sessionId === sid)).toBe(true)
    expect(await row()).toMatchObject({ is_streaming: true, active_stream_id: watch.stream })
    watch.finish()
    await watch.read
    await vi.waitFor(async () => { expect(await row()).toMatchObject({ is_streaming: false, active_stream_id: null }) })
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
})
