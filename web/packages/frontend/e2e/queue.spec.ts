import { createServer, type ServerResponse } from 'node:http'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** TAL-562: queued messages can be edited, deleted and reordered, survive a reload, and drain in the shown order. */

const transcript = (sid: string) => [
  { role: 'user', id: 1, content: `${sid} question` },
  { role: 'assistant', id: 2, content: `${sid} answer` },
]

/** A session whose run streams from a local SSE server until the test settles it; every `chat.start` body is recorded. */
async function runningSession(page: Page, sid: string) {
  const streams = new Map<string, ServerResponse>()
  const server = createServer((request, response) => {
    const streamId = new URL(request.url ?? '/', 'http://fixture').searchParams.get('stream_id') ?? ''
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    response.write(`id: ${streamId}:1\nevent: token\ndata: ${JSON.stringify({ text: 'Working.' })}\n\n`)
    streams.set(streamId, response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  const state = { running: true }
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: sid, title: sid, messages: transcript(sid), ...(state.running ? { active_stream_id: `${sid}-run`, is_streaming: true } : {}) } } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: state.running, stream_id: new URL(route.request().url()).searchParams.get('stream_id'), replay_available: false } }))
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${String(address.port)}${new URL(route.request().url()).search}` }))
  await page.route('**/api/session/draft', (route) => route.fulfill({ json: { ok: true } }))
  const starts: string[] = []
  await page.route('**/api/chat/start', async (route) => { starts.push((route.request().postDataJSON() as { message: string }).message); await route.fulfill({ json: { status: 'suppressed' } }) })
  const settle = () => {
    state.running = false
    streams.get(`${sid}-run`)!.write(`id: ${sid}-run:2\nevent: done\ndata: ${JSON.stringify({ session: { session_id: sid, title: sid, messages: transcript(sid) }, terminal_state: 'completed' })}\n\n`)
  }
  const close = async () => {
    for (const response of streams.values()) response.end()
    await new Promise<void>((resolve) => server.close(() => { resolve() }))
  }
  return { state, streams, starts, settle, close }
}

async function queue(page: Page, text: string) {
  await page.locator('#msg').fill(`/queue ${text}`)
  await page.locator('#btnSend').click()
  await expect(rows(page).last()).toContainText(text)
}

const rows = (page: Page) => page.locator('.queue-card-list > *')
const row = (page: Page, text: string) => rows(page).filter({ hasText: text })

test('queued messages can be edited, deleted and reordered, and drain in the shown order after a reload', async ({ page }) => {
  const sid = 'queue-edit'
  const run = await runningSession(page, sid)
  try {
    await page.goto(`/session/${sid}`)
    await expect.poll(() => run.streams.has(`${sid}-run`)).toBe(true)
    await queue(page, 'First')
    await queue(page, 'Second')
    await queue(page, 'Third')

    const cancel = row(page, 'Second').getByRole('button', { name: 'Cancel queued message' })
    await expect(cancel).toBeVisible()
    await cancel.click()
    await expect(rows(page)).toHaveText(['First', 'Third'])

    await row(page, 'Third').getByRole('button', { name: 'Edit queued message' }).click()
    const editor = page.getByRole('textbox', { name: 'Edit queued message' })
    await editor.fill('Third, edited')
    await editor.press('Enter')
    await expect(rows(page)).toHaveText(['First', 'Third, edited'])

    await row(page, 'Third, edited').getByRole('button', { name: 'Reorder queued message' }).dragTo(row(page, 'First'))
    await expect(rows(page)).toHaveText(['Third, edited', 'First'])

    // The reloaded tab reattaches on a new connection; the run settles on that one.
    run.streams.get(`${sid}-run`)!.end()
    run.streams.delete(`${sid}-run`)
    await page.reload()
    await expect.poll(() => run.streams.has(`${sid}-run`)).toBe(true)
    await expect(rows(page)).toHaveText(['Third, edited', 'First'])
    expect(run.starts).toEqual([])

    run.settle()
    await expect.poll(() => run.starts).toEqual(['Third, edited', 'First'])
    await expect(page.locator('.queue-card')).toHaveCount(0)
  } finally {
    await run.close()
  }
})

test('a queue restored on a session whose run ended meanwhile drains at once', async ({ page }) => {
  const sid = 'queue-idle'
  const run = await runningSession(page, sid)
  try {
    await page.goto(`/session/${sid}`)
    await expect.poll(() => run.streams.has(`${sid}-run`)).toBe(true)
    await queue(page, 'After the run')
    // The run ends while this tab is gone, so no live turn settles to start the drain.
    await page.goto('about:blank')
    run.state.running = false
    await page.goto(`/session/${sid}`)
    await expect.poll(() => run.starts).toEqual(['After the run'])
    await expect(page.locator('.queue-card')).toHaveCount(0)
  } finally {
    await run.close()
  }
})
