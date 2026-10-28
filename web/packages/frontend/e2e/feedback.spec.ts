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
