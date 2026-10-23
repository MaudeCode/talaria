import { createServer, type ServerResponse } from 'node:http'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block', video: 'on' })

test('a healthy sidebar skips polling and resyncs on reconnect', async ({ page }, testInfo) => {
  let stream: ServerResponse | undefined
  let connections = 0
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    response.write('retry: 100\n\nevent: initial\ndata: {"stream":"sessions"}\n\n')
    stream = response
    connections++
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  let title = 'Before reconnect'
  let listReads = 0
  const now = Math.floor(Date.now() / 1000)
  await page.route('**/api/sessions/events', (route) => route.continue({ url: `http://127.0.0.1:${String(address.port)}/` }))
  await page.route(/\/api\/sessions(\?|$)/, (route) => {
    listReads++
    return route.fulfill({ json: { sessions: [{
      session_id: 'reconnect-sidebar', title, updated_at: now, sort_ts: now, last_message_at: now,
      pinned: false, archived: false, project_id: null, is_streaming: false, attention: null,
      is_cli_session: false, source_kind: 'webui', is_messaging_session: false, read_only: false,
      can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true,
    }] } })
  })
  try {
    await page.goto('/')
    await settle(page)
    const hamburger = page.locator('#btnHamburger')
    if (await hamburger.isVisible()) await hamburger.click()
    const row = page.locator('.session-item[data-sid="reconnect-sidebar"] .session-title')
    await expect(row).toHaveText('Before reconnect')
    await expect.poll(() => connections).toBe(1)
    await page.screenshot({ path: testInfo.outputPath('before-reconnect.png') })
    await page.clock.install()
    const before = listReads
    await page.clock.runFor(300_000)
    expect(listReads).toBe(before)
    title = 'Caught up after reconnect'
    stream!.end()
    await expect.poll(() => connections).toBe(2)
    await expect(row).toHaveText('Caught up after reconnect')
    expect(listReads).toBe(before + 1)
    await page.screenshot({ path: testInfo.outputPath('after-reconnect.png') })
  } finally {
    await page.close()
    stream?.end()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
