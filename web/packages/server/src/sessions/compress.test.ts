/**
 * TAL-255: manual compression on `/api/session/compress` (iOS `/compress`) and the `compress/start` + `compress/status`
 * job the browser polls, against a fake `chat.compress`.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SidecarParams, SidecarResult } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { mergeSessionMessagesAppendOnly } from './merge.js'

type Json = Record<string, unknown>
type CompressResult = SidecarResult<'chat.compress'>
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

const ORIGINAL: Json[] = [
  { role: 'user', content: 'one', timestamp: 1 },
  { role: 'assistant', content: 'two', timestamp: 2 },
  { role: 'user', content: 'three', timestamp: 3 },
  { role: 'assistant', content: 'four', timestamp: 4 },
]
const TOOL_CALLS = [{ id: 'call_1', name: 'terminal', assistant_msg_idx: 1, done: true, result: 'schema.sql' }]

/** The Agent's `compress_now` keeping the first and last rows, with its `summarize_manual_compression` feedback. */
const compressed = (params: SidecarParams<'chat.compress'>): CompressResult => {
  const history = params.conversation_history
  return {
    status: 'compressed', messages: [history[0]!, history.at(-1)!], before_tokens: 400, after_tokens: 120, message: null, agent_session_id: params.session_id,
    summary: { noop: false, headline: `Compressed: ${history.length} → 2 messages`, token_line: 'Approx request size: ~400 → ~120 tokens', note: null },
  }
}

async function waitForTerminal(s: TestServer, sid: string): Promise<Json> {
  for (let i = 0; i < 200; i += 1) {
    const payload = await json(await s.get(`/api/session/compress/status?session_id=${sid}`))
    if (payload.status !== 'running') return payload
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('compression job never finished')
}

describe('manual session compression', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  const ensureCurrent = (): void => { sidecar.respond('runtime.ensure_current', () => ({ current: true as const, agent_revision: null })) }
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
  })
  afterAll(() => s.close())
  beforeEach(() => {
    ensureCurrent()
    sidecar.respond('chat.compress', compressed)
  })

  async function seeded(extra: Json = {}): Promise<string> {
    const res = await post(s, '/api/session/new', {})
    const sid = String(((await json(res)).session as Json).session_id)
    const session = s.deps.sessionStore.get(sid)
    Object.assign(session, { messages: structuredClone(ORIGINAL), tool_calls: structuredClone(TOOL_CALLS), ...extra })
    s.deps.sessionStore.save(session)
    return sid
  }
  const staleRuntime = (): void => {
    sidecar.respond('runtime.ensure_current', () => { throw new SidecarError('restart required', { condition: 'agent_runtime_stale' }) })
  }

  it('requires session_id', async () => {
    const res = await post(s, '/api/session/compress', {})
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('Missing required field(s): session_id')
  })

  it('compresses the model context, keeps the transcript, and anchors the manual compression', async () => {
    const sid = await seeded()
    const bak = `${s.deps.sessionStore.pathFor(sid)}.bak`
    writeFileSync(bak, '{}')
    let seen: SidecarParams<'chat.compress'> | null = null
    sidecar.respond('chat.compress', (params) => { seen = params; return compressed(params) })
    const res = await post(s, '/api/session/compress', { session_id: sid, focus_topic: 'database schema' })
    expect(res.status).toBe(200)
    const payload = await json(res)
    expect(payload).toMatchObject({ ok: true, focus_topic: 'database schema', summary: { headline: 'Compressed: 4 → 2 messages', token_line: 'Approx request size: ~400 → ~120 tokens' } })
    const session = payload.session as Json
    // iOS replaces its transcript with `session.messages` (ChatViewModel), so the reply carries the display rows.
    expect((session.messages as Json[]).map((m) => m.content)).toEqual(['one', 'two', 'three', 'four'])
    expect(session).toMatchObject({ session_id: sid, compression_anchor_visible_idx: 3, compression_anchor_message_key: { role: 'assistant', ts: 4, text: 'four', attachments: 0 }, compression_anchor_summary: 'Approx request size: ~400 → ~120 tokens', context_used_tokens: 120 })
    expect(seen).toMatchObject({ session_id: sid, focus_topic: 'database schema', conversation_history: ORIGINAL.map(({ role, content }) => ({ role, content })) })
    const stored = s.deps.sessionStore.get(sid)
    expect(stored.messages.map((m) => m.content)).toEqual(['one', 'two', 'three', 'four'])
    expect(stored.context_messages.map((m) => [m.role, m.content])).toEqual([['user', 'one'], ['assistant', 'four']])
    expect(stored.tool_calls).toEqual(TOOL_CALLS)
    expect(stored).toMatchObject({ compression_anchor_mode: 'manual', last_prompt_tokens: 120, active_stream_id: null, pending_user_message: null })
    expect(typeof stored.truncation_watermark).toBe('number')
    expect(stored.truncation_boundary).toBe(stored.truncation_watermark)
    expect(existsSync(bak)).toBe(false)
  })

  it('compresses the model context a turn would send, so a repeat compression keeps the earlier summary', async () => {
    const context: Json[] = [
      { role: 'user', content: '[CONTEXT COMPACTION] earlier turns summarized', timestamp: 2.5 },
      { role: 'user', content: 'three', timestamp: 3 },
      { role: 'assistant', content: 'four', timestamp: 4 },
      { role: 'user', content: 'five', timestamp: 5 },
    ]
    const sid = await seeded({ messages: [...structuredClone(ORIGINAL), { role: 'user', content: 'five', timestamp: 5 }], context_messages: structuredClone(context) })
    let sent: unknown
    sidecar.respond('chat.compress', (params) => { sent = params.conversation_history; return compressed(params) })
    expect((await post(s, '/api/session/compress', { session_id: sid })).status).toBe(200)
    expect(sent).toEqual(context.map(({ role, content }) => ({ role, content })))
    expect(s.deps.sessionStore.get(sid).context_messages.map((m) => m.content)).toEqual(['[CONTEXT COMPACTION] earlier turns summarized', 'five'])
  })

  it('stops serving a finished job once its session is deleted', async () => {
    const sid = await seeded()
    expect((await post(s, '/api/session/compress', { session_id: sid })).status).toBe(200)
    expect((await json(await s.get(`/api/session/compress/status?session_id=${sid}`))).status).toBe('done')
    expect((await post(s, '/api/session/delete', { session_id: sid })).status).toBe(200)
    const res = await s.get(`/api/session/compress/status?session_id=${sid}`)
    expect(res.status).toBe(404)
    expect(JSON.stringify(await json(res))).not.toContain('"messages"')
  })

  it('caps the focus topic at 500 characters and accepts the `topic` alias', async () => {
    const sid = await seeded()
    let topic: unknown
    sidecar.respond('chat.compress', (params) => { topic = params.focus_topic; return compressed(params) })
    const res = await post(s, '/api/session/compress', { session_id: sid, topic: `  ${'x'.repeat(600)}  ` })
    expect(res.status).toBe(200)
    expect(topic).toBe('x'.repeat(500))
    expect((await json(res)).focus_topic).toBe('x'.repeat(500))
  })

  it('keeps pre-compression state.db rows out of the model history (#4836)', async () => {
    const sid = await seeded({ context_messages: structuredClone(ORIGINAL) })
    expect((await post(s, '/api/session/compress', { session_id: sid })).status).toBe(200)
    const stored = s.deps.sessionStore.get(sid)
    const replayed = mergeSessionMessagesAppendOnly(stored.context_messages, structuredClone(ORIGINAL), { truncationWatermark: stored.truncation_watermark })
    expect(replayed).toHaveLength(stored.context_messages.length)
  })

  it('answers the old guards: unknown, subagent, streaming, and too-short sessions', async () => {
    expect((await post(s, '/api/session/compress', { session_id: 'missing_session' })).status).toBe(404)
    const child = await seeded({ source_tag: 'subagent' })
    const subagent = await post(s, '/api/session/compress', { session_id: child })
    expect([subagent.status, (await json(subagent)).error]).toEqual([400, 'Subagent sessions are view-only and cannot be compressed from WebUI'])
    const streaming = await seeded({ active_stream_id: 'stream-live' })
    const busy = await post(s, '/api/session/compress', { session_id: streaming })
    expect([busy.status, (await json(busy)).error]).toEqual([409, 'Session is still streaming; wait for the current turn to finish.'])
    const short = await seeded({ messages: ORIGINAL.slice(0, 3) })
    const tooShort = await post(s, '/api/session/compress', { session_id: short })
    expect([tooShort.status, (await json(tooShort)).error]).toEqual([400, 'Not enough conversation to compress (need at least 4 messages).'])
  })

  it('maps sidecar failures: no provider, a held lock, and a sanitized catch-all', async () => {
    const sid = await seeded()
    sidecar.respond('chat.compress', () => { throw new SidecarError('no key', { condition: 'credential_missing' }) })
    const noProvider = await post(s, '/api/session/compress', { session_id: sid })
    expect([noProvider.status, (await json(noProvider)).error]).toEqual([400, 'No provider configured -- cannot compress.'])
    sidecar.respond('chat.compress', (params) => ({ ...compressed(params), status: 'lock_skipped', messages: params.conversation_history, summary: null, message: '⏳ Compression already in progress for this session (holder: cli). Please wait for it to finish.' }))
    const locked = await post(s, '/api/session/compress', { session_id: sid })
    expect([locked.status, (await json(locked)).error]).toEqual([409, '⏳ Compression already in progress for this session (holder: cli). Please wait for it to finish.'])
    sidecar.respond('chat.compress', () => { throw new SidecarError('provider log at /Users/alice/.hermes/secrets/token.txt failed', { condition: 'sidecar_error' }) })
    const failed = await json(await post(s, '/api/session/compress', { session_id: sid }))
    expect(failed.error).toBe('Compression failed: provider log at <path> failed')
    expect(s.deps.sessionStore.get(sid).context_messages).toEqual([])
  })

  it('refuses a stale Agent runtime with the typed 409 before mutating or creating a job', async () => {
    const sid = await seeded()
    const before = JSON.stringify(s.deps.sessionStore.get(sid).toDocument())
    staleRuntime()
    for (const path of ['/api/session/compress', '/api/session/compress/start']) {
      const res = await post(s, path, { session_id: sid })
      expect(res.status).toBe(409)
      expect(await json(res)).toMatchObject({ error: 'restart required', type: 'agent_runtime_stale', retryable: true, restart_scheduled: false })
    }
    expect(JSON.stringify(s.deps.sessionStore.get(sid).toDocument())).toBe(before)
    expect((await json(await s.get(`/api/session/compress/status?session_id=${sid}`))).status).toBe('idle')
  })

  it('reports a stale runtime found by the worker with the same taxonomy', async () => {
    const sid = await seeded()
    sidecar.respond('chat.compress', () => { throw new SidecarError('restart required', { condition: 'agent_runtime_stale' }) })
    expect((await post(s, '/api/session/compress/start', { session_id: sid })).status).toBe(200)
    expect(await waitForTerminal(s, sid)).toMatchObject({ ok: false, status: 'error', session_id: sid, error: 'restart required', error_status: 409, type: 'agent_runtime_stale', retryable: true })
  })

  it('runs one job per session: start returns it running, repeats join it, status reports it through done', async () => {
    const sid = await seeded()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let calls = 0
    sidecar.respond('chat.compress', async (params) => { calls += 1; await gate; return compressed(params) })
    const first = await json(await post(s, '/api/session/compress/start', { session_id: sid, focus_topic: 'slow' }))
    expect(first).toMatchObject({ ok: true, status: 'running', session_id: sid, focus_topic: 'slow' })
    // A repeat start, a stale runtime meanwhile, and the iOS route all join the running job instead of starting another.
    staleRuntime()
    expect(await json(await post(s, '/api/session/compress/start', { session_id: sid, focus_topic: 'slow' }))).toMatchObject({ status: 'running', focus_topic: 'slow' })
    const sync = post(s, '/api/session/compress', { session_id: sid })
    expect((await json(await s.get(`/api/session/compress/status?session_id=${sid}`))).status).toBe('running')
    release()
    expect((await sync).status).toBe(200)
    const done = await waitForTerminal(s, sid)
    expect(done).toMatchObject({ ok: true, status: 'done', summary: { headline: 'Compressed: 4 → 2 messages' }, focus_topic: 'slow' })
    expect(((done.session as Json).messages as Json[]).length).toBe(4)
    expect(calls).toBe(1)
    // Every open tab polling the finished job reads the same result until the TTL drops it.
    expect((await json(await s.get(`/api/session/compress/status?session_id=${sid}`))).status).toBe('done')
    expect(s.deps.sessionStore.get(sid).context_messages.map((m) => m.content)).toEqual(['one', 'four'])
  })

  it('starts a fresh job after a terminal error', async () => {
    const sid = await seeded()
    sidecar.respond('chat.compress', () => { throw new SidecarError('boom', { condition: 'sidecar_error' }) })
    await post(s, '/api/session/compress/start', { session_id: sid })
    expect(await waitForTerminal(s, sid)).toMatchObject({ status: 'error', error_status: 400, error: 'Compression failed: boom' })
    sidecar.respond('chat.compress', compressed)
    expect(await json(await post(s, '/api/session/compress/start', { session_id: sid }))).toMatchObject({ ok: true, status: 'running' })
    expect(await waitForTerminal(s, sid)).toMatchObject({ status: 'done' })
  })

  it('refuses a result the transcript moved past and keeps the concurrent edit', async () => {
    const sid = await seeded()
    sidecar.respond('chat.compress', (params) => {
      const live = s.deps.sessionStore.get(sid)
      live.messages.push({ role: 'user', content: 'concurrent edit', timestamp: 5 })
      s.deps.sessionStore.save(live)
      return compressed(params)
    })
    const res = await post(s, '/api/session/compress', { session_id: sid })
    expect([res.status, (await json(res)).error]).toEqual([409, 'Session was modified during compression; please retry.'])
    const stored = s.deps.sessionStore.get(sid)
    expect(stored.messages.at(-1)?.content).toBe('concurrent edit')
    expect(stored.context_messages).toEqual([])
    expect(stored.compression_anchor_mode).toBeNull()
  })

  it('does not compress over a stream that started while the runtime check awaited', async () => {
    const sid = await seeded()
    let compressCalls = 0
    sidecar.respond('runtime.ensure_current', () => {
      const live = s.deps.sessionStore.get(sid)
      live.active_stream_id = 'stream-raced'
      s.deps.sessionStore.save(live)
      return { current: true as const, agent_revision: null }
    })
    sidecar.respond('chat.compress', (params) => { compressCalls += 1; return compressed(params) })
    const res = await post(s, '/api/session/compress', { session_id: sid })
    expect([res.status, (await json(res)).error]).toEqual([409, 'Session is still streaming; wait for the current turn to finish.'])
    expect(compressCalls).toBe(0)
    expect(s.deps.sessionStore.get(sid).active_stream_id).toBe('stream-raced')
  })

  it('evicts the cached turn agent once the compressed context is installed', async () => {
    const sid = await seeded()
    const before = sidecar.calls.length
    expect((await post(s, '/api/session/compress', { session_id: sid })).status).toBe(200)
    expect(sidecar.calls.slice(before).map((c) => c.method)).toEqual(['runtime.ensure_current', 'chat.compress', 'chat.evict_agent'])
  })

  it('refuses a result once a stream started during the compression', async () => {
    const sid = await seeded()
    sidecar.respond('chat.compress', (params) => {
      const live = s.deps.sessionStore.get(sid)
      live.active_stream_id = 'stream-concurrent'
      s.deps.sessionStore.save(live)
      return compressed(params)
    })
    await post(s, '/api/session/compress/start', { session_id: sid })
    expect(await waitForTerminal(s, sid)).toMatchObject({ ok: false, status: 'error', error_status: 409, error: 'Session stream state changed during compression; please retry.' })
    const stored = s.deps.sessionStore.get(sid)
    expect(stored.active_stream_id).toBe('stream-concurrent')
    expect(stored.context_messages).toEqual([])
  })

  it("compresses in the session's profile home with its model and provider", async () => {
    const sid = await seeded({ profile: 'work', model: 'openai/gpt-5.4-mini', model_provider: 'profile-provider' })
    let seen: SidecarParams<'chat.compress'> | null = null
    sidecar.respond('chat.compress', (params) => { seen = params; return compressed(params) })
    await s.deps.sessions.startCompression(sid, null).then((job) => job.done)
    expect(seen).toMatchObject({ profile_home: s.deps.sessions.deps.profileHome('work'), model: 'openai/gpt-5.4-mini', model_provider: 'profile-provider' })
  })
})
