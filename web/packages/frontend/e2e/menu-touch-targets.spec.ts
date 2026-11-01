import type { Locator, Page } from '@playwright/test'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** TAL-1626: shared menu action rows are 44 px touch targets under a coarse pointer and stay compact under a mouse. */

// Mouse rows stay compact: one text-sm line plus py-1.5, about 29 px.
const COMPACT = 32
const COMPACT_FLOOR = 28
const TOUCH = 44
const now = Math.floor(Date.now() / 1000)
// A shared, worktree-backed conversation shows every action the session menu has.
const ROW = {
  session_id: 'touch-menu', title: 'Touch menu', is_streaming: false, attention: null, last_message_at: now - 600, updated_at: now - 600, pinned: false, archived: false, project_id: null,
  is_cli_session: false, source_kind: 'webui', is_messaging_session: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true,
  share_url: '/share/touch-menu-token', worktree_branch: 'touch-menu-branch',
}

const coarse = (page: Page) => page.evaluate(() => matchMedia('(pointer: coarse)').matches)
const heights = (menu: Locator) => menu.getByRole('menuitem').evaluateAll((items) => items.map((item) => ({ label: item.textContent ?? '', height: item.getBoundingClientRect().height })))

async function expectRowHeights(page: Page, menu: Locator): Promise<void> {
  const rows = await heights(menu)
  expect(rows.length).toBeGreaterThan(1)
  for (const row of rows) {
    if (await coarse(page)) expect(row.height, `${row.label} is a touch target`).toBeGreaterThanOrEqual(TOUCH)
    else expect(row.height, `${row.label} keeps the compact desktop row`).toBeLessThan(COMPACT)
  }
}

async function bootSession(page: Page, language?: string): Promise<void> {
  if (language) {
    await page.route('**/api/bootstrap', async (route) => {
      const response = await route.fetch()
      await route.fulfill({ response, json: { ...(await response.json() as object), language } })
    })
  }
  await page.route(/\/api\/sessions(\?|$)/, async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...(await response.json()), sessions: [ROW] } })
  })
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: ROW.session_id, title: ROW.title, messages: [{ role: 'user', id: 1, content: 'question' }] } } }))
  await page.goto(`/session/${ROW.session_id}`)
  await settle(page)
  const hamburger = page.locator('#btnHamburger')
  if (await hamburger.isVisible()) await hamburger.click()
  // Phones hide the row's kebab (long-press opens the row's menu, TAL-699); reveal it to drive the kebab's own menu.
  if (await coarse(page)) await page.addStyleTag({ content: '.session-actions{display:flex !important;opacity:1 !important}' })
}

async function openSessionMenu(page: Page): Promise<{ trigger: Locator; menu: Locator }> {
  const row = page.locator(`.session-item[data-sid="${ROW.session_id}"]`)
  const trigger = row.locator('.session-actions-trigger')
  await row.hover()
  await trigger.click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  return { trigger, menu }
}

test('project context menu rows are touch-sized under a coarse pointer and compact under a mouse', async ({ page }, testInfo) => {
  const name = `Touch ${testInfo.project.name}`
  const created = await page.request.post('/api/projects/create', { data: { name } })
  const id = ((await created.json()) as { project: { project_id: string } }).project.project_id
  try {
    await page.goto('/')
    await settle(page)
    expect(await coarse(page)).toBe(testInfo.project.name === 'mobile')
    const hamburger = page.locator('#btnHamburger')
    if (await hamburger.isVisible()) await hamburger.click()
    await page.locator('.project-bar').getByRole('button', { name, exact: true }).click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Project actions' })
    await expect(menu).toBeVisible()
    // Rename and the destructive Delete share the ordinary action row.
    await expectRowHeights(page, menu)
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  } finally {
    await page.request.post('/api/projects/delete', { data: { project_id: id } })
  }
})

test('session menu rows stay touch-sized when disabled, and a long menu scrolls inside a short viewport', async ({ page }, testInfo) => {
  await bootSession(page)
  const { trigger, menu } = await openSessionMenu(page)
  if (process.env.TAL1626_SHOTS) await page.screenshot({ path: `${process.env.TAL1626_SHOTS}/menu-${testInfo.project.name}.png` })
  await expectRowHeights(page, menu)
  // A disabled row keeps its target size; only its opacity changes.
  const first = menu.getByRole('menuitem').first()
  await first.evaluate((item) => { item.setAttribute('data-disabled', ''); item.setAttribute('aria-disabled', 'true') })
  await expectRowHeights(page, menu)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  await page.setViewportSize({ width: testInfo.project.name === 'mobile' ? 390 : 1280, height: 360 })
  await trigger.focus()
  await page.keyboard.press('Enter')
  await expect(menu).toBeVisible()
  if (process.env.TAL1626_SHOTS) await page.screenshot({ path: `${process.env.TAL1626_SHOTS}/short-${testInfo.project.name}.png` })
  const viewport = page.viewportSize()?.height ?? 0
  const box = await menu.boundingBox()
  expect(box && box.y >= 0 && box.y + box.height <= viewport, 'the menu stays inside the viewport').toBe(true)
  expect(await menu.evaluate((popup) => popup.scrollHeight > popup.clientHeight), 'the long menu scrolls').toBe(true)
  // The last action is reachable by keyboard and scrolls into view.
  await page.keyboard.press('End')
  const last = menu.getByRole('menuitem').last()
  await expect(last).toBeFocused()
  await expect(last).toBeInViewport()
  const lastBox = await last.boundingBox()
  expect(lastBox && box && lastBox.y + lastBox.height <= box.y + box.height + 1, 'the last row is visible inside the menu').toBe(true)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('localized and wrapping session menu labels fit the menu and keep their row size', async ({ page }) => {
  await bootSession(page, 'ru')
  const { menu } = await openSessionMenu(page)
  await expect(menu.getByRole('menuitem', { name: 'Удалить беседу' })).toBeVisible()
  // A label longer than the menu's maximum width wraps onto more lines inside its row.
  const long = menu.getByRole('menuitem').first()
  const single = (await long.boundingBox())?.height ?? 0
  await long.evaluate((item) => { item.textContent = 'Переименовать эту беседу и обновить её заголовок для всех открытых вкладок и устройств' })
  expect((await long.boundingBox())?.height ?? 0).toBeGreaterThan(single)
  await expectRowHeightsAtLeast(page, menu)
  // Labels wrap inside the menu instead of widening it past its edge or the viewport.
  expect(await menu.evaluate((popup) => popup.scrollWidth <= popup.clientWidth)).toBe(true)
  const box = await menu.boundingBox()
  expect(box && box.x >= 0 && box.x + box.width <= (page.viewportSize()?.width ?? 0)).toBe(true)
  for (const row of await menu.getByRole('menuitem').evaluateAll((items) => items.map((item) => item.getBoundingClientRect().width))) expect(row).toBeLessThanOrEqual(box?.width ?? 0)
})

/** Translated labels may wrap to two lines, so they only have a floor. */
async function expectRowHeightsAtLeast(page: Page, menu: Locator): Promise<void> {
  const floor = (await coarse(page)) ? TOUCH : COMPACT_FLOOR
  for (const row of await heights(menu)) expect(row.height, `${row.label} keeps its row size`).toBeGreaterThanOrEqual(floor)
}
