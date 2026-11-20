/** TAL-2022: the server writes an approval's "in plain words" summary once, through a stubbed `aux.complete`. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidecarResult } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { str } from '../util.js'

type Json = Record<string, unknown>
const SUMMARY = 'Deletes every .log file older than a week under the current folder.'
const finished: SidecarResult<'chat.start'> = {
  status: 'completed', messages: [{ role: 'user', content: 'clean' }, { role: 'assistant', content: 'done' }], final_response: 'done', error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '',
  usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: null }, context: {}, model: 'test-model', provider: 'test', compressed: false, agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [],
}

describe('approval explanations', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let finishTurn: () => void = vi.fn()
  let sid = ''
  let streamId = ''
  const post = (path: string, body: unknown) => s.get(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const head = async () => ((await (await s.get(`/api/approval/pending?session_id=${sid}`)).json()) as { pending: Json }).pending
  const asks = () => sidecar.calls.filter((c) => c.method === 'aux.complete' && (c.params as Json).task === 'approval').map((c) => c.params as Json)

  const park = async () => {
    sidecar.respond('chat.start', (_params, emit) => {
      emit({ event: 'approval', data: { request_id: 'clean-logs', pattern_key: 'delete', command: "find . -name '*.log' -mtime +7 -delete", tool_name: 'terminal' } })
      return new Promise((resolve) => { finishTurn = () => { resolve(finished) } })
    })
    sid = str(((await (await post('/api/session/new', {})).json()) as { session: Json }).session.session_id)
    const start = await post('/api/chat/start', { session_id: sid, message: 'clean' })
    streamId = str(((await start.json()) as Json).stream_id)
    await s.sse(`/api/approval/stream?session_id=${sid}`, (f) => Boolean((f.data as Json).pending))
  }

  beforeEach(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
  })
  afterEach(async () => { finishTurn(); await s.close() })

  it('asks the model once per approval and ships its summary on every read and the chat stream', async () => {
    let answer!: () => void
    sidecar.respond('aux.complete', () => new Promise((resolve) => { answer = () => { resolve({ model: 'aux', text: `  ${SUMMARY}\n`, usage: null, finish_reason: 'stop' }) } }))
    await post('/api/settings', { explain_approvals: true })
    await park()
    expect((await head()).explanation).toEqual({ state: 'pending' })
    await vi.waitFor(() => { expect(asks()).toHaveLength(1) })
    answer()
    const frames = await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'approval' && (f.data as Json).explanation !== undefined && ((f.data as { explanation: Json }).explanation.state === 'ready'))
    expect(frames.at(-1)?.data).toMatchObject({ approval_id: 'clean-logs', explanation: { state: 'ready', text: SUMMARY } })
    for (let read = 0; read < 3; read++) expect((await head()).explanation).toEqual({ state: 'ready', text: SUMMARY })
    expect(asks()).toHaveLength(1)
    expect(asks()[0]).toMatchObject({ task: 'approval', main_fallback: true })
    expect(JSON.stringify(asks()[0]?.messages)).toContain("find . -name '*.log' -mtime +7 -delete")
  })

  it('ships unavailable when no model answers', async () => {
    sidecar.respond('aux.complete', () => { throw new Error('no aux model') })
    await post('/api/settings', { explain_approvals: true })
    await park()
    await vi.waitFor(async () => { expect((await head()).explanation).toEqual({ state: 'unavailable' }) })
    expect(asks()).toHaveLength(1)
  })

  it('makes no call and ships no explanation while the setting is off', async () => {
    sidecar.respond('aux.complete', () => ({ model: 'aux', text: SUMMARY, usage: null, finish_reason: 'stop' }))
    await park()
    expect(await head()).not.toHaveProperty('explanation')
    // Any summary the read started would be asked for before the turn it holds ends.
    finishTurn()
    await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'stream_end')
    expect(asks()).toEqual([])
  })
})
