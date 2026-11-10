import { expect, settle, test } from './fixtures'
import { routeProviders } from './providers'

test.use({ serviceWorkers: 'block' })

// TAL-2135: a configured provider's block opens its own page, and Back returns to the list where it was scrolled.
test('a provider block opens its page and Back returns to the same scroll position', async ({ page }) => {
  const available = Array.from({ length: 30 }, (_, i) => ({ id: `extra-${String(i)}`, display_name: `Extra ${String(i)}`, has_key: false, configured: false, configurable: true }))
  await routeProviders(page, () => ({ active_provider: 'anthropic', providers: [
    { id: 'anthropic', display_name: 'Anthropic', has_key: true, configured: true, is_active: true, key_source: 'env_file', key_source_kind: 'env', configurable: true, models: [], models_total: 0 },
    ...available,
  ] }))
  await page.goto('/settings/providers')
  await settle(page)
  const pane = page.locator('#main [data-scroll-restoration-id="settings-main"]')
  const block = page.locator('[data-section="providers-configured"] [data-provider="anthropic"]')
  await expect(block).toBeVisible()
  await pane.evaluate((el) => { el.scrollTop = 40 })
  await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBe(40)
  await block.getByRole('link', { name: 'Anthropic' }).click()
  await expect(page).toHaveURL(/\/settings\/providers\/anthropic$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Anthropic' })).toBeVisible()
  await page.getByRole('button', { name: 'Providers', exact: true }).click()
  await expect(page).toHaveURL(/\/settings\/providers$/)
  await expect(block).toBeVisible()
  await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBe(40)
})
