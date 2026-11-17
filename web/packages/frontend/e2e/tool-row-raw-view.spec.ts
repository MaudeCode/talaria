import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, settle, test } from './fixtures'

// Service-worker requests bypass page routing; these fixtures own every response.
test.use({ serviceWorkers: 'block' })

interface Row { role: string; tool?: { id: string; raw_args?: string; raw_result?: string } }
const fixture = (JSON.parse(readFileSync(join(import.meta.dirname, '../../../../contracts/fixtures/web-session.json'), 'utf8')) as { tool_outcome_views: { session: { messages: { _anchor_activity_scene?: { activity_rows: Row[] } }[] } } }).tool_outcome_views
const list = fixture.session.messages.flatMap((m) => m._anchor_activity_scene?.activity_rows ?? []).find((row) => row.tool?.id === 'call-list')!.tool!

test('an open tool row switches to the server\'s raw view and back, with Copy beside it (TAL-2338)', async ({ page }, testInfo) => {
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'raw-session', title: 'Raw view', messages: fixture.session.messages } } }))
  const row = page.locator('[data-tool-id="call-list"]')
  for (const theme of ['dark', 'light'] as const) {
    if (theme === 'light') {
      await page.goto('/settings/appearance')
      await page.locator('#main [data-theme-val="light"]').click()
      await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
    }
    await page.goto('/session/raw-session')
    await settle(page)
    for (let i = 0; i < 12 && await page.locator('.tool-worklog-summary[aria-expanded="false"]').count(); i += 1) await page.locator('.tool-worklog-summary[aria-expanded="false"]').first().click()
    // The row remembers being open across the reload into the other theme.
    if (await row.locator('.tool-card-header').getAttribute('aria-expanded') === 'false') await row.locator('.tool-card-header').click()
    const toggle = row.getByRole('button', { name: 'Show raw' })
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(row.getByRole('button', { name: 'Copy', exact: true })).toBeVisible()
    await expect(row.locator('[data-tool-view]')).toHaveAttribute('data-tool-view', 'formatted')
    await row.screenshot({ path: testInfo.outputPath(`tool-row-formatted-${theme}-${testInfo.project.name}.png`) })

    await toggle.click()
    await expect(row.getByRole('button', { name: 'Show formatted' })).toHaveAttribute('aria-pressed', 'true')
    await expect(row.getByRole('button', { name: 'Copy raw' })).toBeVisible()
    await expect(row.locator('.tool-card-detail pre')).toHaveText([list.raw_args!, list.raw_result!])
    await row.screenshot({ path: testInfo.outputPath(`tool-row-raw-${theme}-${testInfo.project.name}.png`) })
    // The row's tools stay on the first section's line, inside the column at a phone's width.
    const fits = await row.evaluate((el) => { const tools = el.querySelector('.tool-card-tools')!.getBoundingClientRect(); const box = el.getBoundingClientRect(); return tools.right <= box.right && tools.left >= box.left })
    expect(fits).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    await row.getByRole('button', { name: 'Show formatted' }).click()
    await expect(row.locator('[data-tool-view]')).toHaveAttribute('data-tool-view', 'formatted')
  }
})
