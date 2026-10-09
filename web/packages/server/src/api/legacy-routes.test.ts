import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import type { RequestContext } from '../http/context.js'
import type { SidecarResult } from '@maudecode/talaria-web-contracts'
import { str } from '../util.js'
import { RAW_GET_ROUTES } from './raw-routes.js'

type Json = Record<string, unknown>
type ChatResult = SidecarResult<'chat.start'>
const post = (s: TestServer, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

const completed = (messages: Json[], extra: Partial<ChatResult> = {}): ChatResult => ({
  status: 'completed', messages, final_response: str(messages[messages.length - 1]?.content), error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '',
  usage: { prompt_tokens: 10, completion_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: { context_length: 200000 }, model: 'test-model', provider: 'test', compressed: false,
  agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [], ...extra,
})

describe('legacy chat and test-hook endpoints', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar, env: { HERMES_WEBUI_TEST_HOOKS: '1' } })
    sidecar.respond('aux.complete', () => { throw new SidecarError('no aux model', { condition: 'aux_unconfigured' }) })
  })
  afterAll(() => s.close())

  async function newSession(): Promise<string> {
    return String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
  }

  it('POST /api/chat runs one turn to its end and answers with the reply and the settled session', async () => {
    const sid = await newSession()
    let history: Json[] = []
    sidecar.respond('chat.start', (params) => {
      history = params.conversation_history
      // The Agent's own copy of the prompt (with recalled context) must come back to it byte for byte next turn.
      const user = history.length ? { role: 'user', content: str(params.user_message) } : { role: 'user', content: str(params.user_message), api_content: 'first\n\n<memory-context>recall</memory-context>' }
      return completed([...history, user, { role: 'assistant', content: history.length ? 'second answer' : 'first answer' }])
    })
    let res = await post(s, '/api/chat', { session_id: sid, message: 'first' })
    expect(res.status).toBe(200)
    let body = await json(res)
    expect(body).toMatchObject({ answer: 'first answer', status: 'done', result: { final_response: 'first answer', completed: true, interrupted: false } })
    expect((body.session as Json).session_id).toBe(sid)
    expect(((body.session as Json).messages as Json[]).map((m) => [m.role, m.content])).toEqual([['user', 'first'], ['assistant', 'first answer']])
    res = await post(s, '/api/chat', { session_id: sid, message: 'second' })
    body = await json(res)
    expect(body).toMatchObject({ answer: 'second answer', status: 'done' })
    expect(history[0]?.api_content).toBe('first\n\n<memory-context>recall</memory-context>')
    // Write-back replaces the replayed context instead of appending a second copy of it.
    expect(s.deps.sessionStore.get(sid).messages.map((m) => m.content)).toEqual(['first', 'first answer', 'second', 'second answer'])
    expect(s.deps.sessionStore.get(sid).active_stream_id).toBeNull()
  })

  it('answers partial with the streamed text when the turn is cancelled or fails after producing text', async () => {
    const sid = await newSession()
    sidecar.respond('chat.interrupt', () => ({ ok: true }))
    sidecar.respond('chat.start', (params, emit, opts) => new Promise((resolve) => {
      emit({ event: 'token', data: { text: 'half an answer' } })
      opts.signal?.addEventListener('abort', () => { resolve({ ...completed([{ role: 'user', content: str(params.user_message) }]), status: 'cancelled' }) })
    }))
    const pending = post(s, '/api/chat', { session_id: sid, message: 'long task' })
    let streamId: string | null = null
    for (let i = 0; i < 100 && !streamId; i += 1) {
      streamId = s.deps.sessionStore.get(sid).active_stream_id
      if (!streamId) await new Promise((r) => setTimeout(r, 10))
    }
    await s.sse(`/api/chat/stream?stream_id=${String(streamId)}`, (f) => f.event === 'token')
    expect(await json(await s.get(`/api/chat/cancel?stream_id=${String(streamId)}`))).toMatchObject({ cancelled: true })
    const cancelled = await pending
    expect(cancelled.status).toBe(200)
    expect(await json(cancelled)).toMatchObject({ answer: 'half an answer', status: 'partial', result: { final_response: 'half an answer', completed: false, interrupted: true } })

    sidecar.respond('chat.start', (_params, emit) => {
      emit({ event: 'token', data: { text: 'started to say' } })
      throw new SidecarError('provider exploded', { condition: 'sidecar_error' })
    })
    const failed = await post(s, '/api/chat', { session_id: sid, message: 'try again' })
    expect(failed.status).toBe(200)
    expect(await json(failed)).toMatchObject({ answer: 'started to say', status: 'partial', result: { completed: false, interrupted: false } })
  })

  it('answers a failure that produced no text with its error frame', async () => {
    const sid = await newSession()
    sidecar.respond('chat.start', () => { throw new SidecarError('provider exploded', { condition: 'sidecar_error' }) })
    let res = await post(s, '/api/chat', { session_id: sid, message: 'doomed' })
    expect(res.status).toBe(500)
    expect(await json(res)).toMatchObject({ error: 'provider exploded', terminal_state: 'error' })
    sidecar.respond('chat.start', () => { throw new SidecarError('Agent checkout changed; restart required', { condition: 'agent_runtime_stale' }) })
    res = await post(s, '/api/chat', { session_id: sid, message: 'doomed' })
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ type: 'agent_runtime_stale' })
    expect(s.deps.sessionStore.get(sid).active_stream_id).toBeNull()
  })

  it('refuses before admission: stale runtime, subagent child, empty message, untrusted workspace, busy session', async () => {
    const sid = await newSession()
    let starts = 0
    sidecar.respond('chat.start', (params) => { starts += 1; return completed([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'ok' }]) })
    sidecar.respond('runtime.ensure_current', () => { throw new SidecarError('restart required', { condition: 'agent_runtime_stale' }) })
    let res = await post(s, '/api/chat', { session_id: sid, message: 'hi' })
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ error: 'restart required', type: 'agent_runtime_stale' })
    sidecar.respond('runtime.ensure_current', undefined)
    res = await post(s, '/api/chat', { session_id: sid, message: '   ' })
    expect(res.status).toBe(400)
    expect(await json(res)).toEqual({ error: 'empty message' })
    res = await post(s, '/api/chat', { session_id: sid, message: 'hi', workspace: '/etc' })
    expect(res.status).toBe(400)
    expect(String((await json(res)).error)).toContain('system directory')
    const child = s.deps.sessionStore.get(sid)
    child.source_tag = 'subagent'
    s.deps.sessionStore.save(child)
    res = await post(s, '/api/chat', { session_id: sid, message: 'hi' })
    expect(res.status).toBe(400)
    expect(await json(res)).toEqual({ error: 'Subagent sessions are view-only and cannot be written from WebUI' })
    const busy = await newSession()
    const held = s.deps.sessionStore.get(busy)
    held.active_stream_id = 'other-stream'
    s.deps.sessionStore.save(held)
    s.deps.registry.liveIds.add('other-stream')
    try {
      res = await post(s, '/api/chat', { session_id: busy, message: 'hi' })
      expect(res.status).toBe(409)
      expect(await json(res)).toMatchObject({ error: 'session already has an active stream', active_stream_id: 'other-stream' })
    } finally { s.deps.registry.liveIds.delete('other-stream') }
    expect(starts).toBe(0)
  })

  it('answers the retired process-complete-ack with 410 and the replacement, even without a CSRF pass', async () => {
    const res = await post(s, '/api/process-complete-ack', { session_id: 'x', process_id: 'p' }, { origin: 'https://elsewhere.example' })
    expect(res.status).toBe(410)
    expect(res.headers.get('x-replaced-by')).toBe('/api/bg-task-complete-ack')
    expect(await json(res)).toEqual({ error: 'gone: /api/process-complete-ack was replaced by /api/bg-task-complete-ack as part of the process_complete -> bg_task_complete event rename', replaced_by: '/api/bg-task-complete-ack' })
    // Every other unsafe route still enforces the same-origin check.
    expect((await post(s, '/api/bg-task-complete-ack', { session_id: 'x' }, { origin: 'https://elsewhere.example' })).status).toBe(403)
  })

  it('injects an approval that respond clears locally, without the sidecar', async () => {
    const sid = 'inject-approval'
    let relayed = 0
    sidecar.respond('approval.respond', (params) => { relayed += 1; return { ok: true, resolved: 1, choice: params.choice } })
    expect(await json(await s.get(`/api/approval/inject_test?session_id=${sid}&pattern_key=recursive+delete&command=${encodeURIComponent('rm -rf /tmp/testdir')}`))).toEqual({ ok: true, session_id: sid })
    expect((await json(await s.get(`/api/approval/pending?session_id=${sid}`))).pending).toMatchObject({ command: 'rm -rf /tmp/testdir', pattern_key: 'recursive delete', pattern_keys: ['recursive delete'], description: 'test pattern' })
    expect(await json(await post(s, '/api/approval/respond', { session_id: sid, choice: 'deny' }))).toEqual({ ok: true, choice: 'deny' })
    expect((await json(await s.get(`/api/approval/pending?session_id=${sid}`))).pending).toBeNull()
    await s.get(`/api/approval/inject_test?session_id=${sid}`)
    expect((await json(await s.get(`/api/approval/pending?session_id=${sid}`))).pending).toMatchObject({ command: 'rm -rf /tmp/test', pattern_key: 'test_pattern' })
    expect(await json(await post(s, '/api/approval/respond', { session_id: sid, choice: 'session' }))).toMatchObject({ ok: true, choice: 'session' })
    expect((await json(await s.get(`/api/approval/pending?session_id=${sid}`))).pending).toBeNull()
    expect(relayed).toBe(0)
    const missing = await s.get('/api/approval/inject_test')
    expect(missing.status).toBe(400)
    expect(await json(missing)).toEqual({ error: 'session_id required' })
  })

  it('injects a clarify prompt that respond clears locally', async () => {
    const sid = 'inject-clarify'
    let relayed = 0
    sidecar.respond('clarify.respond', () => { relayed += 1; return { ok: true } })
    expect(await json(await s.get(`/api/clarify/inject_test?session_id=${sid}&question=${encodeURIComponent('Pick the better option')}&choices=A&choices=B`))).toEqual({ ok: true, session_id: sid })
    expect((await json(await s.get(`/api/clarify/pending?session_id=${sid}`))).pending).toMatchObject({ question: 'Pick the better option', choices_offered: ['A', 'B'], kind: 'clarify' })
    expect(await json(await post(s, '/api/clarify/respond', { session_id: sid, response: 'B' }))).toEqual({ ok: true, response: 'B' })
    expect((await json(await s.get(`/api/clarify/pending?session_id=${sid}`))).pending).toBeNull()
    expect(relayed).toBe(0)
    expect((await s.get('/api/clarify/inject_test')).status).toBe(400)
  })

  it('hides the inject hooks without the flag or from a non-loopback peer', async () => {
    const env = s.deps.config.env as Record<string, string | undefined>
    env.HERMES_WEBUI_TEST_HOOKS = ''
    try {
      for (const path of ['/api/approval/inject_test', '/api/clarify/inject_test']) {
        const res = await s.get(`${path}?session_id=hidden`)
        expect(res.status).toBe(404)
        expect(await json(res)).toEqual({ error: 'not found' })
      }
    } finally { env.HERMES_WEBUI_TEST_HOOKS = '1' }
    expect(s.deps.pending.approvalPending('hidden').pending).toBeNull()
    for (const peer of ['10.0.0.5', '192.168.1.20', '::ffff:10.0.0.5']) {
      let answer: [unknown, number | undefined] | null = null
      const ctx = { deps: s.deps, peer, query: new URLSearchParams('session_id=remote'), json: (body: unknown, opts?: { status?: number }) => { answer = [body, opts?.status] } } as unknown as RequestContext
      await RAW_GET_ROUTES['/api/approval/inject_test']!(ctx)
      expect(answer).toEqual([{ error: 'not found' }, 404])
    }
    expect(s.deps.pending.approvalPending('remote').pending).toBeNull()
  })
})
