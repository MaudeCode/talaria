import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block', video: 'on' })

test('blueprint fills the existing task editor', async ({ page }, testInfo) => {
  const blueprint = { key: 'team:brief', title: 'Team brief', description: 'A daily digest of team releases.', category: 'daily', source: 'plugin', plugin: 'team', schedule_label: 'Daily at 09:00', slots: [
    { name: 'topic', type: 'text', label: 'Topic', default: null, options: [], optional: false, strict: true, help: '' },
    { name: 'time', type: 'time', label: 'Time', default: '09:00', options: [], optional: false, strict: true, help: '' },
  ] }
  await page.route('**/api/crons', (route) => route.fulfill({ json: { jobs: [], active_profile: 'default', all_profiles: false, other_profile_count: 0, unwritable_stores: [] } }))
  await page.route('**/api/crons/status', (route) => route.fulfill({ json: { running: {} } }))
  await page.route('**/api/cron/blueprints', (route) => route.fulfill({ json: { blueprints: [blueprint] } }))
  await page.route('**/api/cron/blueprints/fill', (route) => route.fulfill({ json: { draft: { name: 'Team brief', prompt: 'Summarize team releases.', schedule: '30 8 * * *', deliver: 'local', skills: ['summary'] } } }))
  await page.route('**/api/models', (route) => route.fulfill({ json: { groups: [] } }))
  await page.route('**/api/crons/context-sources', (route) => route.fulfill({ json: { profile: 'default', sources: [] } }))
  await page.goto('/tasks')
  await page.getByRole('button', { name: /new job/i }).first().click()
  await page.getByRole('button', { name: 'Start from a blueprint' }).click()
  await expect(page.getByRole('button', { name: /Team brief.*team/ })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('catalog.png') })
  await page.getByRole('button', { name: /Team brief.*team/ }).click()
  await page.getByLabel('Topic', { exact: true }).fill('releases')
  await page.getByLabel('Time', { exact: true }).fill('08:30')
  await page.screenshot({ path: testInfo.outputPath('slots.png') })
  await page.getByRole('button', { name: 'Use blueprint' }).click()
  await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue('Summarize team releases.')
  await expect(page.getByLabel('Schedule', { exact: true })).toHaveValue('30 8 * * *')
  await page.screenshot({ path: testInfo.outputPath('filled.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
