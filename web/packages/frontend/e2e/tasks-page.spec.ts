import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const task = { prompt: 'Synthetic task', schedule: '0 9 * * *', schedule_display: '0 9 * * *', schedule_input: '0 9 * * *', state: 'scheduled', next_run_at: '2026-10-18T09:00:00Z', needs_attention: false, profile: 'default', toast_notifications: true, read_only: false, delivery_unconfirmed_platforms: [] as string[] }
const jobs = [
  { ...task, id: 'digest', name: 'Morning digest', enabled: true, derived_state: 'active', resumable: false },
  { ...task, id: 'parked', name: 'Parked report', enabled: false, derived_state: 'paused', resumable: true },
]
const run = { filename: '2026-10-17_09-00-00.md', size: 1200, modified: 1_792_000_000 }

async function routeTasks(page: Page, rows: typeof jobs) {
  await page.route('**/api/crons', (route) => route.fulfill({ json: { jobs: rows, active_profile: 'default', all_profiles: false, other_profile_count: 0, unwritable_stores: [] } }))
  await page.route('**/api/crons/status', (route) => route.fulfill({ json: { running: {} } }))
  await page.route('**/api/crons/history?*', (route) => route.fulfill({ json: { runs: [run], total: 1, offset: 0 } }))
  await page.route('**/api/crons/run?*', (route) => route.fulfill({ json: { content: 'Synthetic run output', snippet: 'Synthetic', response: 'Synthetic run output', usage: {} } }))
}

test('the task list is the page and a task opens as a detail with a way back', async ({ page }, info) => {
  await routeTasks(page, jobs)
  const desktop = info.project.name === 'desktop'
  await page.goto('/tasks')
  const row = page.locator('#main [data-job-id="digest"]')
  await expect(row).toBeVisible()
  await expect(row).toHaveAttribute('data-state', 'active')
  // The list is the page: no panel beside it on a desktop, no drawer opened over it on a phone.
  await expect(page.locator(desktop ? '.sidebar' : '.sidebar.mobile-open')).toHaveCount(0)
  for (const name of ['Refresh', 'New queue', 'New job']) await expect(page.locator('.main-view-actions').getByRole('button', { name, exact: true })).toBeVisible()
  const parked = page.locator('#main [data-job-id="parked"]')
  await expect(parked).toBeHidden()
  await page.locator('#main summary').click()
  await expect(parked).toBeVisible()
  await page.screenshot({ path: info.outputPath('list.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  const detail = page.getByTestId('cron-detail')
  await row.click()
  await expect(page).toHaveURL(/\/tasks\?job=digest$/)
  await expect(detail).toBeVisible()
  await expect(page.locator('#main [data-job-id]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page).toHaveURL(/\/tasks$/)
  await expect(detail).toHaveCount(0)
  await row.click()
  await expect(detail).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(/\/tasks$/)
  await expect(row).toBeVisible()

  // A missing task keeps the way back; a deep link reaches the same detail.
  await page.goto('/tasks?job=gone')
  await expect(page.getByText('This task no longer exists.')).toBeVisible()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(row).toBeVisible()
  await page.goto('/tasks?job=digest')
  await expect(detail).toBeVisible()
  await page.screenshot({ path: info.outputPath('detail.png') })

  // A picked run still opens: the shell hides its right panel only on the list.
  await page.getByRole('region', { name: 'Runs' }).getByRole('row').first().click()
  await expect(page.getByTestId('cron-run-output')).toBeVisible()
  if (desktop) {
    // The active rail tab leaves a detail for the list instead of folding a sidebar this page does not have.
    await page.locator('.rail [data-panel="tasks"]').click()
    await expect(page).toHaveURL(/\/tasks$/)
    await expect(page.locator('.layout')).not.toHaveClass(/sidebar-collapsed/)
  }
})

test('a task whose last delivery is unconfirmed names the platforms on one line; a confirmed task says nothing (TAL-1850)', async ({ page }, info) => {
  await routeTasks(page, [...jobs, { ...jobs[0]!, id: 'unsure', name: 'Unsure digest', delivery_unconfirmed_platforms: ['telegram', 'slack'] }])
  await page.goto('/tasks?job=unsure')
  const line = page.getByText("Couldn't confirm delivery to telegram, slack", { exact: true })
  await expect(line).toBeVisible()
  expect(await line.evaluate((el) => el.getBoundingClientRect().height <= Number.parseFloat(getComputedStyle(el).lineHeight))).toBe(true)
  await page.screenshot({ path: info.outputPath('unconfirmed.png') })
  await page.goto('/tasks?job=digest')
  await expect(page.getByTestId('cron-detail')).toBeVisible()
  await expect(page.getByText(/confirm delivery/)).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('confirmed.png') })
})
