import { createServer, type ServerResponse } from 'node:http'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** TAL-2337: the real built composer names the server's running call, truncates it inside the composer, and warns while held. */
test('the status above the composer names the running call and a held one, within the composer at every width', async ({ page }, testInfo) => {
  const sid = 'run-status-tool'
  const streamId = `${sid}-run`
  let stream = null as ServerResponse | null
  let seq = 0
  const send = (status: unknown) => {
    stream!.write(`id: ${streamId}:${String(++seq)}\nevent: run_status\ndata: ${JSON.stringify({ session_id: sid, status })}\n\n`)
  }
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    stream = response
    response.write('event: hello\ndata: {}\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: sid, title: 'Release checks', messages: [{ role: 'user', id: 1, content: 'Run the tests and check the changelog' }], active_stream_id: streamId, is_streaming: true, run_status: { phase: 'working' } } } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, blocking_stream_id: null, stream_id: streamId, replay_available: false } }))
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${String(address.port)}${new URL(route.request().url()).search}` }))
  // The desktop project covers the desktop and Duo inner widths, the mobile one the phone and Duo outer and split widths.
  const widths = testInfo.project.name === 'mobile' ? [390, 382, 385] : [1280, 951, 669]
  const shot = async (name: string, width: number) => {
    if (process.env.TAL2337_SHOTS) await page.screenshot({ path: `${process.env.TAL2337_SHOTS}/${name}-${String(width)}.png`, animations: 'disabled' })
  }
  try {
    await page.goto(`/session/${sid}`)
    const pill = page.locator('.composer-notices .live-run-status')
    const label = pill.locator('.live-run-label')
    await expect(label).toHaveText('Working')
    await expect.poll(() => stream !== null).toBe(true)
    for (const width of widths) {
      await page.setViewportSize({ width, height: page.viewportSize()!.height })
      for (const [name, status, text] of [
        ['running', { phase: 'working', current_tool: { kind: 'shell', target: 'npm test', done: false } }, 'Running npm test'],
        ['long', { phase: 'working', current_tool: { kind: 'web', target: 'hermes agent 0.24 changelog and release notes', done: false } }, 'Checking hermes agent 0.24 changelog and release notes'],
        ['held', { phase: 'working', current_tool: { kind: 'shell', target: 'npm publish', done: false, outcome: { key: 'pending_approval', tone: 'attention' } } }, 'Waiting for approval'],
        ['between', { phase: 'working' }, 'Working'],
      ] as const) {
        send(status)
        await expect(label).toHaveText(text)
        // A held call's label takes the theme's warning colour; every other label keeps its own.
        await expect.poll(() => label.evaluate((el) => {
          const probe = document.body.appendChild(document.createElement('span'))
          probe.style.color = 'var(--warning)'
          const warning = getComputedStyle(probe).color
          probe.remove()
          return getComputedStyle(el).color === warning
        }), { timeout: 2000 }).toBe(name === 'held')
        await shot(name, width)
        // The chip stays within the composer, its label cut short with an ellipsis rather than growing past it.
        const box = (await pill.boundingBox())!
        const composer = await page.locator('#composerBox').boundingBox()
        expect(box.x).toBeGreaterThanOrEqual(composer!.x - 1)
        expect(box.x + box.width).toBeLessThanOrEqual(composer!.x + composer!.width + 1)
        if (name === 'long') expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
      }
    }
  } finally {
    stream?.end()
    await new Promise<void>((resolve) => server.close(() => { resolve() }))
  }
})
