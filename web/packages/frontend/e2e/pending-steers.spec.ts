import { createServer, type ServerResponse } from 'node:http'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const open = { edit: true, cancel: true, send_now: true }
const steer = (steer_id: string, text: string, actions = open) => ({ steer_id, text, submitted_at: 1770000300, state: 'pending', actions })

/** Server pending steers render as dashed user bubbles with the actions the server allows (TAL-425). */
test('a pending steer shows its actions; Edit returns it to the composer, Cancel drops it, Send now says when it cannot', async ({ page }, testInfo) => {
  const sid = 'pending-steers'
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Back up the cluster', active_stream_id: 'steer-run', is_streaming: true, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true,
    transcript_seq: null, messages: [{ role: 'user', id: 1, content: 'Back up the cluster', _turn_id: 'steer-run' }],
    pending_steers: [steer('s1', 'Check the backup logs too')],
  } } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: 'steer-run', replay_available: false } }))
  const streams: ServerResponse[] = []
  let seq = 0
  const send = (event: string, data: unknown) => { seq += 1; for (const r of streams) r.write(`id: steer-run:${String(seq)}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    response.write(`id: steer-run:${String(++seq)}\nevent: token\ndata: ${JSON.stringify({ text: 'Running the backup.' })}\n\n`)
    streams.push(response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${String(address.port)}${new URL(route.request().url()).search}` }))
  await page.route('**/api/chat/steer/withdraw', async (route) => {
    const body = route.request().postDataJSON() as { steer_id: string; reason: string }
    const text = body.steer_id === 's1' ? 'Check the backup logs too' : 'Then summarize'
    send('steer_withdrawn', { steer_id: body.steer_id, reason: body.reason, text })
    await route.fulfill({ json: { withdrawn: true, text } })
  })
  await page.route('**/api/chat/steer/send-now', (route) => route.fulfill({ json: { redirected: false } }))
  try {
    await page.goto(`/session/${sid}`)
    const bubble = (text: string) => page.locator('.steer-message', { hasText: text })
    await expect(bubble('Check the backup logs too')).toContainText('Steering hint · Waiting for agent')
    // Another tab's steer arrives on the stream; it may not be sent now.
    await expect.poll(() => streams.length).toBeGreaterThan(0)
    send('steer_pending', steer('s2', 'Then summarize', { edit: true, cancel: true, send_now: false }))
    await expect(bubble('Then summarize')).toBeVisible()
    await expect(bubble('Then summarize').getByRole('button', { name: 'Send now' })).toHaveCount(0)
    await expect(bubble('Check the backup logs too').getByRole('button', { name: 'Send now' })).toBeVisible()
    if (process.env.TAL425_SHOTS) await page.screenshot({ path: `${process.env.TAL425_SHOTS}/pending-${testInfo.project.name}.png` })

    await bubble('Check the backup logs too').getByRole('button', { name: 'Send now' }).click()
    await expect(page.getByText('Nothing is running to take it now; it stays pending.')).toBeVisible()

    await page.locator('#msg').fill('My draft')
    await bubble('Check the backup logs too').getByRole('button', { name: 'Edit steering message' }).click()
    await expect(page.locator('#msg')).toHaveValue('My draft\n\nCheck the backup logs too')
    await expect(bubble('Check the backup logs too')).toHaveCount(0)

    await bubble('Then summarize').getByRole('button', { name: 'Cancel steering message' }).click()
    await expect(page.locator('.steer-message')).toHaveCount(0)
    await expect(page.locator('#msg')).toHaveValue('My draft\n\nCheck the backup logs too')
  } finally {
    for (const response of streams) response.end()
    await new Promise<void>((resolve) => server.close(() => { resolve() }))
  }
})
