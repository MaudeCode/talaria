import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootTestServer } from '../../server/dist/test/harness.js'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** Phone, the Duo outer display and split view, and the Duo inner display (foldable-web viewports). */
const WIDTHS = [[382, 580], [385, 571], [669, 867], [951, 585]] as const
const SECRET = 'Zq8vR2mN4pL7wX1cK9-e2e'
const PURPOSE = 'Read your Foo dashboards to build the weekly report.'

// TAL-1969: the agent asks for FOO_API_KEY mid-turn; the owner types it into the vault card; the server saves it to the
// profile .env. The value travels in the respond request and nowhere else the browser or a stream can see.
test('saves a requested secret to the profile .env without it reaching any other request or frame', async ({ page }, testInfo) => {
  const sidecar = new FakeSidecar()
  let toolResult: unknown = null
  sidecar.respond('runtime.env', () => ({ ok: true }))
  sidecar.respond('chat.start', async (params, emit) => {
    emit({ event: 'token', data: { text: 'I need your Foo key to read the dashboards.' } })
    toolResult = await sidecar.serverRequest('server.secret_request', { caller_session_id: params.session_id, env_name: 'FOO_API_KEY', purpose: PURPOSE, optional: false, timeout_seconds: 600 })
    return { status: 'completed', failed: false, partial: false, error: null, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '',
      usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: {},
      model: 'test-model', provider: 'test', compressed: false, agent_session_id: params.session_id, token_sent: true, pending_steer: '', live_tool_calls: [],
      messages: [...params.conversation_history, { role: 'user', content: params.user_message }, { role: 'assistant', content: 'Saved; reading the dashboards now.' }], final_response: 'Saved; reading the dashboards now.' }
  })
  const server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' } })
  const shot = async (name: string) => { if (process.env.TAL1969_SHOTS) await page.screenshot({ path: `${process.env.TAL1969_SHOTS}/${name}-${testInfo.project.name}.png` }) }
  const bodies: { url: string; body: string }[] = []
  page.on('request', (request) => { const body = request.postData(); if (body) bodies.push({ url: request.url(), body }) })
  const responses: string[] = []
  page.on('response', async (response) => { if (!(response.headers()['content-type'] ?? '').includes('event-stream')) responses.push(await response.text().catch(() => '')) })
  try {
    const session = await server.deps.sessionStore.newSession()
    const start = await server.get('/api/chat/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: session.session_id, message: 'Build the weekly Foo report.' }) })
    expect(start.status).toBe(200)
    const { stream_id: streamId } = await start.json() as { stream_id: string }
    const frames = server.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'stream_end', { timeoutMs: 60_000 })

    await page.goto(`${server.base}/session/${session.session_id}`)
    await settle(page)
    const card = page.getByRole('dialog', { name: 'Set FOO_API_KEY' })
    await expect(card).toBeVisible()
    await expect(card).toContainText(PURPOSE)
    const field = card.getByLabel('FOO_API_KEY')
    await expect(field).toHaveAttribute('type', 'password')
    await shot('empty')
    const original = page.viewportSize()
    for (const [width, height] of WIDTHS) {
      await page.setViewportSize({ width, height })
      await card.scrollIntoViewIfNeeded()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal scroll at ${String(width)}px`).toBe(true)
      await expect(card.getByRole('button', { name: 'Save', exact: true })).toBeVisible()
      await shot(`card-${String(width)}`)
    }
    if (original) await page.setViewportSize(original)
    await field.fill(SECRET)
    await shot('filled')
    await card.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(card).toHaveCount(0)
    const streamed = await frames
    await expect(page.locator('#messages').getByText('Saved; reading the dashboards now.')).toBeVisible()
    await shot('saved')

    expect(toolResult).toMatchObject({ result: { env_name: 'FOO_API_KEY', outcome: 'saved', existed_before: false } })
    expect(readFileSync(join(server.state, '.env'), 'utf8')).toContain(`FOO_API_KEY=${SECRET}`)
    // Exactly one browser request carried the value: the answer itself.
    expect(bodies.filter(({ body }) => body.includes(SECRET)).map(({ url }) => new URL(url).pathname)).toEqual(['/api/clarify/respond'])
    expect(streamed.some((frame) => frame.event === 'clarify')).toBe(true)
    for (const text of [JSON.stringify(toolResult), JSON.stringify(streamed), ...responses, server.logs.join('\n')]) expect(text).not.toContain(SECRET)
    const transcript = await (await server.get(`/api/session?session_id=${session.session_id}`)).text()
    expect(transcript).not.toContain(SECRET)
  } finally { await page.goto('about:blank'); await server.close() }
})
