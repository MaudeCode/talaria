import { createServer, type ServerResponse } from 'node:http'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const memory = { key: 'startup-warning.1a2b3c4d', level: 'warn', text: "⚠ Memory provider 'honcho' could not be loaded; memory is off for this session.", expires_at: null }
const pending = { key: 'mcp_discovery_pending', level: 'info', text: 'Some tools are still connecting. Using available tools for this turn.', expires_at: null }
const credits = { key: 'credits.usage_band', level: 'info', text: "You've used 90% of your Nous credits.", expires_at: null }

/** TAL-803: the session's Agent notices sit in the composer's status tab; the server's `notices` event replaces them live. */
test('shows the session\'s Agent notices and follows the server\'s live list', async ({ page }, testInfo) => {
  const sid = 'agent-notices'
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Plan the week', active_stream_id: 'notice-run', is_streaming: true, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true,
    transcript_seq: null, messages: [{ role: 'user', id: 1, content: 'Plan the week', _turn_id: 'notice-run' }],
    notices: [memory],
  } } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: 'notice-run', replay_available: false } }))
  const streams: ServerResponse[] = []
  let seq = 0
  const send = (event: string, data: unknown) => { seq += 1; for (const r of streams) r.write(`id: notice-run:${String(seq)}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    response.write(`id: notice-run:${String(++seq)}\nevent: token\ndata: ${JSON.stringify({ text: 'Looking at your calendar.' })}\n\n`)
    streams.push(response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${String(address.port)}${new URL(route.request().url()).search}` }))
  try {
    await page.goto(`/session/${sid}`)
    const tab = (text: string) => page.locator('#composerWrap').getByText(text)
    await expect(tab(memory.text)).toBeVisible()
    if (process.env.TAL803_SHOTS) await page.screenshot({ path: `${process.env.TAL803_SHOTS}/notice-${testInfo.project.name}.png` })
    await expect.poll(() => streams.length).toBeGreaterThan(0)
    send('notices', { session_id: sid, notices: [] })
    await expect(tab(memory.text)).toHaveCount(0)
    if (process.env.TAL1227_SHOTS) await page.screenshot({ path: `${process.env.TAL1227_SHOTS}/before-${testInfo.project.name}.png` })
    send('notices', { session_id: sid, notices: [pending] })
    await expect(tab(pending.text)).toBeVisible()
    if (process.env.TAL1227_SHOTS) await page.screenshot({ path: `${process.env.TAL1227_SHOTS}/pending-${testInfo.project.name}.png` })
    send('notices', { session_id: sid, notices: [credits] })
    await expect(tab(pending.text)).toHaveCount(0)
    await expect(tab(credits.text)).toBeVisible()
    await expect(tab(memory.text)).toHaveCount(0)
    send('notices', { session_id: sid, notices: [] })
    await expect(tab(credits.text)).toHaveCount(0)
  } finally {
    for (const response of streams) response.end()
    await new Promise<void>((resolve) => server.close(() => { resolve() }))
  }
})
