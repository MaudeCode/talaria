import { readFileSync } from 'node:fs'
import type { BrowserContext, Page } from '@playwright/test'
import type { ReleaseInfo, WhatsNewAnnouncement } from '@maudecode/talaria-web-contracts'
import { whatsNewState } from '../../server/dist/release.js'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/**
 * TAL-1617. The e2e server ships no announcement, so each spec answers `/api/whats-new` with the server's own decision
 * (`whatsNewState`) for a synthetic installed release and the build this server really serves.
 */
const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/whats-new.json', import.meta.url), 'utf8')) as { web: WhatsNewAnnouncement }
const announcement: WhatsNewAnnouncement = {
  ...fixture.web,
  rows: [
    ...fixture.web.rows,
    { id: 'TAL-11-1', icon: 'voice', title: 'Talk to your agent', description: 'Hold the mic button and speak; your words appear in the composer.' },
    { id: 'TAL-12-1', icon: 'automation', title: 'Scheduled tasks', description: 'Run a prompt every morning and read the result when you sit down.' },
  ],
}
/** A later Experimental build of the same X.Y.Z core packages one new row beside the earlier ones (TAL-1981). */
const EXPERIMENTAL = '1.1.0-exp.cccccccccccc'
const NEW_ROW = { id: 'TAL-13-1', icon: 'share', title: 'Share a chat', description: 'Send a read-only link to any conversation.' } as const
const experimental: WhatsNewAnnouncement = { ...announcement, id: `web-${EXPERIMENTAL}`, version: EXPERIMENTAL, rows: [...announcement.rows.slice(1), NEW_ROW] }
/** A release with nine new rows: three pages of four, four and one (TAL-2174). */
const PAGED_VERSION = '1.2.0'
const paged: WhatsNewAnnouncement = {
  ...announcement, id: `web-${PAGED_VERSION}`, version: PAGED_VERSION,
  rows: Array.from({ length: 9 }, (_, i) => ({ id: `TAL-${String(200 + i)}-1`, icon: 'sparkles', title: `Feature ${String(i + 1)}`, description: `What feature ${String(i + 1)} does for you.` })),
}
const TITLE = "What's New in Talaria Web"
const OLD_BUILD = 'a'.repeat(64)
const BUILD_META = /(<meta name="talaria-build" content=")([a-f0-9]{64})(")/

const release = (version: string) => ({ version, sourceRevision: announcement.sourceCommit }) as ReleaseInfo

interface Server { version: string; fail: boolean; reads: { loaded_build: string | null; observed: string | null }[] }

/** Route the endpoint for every page of `target` to the server decision for `server.version`. */
async function serveWhatsNew(target: Page | BrowserContext, request: Page['request'], server: Server): Promise<void> {
  const current = BUILD_META.exec(await (await request.get('/')).text())?.[2] ?? null
  await target.route('**/api/whats-new**', (route) => {
    const params = new URL(route.request().url()).searchParams
    server.reads.push({ loaded_build: params.get('loaded_build'), observed: params.get('observed') })
    if (server.fail) return route.fulfill({ status: 502, json: { error: 'bad gateway' } })
    const payload = [announcement, experimental, paged].find((a) => a.version === server.version) ?? null
    return route.fulfill({ json: whatsNewState(payload, release(server.version), params.get('observed') ?? undefined, params.get('loaded_build') ?? undefined, current) })
  })
}

const dialog = (page: Page) => page.getByRole('dialog', { name: TITLE })
/** Settings > About's Help row that replays the announcement (TAL-2146). */
const REPLAY = "What's New"

test('a later Web release introduces itself once, and Settings replays the same dialog', async ({ page }, testInfo) => {
  const server: Server = { version: '1.0.0', fail: false, reads: [] }
  await serveWhatsNew(page, page.request, server)
  await page.goto('/')
  await settle(page)
  // First observation is quiet and records the installed release.
  await expect.poll(() => server.reads.length).toBe(1)
  expect(server.reads[0]).toMatchObject({ observed: null })
  expect(server.reads[0]!.loaded_build).toMatch(/^[a-f0-9]{64}$/)
  await expect(dialog(page)).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('whats-new-before.png') })

  server.version = '1.1.0'
  await page.reload()
  const shown = dialog(page)
  await expect(shown).toBeVisible()
  expect(server.reads.at(-1)!.observed).toBe('web:rows:')
  const rows = shown.getByRole('listitem')
  await expect(rows).toHaveCount(4)
  await expect(rows.nth(0)).toHaveText(announcement.rows[0]!.title + announcement.rows[0]!.description)
  await expect(shown.getByRole('button')).toHaveText(['Continue'])
  await expect(shown.getByRole('button', { name: 'Continue' })).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath('whats-new-after.png') })

  await shown.getByRole('button', { name: 'Continue' }).click()
  await expect(shown).toHaveCount(0)
  await page.reload()
  await settle(page)
  await expect(dialog(page)).toHaveCount(0)

  // A release with only an App/Agent change, or a rebuild of the same Web release, stays quiet too.
  await page.reload()
  await settle(page)
  await expect(dialog(page)).toHaveCount(0)

  // An Experimental build of the same X.Y.Z presents only the row this browser has not acknowledged.
  server.version = EXPERIMENTAL
  await page.reload()
  await expect(dialog(page).getByRole('listitem')).toHaveText([NEW_ROW.title + NEW_ROW.description])
  await page.screenshot({ path: testInfo.outputPath('whats-new-experimental.png') })
  await dialog(page).getByRole('button', { name: 'Continue' }).click()
  await expect(dialog(page)).toHaveCount(0)
  await page.reload()
  await settle(page)
  await expect(dialog(page)).toHaveCount(0)

  await page.goto('/settings/about')
  await settle(page)
  await page.screenshot({ path: testInfo.outputPath('whats-new-settings.png') })
  await page.getByRole('button', { name: REPLAY, exact: true }).click()
  const replay = dialog(page)
  // Settings replays the installed build's full announcement, rows already seen included.
  await expect(replay.getByRole('listitem')).toHaveText(experimental.rows.map((row) => row.title + row.description))
  await page.screenshot({ path: testInfo.outputPath('whats-new-replay.png') })
  await page.keyboard.press('Escape')
  await expect(replay).toHaveCount(0)
  await expect(page.getByRole('button', { name: REPLAY, exact: true })).toBeFocused()

  // Light theme: the same dialog keeps its contrast.
  await page.evaluate(() => { localStorage.setItem('hermes-theme', 'light') })
  await page.reload()
  await settle(page)
  await page.getByRole('button', { name: REPLAY, exact: true }).click()
  await expect(dialog(page)).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('whats-new-replay-light.png') })
  await page.keyboard.press('Escape')
  await page.reload()
  await settle(page)
  await expect(dialog(page)).toHaveCount(0)
})

test('an open tab still running the old build waits for the refresh before announcing', async ({ page }) => {
  const server: Server = { version: '1.0.0', fail: false, reads: [] }
  await serveWhatsNew(page, page.request, server)
  await page.goto('/')
  await settle(page)
  await expect.poll(() => server.reads.length).toBe(1)

  // The server updates while this tab keeps (or reloads into) the old bundle.
  server.version = '1.1.0'
  let stale = true
  await page.route('**/*', async (route) => {
    if (!stale || route.request().resourceType() !== 'document') return route.fallback()
    const response = await route.fetch()
    return route.fulfill({ response, body: (await response.text()).replace(BUILD_META, `$1${OLD_BUILD}$3`) })
  })
  await page.reload()
  await settle(page)
  await expect.poll(() => server.reads.at(-1)?.loaded_build).toBe(OLD_BUILD)
  await expect(dialog(page)).toHaveCount(0)

  stale = false
  await page.reload()
  await expect(dialog(page)).toBeVisible()
  // The old tab recorded nothing, so the refreshed tab still had the 1.0.0 observation with no rows.
  expect(server.reads.at(-1)!.observed).toBe('web:rows:')
})

test('two tabs of one browser converge when either dismisses the prompt', async ({ context, page }) => {
  const server: Server = { version: '1.0.0', fail: false, reads: [] }
  await serveWhatsNew(context, page.request, server)
  await page.goto('/')
  await settle(page)
  server.version = '1.1.0'
  await page.reload()
  const other = await context.newPage()
  await other.goto('/')
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(other)).toBeVisible()
  await dialog(other).getByRole('button', { name: 'Continue' }).click()
  await expect(dialog(other)).toHaveCount(0)
  await expect(dialog(page)).toHaveCount(0)
  await other.close()
})

test('a failed read keeps startup normal and leaves the announcement for the next launch', async ({ page, errors }) => {
  const server: Server = { version: '1.0.0', fail: false, reads: [] }
  await serveWhatsNew(page, page.request, server)
  await page.goto('/')
  await settle(page)
  server.version = '1.1.0'
  server.fail = true
  await page.reload()
  await settle(page)
  await expect(page.locator('#msg')).toBeVisible()
  await expect(dialog(page)).toHaveCount(0)
  const reads = server.reads.length
  errors.splice(0, errors.length, ...errors.filter((e) => !/api\/whats-new|status of 502/.test(e)))

  server.fail = false
  await page.reload()
  await expect(dialog(page)).toBeVisible()
  expect(server.reads.length).toBe(reads + 1)
  expect(server.reads.at(-1)!.observed).toBe('web:rows:')
})

test('the prompt waits for a draft in progress and returns to it untouched', async ({ page }) => {
  const server: Server = { version: '1.0.0', fail: false, reads: [] }
  await serveWhatsNew(page, page.request, server)
  await page.goto('/')
  await settle(page)
  server.version = '1.1.0'
  let release!: () => void
  const held = new Promise<void>((done) => { release = done })
  await page.route('**/api/whats-new**', async (route) => { await held; return route.fallback() })
  await page.reload()
  await page.locator('#msg').fill('Keep this thought')
  release()
  await expect.poll(() => server.reads.length).toBe(2)
  await expect(dialog(page)).toHaveCount(0)
  await page.locator('#msg').blur()
  await expect(dialog(page)).toBeVisible()
  await dialog(page).getByRole('button', { name: 'Continue' }).click()
  await expect(page.locator('#msg')).toHaveValue('Keep this thought')
})

test('nine new rows page four at a time with arrows, keys, Continue and a skip line (TAL-2174)', async ({ page }, testInfo) => {
  const server: Server = { version: '1.0.0', fail: false, reads: [] }
  await serveWhatsNew(page, page.request, server)
  await page.goto('/')
  await settle(page)
  await expect.poll(() => server.reads.length).toBe(1)
  server.version = PAGED_VERSION
  await page.reload()
  const shown = dialog(page)
  await expect(shown).toBeVisible()
  const titles = (from: number, to: number) => paged.rows.slice(from, to).map((row) => row.title + row.description)
  const rows = shown.getByRole('listitem')
  const previous = shown.getByRole('button', { name: 'Previous page' })
  const next = shown.getByRole('button', { name: 'Next page' })
  const proceed = shown.getByRole('button', { name: 'Continue' })
  const skip = shown.getByRole('button', { name: 'Skip, I like surprises' })
  await expect(rows).toHaveText(titles(0, 4))
  await expect(shown.locator('[data-page-dot]')).toHaveCount(3)
  await expect(proceed).toBeFocused()
  const height = (await shown.boundingBox())!.height
  const sameHeight = async () => { expect((await shown.boundingBox())!.height).toBeCloseTo(height, 0) }
  await page.screenshot({ path: testInfo.outputPath('whats-new-paged-1.png') })

  // At every width the arrows and dots share one line, the skip line is one line, and nothing scrolls sideways.
  const centre = async (target: ReturnType<Page['locator']>) => { const b = (await target.boundingBox())!; return b.y + b.height / 2 }
  for (const target of [shown.locator('[data-page-dot]').first(), next]) expect(Math.abs(await centre(target) - await centre(previous))).toBeLessThan(1)
  expect(await skip.evaluate((el) => { const range = document.createRange(); range.selectNodeContents(el); return range.getClientRects().length })).toBe(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  if (testInfo.project.use.hasTouch) {
    for (const target of [previous, next, skip]) {
      const box = (await target.boundingBox())!
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44)
    }
  }

  // Mouse: the next arrow turns the page; the previous arrow on page 1 does nothing.
  await expect(previous).toHaveAttribute('aria-disabled', 'true')
  await previous.click({ force: true })
  await expect(rows).toHaveText(titles(0, 4))
  await next.click()
  await expect(rows).toHaveText(titles(4, 8))
  await sameHeight()
  // Keyboard: the arrow keys turn the page, and the last page keeps the skip line's space.
  await page.keyboard.press('ArrowRight')
  await expect(rows).toHaveText(titles(8, 9))
  await expect(skip).toHaveCount(0)
  await sameHeight()
  await page.screenshot({ path: testInfo.outputPath('whats-new-paged-3.png') })
  await page.keyboard.press('ArrowLeft')
  await expect(rows).toHaveText(titles(4, 8))
  // Continue turns the page and keeps focus, by keyboard and by mouse, and closes on the last page.
  await proceed.focus()
  await page.keyboard.press('Enter')
  await expect(rows).toHaveText(titles(8, 9))
  await expect(proceed).toBeFocused()
  await sameHeight()
  await proceed.click()
  await expect(shown).toHaveCount(0)
  await page.reload()
  await settle(page)
  await expect(dialog(page)).toHaveCount(0)

  // Settings replays every packaged row in pages, from the first page, and the skip line closes it.
  await page.goto('/settings/about')
  await settle(page)
  await page.getByRole('button', { name: REPLAY, exact: true }).click()
  await expect(dialog(page).getByRole('listitem')).toHaveText(titles(0, 4))
  await dialog(page).getByRole('button', { name: 'Continue' }).click()
  await expect(dialog(page).getByRole('listitem')).toHaveText(titles(4, 8))
  await dialog(page).getByRole('button', { name: 'Skip, I like surprises' }).click()
  await expect(dialog(page)).toHaveCount(0)
})
