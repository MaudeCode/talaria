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

/** TAL-1712: the bootstrap's `shell` stands in for these reads, so a spec that mocks one must get a bootstrap without it. */
const SHELL_READS = ['settings', 'profiles', 'workspaces', 'projects'].map((name) => new URL(`http://127.0.0.1/api/${name}`))
const BOOTSTRAP = new URL('http://127.0.0.1/api/bootstrap')
type RouteUrl = Parameters<Page['route']>[0]

/** Playwright's URL glob (`**` any characters, `*` any but `/`), enough for the patterns specs pass. */
function routeMatches(pattern: RouteUrl, url: URL): boolean {
  if (typeof pattern === 'function') return pattern(url)
  if (pattern instanceof RegExp) return new RegExp(pattern.source, pattern.flags.replace('g', '')).test(url.href)
  if (typeof pattern !== 'string') return pattern.test(url.href)
  const source = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replaceAll('\u0000', '.*')
  return new RegExp(`^${source}$`).test(url.href)
}

export const test = base.extend<{ errors: string[]; shellMocks: undefined }>({
  /**
   * A spec that mocks a shell read keeps reading it through its mock: once it routes one, every bootstrap the page gets
   * drops `shell`, including one a spec's own `/api/bootstrap` route fulfills from `route.fetch()`.
   */
  shellMocks: [async ({ context, page }, use) => {
    let mocked = false
    const withoutShell = (json: unknown): unknown => {
      if (!mocked || !json || typeof json !== 'object') return json
      const copy = { ...json }
      Reflect.deleteProperty(copy, 'shell')
      return copy
    }
    // Page and context routes alike: a spec may mock a shell read on either.
    for (const target of [page, context] as Pick<Page, 'route'>[]) {
      const route = target.route.bind(target)
      target.route = async (url, handler, options) => {
        if (!mocked && SHELL_READS.some((read) => routeMatches(url, read))) {
          mocked = true
          await page.route('**/api/bootstrap', async (bootstrap) => {
            const response = await bootstrap.fetch()
            await bootstrap.fulfill({ response, json: withoutShell(await response.json()) })
          })
        }
        if (!routeMatches(url, BOOTSTRAP)) return route(url, handler, options)
        return route(url, (bootstrap, request) => {
          const fulfill = bootstrap.fulfill.bind(bootstrap)
          bootstrap.fulfill = (fulfilled) => fulfill(fulfilled && 'json' in fulfilled ? { ...fulfilled, json: withoutShell(fulfilled.json) } : fulfilled)
          return handler(bootstrap, request)
        }, options)
      }
    }
    await use(undefined)
    // A boot or profile switch can still be reading the bootstrap when the test ends; its route must not fail the test then.
    if (mocked) await Promise.all([page.unrouteAll({ behavior: 'ignoreErrors' }), context.unrouteAll({ behavior: 'ignoreErrors' })])
  }, { auto: true }],
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
    await page.route('**/api/background/tasks?**', (route) => route.fulfill({ json: { session_id: new URL(route.request().url()).searchParams.get('session_id') ?? '', agent_available: true, tasks: [], pinned_count: 0 } }))
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

/** TAL-2099: the titlebar shows its profile chip only with Settings > Navigation's Profile switcher shown. */
export async function showTitlebarProfile(page: Page): Promise<void> {
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    return route.fulfill({ response, json: { ...await response.json(), show_titlebar_profile: true } })
  })
}

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

/** Records whether the page cancelled each contextmenu event, which is what suppresses the browser's own menu. */
export async function watchNativeMenu(page: Page): Promise<() => Promise<boolean[]>> {
  await page.evaluate(() => {
    const seen: boolean[] = []
    ;(window as unknown as { nativeMenus: boolean[] }).nativeMenus = seen
    window.addEventListener('contextmenu', (event) => { setTimeout(() => seen.push(!event.defaultPrevented)) }, true)
  })
  return () => page.evaluate(() => (window as unknown as { nativeMenus: boolean[] }).nativeMenus)
}

/** Holds one touch point past Base UI's 500 ms long-press, as a finger would, `across` the way over the target's width. */
export async function longPress(page: Page, target: Locator, across = 1 / 2): Promise<void> {
  const box = await target.boundingBox()
  if (!box) throw new Error('long-press target is not visible')
  const point = { x: box.x + box.width * across, y: box.y + box.height / 2 }
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
  await page.waitForTimeout(800)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

/** 127.0.0.1 is a secure context, so hide the API the way http://<lan-ip> does. The returned reader keeps a private handle on the real clipboard. */
export async function hideClipboardApi(page: Page): Promise<() => Promise<string>> {
  await page.addInitScript(() => {
    ;(window as unknown as { realClipboard: Clipboard }).realClipboard = navigator.clipboard
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
  })
  return () => page.evaluate(() => (window as unknown as { realClipboard: Clipboard }).realClipboard.readText())
}

/** The iPhone Duo's Safari viewports in CSS px (foldable-web skill): each display in both orientations, and split view. */
export const DUO_VIEWPORTS = [
  { name: 'outer-portrait', width: 382, height: 580 },
  { name: 'outer-landscape', width: 594, height: 368 },
  { name: 'inner-portrait', width: 669, height: 867 },
  { name: 'inner-landscape', width: 951, height: 585 },
  { name: 'inner-split', width: 385, height: 571 },
] as const

/**
 * Sizes the page to each Duo viewport and asserts the document has no sideways scroll there, then restores the original
 * size. `pane`, for a page whose content scrolls inside its own element (Settings), is held to the same rule, since its
 * overflow never widens the document. `shot`, when given, is called with `<name>-<viewport>` at each viewport.
 */
export async function expectNoOverflow(page: Page, name: string, shot?: (name: string) => Promise<void>, pane?: Locator): Promise<void> {
  const original = page.viewportSize()
  try {
    for (const { name: viewport, width, height } of DUO_VIEWPORTS) {
      await page.setViewportSize({ width, height })
      // Two frames: media-query listeners re-render after the resize before the width is read.
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} has no horizontal scroll at ${viewport}`).toBe(true)
      if (pane) await expect.poll(() => pane.evaluate((el) => el.scrollWidth <= el.clientWidth), `${name} has no horizontal scroll in its pane at ${viewport}`).toBe(true)
      await shot?.(`${name}-${viewport}`)
    }
  } finally {
    if (original) await page.setViewportSize(original)
  }
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
