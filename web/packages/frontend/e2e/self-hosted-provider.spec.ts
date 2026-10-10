import { expect, settle, test } from './fixtures'

// The replay sidecar cannot write config.yaml, so these fixtures own the provider and model answers (TAL-570).
test.use({ serviceWorkers: 'block' })

const URL = 'http://127.0.0.1:9/v1'
const entry = { id: 'synthetic-local-model', label: 'Synthetic Local Model', provider_id: 'lmstudio' }

test('adds a self-hosted provider, refreshes its models, and picks its model', async ({ page }, testInfo) => {
  let lmstudio: Record<string, unknown> = { id: 'lmstudio', display_name: 'LM Studio', has_key: false, configured: false, configurable: true, is_self_hosted: true, key_source: 'none', key_source_kind: null, base_url: null, models: [], models_total: 0 }
  let active = 'anthropic'
  const anthropic = { id: 'anthropic', display_name: 'Anthropic', has_key: true, configured: true, key_source: 'env_file', key_source_kind: 'env', models: [], models_total: 0 }
  await page.route('**/api/providers', (route) => route.fulfill({ json: { active_provider: active, providers: (active === 'lmstudio' ? [lmstudio, anthropic] : [anthropic, lmstudio]).map((p) => ({ ...p, is_active: p.id === active })) } }))
  await page.route('**/api/providers/self-hosted', (route) => {
    lmstudio = { ...lmstudio, configured: true, base_url: URL, models: [entry], models_total: 1 }
    active = 'lmstudio'
    return route.fulfill({ json: { ok: true, provider: 'lmstudio', base_url: URL, model: entry.id } })
  })
  const catalog = () => ({ active_provider: active, default_model: entry.id, default_option_id: entry.id, groups: active === 'lmstudio' ? [{ provider: 'LM Studio', provider_id: 'lmstudio', models: [entry] }] : [] })
  await page.route('**/api/models', (route) => route.fulfill({ json: catalog() }))
  await page.route('**/api/models/refresh', (route) => {
    lmstudio = { ...lmstudio, models: [entry, { id: 'gemma3', label: 'Gemma 3', provider_id: 'lmstudio' }], models_total: 2 }
    return route.fulfill({ json: { ok: true, provider: 'lmstudio', models: catalog() } })
  })

  await page.goto('/settings/providers')
  await settle(page)
  const row = page.locator('[data-provider="lmstudio"]')
  // TAL-603: the rows render the server's key-source kind and active flag.
  await expect(page.locator('[data-provider="anthropic"]')).toContainText('Configured · env · 0 models')
  await expect(page.locator('[data-provider="anthropic"]')).toHaveClass(/border-accent-bg-strong/)
  await expect(row).toContainText('Not configured · 0 models')
  await page.locator('[data-section="providers"]').screenshot({ path: testInfo.outputPath('providers-badges.png') })
  await row.getByRole('button', { name: 'Set up' }).click()
  await row.getByRole('textbox', { name: 'Base URL' }).fill(URL)
  await row.getByRole('textbox', { name: 'Default model' }).fill(entry.id)
  await row.screenshot({ path: testInfo.outputPath('self-hosted-form.png') })

  const saved = page.waitForRequest((r) => r.url().endsWith('/api/providers/self-hosted'))
  await row.getByRole('button', { name: 'Save' }).click()
  expect((await saved).postDataJSON()).toEqual({ provider: 'lmstudio', base_url: URL, model: entry.id })
  await expect(page.locator('[data-section="providers"] strong').first()).toHaveText('lmstudio')
  await expect(row).toHaveClass(/border-accent-bg-strong/)
  await expect(row).toContainText(`Configured · ${URL} · 1 models`)
  await expect(row.getByRole('textbox', { name: 'Base URL' })).toHaveCount(0)
  await row.screenshot({ path: testInfo.outputPath('self-hosted-saved.png') })

  const refreshed = page.waitForRequest((r) => r.url().endsWith('/api/models/refresh'))
  await row.getByRole('button', { name: 'Refresh models' }).click()
  expect((await refreshed).postDataJSON()).toEqual({ provider: 'lmstudio' })
  await expect(row).toContainText(`Configured · ${URL} · 2 models`)
  await row.screenshot({ path: testInfo.outputPath('self-hosted-refreshed.png') })

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
