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
