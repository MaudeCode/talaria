import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

test('context choices follow the execution store', async ({ page }, testInfo) => {
  const base = { prompt: 'Synthetic task', schedule: 'every 1h', schedule_display: 'every 1h', enabled: true, state: 'scheduled', toast_notifications: true, read_only: false }
  const jobs = [
    { ...base, id: 'editor', name: 'Research task', profile: 'research', owner_profile: 'research', reasoning_effort: 'medium', context_from: [] },
    { ...base, id: 'research-source', name: 'Research source', profile: 'research', owner_profile: 'research' },
    { ...base, id: 'local-source', name: 'Local source', profile: 'default', owner_profile: 'default' },
  ]
  await page.route('**/api/crons', (route) => route.fulfill({ json: { jobs, active_profile: 'default', all_profiles: false, other_profile_count: 0 } }))
  await page.route('**/api/crons/status', (route) => route.fulfill({ json: { running: {} } }))
  await page.route('**/api/crons/history?*', (route) => route.fulfill({ json: { runs: [], total: 0, offset: 0 } }))
  await page.route('**/api/crons/delivery-options', (route) => route.fulfill({ json: { platforms: [{ value: 'local', label: 'Local' }] } }))
  await page.route('**/api/profiles', (route) => route.fulfill({ json: { profiles: [{ name: 'default' }, { name: 'research' }], active: 'default' } }))
  await page.route('**/api/models', (route) => route.fulfill({ json: { groups: [] } }))
  await page.route('**/api/crons/context-sources', (route) => route.fulfill({ json: { profile: 'research', sources: [{ job_id: 'research-source', label: 'Research source', selectable: true }] } }))
  await page.goto('/tasks?job=editor')
  await page.getByRole('button', { name: /^edit$/i }).click()
  const form = page.getByRole('form', { name: /edit job/i })
  await expect(form.getByRole('checkbox', { name: 'Research source' })).toBeVisible()
  await form.getByRole('group', { name: 'Context from jobs' }).locator('../..').screenshot({ path: testInfo.outputPath('context-sources.png') })
  await expect(form.getByRole('checkbox', { name: 'Local source' })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
