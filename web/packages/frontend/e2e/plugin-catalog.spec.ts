import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block', video: 'on' })
const entry = { name: 'calendar-probe', title: 'Calendar', description: 'Calendar tools for a local test profile', repo: 'https://example.invalid/plugins/calendar', sha: 'a'.repeat(40), tier: 'verified', category: 'tools', requirements: ['Environment: CALENDAR_CLIENT_ID', 'Hermes: >=0.22.3'], installed_key: null as string | null, installed_sha: null as string | null, can_install: true, refusal: null }

test('catalog previews, confirms a disabled install and reconciles a lost acknowledgment', async ({ page, errors }, testInfo) => {
  let installed = false
  const calls: unknown[] = []
  const evidence = '/tmp/TAL-1331-evidence'
  await page.route('**/api/plugins', (route) => route.fulfill({ json: { read_only: false, plugins: [{ key: 'notes', name: 'Notes', version: '1.0.0', description: 'Read and write project notes', enabled: true, activation: 'enabled' }, ...(installed ? [{ key: 'calendar-native', name: 'Calendar', version: '1.0.0', description: 'Calendar tools', enabled: false, activation: 'disabled' }] : [])] } }))
  await page.route('**/api/plugins/catalog?*', (route) => route.fulfill({ json: { supported: true, read_only: false, entries: [{ ...entry, installed_key: installed ? 'calendar-native' : null, installed_sha: installed ? entry.sha : null, can_install: !installed }], total: 1, next_offset: null } }))
  await page.route('**/api/plugins/install', (route) => {
    const body = route.request().postDataJSON() as { name: string; consent_token?: string }
    calls.push(body)
    if (!body.consent_token) return route.fulfill({ json: { name: body.name, status: 'needs_consent', consent_token: 'synthetic-bound-preview', findings: 'Calendar · verified\nhttps://example.invalid/plugins/calendar\nEnvironment: CALENDAR_CLIENT_ID\nInstalls disabled. No dependency, host capability or sidecar permission is granted.\nNative Desktop contributions are unverified and do not run in Talaria.' } })
    expect(body.consent_token).toBe('synthetic-bound-preview')
    installed = true
    return route.fulfill({ status: 503, json: { error: 'Install outcome is unknown. Refresh Plugins to check the installed identity before trying again.', condition: 'plugin_install_unconfirmed' } })
  })
  await page.goto('/settings/plugins')
  await settle(page)
  const section = page.locator('[data-section="plugins"]')
  await expect(section.getByText(/^Notes/)).toBeVisible()
  if (process.env.TALARIA_CATALOG_BEFORE === '1') {
    await page.screenshot({ path: `${evidence}/before-${testInfo.project.name}.png` })
    return
  }
  await section.getByRole('button', { name: 'Catalog', exact: true }).click()
  await section.getByRole('button', { name: 'Details', exact: true }).click()
  await expect(section.getByText('Environment: CALENDAR_CLIENT_ID', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: `${evidence}/after-${testInfo.project.name}.png` })
  await section.getByRole('button', { name: 'Install disabled', exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('No dependency, host capability or sidecar permission is granted')
  await page.screenshot({ path: `${evidence}/confirm-${testInfo.project.name}.png` })
  await dialog.getByRole('button', { name: 'Install disabled', exact: true }).click()
  await expect(section.getByText('Installed', { exact: true })).toBeVisible()
  await expect(section.getByRole('button', { name: 'Install disabled', exact: true })).toHaveCount(0)
  await expect(section.getByText('Disabled · disabled', { exact: true })).toBeVisible()
  expect(calls).toEqual([{ name: 'calendar-probe' }, { name: 'calendar-probe', consent_token: 'synthetic-bound-preview' }])
  const expected = /^503 POST .*\/api\/plugins\/install$/
  expect(errors.filter((error) => expected.test(error))).toHaveLength(1)
  errors.splice(0, errors.length, ...errors.filter((error) => !expected.test(error)))
  await page.screenshot({ path: `${evidence}/installed-${testInfo.project.name}.png` })
})

test('catalog and installed empty states identify their own list', async ({ page }, testInfo) => {
  await page.route('**/api/plugins', (route) => route.fulfill({ json: { read_only: false, plugins: [] } }))
  await page.route('**/api/plugins/catalog?*', (route) => {
    const empty = new URL(route.request().url()).searchParams.get('query') === 'absent'
    return route.fulfill({ json: { supported: true, read_only: false, entries: empty ? [] : [entry], total: empty ? 0 : 1, next_offset: null } })
  })
  await page.goto('/settings/plugins')
  await settle(page)
  const section = page.locator('[data-section="plugins"]')
  await section.getByRole('button', { name: 'Catalog', exact: true }).click()
  await expect(section.getByText('Calendar', { exact: true })).toBeVisible()
  if (process.env.TALARIA_CATALOG_BEFORE === '1') {
    await expect(section.getByText('No plugins found.', { exact: true })).toBeVisible()
    await page.screenshot({ path: `/tmp/TAL-1331-evidence/empty-before-${testInfo.project.name}.png` })
    return
  }
  await expect(section.getByText('No installed plugins', { exact: true })).toBeVisible()
  await page.screenshot({ path: `/tmp/TAL-1331-evidence/empty-installed-${testInfo.project.name}.png` })
  await section.getByRole('textbox', { name: 'Search plugins' }).fill('absent')
  await section.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(section.getByText('No matching plugins', { exact: true })).toBeVisible()
  await expect(section.getByText('No installed plugins', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: `/tmp/TAL-1331-evidence/empty-catalog-${testInfo.project.name}.png` })
})
