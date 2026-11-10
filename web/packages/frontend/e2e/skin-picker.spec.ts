import { SKINS } from '../src/theme/skins'
import { expect, settle, test } from './fixtures'

test('the picker offers every built-in skin and a skin trait survives a reload', async ({ page }) => {
  await page.goto('/settings/appearance')
  await settle(page)
  await expect(page.locator('#skinPickerGrid [data-skin-val]')).toHaveCount(SKINS.length)

  await page.locator('[data-skin-val="geist-contrast"]').click()
  await page.reload()
  await settle(page)
  const html = page.locator('html')
  await expect(html).toHaveAttribute('data-skin', 'geist-contrast')
  await expect(html).toHaveAttribute('data-skin-traits', 'square-controls')
})

test('Appearance groups Theme, Skin, Text and layout, and Language (TAL-2083, TAL-2086, TAL-2146)', async ({ page }) => {
  await page.goto('/settings/appearance')
  await settle(page)
  const section = page.locator('[data-section="appearance"]')
  const groups = await section.locator('[data-group]').evaluateAll((nodes) => nodes.map((group) => [group.getAttribute('data-group'), group.querySelector('h3')?.textContent]))
  expect(groups).toEqual([['theme', 'Theme'], ['skin', 'Skin'], ['text-layout', 'Text and layout'], ['language', 'Language']])
  await expect(section.locator('[data-group="theme"] #themePickerGrid')).toBeVisible()
  await expect(section.locator('[data-group="skin"] #skinPickerGrid')).toBeVisible()
  // Skins are rows with a check on the selected one, not bordered tiles; size and width are segmented controls.
  await expect(section.locator('#skinPickerGrid [aria-pressed="true"] [data-mark]')).toHaveCount(1)
  await expect(section.locator('#skinPickerGrid [data-skin-val]').first()).toHaveCSS('border-left-width', '0px')
  await expect(section.locator('[data-group="text-layout"] #fontSizePickerGrid')).toHaveAttribute('role', 'radiogroup')
  await expect(section.locator('[data-group="text-layout"] #chatWidthPickerGrid')).toHaveAttribute('role', 'radiogroup')
  await expect(section.locator('[data-group="language"] #settingsLanguage')).toBeVisible()
  await expect(section.locator('[data-group="language"] #settingsRtl')).toBeVisible()
  // No extension skin is registered, so the extension header stays out.
  await expect(section.getByRole('heading', { name: 'From extensions' })).toHaveCount(0)
})
