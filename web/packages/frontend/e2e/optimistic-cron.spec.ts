import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

test('held task actions show their result at once and roll a refusal back', async ({ page }, testInfo) => {
  const job = { id: 'digest', name: 'Morning digest', prompt: 'Summarise the synthetic inbox', schedule: '0 9 * * *', schedule_display: '0 9 * * *', schedule_input: '0 9 * * *', enabled: true, state: 'scheduled', next_run_at: '2026-10-18T09:00:00Z', derived_state: 'active', needs_attention: false, resumable: false, profile: 'default', toast_notifications: true, read_only: false }
  let jobs = [job]
  let finish!: (result: object) => void
  let writes = 0
  await page.route('**/api/crons', (route) => route.fulfill({ json: { jobs, active_profile: 'default', all_profiles: false, other_profile_count: 0 } }))
  await page.route('**/api/crons/status', (route) => route.fulfill({ json: { running: {} } }))
  await page.route('**/api/crons/history?*', (route) => route.fulfill({ json: { runs: [], total: 0, offset: 0 } }))
  await page.route(/\/api\/crons\/(pause|resume|delete)$/, async (route) => {
    writes += 1
    const result = await new Promise<object>((resolve) => { finish = resolve })
    await route.fulfill({ json: result })
  })
  await page.goto('/tasks?job=digest')
  const detail = page.getByTestId('cron-detail')
  await expect(detail).toHaveAttribute('data-state', 'active')
  await page.getByRole('button', { name: /^pause$/i }).click()
  await expect.poll(() => writes).toBe(1)
  await expect(detail).toHaveAttribute('data-state', 'paused')
  await expect(page.getByRole('button', { name: /^resume$/i })).toBeEnabled()
  await expect(page.getByText(/^Pending/)).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('pause-shown.png') })
  finish({ ok: false, error: 'Synthetic pause refused' })
  await expect(page.getByRole('alert')).toContainText('Synthetic pause refused')
  await expect(detail).toHaveAttribute('data-state', 'active')
  await expect(page.getByRole('button', { name: /^pause$/i })).toBeEnabled()
  await page.getByRole('button', { name: /^delete$/i }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: /^cancel$/i }).click()
  await expect(page.getByRole('alertdialog')).toBeHidden()
  expect(writes).toBe(1)
  await page.getByRole('button', { name: /^delete$/i }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: /^delete$/i }).click()
  await expect(page.getByRole('alertdialog')).toBeHidden()
  await expect(detail).toHaveCount(0)
  await expect(page.locator('[data-job-id="digest"]')).toHaveCount(0)
  await expect(page).toHaveURL(/\/tasks$/)
  await page.screenshot({ path: testInfo.outputPath('delete-shown.png') })
  jobs = []
  finish({ ok: true })
  await expect(page.locator('[data-job-id="digest"]')).toHaveCount(0)
  expect(writes).toBe(2)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
