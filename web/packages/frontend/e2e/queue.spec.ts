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
  const stale: ServerResponse[] = []
  const close = async () => {
    for (const response of [...streams.values(), ...stale]) response.end()
    await new Promise<void>((resolve) => server.close(() => { resolve() }))
  }
  return { state, streams, stale, starts, settle, close }
}

// TAL-1078: the queue is a count chip over the composer; its rows open in a dialog.
const chip = (page: Page) => page.locator('[data-notice="queue"]')
async function queue(page: Page, text: string, count: number) {
  await page.locator('#msg').fill(`/queue ${text}`)
  await page.locator('#btnSend').click()
  await expect(chip(page)).toHaveText(`${String(count)} queued`)
}
async function openQueue(page: Page) {
  await chip(page).getByRole('button').click()
  await expect(page.getByRole('dialog')).toBeVisible()
}

const rows = (page: Page) => page.locator('.queue-card-list > *')
const row = (page: Page, text: string) => rows(page).filter({ hasText: text })

test('queued messages can be edited, deleted and reordered, and drain in the shown order after a reload', async ({ page }) => {
  const sid = 'queue-edit'
  const run = await runningSession(page, sid)
  try {
    await page.goto(`/session/${sid}`)
    await expect.poll(() => run.streams.has(`${sid}-run`)).toBe(true)
    await queue(page, 'First', 1)
    await queue(page, 'Second', 2)
    await queue(page, 'Third', 3)
    await expect(rows(page)).toHaveCount(0)
    await openQueue(page)
    await expect(page.getByRole('dialog', { name: '3 queued' })).toBeVisible()

    const cancel = row(page, 'Second').getByRole('button', { name: 'Cancel queued message' })
    await expect(cancel).toBeVisible()
    await cancel.click()
    await expect(rows(page)).toHaveText(['First', 'Third'])
    await expect(chip(page)).toHaveText('2 queued')

    await row(page, 'Third').getByRole('button', { name: 'Edit queued message' }).click()
    const editor = page.getByRole('textbox', { name: 'Edit queued message' })
    await editor.fill('Third, edited')
    await editor.press('Enter')
    await expect(rows(page)).toHaveText(['First', 'Third, edited'])

    await row(page, 'Third, edited').getByRole('button', { name: 'Reorder queued message' }).dragTo(row(page, 'First'))
    await expect(rows(page)).toHaveText(['Third, edited', 'First'])
    // The keyboard moves a row too, and Escape closes the dialog onto its chip without sending anything.
    await row(page, 'First').getByRole('button', { name: 'Reorder queued message' }).focus()
    await page.keyboard.press('ArrowUp')
    await expect(rows(page)).toHaveText(['First', 'Third, edited'])
    await page.keyboard.press('ArrowDown')
    await expect(rows(page)).toHaveText(['Third, edited', 'First'])
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(chip(page).getByRole('button')).toBeFocused()
    expect(run.starts).toEqual([])

    // The reloaded tab reattaches on a new connection; the run settles on that one. Ending the old one here would
    // settle the turn before the reload.
    run.stale.push(run.streams.get(`${sid}-run`)!)
    run.streams.delete(`${sid}-run`)
    await page.reload()
    await expect.poll(() => run.streams.has(`${sid}-run`)).toBe(true)
    await openQueue(page)
    await expect(rows(page)).toHaveText(['Third, edited', 'First'])
    expect(run.starts).toEqual([])

    // Draining empties the open dialog: it closes, the chip goes, and focus returns to the composer.
    run.settle()
    await expect.poll(() => run.starts).toEqual(['Third, edited', 'First'])
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(chip(page)).toHaveCount(0)
    await expect(page.locator('#msg')).toBeFocused()
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
    await queue(page, 'After the run', 1)
    // The run ends while this tab is gone, so no live turn settles to start the drain.
    await page.goto('about:blank')
    run.state.running = false
    await page.goto(`/session/${sid}`)
    await expect.poll(() => run.starts).toEqual(['After the run'])
    await expect(chip(page)).toHaveCount(0)
  } finally {
    await run.close()
  }
})
