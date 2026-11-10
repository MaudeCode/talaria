import { SKINS } from '../src/theme/skins'
import { expect, settle, test } from './fixtures'

test('the picker offers every built-in skin and a skin trait survives a reload', async ({ page }) => {
  await page.goto('/settings/appearance')
  await settle(page)
  await expect(page.locator('#skinPickerGrid .skin-pick-btn')).toHaveCount(SKINS.length)

  await page.locator('[data-skin-val="geist-contrast"]').click()
  await page.reload()
  await settle(page)
  const html = page.locator('html')
  await expect(html).toHaveAttribute('data-skin', 'geist-contrast')
  await expect(html).toHaveAttribute('data-skin-traits', 'square-controls')
})

test('Appearance groups its pickers under This device, and Text and layout (TAL-2083, TAL-2086)', async ({ page }) => {
  await page.goto('/settings/appearance')
  await settle(page)
  const section = page.locator('[data-section="appearance"]')
  const groups = await section.locator('[data-group]').evaluateAll((nodes) => nodes.map((group) => [group.getAttribute('data-group'), group.querySelector('h3')?.textContent]))
  expect(groups).toEqual([['this-device', 'This device'], ['text-layout', 'Text and layout']])
  await expect(section.locator('[data-group="this-device"] #themePickerGrid')).toBeVisible()
  await expect(section.locator('[data-group="this-device"] #skinPickerGrid')).toBeVisible()
  await expect(section.locator('[data-group="text-layout"] #fontSizePickerGrid')).toBeVisible()
  await expect(section.locator('[data-group="text-layout"] #chatWidthPickerGrid')).toBeVisible()
  await expect(section.locator('[data-group="text-layout"] #settingsLanguage')).toBeVisible()
  await expect(section.locator('[data-group="this-device"] #settingsRtl')).toBeVisible()
  // No extension skin is registered, so the extension header stays out.
  await expect(section.getByRole('heading', { name: 'From extensions' })).toHaveCount(0)
})
