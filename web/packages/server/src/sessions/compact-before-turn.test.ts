/**
 * TAL-1005: an over-threshold session compacts in its joinable compression job (`chat.compress`) before the next turn
 * reads its history, instead of inside the turn's cancellable `chat.start`. A Stop ends only the turn's wait, a resend
 * joins the same job, and a turn that settles over the threshold starts the job in the background.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidecarParams, SidecarResult } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { bootTestServer, type SseFrame, type TestServer } from '../test/harness.js'
import { str } from '../util.js'

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
    const session = s.deps.sessionStore.get(sid)
    Object.assign(session, { messages: structuredClone(ORIGINAL), ...fields })
    s.deps.sessionStore.save(session)
    return sid
  }
  async function turn(sid: string, message: string, body: Json = {}): Promise<{ streamId: string; frames: SseFrame[] }> {
    const res = await post(s, '/api/chat/start', { session_id: sid, message, ...body })
    expect(res.status).toBe(200)
    const streamId = String((await json(res)).stream_id)
    return { streamId, frames: await s.sse(`/api/chat/stream?stream_id=${streamId}&after_event_id=${streamId}:0`, (f) => f.event === 'stream_end' || f.event === 'apperror') }
  }
  const OVER = { last_prompt_tokens: 500, threshold_tokens: 400, next_turn_threshold_tokens: 400 }

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
        await vi.waitFor(() => { expect(s.deps.sessionStore.get(sid).active_stream_id).toBeNull() })
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
        const stored = s.deps.sessionStore.get(sid)
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
    expect(contents(s.deps.sessionStore.get(sid).context_messages).slice(0, 2)).toEqual(['one', 'four'])
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
    expect(s.deps.sessionStore.get(sid).next_turn_threshold_tokens).toBe(400)
  })

  it('starts no job and adds no wait under the threshold', async () => {
    const sid = await seeded({ last_prompt_tokens: 300, threshold_tokens: 400, next_turn_threshold_tokens: 400 })
    const { frames } = await turn(sid, 'small')
    expect(events(frames)).not.toContain('compressing')
    expect(compressCalls).toBe(0)
    expect(contents(turns[0]!)).toEqual(['one', 'two', 'three', 'four'])
    expect((await json(await s.get(`/api/session/compress/status?session_id=${sid}`))).status).toBe('idle')
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
