/**
 * TAL-1005: an over-threshold session compacts in its joinable compression job (`chat.compress`) before the next turn
 * reads its history, instead of inside the turn's cancellable `chat.start`. A Stop ends only the turn's wait, a resend
 * joins the same job, and a turn that settles over the threshold starts the job in the background.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidecarParams, SidecarResult } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { bootTestServer, type SseFrame, type TestServer } from '../test/harness.js'
import { str } from '../util.js'
import { isCompactionRow } from './merge.js'

type Json = Record<string, unknown>
type ChatResult = SidecarResult<'chat.start'>
type ChatContext = ChatResult['context']
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

const ORIGINAL: Json[] = [
  { role: 'user', content: 'one', timestamp: 1 },
  { role: 'assistant', content: 'two', timestamp: 2 },
  { role: 'user', content: 'three', timestamp: 3 },
  { role: 'assistant', content: 'four', timestamp: 4 },
]

/** The Agent's `compress_now` keeping the first and last rows. */
const compressed = (params: SidecarParams<'chat.compress'>): SidecarResult<'chat.compress'> => {
  const history = params.conversation_history
  return {
    status: 'compressed', messages: [history[0]!, history.at(-1)!], before_tokens: 500, after_tokens: 120, message: null, agent_session_id: params.session_id, commit_token: 'token-1',
    summary: { noop: false, headline: `Compressed: ${history.length} → 2 messages`, token_line: 'Approx request size: ~500 → ~120 tokens', note: null },
  }
}

const reply = (params: SidecarParams<'chat.start'>, context: ChatContext = {}): ChatResult => ({
  status: 'completed', messages: [...params.conversation_history, { role: 'user', content: str(params.user_message) }, { role: 'assistant', content: `answer to ${str(params.user_message)}` }], final_response: 'ok', error: null, failed: false, partial: false,
  compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '', usage: { prompt_tokens: 120, completion_tokens: 30, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0.001 },
  context: { context_length: 2000, last_prompt_tokens: 150, ...context }, model: 'test-model', provider: 'test', compressed: false, agent_session_id: params.session_id, token_sent: true, pending_steer: '', live_tool_calls: [],
})

const contents = (rows: unknown[]): unknown[] => rows.map((m) => (m as Json).content)
const events = (frames: SseFrame[]): string[] => frames.map((f) => f.event)

describe('compaction before the next turn', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  /** `conversation_history` of every `chat.start`, and the number of `chat.compress` calls. */
  let turns: unknown[][] = []
  let compressCalls = 0
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
  })
  afterAll(() => s.close())
  beforeEach(() => {
    turns = []
    compressCalls = 0
    sidecar.respond('runtime.ensure_current', () => ({ current: true as const, agent_revision: null }))
    sidecar.respond('chat.compress', (params) => { compressCalls += 1; return compressed(params) })
    sidecar.respond('chat.compress_finalize', () => ({ finalized: true }))
    sidecar.respond('chat.evict_agent', () => ({ evicted: true }))
    sidecar.respond('chat.interrupt', () => ({ ok: false, reason: 'not_running' }))
    sidecar.respond('chat.start', (params) => { turns.push(params.conversation_history); return reply(params) })
  })

  /** A session whose last turn left `fields` (its context figures) on it. */
  async function seeded(fields: Json): Promise<string> {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const session = (await s.deps.sessionStore.get(sid))
    Object.assign(session, { messages: structuredClone(ORIGINAL), ...fields })
    await s.deps.sessionStore.save(session)
    return sid
  }
  async function turn(sid: string, message: string, body: Json = {}): Promise<{ streamId: string; frames: SseFrame[] }> {
    const res = await post(s, '/api/chat/start', { session_id: sid, message, ...body })
    expect(res.status).toBe(200)
    const streamId = String((await json(res)).stream_id)
    return { streamId, frames: await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:0`, (f) => f.event === 'stream_end' || f.event === 'apperror') }
  }
  const OVER = { last_prompt_tokens: 500, threshold_tokens: 400, next_turn_threshold_tokens: 400 }

  it('publishes server-owned compressing status while pre-turn compaction is held (TAL-1058)', async () => {
    const sid = await seeded(OVER)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    sidecar.respond('chat.compress', async (params) => { await gate; return compressed(params) })
    const streamId = String((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'after compaction' }))).stream_id)
    let settled: SseFrame[] = []
    try {
      const waiting = await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'compressing')
      expect(waiting.filter((f) => f.event === 'run_status').at(-1)?.data).toEqual({ session_id: sid, status: { phase: 'compressing' } })
      expect(((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).run_status).toEqual({ phase: 'compressing' })
      expect(turns).toEqual([])
    } finally {
      release()
      settled = await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:0`, (f) => f.event === 'stream_end')
    }
    expect(settled.filter((f) => f.event === 'run_status').map((f) => (f.data as Json).status)).toEqual([{ phase: 'compressing' }, { phase: 'working' }, null])
  })

  for (const mode of ['deferred', 'eager'] as const) {
    it(`keeps one job running across a Stop during the wait, and a resend joins it (${mode} save)`, async () => {
      const turnDeps = (s.deps.turns as unknown as { deps: { saveMode: () => 'deferred' | 'eager' } }).deps
      const saveMode = turnDeps.saveMode
      turnDeps.saveMode = () => mode
      try {
        const sid = await seeded(OVER)
        let release!: () => void
        const gate = new Promise<void>((r) => { release = r })
        sidecar.respond('chat.compress', async (params) => { compressCalls += 1; await gate; return compressed(params) })
        const first = String((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'first' }))).stream_id)
        // The live stream shows the wait; the Agent has not been asked for a turn.
        await s.sse(`/api/chat/stream?stream_id=${first}`, (f) => f.event === 'compressing')
        expect((await s.get(`/api/chat/cancel?stream_id=${first}`)).status).toBe(200)
        const stopped = await s.sse(`/api/chat/stream?stream_id=${first}&after_event_id=${first}:0`, (f) => f.event === 'cancel')
        expect(events(stopped)).toEqual(expect.arrayContaining(['compressing', 'cancel']))
        // The Stop ended the turn, not the job.
        expect((await json(await s.get(`/api/session/compress/status?session_id=${sid}`))).status).toBe('running')
        await vi.waitFor(async () => { expect((await s.deps.sessionStore.get(sid)).active_stream_id).toBeNull() })
        // The resend is admitted at once and waits on the same job.
        const res = await post(s, '/api/chat/start', { session_id: sid, message: 'second' })
        expect(res.status).toBe(200)
        const second = String((await json(res)).stream_id)
        await s.sse(`/api/chat/stream?stream_id=${second}`, (f) => f.event === 'compressing')
        expect(turns).toEqual([])
        release()
        const frames = await s.sse(`/api/chat/stream?stream_id=${second}&after_event_id=${second}:0`, (f) => f.event === 'stream_end')
        expect(events(frames).filter((e) => ['compressing', 'compressed', 'done'].includes(e))).toEqual(['compressing', 'compressed', 'done'])
        expect(compressCalls).toBe(1)
        // The resend's history is the compacted context: the compressed rows first.
        expect(turns).toHaveLength(1)
        expect(contents(turns[0]!).slice(0, 2)).toEqual(['one', 'four'])
        expect(contents(turns[0]!)).not.toContain('two')
        const stored = (await s.deps.sessionStore.get(sid))
        expect(stored.active_stream_id).toBeNull()
        expect(contents(stored.messages)).toEqual(expect.arrayContaining(['one', 'two', 'three', 'four', 'first', 'second', 'answer to second']))
        // The compression anchors to the last row it covered, never a waiting turn's prompt.
        expect(stored.compression_anchor_message_key).toMatchObject({ role: 'assistant', text: 'four' })
      } finally { turnDeps.saveMode = saveMode }
    })
  }

  it('keeps the job of a turn stopped before the job existed, and installs its result', async () => {
    const sid = await seeded(OVER)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let checking!: () => void
    const checked = new Promise<void>((r) => { checking = r })
    // The chat route's own runtime check passes; the job's, right after admission, is held.
    let checks = 0
    sidecar.respond('runtime.ensure_current', async () => { if (++checks === 2) { checking(); await gate } return { current: true as const, agent_revision: null } })
    const streamId = String((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'early' }))).stream_id)
    await checked
    expect((await s.get(`/api/chat/cancel?stream_id=${streamId}`)).status).toBe(200)
    release()
    await vi.waitFor(async () => { expect((await json(await s.get(`/api/session/compress/status?session_id=${sid}`))).status).toBe('done') })
    expect(compressCalls).toBe(1)
    expect(turns).toEqual([])
    expect(contents((await s.deps.sessionStore.get(sid)).context_messages).slice(0, 2)).toEqual(['one', 'four'])
  })

  it('starts the job when a turn settles over the threshold, so the next turn gets the compacted history', async () => {
    const sid = await seeded({})
    sidecar.respond('chat.start', (params) => { turns.push(params.conversation_history); return reply(params, { threshold_tokens: 400, last_prompt_tokens: 500, next_turn_threshold_tokens: 400 }) })
    await turn(sid, 'grow')
    await vi.waitFor(async () => { expect((await json(await s.get(`/api/session/compress/status?session_id=${sid}`))).status).toBe('done') })
    expect(compressCalls).toBe(1)
    sidecar.respond('chat.start', (params) => { turns.push(params.conversation_history); return reply(params, { threshold_tokens: 400, last_prompt_tokens: 150, next_turn_threshold_tokens: 400 }) })
    const { frames } = await turn(sid, 'next')
    // Already compacted: the next turn neither waits nor compresses again.
    expect(events(frames)).not.toContain('compressing')
    expect(compressCalls).toBe(1)
    expect(contents(turns[1]!)).toEqual(['one', 'answer to grow'])
  })

  it("triggers on the primary's threshold after a turn that ran on a larger-window fallback", async () => {
    const sid = await seeded({})
    // The fallback's raised threshold (1000) is above the context; the primary's (400) is not.
    sidecar.respond('chat.start', (params) => { turns.push(params.conversation_history); return reply(params, { threshold_tokens: 1000, last_prompt_tokens: 500, next_turn_threshold_tokens: 400 }) })
    await turn(sid, 'on fallback')
    await vi.waitFor(async () => { expect((await json(await s.get(`/api/session/compress/status?session_id=${sid}`))).status).toBe('done') })
    expect(compressCalls).toBe(1)
    expect((await s.deps.sessionStore.get(sid)).next_turn_threshold_tokens).toBe(400)
  })

  it('starts no job and adds no wait under the threshold', async () => {
    const sid = await seeded({ last_prompt_tokens: 300, threshold_tokens: 400, next_turn_threshold_tokens: 400 })
    const { frames } = await turn(sid, 'small')
    expect(events(frames)).not.toContain('compressing')
    expect(compressCalls).toBe(0)
    expect(contents(turns[0]!)).toEqual(['one', 'two', 'three', 'four'])
    expect((await json(await s.get(`/api/session/compress/status?session_id=${sid}`))).status).toBe('idle')
  })

  it('judges a session the last turn compressed by its post-compression estimate, not the stale prompt size', async () => {
    const sid = await seeded({ ...OVER, post_compression_context_tokens_estimate: 150 })
    const { frames } = await turn(sid, 'after an auto-compression')
    expect(events(frames)).not.toContain('compressing')
    expect(compressCalls).toBe(0)
  })

  it("keeps the session's place in the list when an automatic job installs its result", async () => {
    const sid = await seeded(OVER)
    const before = (await s.deps.sessionStore.get(sid)).updated_at
    await new Promise((r) => setTimeout(r, 20))
    expect(await s.deps.sessions.ensureCompacted(sid)).toBe(true)
    const stored = (await s.deps.sessionStore.get(sid))
    expect(contents(stored.context_messages)).toEqual(['one', 'four'])
    expect(stored.updated_at).toBe(before)
  })

  it("forgets the old model's figures on a switch, so the first turn on the new model never waits", async () => {
    const sid = await seeded({ ...OVER, post_compression_context_tokens_estimate: 450, model: 'old-model' })
    expect((await post(s, '/api/session/update', { session_id: sid, model: 'new-model' })).status).toBe(200)
    expect((await s.deps.sessionStore.get(sid))).toMatchObject({ next_turn_threshold_tokens: null, post_compression_context_tokens_estimate: null, threshold_tokens: 0, last_prompt_tokens: 0 })
    await turn(sid, 'on the new model', { model: 'new-model' })
    expect(compressCalls).toBe(0)
    // A switch through the turn itself forgets them too, even when that turn fails before reporting its own.
    const switched = await seeded({ ...OVER, post_compression_context_tokens_estimate: 450, model: 'old-model' })
    sidecar.respond('chat.start', () => { throw new SidecarError('provider down', { condition: 'sidecar_error' }) })
    await turn(switched, 'fails', { model: 'new-model' })
    expect((await s.deps.sessionStore.get(switched))).toMatchObject({ next_turn_threshold_tokens: null, post_compression_context_tokens_estimate: null })
    expect(s.deps.sessions.compactionDue((await s.deps.sessionStore.get(switched)))).toBe(false)
  })

  it('tells open clients when a background job installs its result', async () => {
    const sid = await seeded(OVER)
    const reasons: string[] = []
    const publish = s.deps.events.publish.bind(s.deps.events)
    const spy = vi.spyOn(s.deps.events, 'publish').mockImplementation((reason, opts) => { if (opts?.sessionId === sid) reasons.push(String(reason)); publish(reason, opts) })
    try {
      expect(await s.deps.sessions.ensureCompacted(sid)).toBe(true)
      expect(reasons).toContain('session_compress')
    } finally { spy.mockRestore() }
  })

  it("settles a turn that waited on a job with its own figures, whichever model it ran", async () => {
    for (const model of [undefined, 'new-model']) {
      const sid = await seeded({ ...OVER, model: 'old-model' })
      let release!: () => void
      const gate = new Promise<void>((r) => { release = r })
      sidecar.respond('chat.compress', async (params) => { await gate; return compressed(params) })
      const job = s.deps.sessions.ensureCompacted(sid)
      sidecar.respond('chat.start', (params) => { turns.push(params.conversation_history); return reply(params, { threshold_tokens: 400, last_prompt_tokens: 380, next_turn_threshold_tokens: 400 }) })
      const res = await post(s, '/api/chat/start', { session_id: sid, message: 'joins', ...(model ? { model } : {}) })
      const streamId = String((await json(res)).stream_id)
      await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'compressing')
      release()
      await job
      await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:0`, (f) => f.event === 'stream_end')
      // The job's 120-token estimate predates the turn's 380-token prompt, which now decides the next compaction.
      expect((await s.deps.sessionStore.get(sid))).toMatchObject({ post_compression_context_tokens_estimate: null, last_prompt_tokens: 380 })
    }
  })

  it('measures the context again when a turn that waited on a job ends without its result', async () => {
    const sid = await seeded(OVER)
    // A compression that keeps every row leaves enough history for a second one.
    sidecar.respond('chat.compress', (params) => { compressCalls += 1; return { ...compressed(params), messages: params.conversation_history } })
    sidecar.respond('models.estimate_tokens', () => ({ tokens: 450 }))
    sidecar.respond('chat.start', (params) => { turns.push(params.conversation_history); throw new SidecarError('provider down after a long tool run', { condition: 'sidecar_error' }) })
    const { frames } = await turn(sid, 'fails')
    expect(events(frames)).toEqual(expect.arrayContaining(['compressing', 'compressed', 'apperror']))
    // The job's 120-token estimate gives way to the context the failed turn left, which is over the threshold again.
    await vi.waitFor(() => { expect(compressCalls).toBe(2) })
    sidecar.respond('models.estimate_tokens', undefined)
  })

  it("measures a stopped turn's kept prompt with the compressed context when the job commits after the Stop", async () => {
    const sid = await seeded(OVER)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    sidecar.respond('chat.compress', async (params) => { compressCalls += 1; await gate; return compressed(params) })
    sidecar.respond('models.estimate_tokens', (params) => ({ tokens: params.messages.length * 100 }))
    try {
      const streamId = String((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'stopped' }))).stream_id)
      await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'compressing')
      expect((await s.get(`/api/chat/cancel?stream_id=${streamId}`)).status).toBe(200)
      await vi.waitFor(async () => { expect((await s.deps.sessionStore.get(sid)).active_stream_id).toBeNull() })
      release()
      await vi.waitFor(async () => { expect((await json(await s.get(`/api/session/compress/status?session_id=${sid}`))).status).toBe('done') })
      const stored = (await s.deps.sessionStore.get(sid))
      // Not the 120 tokens of the compressed rows alone: the kept prompt is counted too.
      expect(contents(stored.context_messages)).toEqual(['one', 'four', 'stopped'])
      expect(stored.post_compression_context_tokens_estimate).toBe(300)
    } finally { sidecar.respond('models.estimate_tokens', undefined) }
  })

  it("leaves a turn on another model to the Agent's own preflight", async () => {
    const sid = await seeded({ ...OVER, model: 'old-model' })
    let model: unknown
    sidecar.respond('chat.start', (params) => { turns.push(params.conversation_history); model = params.model; return reply(params) })
    await turn(sid, 'switched', { model: 'new-model' })
    expect(model).toBe('new-model')
    expect(compressCalls).toBe(0)
    expect(contents(turns[0]!)).toEqual(['one', 'two', 'three', 'four'])
  })

  const outcomes: [string, (params: SidecarParams<'chat.compress'>) => SidecarResult<'chat.compress'>][] = [
    ['an error', () => { throw new SidecarError('boom', { condition: 'sidecar_error' }) }],
    ['lock_skipped', (params) => ({ ...compressed(params), status: 'lock_skipped', messages: params.conversation_history, summary: null, commit_token: null, message: 'Compression already in progress' })],
    ['nothing_to_do', (params) => ({ ...compressed(params), status: 'nothing_to_do', messages: params.conversation_history, summary: null, commit_token: null, message: 'Nothing to compress yet.' })],
  ]
  for (const [name, outcome] of outcomes) {
    it(`runs the turn as before when the job ends in ${name}`, async () => {
      const sid = await seeded(OVER)
      sidecar.respond('chat.compress', (params) => { compressCalls += 1; return outcome(params) })
      const { frames } = await turn(sid, 'go on')
      expect(compressCalls).toBe(1)
      expect(events(frames)).toContain('done')
      expect(events(frames)).not.toContain('compressed')
      expect(contents(turns[0]!)).toEqual(['one', 'two', 'three', 'four'])
    })
  }
})

/**
 * TAL-1284: an idle session at 95% or more of its next turn's threshold compacts on a maintenance tick, ahead of its next
 * turn, in the same joinable job. The server clock and the ticks are the test's; `chat.compress` is held by gates.
 */
describe('idle compaction ahead of the next turn', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let clock = 1_800_000_000
  let turns: unknown[][] = []
  let compressCalls = 0
  beforeEach(async () => {
    clock = 1_800_000_000
    turns = []
    compressCalls = 0
    sidecar = new FakeSidecar()
    sidecar.respond('runtime.ensure_current', () => ({ current: true as const, agent_revision: null }))
    sidecar.respond('chat.compress', (params) => { compressCalls += 1; return compressed(params) })
    sidecar.respond('chat.compress_finalize', () => ({ finalized: true }))
    sidecar.respond('chat.evict_agent', () => ({ evicted: true }))
    sidecar.respond('chat.interrupt', () => ({ ok: false, reason: 'not_running' }))
    sidecar.respond('chat.finalize_session', () => ({ messages: [] }))
    sidecar.respond('chat.start', (params) => { turns.push(params.conversation_history); return reply(params) })
    s = await bootTestServer({ sidecar, now: () => clock })
  })
  afterEach(() => s.close())

  const NEAR = { last_prompt_tokens: 421_674, threshold_tokens: 425_000, next_turn_threshold_tokens: 425_000 }
  /** A session whose last row is `idle` seconds old and whose last turn left `fields`. */
  async function seeded(fields: Json, idle = 300): Promise<string> {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const session = (await s.deps.sessionStore.get(sid))
    Object.assign(session, { messages: ORIGINAL.map((m, i) => ({ ...m, timestamp: clock - idle - (ORIGINAL.length - 1 - i) })), ...fields })
    await s.deps.sessionStore.save(session)
    return sid
  }
  const tick = (): Promise<void> => s.deps.hygiene.tick()
  const status = async (sid: string): Promise<string> => str((await json(await s.get(`/api/session/compress/status?session_id=${sid}`))).status)
  const settled = async (sid: string): Promise<void> => { await vi.waitFor(async () => { expect(['done', 'error']).toContain(await status(sid)) }) }
  function held(): { release: () => void; started: Promise<void> } {
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const begun = new Promise<void>((r) => { started = r })
    sidecar.respond('chat.compress', async (params) => { compressCalls += 1; started(); await gate; return compressed(params) })
    return { release, started: begun }
  }
  const finalized = (): unknown[] => sidecar.calls.filter((c) => c.method === 'chat.compress_finalize').map((c) => (c.params as Json).committed)

  it('starts at exactly 95% of the threshold after 300 idle seconds, never at 94.99%', async () => {
    const below = await seeded({ last_prompt_tokens: 9_499, threshold_tokens: 10_000, next_turn_threshold_tokens: 10_000 }, 3_600)
    const at = await seeded({ last_prompt_tokens: 9_500, threshold_tokens: 10_000, next_turn_threshold_tokens: 10_000 }, 299)
    await tick()
    expect(compressCalls).toBe(0)
    // Opening the chat is not activity: the clock runs from its last message.
    expect((await s.get(`/api/session?session_id=${at}`)).status).toBe(200)
    clock += 1
    await tick()
    await settled(at)
    expect(compressCalls).toBe(1)
    expect(await status(at)).toBe('done')
    expect(await status(below)).toBe('idle')
  })

  it("compacts the motivating 421674/425000 session while idle, so the next send runs on compacted history", async () => {
    const sid = await seeded(NEAR)
    const before = (await s.deps.sessionStore.get(sid))
    const { updated_at: updatedAt } = before
    await s.deps.sessionStore.deps.drafts.write(sid, { text: 'unsent draft', files: [] })
    await tick()
    await settled(sid)
    expect(compressCalls).toBe(1)
    const stored = (await s.deps.sessionStore.get(sid))
    expect(contents(stored.context_messages)).toEqual(['one', 'four'])
    // Maintenance, not activity: the list order, the transcript's own rows, the draft and the turn count stay.
    expect(stored.updated_at).toBe(updatedAt)
    // The compaction's own row is the only one added (TAL-1566).
    expect(contents(stored.messages.filter((m) => !isCompactionRow(m)))).toEqual(['one', 'two', 'three', 'four'])
    expect(stored.messages.filter(isCompactionRow)).toHaveLength(1)
    expect(stored.messages.filter((m) => m.role === 'user')).toHaveLength(2)
    expect((await s.deps.sessionStore.deps.drafts.read(sid)).text).toBe('unsent draft')
    const { frames } = await turn(sid, 'next')
    expect(events(frames)).not.toContain('compressing')
    expect(compressCalls).toBe(1)
    expect(contents(turns[0]!).slice(0, 2)).toEqual(['one', 'four'])
    expect(contents(turns[0]!)).not.toContain('two')
  })

  async function turn(sid: string, message: string): Promise<{ streamId: string; frames: SseFrame[] }> {
    const res = await post(s, '/api/chat/start', { session_id: sid, message })
    expect(res.status).toBe(200)
    const streamId = String((await json(res)).stream_id)
    return { streamId, frames: await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:0`, (f) => f.event === 'stream_end' || f.event === 'apperror') }
  }
  const archive = async (sid: string, archived: boolean): Promise<void> => { expect((await post(s, '/api/session/archive', { session_id: sid, archived })).status).toBe(200) }

  it('never starts for an archived session, and an unarchived one starts on a later tick', async () => {
    const sid = await seeded(NEAR)
    await archive(sid, true)
    await tick()
    await tick()
    expect(compressCalls).toBe(0)
    await archive(sid, false)
    await tick()
    await settled(sid)
    expect(compressCalls).toBe(1)
  })

  it('drops an idle start archived during its admission', async () => {
    const sid = await seeded(NEAR)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let checking!: () => void
    const checked = new Promise<void>((r) => { checking = r })
    sidecar.respond('runtime.ensure_current', async () => { checking(); await gate; return { current: true as const, agent_revision: null } })
    const ticked = tick()
    await checked
    sidecar.respond('runtime.ensure_current', () => ({ current: true as const, agent_revision: null }))
    await archive(sid, true)
    release()
    await ticked
    expect(await status(sid)).toBe('idle')
    expect(compressCalls).toBe(0)
    await archive(sid, false)
    await tick()
    await settled(sid)
    expect(compressCalls).toBe(1)
  })

  it('installs nothing and finalizes uncommitted when the session is archived or deleted while the provider runs', async () => {
    for (const end of ['archive', 'delete'] as const) {
      const sid = await seeded(NEAR)
      const { release, started } = held()
      await tick()
      await started
      if (end === 'archive') await archive(sid, true)
      else expect((await post(s, '/api/session/delete', { session_id: sid })).status).toBe(200)
      release()
      if (end === 'archive') {
        await settled(sid)
        expect(await status(sid)).toBe('error')
        expect((await s.deps.sessionStore.get(sid)).context_messages).toEqual([])
      } else await vi.waitFor(() => { expect(finalized()).toHaveLength(1) })
      await vi.waitFor(() => { expect(finalized()).toEqual([false]) })
      sidecar.calls.length = 0
      if (end === 'archive') {
        // Unarchived, the same unchanged context is eligible again.
        sidecar.respond('chat.compress', (params) => { compressCalls += 1; return compressed(params) })
        await archive(sid, false)
        await tick()
        await vi.waitFor(async () => { expect(await status(sid)).toBe('done') })
        expect(contents((await s.deps.sessionStore.get(sid)).context_messages)).toEqual(['one', 'four'])
        sidecar.calls.length = 0
      }
    }
  })

  it('takes no new idle work for a profile being deleted, and drops a result it finishes meanwhile', async () => {
    const sid = await seeded(NEAR)
    const deps = s.deps.sessions.deps
    const { profileDeleting } = deps
    let deleting = true
    deps.profileDeleting = (profile) => deleting || profileDeleting?.(profile) === true
    try {
      await tick()
      expect(compressCalls).toBe(0)
      deleting = false
      const { release, started } = held()
      // A new turn's figures rearm the session the refused tick tried.
      const session = (await s.deps.sessionStore.get(sid))
      session.last_prompt_tokens = 421_675
      await s.deps.sessionStore.save(session, { touchUpdatedAt: false })
      await tick()
      await started
      deleting = true
      release()
      await settled(sid)
      expect(await status(sid)).toBe('error')
      expect((await s.deps.sessionStore.get(sid)).context_messages).toEqual([])
      expect(finalized()).toEqual([false])
    } finally { Object.assign(deps, { profileDeleting }) }
  })

  it('does not start when a send lands before admission', async () => {
    const sid = await seeded(NEAR)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let checking!: () => void
    const checked = new Promise<void>((r) => { checking = r })
    // The idle admission's runtime check is held; the send's own passes.
    sidecar.respond('runtime.ensure_current', async () => { checking(); await gate; return { current: true as const, agent_revision: null } })
    const ticked = tick()
    await checked
    sidecar.respond('runtime.ensure_current', () => ({ current: true as const, agent_revision: null }))
    let replying!: () => void
    const replyGate = new Promise<void>((r) => { replying = r })
    sidecar.respond('chat.start', async (params) => { turns.push(params.conversation_history); await replyGate; return reply(params) })
    const streamId = String((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'raced' }))).stream_id)
    await vi.waitFor(() => { expect(turns).toHaveLength(1) })
    release()
    await ticked
    replying()
    await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:0`, (f) => f.event === 'stream_end')
    expect(compressCalls).toBe(0)
    expect(contents(turns[0]!)).toEqual(['one', 'two', 'three', 'four'])
  })

  it('joins a send after admission to the one job, across a Stop and a resend, keeping both prompts', async () => {
    const sid = await seeded(NEAR)
    const { release, started } = held()
    await tick()
    await started
    expect(((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).run_status).toEqual({ phase: 'compressing' })
    const first = String((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'first' }))).stream_id)
    await s.sse(`/api/chat/stream?stream_id=${first}`, (f) => f.event === 'compressing')
    expect((await s.get(`/api/chat/cancel?stream_id=${first}`)).status).toBe(200)
    await s.sse(`/api/chat/stream?stream_id=${first}&after_event_id=${first}:0`, (f) => f.event === 'cancel')
    await vi.waitFor(async () => { expect((await s.deps.sessionStore.get(sid)).active_stream_id).toBeNull() })
    expect(await status(sid)).toBe('running')
    const second = String((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'second' }))).stream_id)
    await s.sse(`/api/chat/stream?stream_id=${second}`, (f) => f.event === 'compressing')
    release()
    const frames = await s.sse(`/api/chat/stream?stream_id=${second}&after_event_id=${second}:0`, (f) => f.event === 'stream_end')
    expect(events(frames).filter((e) => ['compressing', 'compressed', 'done'].includes(e))).toEqual(['compressing', 'compressed', 'done'])
    expect(compressCalls).toBe(1)
    expect(turns).toHaveLength(1)
    expect(contents(turns[0]!).slice(0, 2)).toEqual(['one', 'four'])
    expect(contents((await s.deps.sessionStore.get(sid)).messages)).toEqual(expect.arrayContaining(['one', 'two', 'three', 'four', 'first', 'second', 'answer to second']))
  })

  it('runs one idle job at a time across sessions, joins manual and pre-turn starts, and reaches every candidate', async () => {
    await tick()
    expect(compressCalls).toBe(0)
    const sids = [await seeded(NEAR, 400), await seeded(NEAR, 500), await seeded(NEAR, 600)]
    const { release, started } = held()
    await Promise.all([tick(), tick()])
    await tick()
    await started
    expect(compressCalls).toBe(1)
    const running = sids.filter((sid) => s.deps.sessions.currentRunStatus(sid, null) !== null)
    expect(running).toEqual([sids[0]])
    // The newest idle session goes first; a manual start and a pre-turn start join it.
    const startedAt = (await json(await s.get(`/api/session/compress/status?session_id=${sids[0]!}`))).started_at
    expect((await json(await post(s, '/api/session/compress/start', { session_id: sids[0] }))).started_at).toBe(startedAt)
    const joined = s.deps.sessions.ensureCompacted(sids[0]!, { due: true })
    release()
    expect(await joined).toBe(true)
    await settled(sids[0]!)
    expect(compressCalls).toBe(1)
    for (const sid of sids.slice(1)) {
      await tick()
      await settled(sid)
    }
    expect(compressCalls).toBe(3)
    await tick()
    expect(compressCalls).toBe(3)
  })

  const outcomes: [string, (params: SidecarParams<'chat.compress'>) => SidecarResult<'chat.compress'>][] = [
    ['an error', () => { throw new SidecarError('boom', { condition: 'sidecar_error' }) }],
    ['lock_skipped', (params) => ({ ...compressed(params), status: 'lock_skipped', messages: params.conversation_history, summary: null, commit_token: null, message: 'Compression already in progress' })],
    ['nothing_to_do', (params) => ({ ...compressed(params), status: 'nothing_to_do', messages: params.conversation_history, summary: null, commit_token: null, message: 'Nothing to compress yet.' })],
  ]
  for (const [name, outcome] of outcomes) {
    it(`does not retry unchanged context after ${name}; unarchiving or a new turn's figures rearm it`, async () => {
      const sid = await seeded(NEAR)
      sidecar.respond('chat.compress', (params) => { compressCalls += 1; return outcome(params) })
      await tick()
      await settled(sid)
      for (let i = 0; i < 3; i += 1) { clock += 60; await tick() }
      expect(compressCalls).toBe(1)
      // Unarchiving rearms the unchanged context once; archived, it is never tried.
      await archive(sid, true)
      await tick()
      expect(compressCalls).toBe(1)
      await archive(sid, false)
      await tick()
      await settled(sid)
      await tick()
      expect(compressCalls).toBe(2)
      const session = (await s.deps.sessionStore.get(sid))
      session.last_prompt_tokens = 422_000
      await s.deps.sessionStore.save(session, { touchUpdatedAt: false })
      await tick()
      await settled(sid)
      expect(compressCalls).toBe(3)
    })
  }

  it('does not retrigger once compressed low, and skips invalid or forgotten figures', async () => {
    const sid = await seeded(NEAR)
    await tick()
    await settled(sid)
    clock += 600
    await tick()
    expect(compressCalls).toBe(1)
    for (const fields of [{ last_prompt_tokens: 'many', threshold_tokens: 425_000 }, { last_prompt_tokens: -1, threshold_tokens: 425_000 }, { last_prompt_tokens: 421_674, threshold_tokens: 0, next_turn_threshold_tokens: null }, { last_prompt_tokens: Number.NaN, threshold_tokens: Number.POSITIVE_INFINITY }]) await seeded(fields)
    // A model switch forgets the old model's figures.
    const switched = await seeded({ ...NEAR, model: 'old-model' })
    expect((await post(s, '/api/session/update', { session_id: switched, model: 'new-model' })).status).toBe(200)
    await tick()
    expect(compressCalls).toBe(1)
    // The fallback's raised threshold does not hide the primary's.
    const fallback = await seeded({ last_prompt_tokens: 400, threshold_tokens: 1_000, next_turn_threshold_tokens: 420 })
    await tick()
    await settled(fallback)
    expect(compressCalls).toBe(2)
  })

  it('finds idle sessions from the index after a restart, reading metadata but no transcript until one is admitted', async () => {
    const [eligible, below] = [await seeded(NEAR), await seeded({ last_prompt_tokens: 100, threshold_tokens: 425_000 })]
    // A restarted server: nothing resident, nothing tried.
    for (const sid of [eligible, below]) (s.deps.sessionStore as unknown as { sessions: Map<string, unknown> }).sessions.delete(sid)
    const load = vi.spyOn(s.deps.sessionStore, 'load')
    try {
      await tick()
      await settled(eligible)
      expect(compressCalls).toBe(1)
      expect(load.mock.calls.map(([sid]) => sid)).not.toContain(below)
    } finally { load.mockRestore() }
  })

  it('admits nothing after shutdown and lets an accepted job finish and finalize', async () => {
    const sid = await seeded(NEAR)
    const later = await seeded(NEAR, 900)
    const { release, started } = held()
    await tick()
    await started
    await s.deps.hygiene.stop()
    release()
    await settled(sid)
    expect(finalized()).toEqual([true])
    await tick()
    expect(await status(later)).toBe('idle')
    expect(compressCalls).toBe(1)
  })
})
