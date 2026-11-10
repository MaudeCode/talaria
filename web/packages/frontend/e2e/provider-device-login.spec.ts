import { expect, settle, test } from './fixtures'
import { routeProviders } from './providers'

test.use({ serviceWorkers: 'block', video: 'on' })

test('provider device sign-in is usable across phone layouts and reconciles approval', async ({ page }, testInfo) => {
  let approved = false
  const starts: unknown[] = []
  await routeProviders(page, () => ({ active_provider: 'copilot', providers: [
    { id: 'copilot', display_name: 'GitHub Copilot', is_plugin_provider: true, configurable: false, device_login: true, has_key: approved, configured: approved, models: [] },
    { id: 'no-hooks', display_name: 'No Hooks', is_plugin_provider: true, configurable: false, has_key: false, models: [] },
  ] }))
  await page.route('**/api/onboarding/oauth/start', (route) => {
    starts.push(route.request().postDataJSON())
    return route.fulfill({ json: { ok: true, status: 'pending', provider: 'copilot', flow_id: 'device-flow', user_code: 'TEST-1827', verification_url: 'https://device.example.test/login', expires_in: 90, interval: 1 } })
  })
  await page.route('**/api/onboarding/oauth/poll?*', (route) => route.fulfill({ json: { ok: true, status: approved ? 'approved' : 'pending', provider: 'copilot', flow_id: 'device-flow' } }))
  await page.route('**/api/onboarding/oauth/cancel', (route) => route.fulfill({ json: { ok: true, status: 'cancelled', provider: 'copilot', flow_id: 'device-flow' } }))
  await page.goto('/settings/providers')
  await settle(page)
  const line = page.locator('[data-provider="copilot"]')
  // TAL-2136: Sign in opens the device sign-in in the row under the provider.
  const row = page.locator('[data-provider-setup="copilot"]')
  const viewports = testInfo.project.name === 'desktop'
    ? [[1280, 800], [382, 580], [594, 368], [669, 867], [951, 585], [385, 571]]
    : [[390, 844]]
  const capture = async (state: string) => {
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width: width!, height: height! })
      await line.scrollIntoViewIfNeeded()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`${state}-${width}-${height}.png`) })
    }
  }
  await capture('before-sign-in')
  await expect(page.locator('[data-provider="no-hooks"]').getByRole('button')).toHaveCount(0)
  await expect(page.locator('[data-provider="no-hooks"]')).toContainText('Agent CLI only')
  await line.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(row.getByRole('button', { name: 'Sign in with GitHub Copilot' })).toBeVisible()
  await row.getByRole('button', { name: 'Sign in with GitHub Copilot' }).click()
  await expect(row.getByText('TEST-1827')).toBeVisible()
  await expect(row.getByRole('link')).toHaveAttribute('href', 'https://device.example.test/login')
  await capture('device-code')
  await row.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(row.getByText('TEST-1827')).toHaveCount(0)
  await expect(row.getByText('Sign-in cancelled.')).toBeVisible()
  await row.getByRole('button', { name: 'Sign in with GitHub Copilot' }).click()
  await expect(row.getByText('TEST-1827')).toBeVisible()
  approved = true
  // TAL-2135: once signed in, the provider joins Your providers, which opens its own page.
  await expect(page.locator('[data-section="providers-configured"] [data-provider="copilot"]')).toContainText('Configured')
  expect(starts).toEqual([{ provider: 'copilot' }, { provider: 'copilot' }])
  await capture('signed-in')
})
