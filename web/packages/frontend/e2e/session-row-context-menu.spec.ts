import type { Locator, Page } from '@playwright/test'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** TAL-699: a conversation row opens its actions on right-click and long-press; text fields and selections keep the browser's menu. */

const now = Math.floor(Date.now() / 1000)
const base = { sort_ts: now, is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true, source_kind: 'webui', is_messaging_session: false }
const CURRENT = { ...base, session_id: 'row-menu-current', title: 'Current conversation', sidebar_group: 'recent' }

async function boot(page: Page): Promise<{ item: Locator; writes: Record<string, unknown>[] }> {
  let row = { ...base, session_id: 'row-menu', title: 'Row menu', pinned: false, sidebar_group: 'recent' }
  const writes: Record<string, unknown>[] = []
  await page.route(/\/api\/sessions(\?|$)/, (route) => route.fulfill({ json: { sessions: [row, CURRENT] } }))
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { ...CURRENT, messages: [] } } }))
  await page.route('**/api/session/rename', async (route) => {
    const write = route.request().postDataJSON() as { title: string }
    writes.push({ rename: write.title })
    row = { ...row, title: write.title }
    await route.fulfill({ json: { session: row } })
  })
  await page.route('**/api/session/pin', async (route) => {
    const write = route.request().postDataJSON() as { pinned: boolean }
    writes.push({ pinned: write.pinned })
    row = { ...row, pinned: write.pinned, sidebar_group: write.pinned ? 'pinned' : 'recent' }
    await route.fulfill({ json: { ok: true } })
  })
  await page.goto(`/session/${CURRENT.session_id}`)
  await settle(page)
  const hamburger = page.locator('#btnHamburger')
  if (await hamburger.isVisible()) await hamburger.click()
  const item = page.locator('#sessionList .session-item[data-sid="row-menu"]')
  await expect(item).toBeVisible()
  return { item, writes }
}

/** Records whether the page cancelled each contextmenu event, which is what suppresses the browser's own menu. */
async function watchNativeMenu(page: Page): Promise<() => Promise<boolean[]>> {
  await page.evaluate(() => {
    const seen: boolean[] = []
    ;(window as unknown as { nativeMenus: boolean[] }).nativeMenus = seen
    window.addEventListener('contextmenu', (event) => { setTimeout(() => seen.push(!event.defaultPrevented)) }, true)
  })
  return () => page.evaluate(() => (window as unknown as { nativeMenus: boolean[] }).nativeMenus)
}

/** Holds one touch point past Base UI's 500 ms long-press, as a finger would. */
async function longPress(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox()
  if (!box) throw new Error('long-press target is not visible')
  const point = { x: box.x + box.width / 3, y: box.y + box.height / 2 }
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
  await page.waitForTimeout(800)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

const labels = (menu: Locator) => menu.getByRole('menuitem').allTextContents()

test('right-click on a row opens its actions at the pointer, the same list as the kebab, without navigating', async ({ page, context }, info) => {
  test.skip(info.project.name !== 'desktop', 'right-click is the desktop route')
  const { item, writes } = await boot(page)
  const nativeMenus = await watchNativeMenu(page)
  const box = (await item.boundingBox())!
  const pointer = { x: 30, y: box.height / 2 }
  await item.click({ button: 'right', position: pointer })
  const menu = page.getByRole('menu', { name: 'Conversation actions' })
  await expect(menu).toBeVisible()
  // The menu opens at the pointer, not at the row's kebab on the right.
  const popup = (await menu.boundingBox())!
  expect(Math.abs(popup.x - (box.x + pointer.x))).toBeLessThan(16)
  await page.screenshot({ path: info.outputPath('row-context-menu-desktop.png') })
  const rowItems = await labels(menu)
  expect(rowItems[0]).toBe('Open in new tab')
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect.poll(nativeMenus).toEqual([false])

  // The hover kebab shows the same items in the same order.
  await item.hover()
  await item.getByRole('button', { name: 'Conversation actions' }).click()
  await expect(menu).toBeVisible()
  expect(await labels(menu)).toEqual(rowItems)
  await page.keyboard.press('Escape')

  // Open in new tab opens the row's conversation.
  await item.click({ button: 'right', position: pointer })
  const opened = context.waitForEvent('page')
  await menu.getByRole('menuitem', { name: 'Open in new tab' }).click()
  const tab = await opened
  await expect.poll(() => tab.url()).toContain('/session/row-menu')
  await tab.close()

  // Pin runs from the row menu; the row moves to Pinned and the current conversation stays open.
  await item.click({ button: 'right', position: pointer })
  await menu.getByRole('menuitem', { name: 'Pin' }).click()
  await expect.poll(() => writes).toEqual([{ pinned: true }])
  const pinned = page.locator('.session-date-group').filter({ has: page.getByRole('button', { name: 'Pinned', exact: true }) })
  await expect(pinned.locator('[data-sid="row-menu"]')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/session/${CURRENT.session_id}$`))
  await page.screenshot({ path: info.outputPath('row-pinned-desktop.png') })
})

test('the search field and selected row text keep the browser menu', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'right-click is the desktop route')
  const { item } = await boot(page)
  const nativeMenus = await watchNativeMenu(page)
  await page.getByRole('button', { name: 'Filter conversations...' }).click()
  const search = page.locator('#sessionSearch')
  await search.click({ button: 'right' })
  await expect(page.getByRole('menu')).toHaveCount(0)

  // Rows are not selectable themselves, so a page-wide selection (select all) is the one that reaches a row.
  await page.evaluate(() => { document.getSelection()?.selectAllChildren(document.body) })
  await item.locator('.session-title').click({ button: 'right' })
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect.poll(nativeMenus).toEqual([true, true])
})

test('long-press on a row opens its actions, and Rename works from there', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'long-press is the touch route')
  const { item, writes } = await boot(page)
  // Touch layouts hide the kebab, so the long-press is the only route to the row's actions.
  await expect(item.locator('.session-actions')).toBeHidden()
  await longPress(page, item)
  const menu = page.getByRole('menu', { name: 'Conversation actions' })
  await expect(menu).toBeVisible()
  await page.screenshot({ path: info.outputPath('row-context-menu-mobile.png') })
  await menu.getByRole('menuitem', { name: 'Rename conversation' }).click()
  const dialog = page.getByRole('dialog', { name: 'Rename conversation' })
  await dialog.getByRole('textbox').fill('Renamed by long-press')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(item.locator('.session-title')).toHaveText('Renamed by long-press')
  await expect.poll(() => writes).toEqual([{ rename: 'Renamed by long-press' }])
  // The long-press did not also follow the row's link.
  await expect(page).toHaveURL(new RegExp(`/session/${CURRENT.session_id}$`))
  await page.screenshot({ path: info.outputPath('row-renamed-mobile.png') })
})
