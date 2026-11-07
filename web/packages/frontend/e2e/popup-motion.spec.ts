import type { Locator, Page } from '@playwright/test'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** TAL-1784: floating surfaces transition in a real browser, never delay a click, and stop moving under reduced motion. */

const now = Math.floor(Date.now() / 1000)
const base = { sort_ts: now, is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true, source_kind: 'webui', is_messaging_session: false, pinned: false, sidebar_group: 'recent' }
const ROW = { ...base, session_id: 'motion-row', title: 'Motion row' }
const OTHER = { ...base, session_id: 'motion-other', title: 'Other row' }
const CURRENT = { ...base, session_id: 'motion-current', title: 'Current conversation' }

interface Run { surface: string | null; property: string; ms: number }

/** Each transition as it starts: the surface's role, the property, and the duration its current phase asked for. */
async function recordRuns(page: Page) {
  await page.evaluate(() => {
    const runs: Run[] = []
    ;(window as unknown as { motionRuns: Run[] }).motionRuns = runs
    document.addEventListener('transitionrun', (event) => {
      const target = event.target as HTMLElement
      runs.push({ surface: target.getAttribute('role'), property: event.propertyName, ms: Math.round(parseFloat(getComputedStyle(target).transitionDuration) * 1000) })
    }, true)
  })
}

async function boot(page: Page): Promise<{ item: Locator; other: Locator }> {
  await page.route(/\/api\/sessions(\?|$)/, (route) => route.fulfill({ json: { sessions: [ROW, OTHER, CURRENT] } }))
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { ...CURRENT, messages: [] } } }))
  await page.goto(`/session/${CURRENT.session_id}`)
  await settle(page)
  const item = page.locator(`#sessionList .session-item[data-sid="${ROW.session_id}"]`)
  await expect(item).toBeVisible()
  await recordRuns(page)
  return { item, other: page.locator(`#sessionList .session-item[data-sid="${OTHER.session_id}"]`) }
}

const POPUP_TIMINGS = ['opacity 160', 'scale 160', 'opacity 110', 'scale 110']
const timings = (runs: Run[]) => runs.map(({ property, ms }) => `${property} ${String(ms)}`)
const recorded = (page: Page) => page.evaluate(() => (window as unknown as { motionRuns: Run[] }).motionRuns)

test.describe('popup motion', () => {
  test.beforeEach(({}, info) => { test.skip(info.project.name !== 'desktop', 'right-click is the desktop route; the classes are the same at every width') })

  test.describe('with motion allowed', () => {
    test.use({ reducedMotion: 'no-preference' })

    test('a context menu grows from the pointer and leaves faster', async ({ page }) => {
      const { item } = await boot(page)
      await item.click({ button: 'right', position: { x: 40, y: 10 } })
      const menu = page.getByRole('menu')
      await expect(menu).toBeVisible()
      await expect.poll(() => recorded(page)).toEqual(expect.arrayContaining([
        { surface: 'menu', property: 'opacity', ms: 160 },
        { surface: 'menu', property: 'scale', ms: 160 },
      ]))
      await expect(menu).toHaveCSS('opacity', '1')
      await page.keyboard.press('Escape')
      await expect(menu).toBeHidden()
      await expect.poll(() => recorded(page)).toEqual(expect.arrayContaining([
        { surface: 'menu', property: 'opacity', ms: 110 },
        { surface: 'menu', property: 'scale', ms: 110 },
      ]))
    })

    test('a dialog mounted already open rises in, and sinks out after its parent unmounts it', async ({ page }) => {
      const { item } = await boot(page)
      await item.click({ button: 'right', position: { x: 40, y: 10 } })
      await page.getByRole('menuitem', { name: 'Delete' }).click()
      const dialog = page.getByRole('alertdialog')
      await expect(dialog).toBeVisible()
      await expect.poll(() => recorded(page)).toEqual(expect.arrayContaining([
        { surface: 'alertdialog', property: 'opacity', ms: 260 },
        { surface: 'alertdialog', property: 'transform', ms: 260 },
        { surface: 'presentation', property: 'opacity', ms: 200 },
      ]))
      await expect(dialog).toHaveCSS('opacity', '1')
      await page.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toBeHidden()
      await expect.poll(() => recorded(page)).toEqual(expect.arrayContaining([
        { surface: 'alertdialog', property: 'opacity', ms: 150 },
        { surface: 'alertdialog', property: 'transform', ms: 150 },
        { surface: 'presentation', property: 'opacity', ms: 160 },
      ]))
      await expect(page.locator('[data-ending-style]')).toHaveCount(0)
    })

    test('a Select and a popover grow in and leave faster, as a menu does', async ({ page }) => {
      await boot(page)
      await page.goto('/settings/preferences')
      await settle(page)
      await recordRuns(page)
      await page.locator('#settingsSendKey').click()
      const select = page.getByRole('listbox')
      await expect(select).toBeVisible()
      await expect(select).toHaveCSS('opacity', '1')
      await page.keyboard.press('Escape')
      await expect(select).toBeHidden()
      await expect.poll(async () => timings(await recorded(page))).toEqual(expect.arrayContaining(POPUP_TIMINGS))
      await recordRuns(page)
      const tip = page.locator('main button[aria-label]', { has: page.locator('svg.lucide-circle-help') }).first()
      await tip.click()
      const popover = page.getByRole('dialog')
      await expect(popover).toBeVisible()
      await expect(popover).toHaveCSS('opacity', '1')
      await page.keyboard.press('Escape')
      await expect(popover).toBeHidden()
      await expect.poll(async () => timings(await recorded(page))).toEqual(expect.arrayContaining(POPUP_TIMINGS))
    })

    test('items take a click from the first frame, and a closing dialog lets the next click through', async ({ page }) => {
      const { item, other } = await boot(page)
      await item.click({ button: 'right', position: { x: 40, y: 10 } })
      // `force` skips Playwright's wait for the element to stop moving: a real click mid-entrance.
      await page.getByRole('menuitem', { name: 'Delete' }).click({ force: true })
      await expect(page.getByRole('alertdialog')).toBeVisible()
      await page.getByRole('button', { name: 'Cancel' }).click({ force: true })
      await other.click({ button: 'right', position: { x: 40, y: 10 }, force: true })
      await expect(page.getByRole('menu')).toBeVisible()
    })
  })

  // The suite's default: reduced motion.
  test('reduced motion scales and moves nothing', async ({ page }) => {
    const { item } = await boot(page)
    await item.click({ button: 'right', position: { x: 40, y: 10 } })
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    await expect(page.getByRole('alertdialog')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('alertdialog')).toBeHidden()
    const surfaces = (await recorded(page)).filter(({ surface }) => surface === 'menu' || surface === 'alertdialog')
    expect(surfaces.filter(({ property }) => property !== 'opacity')).toEqual([])
  })
})
