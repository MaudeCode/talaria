import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

test('background results keep one leading review icon and only their goal at desktop and narrow widths', async ({ page }, testInfo) => {
  const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts/fixtures/background-review.json'), 'utf8')) as { session_id: string; messages: Record<string, unknown>[] }
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    ...fixture, title: 'Background review', is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true, transcript_seq: null,
    messages: [{ role: 'user', content: 'Check these results.' }, ...fixture.messages, { role: 'assistant', content: 'The test run needs attention.' }],
  } } }))
  await page.goto(`/session/${fixture.session_id}`)
  const lines = page.locator('.background-update summary li')
  await expect(lines).toHaveCount(5)
  const labels = ['Audit the storage', 'Check the backups', 'Review the configuration', 'Run the tests', 'Recover the result']
  const descriptions = ['Waiting for the parent to review this result.', 'The parent is reviewing this result.', 'The parent reviewed this result.', 'The worker or parent review failed.', 'The worker or parent review outcome is unknown.']
  for (const [i, label] of labels.entries()) {
    await expect(lines.nth(i)).toHaveText(label)
    await expect(lines.nth(i).locator('svg')).toHaveCount(1)
    await expect(lines.nth(i)).toHaveAttribute('aria-label', `${label}. ${descriptions[i]}`)
  }
  await expect(page.getByText('The test run needs attention.')).toBeVisible()
  if (process.env.TAL1022_SHOTS) await page.screenshot({ path: `${process.env.TAL1022_SHOTS}/review-${testInfo.project.name}.png` })
  await page.reload()
  await expect(lines).toHaveCount(5)
  await expect(lines.nth(2).locator('svg')).toHaveClass(/lucide-check/)
})
