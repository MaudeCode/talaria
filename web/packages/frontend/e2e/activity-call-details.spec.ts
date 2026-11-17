import { expect, settle, test } from './fixtures'

test('Settings › Access › Privacy offers the switch for tool call details outside the chat (TAL-2336)', async ({ page }, testInfo) => {
  // The projects share one server; each answers its own writes so one never flips the other's switch.
  await page.route('**/api/settings', (route) => route.request().method() === 'POST' ? route.fulfill({ json: route.request().postDataJSON() }) : route.fallback())
  await page.goto('/settings/access')
  await settle(page)
  const toggle = page.getByRole('switch', { name: 'Tool call details in Live Activities and alerts' })
  await expect(toggle).toBeChecked()
  await toggle.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath(`activity-call-details-${testInfo.project.name}.png`), fullPage: true })
  const saved = page.waitForRequest((request) => request.url().endsWith('/api/settings') && request.method() === 'POST')
  await toggle.click()
  expect((await saved).postDataJSON()).toMatchObject({ activity_call_details: false })
  await expect(toggle).not.toBeChecked()
  await toggle.click()
  await expect(toggle).toBeChecked()
})
