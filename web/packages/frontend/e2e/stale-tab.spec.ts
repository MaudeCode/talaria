import type { BrowserContext, Page, Route } from '@playwright/test'
import { expect, settle, test } from './fixtures'

/** A disposable identity for "the bundle this tab loaded before the deployment"; the server serves the committed build. */
const OLD_BUILD = 'a'.repeat(64)
const BUILD_META = /(<meta name="talaria-build" content=")[a-f0-9]{64}(")/
const TITLE = 'Talaria Web was updated'

interface BuildState { current_build: string | null; loaded_build: string | null; refresh_required: boolean; notification_id: string | null }

/** Every server build comparison this page receives, in order. */
function watchChecks(page: Page): BuildState[] {
  const seen: BuildState[] = []
  page.on('response', (res) => {
    if (res.request().method() !== 'GET' || !res.ok() || !new URL(res.url()).pathname.endsWith('/api/update-notifications')) return
    void res.json().then((body: { frontend_build: BuildState }) => { seen.push(body.frontend_build) }, () => undefined)
  })
  return seen
}

/** Serve the real shell with the old build identity stamped in. */
async function fulfillOldShell(route: Route): Promise<void> {
  const response = await route.fetch()
  await route.fulfill({ response, body: (await response.text()).replace(BUILD_META, `$1${OLD_BUILD}$2`) })
}

type ShellMode = 'old' | 'current' | 'unreachable'

/** Answer every shell request (including a service worker's network fetch and precache) per `mode()`. */
async function routeShell(target: Page | BrowserContext, mode: () => ShellMode): Promise<void> {
  await target.route('**/*', (route) => {
    const request = route.request()
    const shell = request.isNavigationRequest() || request.resourceType() === 'document' || (request.headers().accept ?? '').includes('text/html') || new URL(request.url()).pathname.endsWith('/index.html')
    if (!shell || mode() === 'current') return route.fallback()
    return mode() === 'old' ? fulfillOldShell(route) : route.abort('internetdisconnected')
  })
}

test.describe('stale Web tab refresh notice', () => {
  test.use({ serviceWorkers: 'block' })

  test('an old tab keeps one persistent server notice until Refresh now loads the current build', async ({ page, context }) => {
    let mode: ShellMode = 'old'
    await routeShell(page, () => mode)
    const checks = watchChecks(page)
    let documents = 0
    page.on('request', (request) => { if (request.resourceType() === 'document') documents += 1 })
    await page.goto('/')
    await settle(page)

    const popup = page.locator('.notification-toast').filter({ hasText: TITLE })
    const refresh = popup.getByRole('button', { name: 'Refresh now', exact: true })
    await expect(refresh).toBeVisible()
    await expect(popup.getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(0)
    await expect.poll(() => checks.at(-1)).toMatchObject({ loaded_build: OLD_BUILD, refresh_required: true })
    const { current_build: current, notification_id: id } = checks.at(-1)!
    expect(current).toMatch(/^[a-f0-9]{64}$/)
    expect(current).not.toBe(OLD_BUILD)
    expect(id).toMatch(/^[0-9a-f-]{36}$/)

    // Another tab on the current build: no false notice, and the stale tab's record stays scoped to that tab.
    const other = await context.newPage()
    const otherChecks = watchChecks(other)
    await other.goto('/')
    await settle(other)
    await expect.poll(() => otherChecks.length).toBeGreaterThan(1)
    expect(otherChecks.every((check) => check.loaded_build === current && !check.refresh_required && check.notification_id === null)).toBe(true)
    await expect(other.locator('.notification-toast').filter({ hasText: TITLE })).toHaveCount(0)
    await other.close()

    // A same-origin window opened from the stale tab inherits a copy of its sessionStorage; it must still get its own tab id.
    const tabIds = (target: Page) => {
      const ids = new Set<string>()
      target.on('request', (request) => { const id = new URL(request.url()).searchParams.get('tab_id'); if (id) ids.add(id) })
      return ids
    }
    const staleIds = tabIds(page)
    const [opened] = await Promise.all([page.waitForEvent('popup'), page.evaluate(() => { window.open('./', '_blank') })])
    const openedIds = tabIds(opened)
    const openedChecks = watchChecks(opened)
    await settle(opened)
    await expect.poll(() => openedChecks.length).toBeGreaterThan(1)
    expect(openedChecks.at(-1)).toMatchObject({ loaded_build: current, refresh_required: false })
    await expect.poll(() => staleIds.size).toBe(1)
    expect([...openedIds].some((id) => staleIds.has(id))).toBe(false)
    await opened.close()
    await expect.poll(() => checks.at(-1)).toMatchObject({ refresh_required: true, notification_id: id })

    // Reading the inbox and Clear all leave the required interaction in place.
    const bell = page.getByRole('button', { name: 'Notifications', exact: true })
    await bell.click()
    const center = page.getByRole('dialog')
    const row = center.getByRole('listitem').filter({ hasText: TITLE })
    await expect(row.getByRole('button', { name: 'Refresh now', exact: true })).toBeVisible()
    await expect(row.getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(0)
    const clearAll = center.getByRole('button', { name: 'Clear all', exact: true })
    if (await clearAll.isEnabled()) await clearAll.click()
    await expect(row).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(center).toBeHidden()
    await expect(bell).toBeFocused()
    await expect(refresh).toBeVisible()

    // An ordinary reload that still receives the old bundle keeps the same record.
    await page.reload()
    await settle(page)
    await expect(refresh).toBeVisible()
    await expect.poll(() => checks.at(-1)?.notification_id).toBe(id)

    // Refresh now that lands on the old bundle again leaves the notice actionable (keyboard activation).
    await refresh.focus()
    await Promise.all([page.waitForEvent('load'), page.keyboard.press('Enter')])
    await settle(page)
    await expect(refresh).toBeVisible()
    await expect.poll(() => checks.at(-1)?.notification_id).toBe(id)

    // The deployment is now served: Refresh now reloads once, and the server clears the notice after verifying the build.
    mode = 'current'
    const before = documents
    await Promise.all([page.waitForEvent('load'), refresh.click()])
    await settle(page)
    await expect.poll(() => checks.at(-1)).toEqual({ current_build: current, loaded_build: current, refresh_required: false, notification_id: null })
    await expect(popup).toHaveCount(0)
    expect(documents - before).toBe(1)
    expect(new Set(checks.map((check) => check.notification_id).filter(Boolean))).toEqual(new Set([id]))
  })
})

test.describe('stale Web tab refresh notice with a service worker', () => {
  test.use({ serviceWorkers: 'allow' })

  test('a stale cached shell keeps the notice actionable, and Refresh now reaches the current build through the worker', async ({ page, context }) => {
    let mode: ShellMode = 'old'
    await routeShell(context, () => mode)
    const checks = watchChecks(page)
    await page.goto('/')
    await settle(page)
    // The worker installs and precaches this (old) shell.
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 20_000 }).toBe(true)
    await page.reload()
    await settle(page)
    const popup = page.locator('.notification-toast').filter({ hasText: TITLE })
    const refresh = popup.getByRole('button', { name: 'Refresh now', exact: true })
    await expect(refresh).toBeVisible()
    await expect.poll(() => checks.at(-1)).toMatchObject({ loaded_build: OLD_BUILD, refresh_required: true })
    const { current_build: current, notification_id: id } = checks.at(-1)!

    // The deployment is live, but the reload cannot reach the server: the worker answers with its cached old shell.
    mode = 'unreachable'
    await Promise.all([page.waitForEvent('load'), refresh.click()])
    await expect(refresh).toBeVisible()
    await expect.poll(() => checks.at(-1)).toMatchObject({ loaded_build: OLD_BUILD, refresh_required: true, notification_id: id })

    // Reachable again: the worker fetches navigations network-first, so one Refresh now loads the current build.
    mode = 'current'
    await Promise.all([page.waitForEvent('load'), refresh.click()])
    await settle(page)
    await expect.poll(() => checks.at(-1)).toEqual({ current_build: current, loaded_build: current, refresh_required: false, notification_id: null })
    await expect(popup).toHaveCount(0)
    expect(new Set(checks.map((check) => check.notification_id).filter(Boolean))).toEqual(new Set([id]))
  })
})
