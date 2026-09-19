import { test as base, expect, type ConsoleMessage, type Page } from '@playwright/test'

/** Console errors and page exceptions fail the test; the allowlist is deliberately tiny. */
const BENIGN = [
  /favicon/i,
  /service worker/i,
  /sw\.js/i,
  /the server responded with a status of (40[134]|503)/i,
  // A deliberately wrong password in auth.spec.ts.
  /\/api\/auth\/login$/,
  // Server-side backpressure: the per-client SSE cap (api/http_server.py) counts
  // streams from earlier tests until their disconnect is noticed; EventSource
  // reconnects on 503 by specification, so the UI self-heals.
  /503 GET .*\/api\/sessions\/events$/,
  // Kanban needs hermes_cli; without it the server answers 503 "kanban unavailable" by
  // design (api/kanban_bridge.py) and the page shows its unavailable state.
  /503 GET .*\/api\/kanban\/(boards?|tasks?)(\?|$)/,
]

export const test = base.extend<{ errors: string[] }>({
  errors: [async ({ page }, use) => {
    const errors: string[] = []
    const onConsole = (msg: ConsoleMessage) => {
      if (msg.type() === 'error' && !BENIGN.some((re) => re.test(msg.text()))) errors.push(msg.text())
    }
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

export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle')
  // Wait for the router to render the shell (the titlebar is hidden in desktop browsers, so wait for the layout or a full-page route).
  await expect(page.locator('#app :visible').first()).toBeVisible()
}
