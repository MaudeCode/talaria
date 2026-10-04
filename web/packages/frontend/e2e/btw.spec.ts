import { createServer, type ServerResponse } from 'node:http'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const frame = (id: string, event: string, data: unknown) => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`

/** The chat (running or idle), a fixture SSE server for its streams, and the side-question route; records steers and sends. */
async function sideQuestionChat(page: Page, sid: string, running: boolean) {
  const run = `${sid}-run`
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Back up the cluster', active_stream_id: running ? run : null, is_streaming: running, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_duplicate: true,
    transcript_seq: null, messages: [{ role: 'user', id: 1, content: 'Back up the cluster', _turn_id: run }, ...(running ? [] : [{ role: 'assistant', id: 2, content: 'Backed up.', _turn_id: run }])],
  } } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: running, stream_id: running ? run : null, replay_available: false } }))
  const streams: ServerResponse[] = []
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    streams.push(response)
    if (new URL(request.url ?? '/', 'http://x').searchParams.get('stream_id') !== 'side') { response.write(frame(`${run}:1`, 'token', { text: 'Running the backup.' })); return }
    response.write(frame('side:1', 'token', { text: 'Three' }))
    response.write(frame('side:2', 'done', { ephemeral: true, answer: 'Three **nodes**.', terminal_state: 'completed' }))
    response.end(frame('side:3', 'stream_end', {}))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${String(address.port)}${new URL(route.request().url()).search}` }))
  const asked: unknown[] = []
  await page.route('**/api/btw', (route) => { asked.push(route.request().postDataJSON()); return route.fulfill({ json: { stream_id: 'side', session_id: 'hidden', parent_session_id: sid } }) })
  const sent: string[] = []
  await page.route('**/api/chat/{steer,start}', (route) => { sent.push(route.request().url()); return route.fulfill({ status: 500, json: { error: 'not expected' } }) })
  const close = async () => {
    for (const response of streams) response.end()
    await new Promise<void>((resolve) => server.close(() => { resolve() }))
  }
  return { asked, sent, close }
}

for (const running of [true, false]) {
  test(`/btw ${running ? 'during a run' : 'when idle'} answers beside the chat and leaves the transcript alone (TAL-518)`, async ({ page }, testInfo) => {
    const sid = running ? 'btw-running' : 'btw-idle'
    const chat = await sideQuestionChat(page, sid, running)
    try {
      await page.goto(`/session/${sid}`)
      await expect(page.locator('#messages')).toContainText('Back up the cluster')
      await page.locator('#msg').fill('/btw how many nodes?')
      await expect(page.locator('#btnSend')).toHaveAccessibleName('Send message')
      await page.locator('#btnSend').click()
      const panel = page.getByRole('region', { name: 'Side question — not in history' })
      await expect(panel).toContainText('how many nodes?')
      await expect(panel).toContainText('Three nodes.')
      expect(chat.asked).toEqual([{ session_id: sid, question: 'how many nodes?' }])
      expect(chat.sent).toEqual([])
      await expect(page.locator('#msg')).toHaveValue('')
      await expect(page.locator('#messages')).not.toContainText('how many nodes?')
      if (process.env.TAL518_SHOTS) await page.screenshot({ path: `${process.env.TAL518_SHOTS}/btw-${running ? 'running' : 'idle'}-${testInfo.project.name}.png` })

      await page.locator('[data-notice="btw"]').getByRole('button', { name: 'Dismiss' }).click()
      await expect(panel).toHaveCount(0)
    } finally {
      await chat.close()
    }
  })
}
