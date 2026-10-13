import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

test('default model speed uses server tiers and survives a reload', async ({ page }, testInfo) => {
  const main = { model: 'gpt-6-astra', provider: 'openai-codex', service_tier: 'priority', supported_speed_tiers: [
    { id: 'standard', service_tier: 'default' }, { id: 'priority', service_tier: 'priority' }, { id: 'ultrafast', service_tier: 'ultrafast' },
  ] }
  const writes: unknown[] = []
  await page.route('**/api/model/auxiliary', (route) => route.fulfill({ json: { main, tasks: [] } }))
  await page.route('**/api/models', (route) => route.fulfill({ json: {
    default_option_id: 'gpt-6-astra', default_model: 'gpt-6-astra', groups: [{ provider: 'OpenAI Codex', provider_id: 'openai-codex', models: [{ id: 'gpt-6-astra', bare_id: 'gpt-6-astra', provider_id: 'openai-codex', label: 'GPT-6 Astra', supported_speed_tiers: main.supported_speed_tiers }] }],
  } }))
  await page.route('**/api/default-model', async (route) => {
    const body = route.request().postDataJSON() as { advanced: { service_tier: string } }
    writes.push(body)
    main.service_tier = body.advanced.service_tier
    await route.fulfill({ json: { ok: true, model: main.model, provider: main.provider } })
  })
  await page.goto('/settings/preferences')
  await settle(page)
  const speed = page.getByRole('combobox', { name: 'Speed', exact: true })
  await expect(speed).toHaveText('Fast')
  await speed.click()
  await expect(page.getByRole('option')).toHaveText(['Standard', 'Fast', 'Ultrafast'])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('speed-options.png') })
  await page.getByRole('option', { name: 'Ultrafast', exact: true }).click()
  await expect(speed).toHaveText('Ultrafast')
  expect(writes).toEqual([{ model: 'gpt-6-astra', provider: 'openai-codex', advanced: { service_tier: 'ultrafast' } }])
  await page.reload()
  await expect(speed).toHaveText('Ultrafast')
  await page.screenshot({ path: testInfo.outputPath('speed-saved.png') })
  main.supported_speed_tiers = []
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Default Model', exact: true })).toBeVisible()
  await expect(speed).toHaveCount(0)
})
