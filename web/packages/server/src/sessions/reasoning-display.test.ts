import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { showReasoning } from '../config/agent-config.js'
import { anchorActivitySceneTransportPreview } from './anchor.js'
import { reasoningProjection } from './reasoning-display.js'

type Row = Record<string, unknown>

describe('reasoning display policy (TAL-996)', () => {
  let s: TestServer
  const sidecar = new FakeSidecar()
  let show: unknown = false
  beforeAll(async () => {
    s = await bootTestServer({ sidecar })
    writeFileSync(join(s.state, 'config.yaml'), '# synthetic reasoning preference\n')
    sidecar.respond('config.get', () => ({ path: join(s.state, 'config.yaml'), exists: true, config: { display: { platforms: { webui: { show_reasoning: show } } } } }))
  })
  afterAll(() => s.close())

  it.each(['false', 'off', 'no', 'true', 'on', 'yes'])('normalizes quoted %s at both precedence keys', (value) => {
    const expected = ['true', 'on', 'yes'].includes(value)
    expect(showReasoning({ display: { show_reasoning: value } })).toBe(expected)
    expect(showReasoning({ display: { show_reasoning: !expected, platforms: { webui: { show_reasoning: value } } } })).toBe(expected)
  })

  it('filters full scene inputs before computing preview counts and preserves tools and prose', () => {
    const activity_rows = Array.from({ length: 100 }, (_, i) => ({ role: 'reasoning', row_id: `r${i}`, text: 'PRIVATE_THOUGHT', order_index: i }))
    const preview = anchorActivitySceneTransportPreview({ activity_rows: [...activity_rows, { role: 'prose', row_id: 'p', text: 'Public progress' }] }, '', false)
    expect(preview).toMatchObject({ activity_rows_total: 1, activity_rows_offset: 0, activity_rows_complete: true })
    expect(JSON.stringify(preview)).not.toContain('PRIVATE_THOUGHT')
    const raw = { messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_THOUGHT' }, { type: 'text', text: 'Public answer' }], reasoning_content: 'PRIVATE_THOUGHT' }] }
    expect(JSON.stringify(reasoningProjection(raw, false))).not.toContain('PRIVATE_THOUGHT')
    expect(JSON.stringify(raw)).toContain('PRIVATE_THOUGHT')
  })

  it('hides live and replayed reasoning, history scenes and exports, then restores stored reasoning', async () => {
    const post = async (path: string, body: unknown) => s.get(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const created = await (await post('/api/session/new', {})).json() as { session: { session_id: string } }
    const sid = created.session.session_id
    sidecar.respond('chat.start', (params, emit) => {
      emit({ event: 'reasoning', data: { text: 'PRIVATE_THOUGHT' } })
      emit({ event: 'token', data: { text: 'Public answer' } })
      return { status: 'completed', messages: [{ role: 'user', content: typeof params.user_message === 'string' ? params.user_message : '' }, { role: 'assistant', content: 'Public answer', reasoning: 'PRIVATE_THOUGHT' }], final_response: 'Public answer', error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '', usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: null }, context: { context_length: 200000 }, model: 'test-model', provider: 'test', compressed: false, agent_session_id: sid, token_sent: true, pending_steer: '', live_tool_calls: [] }
    })
    const started = await (await post('/api/chat/start', { session_id: sid, message: 'hello' })).json() as { stream_id: string }
    const path = `/api/chat/stream?stream_id=${started.stream_id}&replay=1`
    for (const phase of ['live', 'replay']) {
      const frames = await s.sse(path, (f) => f.event === 'stream_end')
      expect(frames.some((f) => f.event === 'reasoning'), phase).toBe(false)
      expect(JSON.stringify(frames), phase).not.toContain('PRIVATE_THOUGHT')
      expect(frames.some((f) => f.event === 'token')).toBe(true)
    }
    const detail = async (extra = '') => (await (await s.get(`/api/session?session_id=${sid}${extra}`)).json() as { session: Row }).session
    for (const query of ['', '&msg_limit=1']) {
      const hidden = await detail(query)
      expect(hidden.show_reasoning).toBe(false)
      expect((hidden.messages as Row[]).filter((m) => m.role === 'assistant').every((m) => m.reasoning === '')).toBe(true)
      expect(JSON.stringify(hidden)).not.toContain('PRIVATE_THOUGHT')
    }
    for (const format of ['json', 'html', 'markdown']) {
      const response = await s.get(`/api/session/export?session_id=${sid}&format=${format}`)
      expect(response.status).toBe(200)
      expect(await response.text(), format).not.toContain('PRIVATE_THOUGHT')
    }
    const createdShare = await post('/api/share/create', { session_id: sid })
    expect(createdShare.status).toBe(200)
    const share = await createdShare.json() as { share: { token: string } }
    const shared = await s.get(`/api/share/${share.share.token}`)
    expect(shared.status).toBe(200)
    expect(await shared.text()).not.toContain('PRIVATE_THOUGHT')
    expect(JSON.stringify((await s.deps.sessionStore.get(sid)).messages)).toContain('PRIVATE_THOUGHT')
    show = true
    s.deps.agentConfig.invalidate()
    const visible = await detail()
    expect(visible.show_reasoning).toBe(true)
    expect(JSON.stringify(visible)).toContain('PRIVATE_THOUGHT')
    expect((await s.sse(path, (f) => f.event === 'stream_end')).some((f) => f.event === 'reasoning')).toBe(true)
  })
})
