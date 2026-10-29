import type { Route } from '@playwright/test'
import { expect, settle, test } from './fixtures'

/** TAL-1574: Settings → Help sends feedback optimistically; a refusal reopens the dialog with the draft. */
const diagnostics = { text: 'Web: 1.4.0\nRelay registered: no', bytes: 31 }

for (const theme of ['dark', 'light'] as const) {
  test(`Send feedback closes at once and a rate limit reopens the draft (${theme})`, async ({ page, errors }, testInfo) => {
    await page.addInitScript((value) => { localStorage.setItem('hermes-theme', value) }, theme)
    await page.route('**/api/feedback/diagnostics', (route) => route.fulfill({ json: diagnostics }))
    let held: Route | null = null
    await page.route('**/api/feedback/submit', (route) => { held = route })
    await page.goto('/settings/help')
    await settle(page)
    await page.getByRole('button', { name: 'Send feedback' }).click()
    const dialog = page.getByRole('dialog', { name: 'Send feedback' })
    await dialog.getByRole('button', { name: 'Feature request' }).click()
    await dialog.getByRole('textbox', { name: 'Title' }).fill('Composer loses the draft after reconnecting')
    await dialog.getByRole('textbox', { name: 'Details' }).fill('The composer was empty after the connection came back.')
    await dialog.getByText('Show diagnostics').click()
    await expect(dialog.locator('[data-feedback-diagnostics]')).toHaveText(diagnostics.text)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`feedback-${theme}.png`) })

    await dialog.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByText('Feedback sent')).toBeVisible()
    await expect.poll(() => held !== null).toBe(true)
    const body = held!.request().postDataJSON() as { requestId: string; includeDiagnostics: boolean; client: unknown }
    expect(body).toMatchObject({ kind: 'feature', includeDiagnostics: true, client: { platform: 'web' } })
    await held!.fulfill({ status: 429, json: { error: 'rate_limited', retryAfterSeconds: 42 } })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('textbox', { name: 'Title' })).toHaveValue('Composer loses the draft after reconnecting')
    await expect(page.getByText(/Feedback limit reached\. Try again in 42/)).toBeVisible()
    await expect(page.getByText('Feedback sent')).toBeHidden()
    for (const kind of ['Bug', 'Feature request', 'Other']) expect((await dialog.getByRole('button', { name: kind }).boundingBox())!.height).toBeLessThan(40)
    await page.screenshot({ path: testInfo.outputPath(`feedback-${theme}-rate-limited.png`) })
    // The refusal is the case under test.
    errors.splice(0, errors.length, ...errors.filter((e) => !/api\/feedback\/submit|status of 429/.test(e)))
  })
}

test('Send feedback stays reachable on a short viewport with diagnostics open', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 })
  await page.route('**/api/feedback/diagnostics', (route) => route.fulfill({ json: { text: Array.from({ length: 40 }, (_, i) => `line ${String(i)}`).join('\n'), bytes: 0 } }))
  await page.goto('/settings/help')
  await settle(page)
  await page.getByRole('button', { name: 'Send feedback' }).click()
  const dialog = page.getByRole('dialog', { name: 'Send feedback' })
  await dialog.getByText('Show diagnostics').click()
  await expect(dialog.locator('[data-feedback-diagnostics]')).toBeVisible()
  const sendButton = dialog.getByRole('button', { name: 'Send', exact: true })
  await sendButton.scrollIntoViewIfNeeded()
  const box = await sendButton.boundingBox()
  expect(box && box.y >= 0 && box.y + box.height <= 390).toBe(true)
})

/** TAL-1588: an opt-in rail button above Notifications opens the same Send feedback dialog. */
test('Sidebar feedback button is opt-in and sits above Notifications in the rail', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'The rail is hidden on phone widths; Settings → Help remains the entry point.')
  const railButton = page.locator('.rail').getByRole('button', { name: 'Send feedback' })
  const notifications = page.locator('.rail').getByRole('button', { name: 'Notifications', exact: true })
  try {
    await page.goto('/settings/preferences')
    await settle(page)
    await expect(notifications).toBeVisible()
    await expect(railButton).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('rail-feedback-off.png') })
    const toggle = page.getByRole('switch', { name: 'Sidebar feedback button' })
    await expect(toggle).not.toBeChecked()
    await toggle.click()
    await expect(railButton).toBeVisible()
    const [feedbackBox, notificationsBox] = [(await railButton.boundingBox())!, (await notifications.boundingBox())!]
    expect(feedbackBox.y + feedbackBox.height).toBeLessThanOrEqual(notificationsBox.y + 1)
    await page.screenshot({ path: testInfo.outputPath('rail-feedback-on.png') })

    await page.reload()
    await settle(page)
    await expect(railButton).toBeVisible()
    await railButton.click()
    await expect(page.getByRole('dialog', { name: 'Send feedback' })).toHaveCount(1)
    await page.screenshot({ path: testInfo.outputPath('rail-feedback-dialog.png') })
    await page.keyboard.press('Escape')

    await toggle.click()
    await expect(railButton).toHaveCount(0)
  } finally {
    await page.request.post('/api/settings', { data: { show_sidebar_feedback: false } })
  }
})
