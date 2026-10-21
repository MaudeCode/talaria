import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

test('plugin save distinguishes persisted settings from live MCP application', async ({ page }, testInfo) => {
  const fields = [{ key: 'api_key', type: 'secret', label: 'API key', description: '', required: false, env: 'DEMO_KEY', has_value: true }]
  await page.route('**/api/plugins', (route) => route.fulfill({ json: {
    read_only: false, plugins: [{ key: 'demo', name: 'Demo', enabled: true, settings: fields }],
  } }))
  let runtime_application = 'applied'
  await page.route('**/api/plugins/settings', (route) => route.fulfill({ json: {
    ok: true, key: 'demo', written: ['api_key'], settings: fields, runtime_application,
  } }))
  await page.goto('/settings/plugins')
  await settle(page)
  const section = page.locator('[data-section="plugins"]')
  for (const [application, message] of [
    ['applied', 'Saved'],
    ['restart_required', 'Settings saved. Restart the affected MCP server to apply them.'],
    ['unknown', 'Settings saved. Live MCP application is unconfirmed. Check MCP status before retrying.'],
  ]) {
    runtime_application = process.env.TALARIA_PLUGIN_SETTINGS_BEFORE === '1' ? 'restart_required' : application!
    await section.getByRole('button', { name: 'Settings', exact: true }).click()
    await section.getByLabel('API key', { exact: true }).fill('synthetic-key')
    if (process.env.TALARIA_PLUGIN_SETTINGS_BEFORE === '1') {
      await page.screenshot({ path: testInfo.outputPath('before-form.png') })
      await section.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.getByRole('status').getByText('Saved', { exact: true })).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath('before-save.png') })
      return
    }
    await section.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('status').getByText(message!, { exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`${application}.png`) })
    await page.reload()
    await settle(page)
  }
})
