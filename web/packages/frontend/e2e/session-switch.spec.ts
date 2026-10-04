import { createServer, type ServerResponse } from 'node:http'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** Switching sessions leaves nothing of the previous one behind: its queue, YOLO state, or compression (TAL-517). */

const transcript = (sid: string) => [
  { role: 'user', id: 1, content: `${sid} question` },
  { role: 'assistant', id: 2, content: `${sid} answer` },
]

/** Sidebar-style entry: the router changes the session without reloading the page. */
async function enter(page: Page, sid: string): Promise<void> {
  await page.evaluate((path) => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')) }, `/session/${sid}`)
  await expect(page.locator('#messages').getByText(`${sid} question`)).toBeAttached()
}

/** A request held until the test releases it. */
function hold() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  return { gate, release }
}

const yoloTab = '.composer-tab [data-notice="yolo"]'

test('a message queued in one session never sends into the next', async ({ page }) => {
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
  let bDone = false
  await page.route('**/api/session?**', (route) => {
    const sid = new URL(route.request().url()).searchParams.get('session_id') ?? ''
    const running = sid === 'switch-queue-a' || (sid === 'switch-queue-b' && !bDone)
    return route.fulfill({ json: { session: { session_id: sid, title: sid, messages: transcript(sid), ...(running ? { active_stream_id: `${sid}-run`, is_streaming: true } : {}) } } })
  })
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: new URL(route.request().url()).searchParams.get('stream_id'), replay_available: false } }))
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${String(address.port)}${new URL(route.request().url()).search}` }))
  await page.route('**/api/session/draft', (route) => route.fulfill({ json: { ok: true } }))
  const starts: unknown[] = []
  await page.route('**/api/chat/start', async (route) => { starts.push(route.request().postDataJSON()); await route.fulfill({ json: { status: 'suppressed' } }) })
  try {
    await page.goto('/session/switch-queue-a')
    await expect.poll(() => streams.has('switch-queue-a-run')).toBe(true)
    await page.locator('#msg').fill('/queue Follow up in A')
    await page.locator('#btnSend').click()
    await expect(page.locator('.queue-card')).toContainText('Follow up in A')

    await enter(page, 'switch-queue-b')
    await expect.poll(() => streams.has('switch-queue-b-run')).toBe(true)
    // B's own turn settles: a queue carried over from A would drain into B now.
    bDone = true
    streams.get('switch-queue-b-run')!.write(`id: switch-queue-b-run:2\nevent: done\ndata: ${JSON.stringify({ session: { session_id: 'switch-queue-b', title: 'switch-queue-b', messages: transcript('switch-queue-b') }, terminal_state: 'completed' })}\n\n`)
    await expect(page.locator('.live-turn')).toHaveCount(0)
    await page.waitForTimeout(500)
    expect(starts).toEqual([])
    await expect(page.locator('.queue-card')).toHaveCount(0)
  } finally {
    for (const response of streams.values()) response.end()
    await new Promise<void>((resolve) => server.close(() => { resolve() }))
  }
})

test("a session's YOLO state is its own, however late the previous session's answer arrives", async ({ page }) => {
  const yolo: Record<string, boolean> = { 'switch-yolo-a': true, 'switch-yolo-b': false }
  const held = new Map<string, ReturnType<typeof hold>>()
  const answered = new Map<string, ReturnType<typeof hold>>()
  await page.route('**/api/session?**', (route) => {
    const sid = new URL(route.request().url()).searchParams.get('session_id') ?? ''
    return route.fulfill({ json: { session: { session_id: sid, title: sid, messages: transcript(sid) } } })
  })
  await page.route('**/api/session/draft', (route) => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/session/yolo?**', async (route) => {
    const sid = new URL(route.request().url()).searchParams.get('session_id') ?? ''
    await held.get(sid)?.gate
    await route.fulfill({ json: { yolo_enabled: yolo[sid] } })
    answered.get(sid)?.release()
  })

  await page.goto('/session/switch-yolo-a')
  await expect(page.locator(yoloTab)).toBeVisible()

  // B's answer is slow: until it arrives B does not show A's setting.
  held.set('switch-yolo-b', hold())
  await enter(page, 'switch-yolo-b')
  await page.waitForTimeout(300)
  await expect(page.locator(yoloTab)).toHaveCount(0)
  held.get('switch-yolo-b')!.release()

  // A's answer lands after the switch to B: it does not apply to B.
  await enter(page, 'switch-yolo-a')
  await expect(page.locator(yoloTab)).toBeVisible()
  held.set('switch-yolo-b', hold())
  await enter(page, 'switch-yolo-b')
  held.get('switch-yolo-b')!.release()
  await expect(page.locator(yoloTab)).toHaveCount(0)
  held.set('switch-yolo-a', hold())
  answered.set('switch-yolo-a', hold())
  held.set('switch-yolo-b', hold())
  await enter(page, 'switch-yolo-a')
  await enter(page, 'switch-yolo-b')
  held.get('switch-yolo-a')!.release()
  await answered.get('switch-yolo-a')!.gate
  await page.waitForTimeout(300)
  await expect(page.locator(yoloTab)).toHaveCount(0)
  held.get('switch-yolo-b')!.release()
  await expect(page.locator(yoloTab)).toHaveCount(0)
})

test('leaving a session mid-compression stops it: the next session stays unlocked and is never navigated away from', async ({ page }) => {
  let polls = 0
  let finished = false
  await page.route('**/api/session?**', (route) => {
    const sid = new URL(route.request().url()).searchParams.get('session_id') ?? ''
    return route.fulfill({ json: { session: { session_id: sid, title: sid, messages: transcript(sid) } } })
  })
  await page.route('**/api/session/draft', (route) => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/session/compress/start', (route) => route.fulfill({ json: { status: 'running' } }))
  await page.route('**/api/session/compress/status?**', (route) => {
    polls += 1
    return route.fulfill({ json: finished ? { status: 'done', session_id: 'switch-compress-fork' } : { status: 'running' } })
  })
  await page.goto('/session/switch-compress-a')
  await page.locator('#msg').fill('/compress')
  await page.locator('#btnSend').click()
  await expect(page.locator('.composer-tab [data-notice="runtime:compressing"]')).toBeVisible()
  await expect.poll(() => polls).toBeGreaterThan(0)

  await enter(page, 'switch-compress-b')
  await expect(page.locator('.composer-tab [data-notice="runtime:compressing"]')).toHaveCount(0)
  // A's compression finishes into a fork; B is not navigated to it, and A's job is no longer polled.
  finished = true
  const seen = polls
  await page.waitForTimeout(2500)
  await expect(page).toHaveURL(/\/session\/switch-compress-b$/)
  expect(polls - seen).toBeLessThanOrEqual(1)
})
