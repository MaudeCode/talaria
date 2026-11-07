import { test as base, expect, type ConsoleMessage, type Locator, type Page } from '@playwright/test'

/** Console errors and page exceptions fail the test; the allowlist is deliberately tiny. */
const BENIGN = [
  /favicon/i,
  /service worker/i,
  /sw\.js/i,
  /the server responded with a status of (40[134]|503)/i,
  // A deliberately wrong password in auth.spec.ts.
  /\/api\/auth\/login$/,
  // Server-side backpressure: the per-client SSE cap (server api/sse-routes.ts) counts
  // streams from earlier tests until their disconnect is noticed; EventSource
  // reconnects on 503 by specification, so the UI self-heals.
  /503 GET .*\/api\/sessions\/events$/,
  // Kanban needs the Agent sidecar; without it the server answers 503 "kanban unavailable" by
  // design (server tools/kanban.ts) and the page shows its unavailable state.
  /503 GET .*\/api\/kanban\/(boards?|tasks?(\/[^/?]+)?|stats)(\?|$)/,
]

export const test = base.extend<{ errors: string[] }>({
  errors: [async ({ page }, use) => {
    const errors: string[] = []
    const onConsole = (msg: ConsoleMessage) => {
      if (msg.type() === 'error' && !BENIGN.some((re) => re.test(msg.text()))) errors.push(msg.text())
    }
    // TAL-372: specs that mock their session in the page have no server record of it, so the composer's background card
    // gets an empty list by default; a spec that tests background work routes its own (later routes win).
    // TAL-567: the Kanban page holds an event stream; by default it says hello and reconnects each second, so the page
    // still reaches network idle. A spec that tests live refresh routes its own.
    await page.route('**/api/kanban/events/stream**', (route) => route.fulfill({ headers: { 'content-type': 'text/event-stream' }, body: 'retry: 1000\n\nevent: hello\ndata: {}\n\n' }))
    await page.route('**/api/background/tasks?**', (route) => route.fulfill({ json: { session_id: new URL(route.request().url()).searchParams.get('session_id') ?? '', agent_available: true, tasks: [] } }))
    // TAL-564: likewise the composer's server draft reads empty and accepts saves; draft-sync.spec.ts unroutes this.
    await page.route('**/api/session/draft**', (route) => route.fulfill({ json: { ok: true, draft: { text: '', files: [] }, draft_version: null } }))
    page.on('console', onConsole)
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
    page.on('response', (res) => {
      // Name the failing request: the console only says "Failed to load resource".
      const line = `${res.status()} ${res.request().method()} ${res.url()}`
      if (res.status() >= 400 && !BENIGN.some((re) => re.test(line))) errors.push(line)
    })
    await use(errors)
    expect(errors, 'no console errors or uncaught exceptions').toEqual([])
  }, { auto: true }],
})

export { expect }

/** Opens the Chats filter menu; on a phone the drawer must already be open. */
export async function openChatFilters(page: Page) {
  await page.getByRole('button', { name: /^Chat filters/ }).click()
  const menu = page.getByRole('menu', { name: /^Chat filters/ })
  await expect(menu).toBeVisible()
  return menu
}

/** Opens the selected project's actions through the filter menu (TAL-1869). */
export async function openProjectActions(page: Page) {
  await (await openChatFilters(page)).getByRole('menuitem', { name: 'Selected project' }).click()
  const menu = page.getByRole('menu', { name: 'Selected project' })
  await expect(menu).toBeVisible()
  return menu
}

export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle')
  // Wait for the router to render the shell (the titlebar is hidden in desktop browsers, so wait for the layout or a full-page route).
  await expect(page.locator('#app :visible').first()).toBeVisible()
}

/** 127.0.0.1 is a secure context, so hide the API the way http://<lan-ip> does. The returned reader keeps a private handle on the real clipboard. */
export async function hideClipboardApi(page: Page): Promise<() => Promise<string>> {
  await page.addInitScript(() => {
    ;(window as unknown as { realClipboard: Clipboard }).realClipboard = navigator.clipboard
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
  })
  return () => page.evaluate(() => (window as unknown as { realClipboard: Clipboard }).realClipboard.readText())
}

/** TAL-1943: the prompt card starts below the chat header, each control is on screen and uncovered once scrolled to, and the page has no sideways scroll. */
export async function expectPromptReachable(page: Page, card: Locator, controls: Locator[]): Promise<void> {
  // --composer-h is a whole pixel, so the card's edge can land a fraction of one past the stage's.
  await expect.poll(async () => (await card.boundingBox())!.y + 1).toBeGreaterThanOrEqual((await page.locator('.chat-stage').boundingBox())!.y)
  for (const control of controls) {
    await control.scrollIntoViewIfNeeded()
    await expect(control).toBeInViewport({ ratio: 1 })
    await expect.poll(() => control.evaluate((el) => {
      const box = el.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return !!hit && el.contains(hit)
    })).toBe(true)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}
