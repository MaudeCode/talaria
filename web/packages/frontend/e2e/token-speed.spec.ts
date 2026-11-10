import { createServer, type ServerResponse } from 'node:http'
import { expect, test } from './fixtures'
import { hydrateAnchorActivityScenes, withTurnIds } from '../../server/dist/sessions/anchor.js'
import { redactSessionData } from '../../server/dist/redact.js'

test.use({ serviceWorkers: 'block' })

// TAL-2150: "Show token speed" alone decides whether a streaming reply and a finished one, after a reload too, show a rate.
for (const shown of [true, false]) {
  test(`token speed ${shown ? 'shows' : 'stays hidden'} with Show token speed ${shown ? 'on' : 'off'}`, async ({ context, page, request }, testInfo) => {
    const settings = { ...await (await request.get('/api/settings')).json(), show_tps: shown, show_token_usage: false }
    await context.route('**/api/settings', (route) => route.fulfill({ json: settings }))
    const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`token-speed-${name}-${shown ? 'on' : 'off'}-${testInfo.project.name}.png`) })

    const live = 'token-speed-live'
    let stream = null as ServerResponse | null
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
      stream = response
      response.write('event: hello\ndata: {}\n\n')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const messages = [
      { role: 'user', id: 1, content: 'Summarize the release notes' },
      { role: 'assistant', id: 2, content: 'Three fixes and one new setting.', _turnDuration: 4.2, _usedModel: 'test-model', _turnTps: 41.6 },
      { role: 'user', id: 3, content: 'And the older reply?' },
      { role: 'assistant', id: 4, content: 'Stored before the speed was kept.', _turnDuration: 2.1, _usedModel: 'test-model' },
    ]
    await page.route('**/api/session?**', (route) => {
      const sid = new URL(route.request().url()).searchParams.get('session_id')
      if (sid === live) return route.fulfill({ json: { session: { session_id: live, title: 'Live', messages: [messages[0]], active_stream_id: `${live}-run`, is_streaming: true } } })
      return route.fulfill({ json: { session: { session_id: sid, title: 'Release notes', messages: redactSessionData({ messages: hydrateAnchorActivityScenes(withTurnIds(messages), {}) }, true).messages } } })
    })
    await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, blocking_stream_id: null, stream_id: `${live}-run`, replay_available: false } }))
    await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${String(address.port)}${new URL(route.request().url()).search}` }))
    try {
      await page.goto(`/session/${live}`)
      const pill = page.locator('.composer-notices .live-run-status')
      await expect(pill).toContainText('Working')
      await expect.poll(() => stream !== null).toBe(true)
      stream!.write(`id: ${live}-run:1\nevent: metering\ndata: ${JSON.stringify({ session_id: live, tps: 42.1, tps_available: true, estimated: false })}\n\n`)
      if (shown) await expect(pill).toContainText('42.1 tok/s')
      else {
        // The frame is applied once the stream renders a later one; the rate never joins it.
        stream!.write(`id: ${live}-run:2\nevent: token\ndata: ${JSON.stringify({ text: 'Streaming now' })}\n\n`)
        await expect(page.getByText('Streaming now')).toBeVisible()
        await expect(pill).not.toContainText('tok/s')
      }
      await shot('live')
    } finally {
      stream?.end()
      await new Promise<void>((resolve) => server.close(() => { resolve() }))
    }

    await page.goto('/session/token-speed-done')
    for (const pass of ['loaded', 'reloaded']) {
      if (pass === 'reloaded') await page.reload()
      await expect(page.locator('[data-final-answer="1"]').last()).toContainText('Stored before the speed was kept.')
      const speeds = page.locator('.msg-turn-tps')
      if (shown) {
        await expect(speeds).toHaveText(['42 tok/s'])
        await expect(speeds).toHaveAttribute('title', '41.6 tok/s')
      } else await expect(speeds).toHaveCount(0)
      await expect(page.locator('.msg-turn-usage')).toHaveCount(0)
    }
    await page.locator('.msg-row.assistant-turn').first().hover()
    await shot('finished')
  })
}
