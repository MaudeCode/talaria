import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

test('an answer omitted from Agent messages remains visible after settlement and reload', async ({ page }, testInfo) => {
  const { FakeSidecar } = await import('../../server/dist/sidecar/fake.js')
  const { bootTestServer } = await import('../../server/dist/test/harness.js')
  const sidecar = new FakeSidecar()
  sidecar.respond('chat.start', (params, emit) => {
    emit({ event: 'token', data: { text: 'Unique final answer' } })
    return { status: 'completed', failed: false, partial: false, error: null, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '',
      usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: {},
      model: 'test-model', provider: 'test', compressed: false, agent_session_id: params.session_id, token_sent: true, pending_steer: '', live_tool_calls: [],
      messages: [...params.conversation_history, { role: 'user', content: params.user_message }], final_response: 'Unique final answer' }
  })
  const server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' } })
  try {
    const session = await server.deps.sessionStore.newSession()
    const start = await server.get('/api/chat/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: session.session_id, message: 'Please answer this question.' }) })
    expect(start.status).toBe(200)
    const { stream_id: streamId } = await start.json() as { stream_id: string }
    await server.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'stream_end')
    await page.goto(`${server.base}/session/${session.session_id}`)
    await expect(page.locator('#messages')).toContainText('Please answer this question.')
    try {
      await expect(page.locator('#messages').getByText('Unique final answer', { exact: true })).toBeVisible()
    } finally {
      if (process.env.TAL1030_SHOTS) await page.screenshot({ path: `${process.env.TAL1030_SHOTS}/settled-${testInfo.project.name}.png` })
    }
    await page.reload()
    await expect(page.locator('#messages').getByText('Unique final answer', { exact: true })).toHaveCount(1)
  } finally { await page.goto('about:blank'); await server.close() }
})
