import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, settle, test } from './fixtures'

// Service-worker requests bypass page routing; these fixtures own every response.
test.use({ serviceWorkers: 'block' })

const fixture = (JSON.parse(readFileSync(join(import.meta.dirname, '../../../../contracts/fixtures/web-session.json'), 'utf8')) as { tool_lookup_views: { session: { messages: unknown[] } } }).tool_lookup_views

test('a tool lookup the server hides stays out of the turn, a failed one shows, and Settings › Chat offers the switch (TAL-2331)', async ({ page }, testInfo) => {
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}-${testInfo.project.name}.png`), fullPage: true })
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'lookup-session', title: 'Tool lookups', messages: fixture.session.messages } } }))

  await page.goto('/session/lookup-session')
  await settle(page)
  await page.getByRole('button', { name: 'Worked' }).click()
  await page.getByRole('button', { name: 'Expand all' }).click()
  await expect(page.locator('[data-tool-id="call-list"]')).toBeVisible()
  await expect(page.locator('[data-tool-id="call-list"]')).toHaveCount(1)
  await expect(page.locator('[data-tool-id="call-search"]')).toHaveCount(1)
  await expect(page.locator('[data-tool-id="call-describe"]')).toHaveCount(0)
  await shot('tool-lookups-transcript')

  await page.goto('/settings/chat')
  await settle(page)
  const toggle = page.getByRole('switch', { name: 'Show tool lookups' })
  await expect(toggle).not.toBeChecked()
  await toggle.scrollIntoViewIfNeeded()
  await shot('tool-lookups-setting')
  const saved = page.waitForRequest((request) => request.url().endsWith('/api/settings') && request.method() === 'POST')
  await toggle.click()
  expect((await saved).postDataJSON()).toMatchObject({ show_tool_lookups: true })
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(toggle).not.toBeChecked()
})
