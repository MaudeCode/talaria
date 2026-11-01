import type { Locator, Page } from '@playwright/test'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/**
 * TAL-1625: a touch opening of the model menu focuses the list, so no software keyboard covers it; a keyboard or mouse
 * opening focuses search. Desktop drives the footer chip by keyboard and mouse, mobile the overflow row by touch.
 */

const IDS = Array.from({ length: 30 }, (_, i) => `model-${String(i + 1).padStart(2, '0')}`)
const [FIRST, SECOND] = ['model-01', 'model-02']
const catalog = (ids: string[]) => ({
  active_provider: 'test', default_model: IDS[0], default_option_id: IDS[0],
  groups: [{ provider: 'Synthetic', provider_id: 'test', models: ids.map((id) => ({ id, label: id, provider_id: 'test', bare_id: id })) }],
})
const REFRESHED = 'model-31'

/** On screen means the browser hits the element at its centre: inside the popup's clip and under nothing else. */
async function onScreen(target: Locator): Promise<boolean> {
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return hit !== null && (hit === el || el.contains(hit))
  })
}

/** Serves the catalog; once `hold` is set, the next read waits until the returned release runs. */
async function openSession(page: Page) {
  let held: (() => void) | null = null
  let holdNext = false
  let ids = IDS
  await page.route('**/api/models', async (route) => {
    if (holdNext) {
      holdNext = false
      await new Promise<void>((resolve) => { held = resolve })
    }
    await route.fulfill({ json: catalog(ids) })
  })
  const sid = 'model-picker-focus'
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Model picker focus', model: IDS[0], model_provider: 'test', model_option_id: IDS[0], is_streaming: false,
    messages: [{ role: 'user', id: 1, content: 'Pick a model' }],
  } } }))
  await page.goto(`/session/${sid}`)
  await settle(page)
  // The narrow composer shows its settings button once the draft has text.
  await page.locator('#msg').fill('Pick a model')
  return {
    holdNextRefresh(next: string[]) { holdNext = true; ids = next },
    release() { held?.() },
  }
}

test('a touch opening keeps search unfocused and the list visible; a keystroke or touch reaches search', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'touch runs on the mobile project')
  const catalogServer = await openSession(page)
  await page.locator('#composerMobileConfigBtn').tap()
  const opener = page.locator('#composerMobileConfigPanel').getByRole('button', { name: `Model: ${FIRST}` })
  catalogServer.holdNextRefresh([...IDS, REFRESHED])
  await opener.tap()
  const menu = page.getByRole('menu', { name: 'Model' })
  const search = menu.getByRole('searchbox', { name: 'Search models…' })
  await expect(menu.getByRole('menuitemradio')).toHaveCount(IDS.length)
  await expect(menu).toBeFocused()
  await expect(search).not.toBeFocused()
  await expect.poll(() => onScreen(menu.getByRole('menuitemradio', { name: FIRST, exact: true })), 'first option on screen').toBe(true)
  await page.screenshot({ animations: 'disabled', path: info.outputPath('touch-open.png') })

  // A hardware keyboard on a touch device: a printable key goes into search once.
  await page.keyboard.press('m')
  await expect(search).toBeFocused()
  await expect(search).toHaveValue('m')
  await search.fill('')
  await menu.focus()

  // Touching search focuses it, and the held opening refresh landing afterwards leaves it focused.
  await search.tap()
  await expect(search).toBeFocused()
  catalogServer.release()
  await expect(menu.getByRole('menuitemradio', { name: REFRESHED, exact: true })).toBeVisible()
  await expect(search).toBeFocused()
  await page.screenshot({ animations: 'disabled', path: info.outputPath('touch-search-after-refresh.png') })

  // Escape closes only the menu and hands focus back to the row that opened it.
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(page.locator('#composerMobileConfigPanel')).toBeVisible()
  await expect(opener).toBeFocused()
})

test('a keyboard or mouse opening focuses search for typing and list keys', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'the footer chip is the desktop opener')
  await openSession(page)
  const chip = page.locator('#composerModelChip')
  const menu = page.getByRole('menu', { name: 'Model' })
  const search = menu.getByRole('searchbox', { name: 'Search models…' })

  await chip.focus()
  await page.keyboard.press('Enter')
  await expect(menu.getByRole('menuitemradio')).toHaveCount(IDS.length)
  await expect(search).toBeFocused()
  await page.keyboard.type('model-0')
  await expect(search).toHaveValue('model-0')
  await expect(menu.getByRole('menuitemradio')).toHaveCount(9)
  // A query no catalog entry matches leaves only the custom-id entry.
  await page.keyboard.type('x')
  await expect(menu.getByRole('menuitemradio')).toHaveCount(0)
  await expect(menu.getByRole('menuitem', { name: /model-0x/ })).toBeVisible()
  await page.screenshot({ animations: 'disabled', path: info.outputPath('keyboard-no-match.png') })
  // Clearing search restores the long list; each ArrowDown moves one row.
  await search.fill('')
  await expect(menu.getByRole('menuitemradio')).toHaveCount(IDS.length)
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitemradio', { name: FIRST, exact: true })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitemradio', { name: SECOND, exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(chip).toBeFocused()

  await chip.click()
  await expect(menu.getByRole('menuitemradio')).toHaveCount(IDS.length)
  await expect(search).toBeFocused()
  await page.screenshot({ animations: 'disabled', path: info.outputPath('mouse-open.png') })
})
