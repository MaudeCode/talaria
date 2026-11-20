import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const longLabel = 'Apply approved default-profile plugin decisions '.repeat(4).trim()

test('background results keep one leading review icon and only their goal at desktop and narrow widths', async ({ page }, testInfo) => {
  const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts/fixtures/background-review.json'), 'utf8')) as { session_id: string; messages: Record<string, unknown>[] }
  const failed = fixture.messages.find((message) => message.message_id === 'review-failed')!
  const update = failed._background_update as { lines: Record<string, unknown>[] }
  const long = { ...failed, message_id: 'review-long', _background_update: { ...update, lines: [{ ...update.lines[0], label: longLabel }] } }
  const marker = { role: 'user', content: 'Earlier turns were summarised.', message_id: 'marker', _display: 'row', _marker_kind: 'context_compaction' }
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    ...fixture, title: 'Background review', is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_rename: true, can_move: true, can_duplicate: true, can_share: true, transcript_seq: null,
    messages: [{ role: 'user', content: 'Check these results.' }, marker, ...fixture.messages, long, { role: 'assistant', content: 'The test run needs attention.' }],
  } } }))
  await page.goto(`/session/${fixture.session_id}`)
  const lines = page.locator('[data-role="background"] summary li')
  await expect(lines).toHaveCount(6)
  const labels = ['Audit the storage', 'Check the backups', 'Review the configuration', 'Run the tests', 'Recover the result']
  const descriptions = ['Waiting for the parent to review this result.', 'The parent is reviewing this result.', 'The parent reviewed this result.', 'The worker or parent review failed.', 'The worker or parent review outcome is unknown.']
  for (const [i, label] of labels.entries()) {
    await expect(lines.nth(i)).toHaveText(label)
    await expect(lines.nth(i).locator('svg')).toHaveCount(1)
    await expect(lines.nth(i)).toHaveAttribute('aria-label', `${label}. ${descriptions[i]}`)
  }
  await expect(page.getByText('The test run needs attention.')).toBeVisible()

  // TAL-1962: each result is the marker's disclosure: its muted label, 14px icons, one chevron, a 44px touch target.
  const markerLabel = page.locator('[data-role="marker"] summary > div')
  const style = (locator: typeof markerLabel) => locator.evaluate((el) => { const { color, fontSize } = getComputedStyle(el); return { color, fontSize } })
  expect(await style(lines.first().locator('span'))).toEqual(await style(markerLabel))
  for (const icon of await lines.locator('svg').all()) expect(await icon.getAttribute('width')).toBe('14')
  await expect(lines.nth(3).locator('svg')).toHaveClass(/text-warning/)
  const summary = page.locator('[data-role="background"] summary').first()
  await expect(summary.locator(':scope > svg')).toHaveCount(1)
  if (testInfo.project.name === 'mobile') expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  const longLine = lines.filter({ hasText: longLabel })
  const longSpan = longLine.locator('span')
  expect(await longSpan.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  const chevron = (await page.locator('[data-role="background"] summary').last().locator(':scope > svg').boundingBox())!
  expect(chevron.x + chevron.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  expect((await longSpan.boundingBox())!.height).toBeLessThan(24)

  if (process.env.TAL1022_SHOTS) await page.screenshot({ path: `${process.env.TAL1022_SHOTS}/review-collapsed-${testInfo.project.name}.png` })
  // Opening it turns the chevron and shows the flat body under the titles, with its time and Copy.
  await summary.click()
  await expect(summary.locator(':scope > svg')).toHaveCSS('rotate', '90deg')
  const body = page.locator('[data-role="background"] details[open] > div')
  await expect(body.locator('.msg-body')).toHaveText('Synthetic background results')
  await expect(body.getByRole('button', { name: 'Copy' })).toBeVisible()
  await expect(body).toHaveCSS('border-top-width', '0px')
  await expect(body).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(body).toHaveCSS('padding-left', '22px')
  if (process.env.TAL1022_SHOTS) await page.screenshot({ path: `${process.env.TAL1022_SHOTS}/review-${testInfo.project.name}.png` })
  await page.reload()
  await expect(lines).toHaveCount(6)
  await expect(lines.nth(2).locator('svg')).toHaveClass(/lucide-check/)
})
