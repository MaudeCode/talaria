import { createServer, type ServerResponse } from 'node:http'
import type { Page } from '@playwright/test'
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

/** A running session whose stream stays open, so the composer is in busy mode (steer by default). */
async function runningSession(page: Page, sid: string) {
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Back up the cluster', active_stream_id: `${sid}-run`, is_streaming: true, read_only: false,
    transcript_seq: null, messages: [{ role: 'user', id: 1, content: 'Back up the cluster', _turn_id: `${sid}-run` }], pending_steers: [],
  } } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: `${sid}-run`, replay_available: false } }))
  const streams: ServerResponse[] = []
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    response.write(`id: ${sid}-run:1\nevent: token\ndata: ${JSON.stringify({ text: 'Running the backup.' })}\n\n`)
    streams.push(response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${String(address.port)}${new URL(route.request().url()).search}` }))
  let seq = 1
  const send = (event: string, data: unknown) => { seq += 1; for (const r of streams) r.write(`id: ${sid}-run:${String(seq)}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
  const close = async () => {
    for (const response of streams) response.end()
    await new Promise<void>((resolve) => server.close(() => { resolve() }))
  }
  return { send, streams, close }
}

/** TAL-743: a steer empties the composer when it is sent, like any send; a refused or failed one comes back after newer text. */
for (const [name, typed, answer] of [
  ['accepted', 'Check the backup logs too', { accepted: true, fallback: null, stream_id: 'x', steer_id: 'x' }],
  ['accepted via /steer', '/steer Check the backup logs too', { accepted: true, fallback: null, stream_id: 'x', steer_id: 'x' }],
  ['refused', 'Check the backup logs too', { accepted: false, fallback: 'not_running', stream_id: null }],
  ['failed', 'Check the backup logs too', null],
] as const) {
  test(`a steer clears the composer while its request is in flight: ${name}`, async ({ page, errors }) => {
    const { close } = await runningSession(page, 'steer-clears')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    await page.route('**/api/chat/steer', async (route) => {
      await gate
      if (answer) await route.fulfill({ json: answer })
      else await route.fulfill({ status: 500, json: { error: 'Steer failed' } })
    })
    try {
      await page.goto('/session/steer-clears')
      const msg = page.locator('#msg')
      await expect(msg).toHaveAttribute('placeholder', 'Enter = steer | /queue | /background | /interrupt')
      await msg.fill(typed)
      // The send arrow beside Stop steers like Enter does; a touch keyboard's Enter types a newline.
      await page.locator('#btnSend').click()
      await expect(page.locator('.steer-message', { hasText: 'Check the backup logs too' })).toBeVisible()
      await expect(msg).toHaveValue('')
      await msg.fill('Then summarize')
      release()
      if (name === 'refused') await expect(page.getByText('Steer unavailable — draft restored')).toBeVisible()
      await expect(msg).toHaveValue(answer?.accepted ? 'Then summarize' : 'Then summarize\n\nCheck the backup logs too')
      // The synthetic 500 is the point of the failed case.
      errors.splice(0, errors.length, ...errors.filter((e) => !/api\/chat\/steer|status of 500/.test(e)))
    } finally {
      await close()
    }
  })
}

test('a steer a Stop withdrew while its request was in flight comes back to the composer once (TAL-743)', async ({ page }) => {
  const { send, streams, close } = await runningSession(page, 'steer-stopped')
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let steerId = ''
  await page.route('**/api/chat/steer', async (route) => {
    steerId = (route.request().postDataJSON() as { steer_id: string }).steer_id
    await gate
    await route.fulfill({ json: { accepted: false, fallback: 'stream_dead', stream_id: null } })
  })
  try {
    await page.goto('/session/steer-stopped')
    const msg = page.locator('#msg')
    await expect.poll(() => streams.length).toBeGreaterThan(0)
    await msg.fill('Check the backup logs too')
    await page.locator('#btnSend').click()
    await expect(msg).toHaveValue('')
    await expect.poll(() => steerId).not.toBe('')
    send('steer_withdrawn', { steer_id: steerId, reason: 'stopped', text: 'Check the backup logs too' })
    await expect(msg).toHaveValue('Check the backup logs too')
    release()
    await expect(page.getByText('Steer unavailable — draft restored')).toBeVisible()
    await expect(msg).toHaveValue('Check the backup logs too')
  } finally {
    await close()
  }
})
