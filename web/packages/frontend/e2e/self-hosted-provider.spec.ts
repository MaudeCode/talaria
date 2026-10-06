import { expect, settle, test } from './fixtures'

// TAL-570: the real server saves the provider; nothing here is routed.
test('adds a self-hosted provider, then picks its model and refreshes its models', async ({ page }, testInfo) => {
  await page.goto('/settings/providers')
  await settle(page)
  const row = page.locator('[data-provider="lmstudio"]')
  await row.getByRole('button', { name: 'Set up' }).click()
  await row.getByRole('textbox', { name: 'Base URL' }).fill('http://127.0.0.1:9/v1')
  await row.getByRole('textbox', { name: 'API key (optional)' }).fill('lm-synthetic-key')
  await row.getByRole('textbox', { name: 'Default model' }).fill('synthetic-local-model')
  await row.screenshot({ path: testInfo.outputPath('self-hosted-form.png') })

  const saved = page.waitForResponse((r) => r.url().endsWith('/api/providers/self-hosted') && r.ok())
  await row.getByRole('button', { name: 'Save' }).click()
  expect(await (await saved).json()).toMatchObject({ ok: true, provider: 'lmstudio', base_url: 'http://127.0.0.1:9/v1', model: 'synthetic-local-model' })
  await expect(page.locator('[data-section="providers"] strong').first()).toHaveText('lmstudio')
  await expect(row.getByRole('textbox', { name: 'Base URL' })).toHaveCount(0)
  await expect(row).toContainText('Configured')
  await expect(row).toContainText('http://127.0.0.1:9/v1')
  await row.screenshot({ path: testInfo.outputPath('self-hosted-saved.png') })

  const refreshed = page.waitForRequest((r) => r.url().endsWith('/api/models/refresh'))
  const reread = page.waitForResponse((r) => r.url().endsWith('/api/providers') && r.request().method() === 'GET')
  await row.getByRole('button', { name: 'Refresh models' }).click()
  expect((await refreshed).postDataJSON()).toEqual({ provider: 'lmstudio' })
  expect((await reread).ok()).toBe(true)

  await page.goto('/')
  await settle(page)
  const chip = page.locator('#composerModelChip')
  await expect(chip).toHaveAttribute('aria-label', 'Conversation model: Synthetic Local Model')
  // The narrow composer folds its chips away; the picker opens from the desktop strip.
  if (testInfo.project.name !== 'desktop') return
  await chip.click()
  await expect(page.getByRole('menuitemradio', { name: 'Synthetic Local Model' })).toHaveAttribute('aria-checked', 'true')
  await page.screenshot({ path: testInfo.outputPath('self-hosted-picker.png') })
})
