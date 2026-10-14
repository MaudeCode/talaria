import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

test('context choices follow the execution store', async ({ page }, testInfo) => {
  const base = { prompt: 'Synthetic task', schedule: 'every 1h', schedule_display: 'every 1h', schedule_input: 'every 1h', enabled: true, state: 'scheduled', toast_notifications: true, read_only: false }
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

test('a stuck job shows the server hint and a run shows the server-extracted reply (TAL-599)', async ({ page }, testInfo) => {
  const job = { id: 'stuck', name: 'Stuck digest', prompt: 'Synthetic task', schedule: '0 9 * * *', schedule_display: '0 9 * * *', schedule_input: '0 9 * * *', enabled: false, state: 'completed', next_run_at: null, last_error: "No module named 'croniter'", derived_state: 'needs_attention', needs_attention: true, resumable: true, attention_hint: 'croniter_missing', toast_notifications: true, read_only: false }
  await page.route('**/api/crons', (route) => route.fulfill({ json: { jobs: [job], active_profile: 'default', all_profiles: false, other_profile_count: 0 } }))
  await page.route('**/api/crons/status', (route) => route.fulfill({ json: { running: {} } }))
  await page.route('**/api/crons/history?*', (route) => route.fulfill({ json: { runs: [{ filename: '2026-10-09_09-00-00.md', size: 120, modified: 1_791_536_400 }], total: 1, offset: 0 } }))
  // The client renders `response` as sent; the raw `content` front-matter must never appear.
  await page.route('**/api/crons/run?*', (route) => route.fulfill({ json: { content: '# Cron run\n**Model:** front-matter-model\n\n## Response\n# Morning digest\nAll quiet.', snippet: 'All quiet.', response: '# Morning digest\n\nAll quiet.', usage: {} } }))
  await page.goto('/tasks?job=stuck')
  const banner = page.getByTestId('cron-detail').getByRole('alert')
  await expect(banner).toContainText('may be missing the croniter package')
  await page.getByRole('region', { name: /^runs$/i }).getByRole('cell').first().click()
  const output = page.getByTestId('cron-run-output')
  await expect(output.getByRole('heading', { name: 'Morning digest' })).toBeVisible()
  await expect(output).not.toContainText('front-matter-model')
  await page.screenshot({ path: testInfo.outputPath('cron-hint-run.png') })
  await banner.screenshot({ path: testInfo.outputPath('cron-hint.png') })
  await output.screenshot({ path: testInfo.outputPath('cron-run.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('an unwritable store shows one banner and a recovered job keeps its last failure (TAL-810)', async ({ page }, testInfo) => {
  const job = { id: 'digest', name: 'Morning digest', prompt: 'Synthetic task', schedule: '0 9 * * *', schedule_display: '0 9 * * *', schedule_input: '0 9 * * *', enabled: true, state: 'scheduled', last_status: 'ok', last_run_at: '2026-10-12T09:00:00Z', next_run_at: '2026-10-13T09:00:00Z', derived_state: 'active', needs_attention: false, resumable: false, attention_hint: null, last_failure: { at: 1_791_450_000, detail: 'Provider timed out after 600s' }, toast_notifications: true, read_only: false }
  const store = { profile: 'default', store: '/srv/hermes/cron', error: 'EROFS: Read-only file system', fix: 'free disk space, remount it read-write, or fix permissions on /srv/hermes/cron', since: 1_791_400_000 }
  await page.route('**/api/crons', (route) => route.fulfill({ json: { jobs: [job], active_profile: 'default', all_profiles: false, other_profile_count: 0, unwritable_stores: [store] } }))
  await page.route('**/api/crons/status', (route) => route.fulfill({ json: { running: {} } }))
  await page.route('**/api/crons/history?*', (route) => route.fulfill({ json: { runs: [], total: 0, offset: 0 } }))
  await page.goto('/tasks?job=digest')
  const banner = page.getByTestId('cron-detail').getByRole('alert')
  await expect(banner).toHaveCount(1)
  await expect(banner).toContainText("Scheduled tasks can't run")
  await expect(banner).toContainText(store.fix)
  await expect(page.getByTestId('cron-detail')).toContainText('Provider timed out after 600s')
  await page.screenshot({ path: testInfo.outputPath('cron-store-banner.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
