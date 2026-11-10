import { expect, settle, test } from './fixtures'
import { routePlugins } from './plugins'

test.use({ serviceWorkers: 'block' })

test('plugin save distinguishes persisted settings from live MCP application', async ({ page }, testInfo) => {
  const fields = [{ key: 'api_key', type: 'secret', label: 'API key', description: '', required: false, env: 'DEMO_KEY', has_value: true }]
  await routePlugins(page, () => ({
    read_only: false, plugins: [{ key: 'demo', name: 'Demo', enabled: true, settings: fields }],
  }))
  let runtime_application = 'applied'
  await page.route('**/api/plugins/settings', (route) => route.fulfill({ json: {
    ok: true, key: 'demo', written: ['api_key'], settings: fields, runtime_application,
  } }))
  await page.goto('/settings/tools')
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

test('plugin filter narrows the installed list and each description keeps to one line (TAL-2082)', async ({ page }, testInfo) => {
  const long = 'Connects the agent to a synthetic calendar service so it can read, create and move events, answer availability questions and send invitations on your behalf'
  const plugins = Array.from({ length: 12 }, (_, i) => ({ key: `plugin-${i}`, name: `Plugin ${i}`, version: '1.0.0', kind: 'standalone', enabled: true, description: i === 3 ? `${long} with MAILBOX access` : long }))
  await routePlugins(page, () => ({ read_only: false, plugins }))
  await page.route('**/api/settings', async (route) => route.request().method() === 'GET' ? route.fulfill({ json: { ...await (await route.fetch()).json(), agent_approvals: true } }) : route.continue())
  await page.goto('/settings/tools')
  await settle(page)
  const section = page.locator('[data-section="plugins"]')
  const rows = section.locator('[data-plugin]')
  await expect(rows).toHaveCount(12)
  await expect(page.getByRole('region', { name: 'Agent permissions' })).toBeVisible()
  const description = rows.first().getByText(long, { exact: true })
  await expect(description).toHaveAttribute('title', long)
  const lineHeight = await description.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight))
  expect((await description.boundingBox())!.height).toBeLessThanOrEqual(lineHeight + 1)
  if (testInfo.project.name === 'desktop') for (const height of await rows.evaluateAll((els) => els.map((el) => el.firstElementChild!.getBoundingClientRect().height))) expect(height).toBeLessThanOrEqual(48)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('plugins.png') })
  const filter = section.getByRole('searchbox', { name: 'Filter plugins' })
  await filter.fill('mailbox')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toHaveAttribute('data-plugin', 'plugin-3')
  await filter.fill('PLUGIN 1')
  await expect(rows).toHaveCount(3)
  await page.screenshot({ path: testInfo.outputPath('plugins-filtered.png') })
  await filter.fill('nothing like this')
  await expect(rows).toHaveCount(0)
  await expect(section.getByText('No plugins match')).toBeVisible()
  await filter.fill('')
  await expect(rows).toHaveCount(12)
})
