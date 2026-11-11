import { createServer, type ServerResponse } from 'node:http'
import { expect, expectNoOverflow, test } from './fixtures'
import { deferred } from '../src/test/fixtures'

test('a live reasoning disclosure follows real layout and holds the reader independently of the transcript', async ({ page }, info) => {
  const sid = 'reasoning-follow'
  const connected = deferred<ServerResponse>()
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    response.write('id: reasoning-run:1\nevent: server_turn_started\ndata: ' + JSON.stringify({ session_id: sid, stream_id: 'reasoning-run', user_message_id: 1 }) + '\n\n')
    response.write('id: reasoning-run:2\nevent: reasoning\ndata: ' + JSON.stringify({ text: Array.from({ length: 60 }, (_, i) => `Checking step ${i + 1} against the original values.\n`).join(''), titles: ['Checking the calculation'] }) + '\n\n')
    connected.resolve(response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Check the calculation', show_reasoning: true,
    messages: [
      ...Array.from({ length: 12 }, (_, i) => ({ role: 'user', id: i + 10, content: `Earlier calculation ${i + 1}`, _turn_id: `earlier-${i}` })),
      { role: 'user', id: 1, content: 'Check the calculation', _turn_id: 'reasoning-run' },
    ], active_stream_id: 'reasoning-run',
  } } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: 'reasoning-run', replay_available: true } }))
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${address.port}/stream` }))
  try {
    await page.goto(`/session/${sid}`)
    const stream = await connected.promise
    const header = page.locator('.thinking-card-header')
    const body = page.locator('.thinking-card-body')
    const transcript = page.locator('#messages')
    const pinTranscript = async () => {
      await transcript.evaluate((el) => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')) })
      await expect.poll(() => transcript.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(2)
    }
    const frameBody = async () => {
      await body.evaluate((el) => {
        const pane = document.getElementById('messages')!
        const dock = document.querySelector('.composer-dock')!
        pane.scrollTop += el.getBoundingClientRect().bottom - (dock.getBoundingClientRect().top - 12)
        pane.dispatchEvent(new Event('scroll'))
      })
      await expect.poll(() => body.evaluate((el) => {
        const box = el.getBoundingClientRect()
        return el.contains(document.elementFromPoint(box.x + box.width / 2, box.bottom - 8))
      })).toBe(true)
    }
    await header.click()
    await expect(body).toBeVisible()
    await expect.poll(() => body.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(500)
    const shots = process.env.TAL1123_SHOTS
    await pinTranscript()
    await frameBody()
    if (shots) await page.screenshot({ path: `${shots}/${info.project.name}.png` })
    const gap = () => body.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)
    await expect.poll(gap).toBeLessThanOrEqual(2)
    const grow = async (id: number) => {
      const length = (await body.textContent())!.length
      stream.write(`id: reasoning-run:${id}\nevent: reasoning\ndata: ${JSON.stringify({ text: '\nAnother verified step.\n'.repeat(20) })}\n\n`)
      await expect.poll(async () => (await body.textContent())!.length).toBeGreaterThan(length)
    }
    await grow(3)
    await expect.poll(gap).toBeLessThanOrEqual(2)
    await body.evaluate((el) => { el.scrollTop = 120; el.dispatchEvent(new Event('scroll')) })
    await grow(4)
    await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(120)
    await header.click()
    stream.write(`id: reasoning-run:5\nevent: reasoning\ndata: ${JSON.stringify({ text: '\nThinking while collapsed.\n' })}\n\n`)
    await header.click()
    await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(120)
    await body.evaluate((el) => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')) })
    await grow(6)
    await expect.poll(gap).toBeLessThanOrEqual(2)
    await transcript.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })
    await grow(7)
    await expect.poll(gap).toBeLessThanOrEqual(2)
    expect(await transcript.evaluate((el) => el.scrollTop)).toBe(0)
    if (info.project.name === 'desktop') {
      await expectNoOverflow(page, 'reasoning-follow', async (name) => {
        await expect.poll(gap).toBeLessThanOrEqual(2)
        await header.evaluate((el) => el.scrollIntoView({ block: 'start' }))
        await expect.poll(() => header.evaluate((el) => {
          const box = el.getBoundingClientRect()
          return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
        })).toBe(true)
        await frameBody()
        if (shots) await page.screenshot({ path: `${shots}/${name}.png` })
      }, body)
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
