import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** TAL-1154: a transcript message opens its hover-bar actions on right-click and long-press; links and selections keep the browser's menu. */

const ANSWER = 'Read the [release notes](https://example.com/notes) first.'

async function boot(page: Page): Promise<{ user: Locator; assistant: Locator; truncates: Record<string, unknown>[] }> {
  let truncated = false
  const truncates: Record<string, unknown>[] = []
  const messages = [{ role: 'user', id: 1, content: 'Plan the release', attachments: [{ filename: 'report.pdf', download_url: 'api/media?path=report.pdf' }] }, { role: 'assistant', id: 2, content: ANSWER }]
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'msg-menu', title: 'Message menu', can_branch: true, messages: truncated ? [] : messages } } }))
  await page.route('**/api/session/truncate', (route) => {
    truncates.push(route.request().postDataJSON() as Record<string, unknown>)
    truncated = true
    return route.fulfill({ json: { ok: true, session: { session_id: 'msg-menu', title: 'Message menu' } } })
  })
  await page.goto('/session/msg-menu')
  const user = page.locator('#messages .msg-row[data-role="user"]')
  const assistant = page.locator('#messages .msg-row[data-role="assistant"]')
  await expect(assistant.getByRole('button', { name: 'release notes' })).toBeVisible()
  return { user, assistant, truncates }
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
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
  await page.waitForTimeout(800)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

const menuLabels = (menu: Locator) => menu.getByRole('menuitem').allTextContents()
const barLabels = (row: Locator) => row.locator('.msg-foot > button').evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label')))

test('right-click on a message opens its hover-bar actions, and Copy works from there', async ({ page, context }, info) => {
  test.skip(info.project.name !== 'desktop', 'right-click is the desktop route')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const { user, assistant } = await boot(page)
  const nativeMenus = await watchNativeMenu(page)
  const menu = page.getByRole('menu', { name: 'Message actions' })

  await user.locator('.msg-body').click({ button: 'right' })
  await expect(menu).toBeVisible()
  expect(await menuLabels(menu)).toEqual(['Copy', 'Edit message', 'Branch from here'])
  expect(await menuLabels(menu)).toEqual(await barLabels(user))
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  // The first word, clear of the link.
  await assistant.locator('.msg-body').click({ button: 'right', position: { x: 6, y: 8 } })
  await expect(menu).toBeVisible()
  expect(await menuLabels(menu)).toEqual(await barLabels(assistant))
  expect(await menuLabels(menu)).toContain('Regenerate response')
  await page.screenshot({ path: info.outputPath('message-context-menu-desktop.png') })
  await menu.getByRole('menuitem', { name: 'Copy' }).click()
  await expect(menu).toHaveCount(0)
  await expect(page.getByText('Copied!', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Read the [release notes](https://example.com/notes) first.')
  await expect.poll(nativeMenus).toEqual([false, false])
})

test('links and selected text inside a message keep the browser menu', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'right-click is the desktop route')
  const { user, assistant } = await boot(page)
  const nativeMenus = await watchNativeMenu(page)
  await assistant.getByRole('button', { name: 'release notes' }).click({ button: 'right' })
  await expect(page.getByRole('menu')).toHaveCount(0)
  const attachment = user.getByRole('link', { name: 'report.pdf' })
  await attachment.click({ button: 'right' })
  await expect(page.getByRole('menu')).toHaveCount(0)
  // The row's iOS callout suppression must not reach the link: base.css restores it under this selector.
  expect(await attachment.evaluate((a) => a.matches('[data-context-menu] a[href]') && a.closest('[data-context-menu]') === a.closest('.msg-row'))).toBe(true)

  await assistant.locator('.msg-body').evaluate((el) => {
    const range = document.createRange(); range.selectNodeContents(el)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  })
  await assistant.locator('.msg-body').click({ button: 'right' })
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect.poll(nativeMenus).toEqual([true, true, true])
})

test('long-press on a user message opens its actions, and Edit works from there', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'long-press is the touch route')
  const { user, truncates } = await boot(page)
  await longPress(page, user.locator('.msg-body'))
  const menu = page.getByRole('menu', { name: 'Message actions' })
  await expect(menu).toBeVisible()
  expect(await menuLabels(menu)).toEqual(['Copy', 'Edit message', 'Branch from here'])
  await page.screenshot({ path: info.outputPath('message-context-menu-mobile.png') })
  await menu.getByRole('menuitem', { name: 'Edit message' }).click()
  await expect.poll(() => truncates.map((body) => body.keep_count)).toEqual([0])
  await expect(page.locator('#msg')).toHaveValue('Plan the release')
})
