import { createServer, type ServerResponse } from 'node:http'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** TAL-821: while the Agent sits out a rate limit, the run status names the provider and reset time; Stop stays. */
test('the run status shows a rate-limit wait until the server clears it, with Stop available', async ({ page }, testInfo) => {
  const sid = 'rate-limit-wait'
  const streamId = `${sid}-run`
  let stream = null as ServerResponse | null
  let seq = 0
  const send = (event: string, data: unknown) => { stream!.write(`id: ${streamId}:${String(++seq)}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    stream = response
    send('reasoning', { text: 'Thinking about it' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  const messages = [{ role: 'user', id: 1, content: 'Summarize the release notes' }]
  const cancels: string[] = []
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: sid, title: 'Release notes', messages, active_stream_id: streamId, is_streaming: true } } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: streamId, replay_available: false } }))
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${String(address.port)}${new URL(route.request().url()).search}` }))
  await page.route('**/api/chat/cancel?**', async (route) => { cancels.push(new URL(route.request().url()).searchParams.get('stream_id') ?? ''); await route.fulfill({ json: { ok: true } }) })
  await page.route('**/api/session/draft', (route) => route.fulfill({ json: { ok: true } }))
  try {
    await page.goto(`/session/${sid}`)
    const status = page.locator('.composer-notices .live-run-status')
    await expect(status).toContainText('Working')
    await expect.poll(() => stream).not.toBeNull()
    const shot = async (name: string) => { if (process.env.TAL821_SHOTS) await page.screenshot({ path: `${process.env.TAL821_SHOTS}/${name}-${testInfo.project.name}.png` }) }
    await shot('before')
    const until = new Date(Date.now() + 17 * 60_000)
    // The browser runs in UTC (playwright.config.ts).
    const time = until.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
    send('rate_limit_wait', { session_id: sid, wait: { provider: 'openrouter', provider_label: 'OpenRouter', until: until.getTime() / 1000, until_kind: 'reset' } })
    await expect(status).toHaveText(new RegExp(`^OpenRouter rate limit until (\\w{3} )?${time}$`))
    await expect(page.locator('#btnStop')).toBeVisible()
    await shot('waiting')
    send('rate_limit_wait', { session_id: sid, wait: null })
    await expect(status).toContainText('Working')
    // No reset from the provider: the time is the Agent's next retry.
    send('rate_limit_wait', { session_id: sid, wait: { provider: 'openrouter', provider_label: 'OpenRouter', until: until.getTime() / 1000, until_kind: 'retry' } })
    await expect(status).toHaveText(new RegExp(`^OpenRouter rate limit · retry at (\\w{3} )?${time}$`))
    await shot('retry')
    await page.locator('#btnStop').click()
    await expect.poll(() => cancels).toEqual([streamId])
  } finally {
    stream?.end()
    await new Promise<void>((resolve) => server.close(() => { resolve() }))
  }
})
