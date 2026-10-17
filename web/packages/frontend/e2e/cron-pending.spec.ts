import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

test('held task actions show intent, recover refusal and retain confirmed running state', async ({ page }, testInfo) => {
  const job = { id: 'digest', name: 'Morning digest', prompt: 'Summarise the synthetic inbox', schedule: '0 9 * * *', schedule_display: '0 9 * * *', schedule_input: '0 9 * * *', enabled: true, state: 'scheduled', next_run_at: '2026-10-18T09:00:00Z', derived_state: 'active', needs_attention: false, resumable: false, profile: 'default', toast_notifications: true, read_only: false }
  let jobs = [job]
  let finish!: (result: object) => void
  let writes = 0
  await page.route('**/api/crons', (route) => route.fulfill({ json: { jobs, active_profile: 'default', all_profiles: false, other_profile_count: 0 } }))
  await page.route('**/api/crons/status', (route) => route.fulfill({ json: { running: { digest: 1790000000 } } }))
  await page.route('**/api/crons/history?*', (route) => route.fulfill({ json: { runs: [], total: 0, offset: 0 } }))
  await page.route(/\/api\/crons\/(pause|resume|delete)$/, async (route) => {
    writes += 1
    const result = await new Promise<object>((resolve) => { finish = resolve })
    await route.fulfill({ json: result })
  })
  await page.goto('/tasks?job=digest')
  const detail = page.getByTestId('cron-detail')
  await expect(detail).toHaveAttribute('data-state', 'running')
  await page.getByRole('button', { name: /^pause$/i }).click()
  await expect.poll(() => writes).toBe(1)
  // Also captured against the baseline build, before the pending assertions.
  await page.screenshot({ path: testInfo.outputPath('pause-pending.png') })
  await expect(detail.getByRole('status')).toHaveText('Pending: Pause')
  await expect(page.getByRole('button', { name: /^pause$/i })).toBeDisabled()
  await expect(detail).toHaveAttribute('data-state', 'running')
  finish({ ok: false, error: 'Synthetic pause refused' })
  await expect(page.getByRole('alert')).toContainText('Synthetic pause refused')
  await expect(page.getByRole('button', { name: /^pause$/i })).toBeEnabled()
  await expect(detail.getByRole('status')).toHaveCount(0)
  await page.getByRole('button', { name: /^delete$/i }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: /^cancel$/i }).click()
  await expect(page.getByRole('alertdialog')).toBeHidden()
  expect(writes).toBe(1)
  await page.getByRole('button', { name: /^delete$/i }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: /^delete$/i }).click()
  await expect(detail.getByRole('status')).toHaveText('Pending: Delete')
  await expect(detail).toHaveAttribute('data-state', 'running')
  await page.screenshot({ path: testInfo.outputPath('delete-pending.png') })
  jobs = []
  finish({ ok: true })
  await expect(detail).toHaveCount(0)
  await expect(page.locator('[data-job-id="digest"]')).toHaveCount(0)
  await expect(page).toHaveURL(/\/tasks$/)
  await expect(page.getByText('Select a task to see its schedule, runs and status.')).toBeVisible()
  expect(writes).toBe(2)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
