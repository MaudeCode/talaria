import { expect, settle, test } from './fixtures'

// Service-worker requests bypass page routing; these fixtures own every response.
test.use({ serviceWorkers: 'block' })

test('Web updates: finish an incomplete release at the current source', async ({ page }, testInfo) => {
  let repair = true
  let applied = 0
  await page.route('**/api/updates/check', (route) => route.fulfill({ json: {
    cached: false, webui: { behind: 0, metadata_repair: repair, current_sha: 'a'.repeat(40), latest_sha: 'a'.repeat(40) }, agent: { behind: 0 },
  } }))
  await page.route('**/api/updates/apply', (route) => {
    expect(route.request().method()).toBe('POST')
    expect(route.request().postDataJSON()).toEqual({ target: 'webui', channel: 'stable' })
    applied += 1
    repair = false
    return route.fulfill({ json: { ok: true, restart_scheduled: true, message: 'Release metadata repaired' } })
  })
  await page.goto('/settings/system')
  await settle(page)
  await expect(page.getByText('Finish applying this release', { exact: true })).toBeVisible()
  await expect(page.getByText('Up to date', { exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('update-repair.png'), fullPage: true })
  await page.getByRole('button', { name: 'Finish update', exact: true }).click()
  await expect(page.getByText('Up to date', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Finish update', exact: true })).toHaveCount(0)
  expect(applied).toBe(1)
})

for (const scenario of [
  { name: 'private-access', update: { behind: null, manual_update: true, error: 'Synthetic release access unavailable' }, status: 'Update check failed' },
  { name: 'local-changes', update: { behind: 1, manual_update: true, dirty: true }, status: 'Local changes prevent automatic updates' },
]) {
  test(`Web updates: ${scenario.name}`, async ({ page }, testInfo) => {
    await page.route('**/api/updates/check', (route) => route.fulfill({ json: { cached: false, webui: scenario.update, agent: { behind: 0 } } }))
    await page.goto('/settings/system')
    await settle(page)
    await expect(page.getByText(scenario.status, { exact: true })).toBeVisible()
    await expect(page.getByText('Up to date', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /update now/i })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Install updates manually' })).toHaveAttribute('href', 'https://github.com/MaudeCode/talaria/releases')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`${scenario.name}.png`), fullPage: true })
  })
}
