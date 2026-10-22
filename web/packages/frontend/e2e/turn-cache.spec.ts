import { createServer, type ServerResponse } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { expect, test } from './fixtures'
import { sessionFixture } from '../src/test/fixtures'

test.use({ serviceWorkers: 'block', video: 'on' })

test('turn boundaries keep the transcript supplied by the terminal frame', async ({ page }, info) => {
  const sid = 'turn-cache'
  const baseline = process.env.TAL1210_BASELINE === '1'
  let stream: ServerResponse | undefined
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    response.write('event: token\ndata: {"text":"Checking the cache."}\n\n')
    stream = response
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture listener missing')
  let session = sessionFixture({ session_id: sid, title: 'Turn cache', messages: [{ role: 'user', id: 1, content: 'Earlier question' }, { role: 'assistant', id: 2, content: 'Earlier answer' }] })
  let reads = 0
  await page.route('**/api/session?**', (route) => { reads++; return route.fulfill({ json: { session } }) })
  await page.route('**/api/chat/start', (route) => {
    session = { ...session, is_streaming: true, active_stream_id: 'cache-run', messages: [...session.messages!, { role: 'user', id: 3, content: 'Check the cache' }] }
    return route.fulfill({ json: { stream_id: 'cache-run', user_message_id: 3 } })
  })
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: 'cache-run', blocking_stream_id: 'cache-run' } }))
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${address.port}` }))
  try {
    await page.goto(`/session/${sid}`)
    await expect(page.getByText('Earlier answer', { exact: true })).toBeVisible()
    const initialReads = reads
    await page.locator('#msg').fill('Check the cache')
    await page.locator('#btnSend').click()
    await expect(page.getByText('Checking the cache.', { exact: true })).toBeVisible()
    expect(reads).toBe(initialReads + (baseline ? 1 : 0))
    session = { ...session, is_streaming: false, active_stream_id: null, messages: [...session.messages!, { role: 'assistant', id: 4, content: 'The settled reply is ready.' }] }
    stream!.write(`event: done\ndata: ${JSON.stringify({ session })}\n\n`)
    await expect(page.locator('#btnStop')).toHaveCount(0)
    if (baseline) await expect.poll(() => reads).toBe(initialReads + 2)
    else {
      await expect(page.getByText('The settled reply is ready.', { exact: true })).toBeVisible()
      await expect(page.locator('[data-live-user]')).toHaveCount(0)
      expect(reads).toBe(initialReads)
    }
    if (process.env.TAL1210_EVIDENCE) {
      await mkdir(process.env.TAL1210_EVIDENCE, { recursive: true })
      await page.screenshot({ path: `${process.env.TAL1210_EVIDENCE}/${baseline ? 'before' : 'after'}-${info.project.name}.png` })
    }
  } finally {
    stream?.end()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
