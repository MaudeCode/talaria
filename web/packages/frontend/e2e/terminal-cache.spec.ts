import { createServer, type ServerResponse } from 'node:http'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block', video: 'on' })

for (const order of ['before', 'after'] as const) {
  test(`terminal session replaces the live reply with sidebar ${order} done`, async ({ page }, info) => {
    const sid = 'terminal-cache-fixture'
    const run = 'terminal-cache-run'
    const prompt = { role: 'user', id: 1, content: 'Summarize the result.', _turn_id: run }
    const session = { session_id: sid, title: 'Terminal cache', read_only: false, messages: [prompt], active_stream_id: run, transcript_seq: { stream_id: run, seq: 0 } }
    const settled = { ...session, title: 'Result summary', active_stream_id: null, messages: [prompt, { role: 'assistant', id: 2, content: 'The final reply stays in place.', _turn_id: run }] }
    const feeds = new Map<string, ServerResponse>()
    const server = createServer((request, response) => {
      feeds.set(request.url!, response)
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
      response.write(': connected\n\n')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    let done = false
    let detailFetches = 0
    await page.route('**/api/session?**', (route) => {
      if (done) detailFetches += 1
      return route.fulfill({ json: { session: done ? settled : session } })
    })
    await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: run, replay_available: true, blocking_stream_id: null } }))
    for (const [pattern, path] of [['**/api/chat/stream?**', '/chat'], ['**/api/sessions/events*', '/sidebar'], ['**/api/session/stream?**', '/session']] as const) {
      await page.route(pattern, (route) => route.continue({ url: `http://127.0.0.1:${address.port}${path}` }))
    }
    const emit = (path: string, event: string, data: unknown) => feeds.get(path)!.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    try {
      const initialList = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/sessions' && response.ok())
      await page.goto(`/session/${sid}`)
      await initialList
      await expect.poll(() => feeds.size).toBe(3)
      emit('/chat', 'token', { text: 'The final reply stays in place.' })
      await expect(page.locator('.live-turn')).toContainText('The final reply stays in place.')
      await page.screenshot({ path: info.outputPath('live.png') })
      done = true
      if (order === 'before') {
        const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/sessions' && response.ok())
        emit('/sidebar', 'sessions_changed', { reason: 'session_done', session_id: sid })
        await refreshed
        expect(detailFetches).toBe(0)
      }
      emit('/chat', 'done', { session: settled })
      await expect(page.locator('.live-turn')).toHaveCount(0)
      emit('/chat', 'title', { title: settled.title })
      if (order === 'after') emit('/sidebar', 'sessions_changed', { reason: 'session_done', session_id: sid })
      emit('/chat', 'stream_end', {})
      await expect(page.locator('[data-role="assistant"]')).toContainText('The final reply stays in place.')
      await page.screenshot({ path: info.outputPath('settled.png') })
      // Cross a rendering frame and the detail endpoint's request/response turn before counting.
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      expect(detailFetches).toBe(0)
    } finally {
      for (const feed of feeds.values()) feed.end()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
}
