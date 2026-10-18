import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ModelsSchema, ProviderQuotasSchema } from '../src/contracts'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })
const raw = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts/fixtures/catalog-recovery.json'), 'utf8')) as { models: unknown; quotas: unknown }
const models = ModelsSchema.parse(raw.models)
const quotas = ProviderQuotasSchema.parse(raw.quotas)

test('recovery holds label cached quotas and the configured model truthfully', async ({ page }, testInfo) => {
  let held = false
  await page.route('**/api/providers', (route) => route.fulfill({ json: {
    availability: held ? quotas.availability : undefined,
    active_provider: 'anthropic', providers: [{ id: 'anthropic', display_name: 'Anthropic', has_key: true, configured: true, is_oauth: true, models: [], models_total: 0 }],
  } }))
  await page.route('**/api/provider/quotas**', (route) => route.fulfill({ json: held ? quotas : { ...quotas, availability: undefined, sources: [] } }))
  await page.route('**/api/models', (route) => route.fulfill({ json: held ? models : { ...models, availability: undefined, groups: models.groups.map((g) => ({ ...g, availability: undefined })) } }))
  await page.goto('/settings/preferences')
  await settle(page)
  await page.getByRole('combobox', { name: 'Default Model', exact: true }).click()
  await expect(page.getByRole('option', { name: 'GPT-6.1 Sol' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('models-before.png'), fullPage: true })
  await page.goto('/settings/providers')
  await settle(page)
  await expect(page.locator('[data-provider="anthropic"]')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('quota-before.png'), fullPage: true })
  held = true
  await page.reload()
  await expect(page.locator('[data-section="providers"]').getByRole('status')).toContainText('Showing last-confirmed data')
  await expect(page.getByTestId('provider-quota-pace')).toBeVisible()
  await page.getByRole('button', { name: 'Refresh quotas', exact: true }).click()
  await expect(page.getByTestId('provider-quota-pace')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('quota-recovery-after.png'), fullPage: true })
  await page.goto('/settings/preferences')
  await settle(page)
  await page.getByRole('combobox', { name: 'Default Model', exact: true }).click()
  await expect(page.getByText('OpenAI Codex · Last-confirmed data')).toBeVisible()
  await expect(page.getByRole('option', { name: 'GPT-6.1 Sol' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('models-recovery-after.png'), fullPage: true })
})
