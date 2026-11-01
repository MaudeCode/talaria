import type { Locator, Page } from '@playwright/test'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block', video: 'on' })

/** TAL-1131: a long model menu keeps its search pinned and the selected or highlighted row on screen. */

const IDS = Array.from({ length: 30 }, (_, i) => `model-${String(i + 1).padStart(2, '0')}`)
const SELECTED = 'model-24'
const CATALOG = {
  active_provider: 'test', default_model: IDS[0], default_option_id: IDS[0],
  groups: [{ provider: 'Synthetic', provider_id: 'test', models: IDS.map((id) => ({ id, label: id, provider_id: 'test', bare_id: id })) }],
}

/** On screen means the browser hits the element at its centre: inside the popup's clip and under nothing else. */
async function onScreen(target: Locator): Promise<boolean> {
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return hit !== null && (hit === el || el.contains(hit))
  })
}

async function openModelMenu(page: Page, mobile: boolean): Promise<Locator> {
  if (mobile) {
    await page.locator('#composerMobileConfigBtn').click()
    await page.locator('#composerMobileConfigPanel').getByRole('button', { name: `Model: ${SELECTED}` }).click()
  } else {
    await page.locator('#composerModelChip').click()
  }
  const menu = page.getByRole('menu', { name: 'Model' })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitemradio')).toHaveCount(IDS.length)
  return menu
}

test('long model menu reveals the selection and keeps search and keyboard rows visible', async ({ page }, info) => {
  const mobile = info.project.name === 'mobile'
  const sid = 'long-model-menu'
  await page.route('**/api/models', (route) => route.fulfill({ json: CATALOG }))
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Long model menu', model: SELECTED, model_provider: 'test', model_option_id: SELECTED, is_streaming: false,
    messages: [{ role: 'user', id: 1, content: 'Pick a model' }],
  } } }))
  await page.goto(`/session/${sid}`)
  await settle(page)
  // The narrow composer shows its settings button once the draft has text.
  await page.locator('#msg').fill('Pick a model')
  await expect(page.locator(mobile ? '#composerMobileConfigBtn' : '#composerModelChip')).toBeVisible()

  const menu = await openModelMenu(page, mobile)
  const search = menu.getByRole('searchbox', { name: 'Search models…' })
  const checked = menu.getByRole('menuitemradio', { name: SELECTED, exact: true })
  await expect(checked).toHaveAttribute('aria-checked', 'true')
  await expect(search).toBeFocused()
  // The deep selected row is in view as the menu opens, with search still above it.
  await expect.poll(() => onScreen(checked), 'selected row is revealed on open').toBe(true)
  expect(await onScreen(search)).toBe(true)
  await page.screenshot({ animations: 'disabled', path: info.outputPath('open-selected.png') })

  // Scrolling the options to the end leaves search pinned and usable.
  const last = menu.getByRole('menuitemradio', { name: IDS.at(-1)!, exact: true })
  await last.hover()
  await page.mouse.wheel(0, 5000)
  await expect.poll(() => onScreen(last)).toBe(true)
  expect(await onScreen(search), 'search stays pinned after scrolling').toBe(true)
  await page.screenshot({ animations: 'disabled', path: info.outputPath('scrolled-end.png') })
  await search.click()
  await search.pressSequentially('model-0')
  await expect(menu.getByRole('menuitemradio')).toHaveCount(9)
  await search.fill('')
  await expect(menu.getByRole('menuitemradio')).toHaveCount(IDS.length)

  // ArrowDown leaves search for the list; every highlighted row clears the pinned header, through wrap in both directions.
  await search.focus()
  await page.keyboard.press('ArrowDown')
  const highlighted = menu.locator('[role="menuitemradio"][data-highlighted]')
  for (const id of IDS) {
    await expect(highlighted).toHaveText(id)
    await expect.poll(() => onScreen(highlighted), `highlighted ${id} is visible`).toBe(true)
    await page.keyboard.press('ArrowDown')
  }
  await expect(highlighted).toHaveText(IDS[0]!)
  await expect.poll(() => onScreen(highlighted), 'ArrowDown wraps to the first row in view').toBe(true)
  await page.keyboard.press('ArrowUp')
  await expect(highlighted).toHaveText(IDS.at(-1)!)
  await expect.poll(() => onScreen(highlighted), 'ArrowUp wraps to the last row in view').toBe(true)
  expect(await onScreen(search)).toBe(true)
  await page.screenshot({ animations: 'disabled', path: info.outputPath('keyboard-wrap.png') })

  // A shorter viewport shrinks the menu; search and the highlighted row stay reachable.
  const size = page.viewportSize()!
  await page.setViewportSize({ width: size.width, height: Math.round(size.height * 0.6) })
  await expect.poll(() => onScreen(search), 'search survives resize').toBe(true)
  await expect.poll(() => onScreen(highlighted), 'highlighted row survives resize').toBe(true)
  await page.screenshot({ animations: 'disabled', path: info.outputPath('resized.png') })

  // Escape closes the menu and returns focus to the control that opened it.
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  if (mobile) await expect(page.locator('#composerMobileConfigPanel').getByRole('button', { name: `Model: ${SELECTED}` })).toBeFocused()
  else await expect(page.locator('#composerModelChip')).toBeFocused()
})
