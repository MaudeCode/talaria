import { test as base, expect, type ConsoleMessage, type Page } from '@playwright/test'

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
  /503 GET .*\/api\/kanban\/(boards?|tasks?)(\?|$)/,
]

export const test = base.extend<{ errors: string[] }>({
  errors: [async ({ page }, use) => {
    const errors: string[] = []
    const onConsole = (msg: ConsoleMessage) => {
      if (msg.type() === 'error' && !BENIGN.some((re) => re.test(msg.text()))) errors.push(msg.text())
    }
    // TAL-372: specs that mock their session in the page have no server record of it, so the composer's background card
    // gets an empty list by default; a spec that tests background work routes its own (later routes win).
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

export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle')
  // Wait for the router to render the shell (the titlebar is hidden in desktop browsers, so wait for the layout or a full-page route).
  await expect(page.locator('#app :visible').first()).toBeVisible()
}
