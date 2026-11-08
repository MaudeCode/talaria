import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

test('plugin updates show Agent scan consent and block dangerous revisions', async ({ page }, testInfo) => {
  let updated = false
  let dangerous = false
  let renewedConsent = false
  const calls: unknown[] = []
  await page.route('**/api/plugins', (route) => route.fulfill({ json: {
    read_only: false,
    plugins: [
      { key: 'weather', name: 'Weather', version: updated ? '2.0.0' : '1.0.0', description: 'Local weather tools', enabled: true, activation: 'enabled', update: { available: !updated, latest_revision: 'new-revision' } },
      { key: 'notes', name: 'Notes', version: '1.0.0', description: 'Read and write project notes', enabled: false, activation: 'disabled' },
    ],
  } }))
  await page.route('**/api/plugins/update', (route) => {
    const body = route.request().postDataJSON() as { key: string; accept_caution: boolean; consent_token?: string }
    calls.push(body)
    if (dangerous) return route.fulfill({ json: { key: body.key, status: 'blocked', verdict: 'dangerous', findings: 'Security scan blocked this revision. Credential exfiltration in plugin.py:14.' } })
    if (!body.accept_caution) return route.fulfill({ json: { key: body.key, status: 'needs_consent', verdict: 'caution', findings: 'Security scan verdict: caution.\nReview outbound network access in plugin.py:14 before updating.', consent_token: 'synthetic-consent' } })
    expect(body.consent_token).toBe(renewedConsent ? 'renewed-consent' : 'synthetic-consent')
    if (!renewedConsent) {
      renewedConsent = true
      return route.fulfill({ json: { key: body.key, status: 'needs_consent', verdict: 'caution', findings: 'The scan findings changed. Review this revision again.', consent_token: 'renewed-consent' } })
    }
    updated = true
    return route.fulfill({ json: { key: body.key, status: 'updated' } })
  })
  await page.goto('/settings/agent')
  await settle(page)
  const section = page.locator('[data-section="plugins"]')
  await expect(section.getByText(/^Weather/)).toBeVisible()
  if (process.env.TALARIA_PLUGIN_BEFORE === '1') {
    await page.screenshot({ path: `/tmp/TAL-1275-evidence/before-${testInfo.project.name}.png` })
    return
  }
  await expect(section.getByText('Update available', { exact: true })).toBeVisible()
  await expect(section.getByRole('button', { name: 'Update', exact: true })).toHaveCount(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: `/tmp/TAL-1275-evidence/after-${testInfo.project.name}.png` })
  await section.getByRole('button', { name: 'Update', exact: true }).click()
  const consent = page.getByRole('alertdialog')
  await expect(consent).toContainText('Review outbound network access')
  await page.screenshot({ path: `/tmp/TAL-1275-evidence/consent-${testInfo.project.name}.png` })
  await consent.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(calls).toEqual([{ key: 'weather', accept_caution: false }])
  await section.getByRole('button', { name: 'Update', exact: true }).click()
  await consent.getByRole('button', { name: 'Update', exact: true }).click()
  await expect(consent).toContainText('The scan findings changed')
  await consent.getByRole('button', { name: 'Update', exact: true }).click()
  await expect(section.getByText('v2.0.0', { exact: true })).toBeVisible()
  await expect(section.getByText('Update available', { exact: true })).toHaveCount(0)
  expect(calls).toEqual([{ key: 'weather', accept_caution: false }, { key: 'weather', accept_caution: false }, { key: 'weather', accept_caution: true, consent_token: 'synthetic-consent' }, { key: 'weather', accept_caution: true, consent_token: 'renewed-consent' }])

  updated = false
  dangerous = true
  await page.reload()
  await section.getByRole('button', { name: 'Update', exact: true }).click()
  await expect(section.getByRole('alert')).toContainText('Credential exfiltration')
  await expect(consent).toHaveCount(0)
  await page.screenshot({ path: `/tmp/TAL-1275-evidence/blocked-${testInfo.project.name}.png` })
})

test('TAL-1829: a long update reason stays on its plugin row without widening the page', async ({ page }, testInfo) => {
  const reason = `the dependency environment no longer builds with it: ${'no-solution-for-synthetic-package=='.repeat(8)}`
  await page.route('**/api/plugins', (route) => route.fulfill({ json: {
    read_only: false,
    plugins: [
      { key: 'weather', name: 'Weather', version: '1.0.0', description: 'Local weather tools', enabled: false, activation: 'disabled', disabled_reason: { kind: 'update', reason } },
      { key: 'notes', name: 'Notes', version: '1.0.0', description: 'Read and write project notes', enabled: false, activation: 'disabled' },
    ],
  } }))
  await page.goto('/settings/agent')
  await settle(page)
  const section = page.locator('[data-section="plugins"]')
  await expect(section.locator('li', { hasText: 'Weather' })).toContainText('Turned off by the last update: the dependency environment no longer builds with it')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath(`after-${testInfo.project.name}.png`) })
})

test('TAL-1914: the switch, Update all and a behind catalog row work and fit the page', async ({ page }) => {
  let autoApply = false
  let updated = false
  const sha = 'b'.repeat(40)
  await page.route('**/api/plugins', (route) => route.fulfill({ json: {
    read_only: false,
    auto_update: { auto_apply: autoApply, check_hours: 24, inactive_reason: null },
    plugins: [
      { key: 'weather', name: 'Weather', version: updated ? '2.0.0' : '1.0.0', description: 'Local weather tools', enabled: true, activation: 'enabled', update: { available: !updated, latest_revision: sha } },
      { key: 'notes', name: 'Notes', version: '1.0.0', description: 'Read and write project notes', enabled: false, activation: 'disabled' },
    ],
  } }))
  await page.route('**/api/plugins/catalog?*', (route) => route.fulfill({ json: { supported: true, read_only: false, total: 1, next_offset: null, entries: [
    { name: 'weather-catalog', title: 'Weather', description: 'Local weather tools', repo: 'https://example.invalid/plugins/weather', sha, tier: 'verified', category: 'tools', requirements: [], installed_key: 'weather', installed_sha: 'a'.repeat(40), can_install: false, refusal: null, can_update: !updated },
  ] } }))
  await page.route('**/api/plugins/auto-update', (route) => {
    const body = route.request().postDataJSON() as { enabled: boolean }
    autoApply = body.enabled
    return route.fulfill({ json: { auto_apply: autoApply, check_hours: 24, inactive_reason: null } })
  })
  await page.route('**/api/plugins/update-all', (route) => route.fulfill({ json: { current: 1, results: [
    { name: 'notes', status: 'current', detail: '' },
    { name: 'weather', status: 'needs_review', detail: `Updating 'weather' to bbbbbbbb adds tools: ${'synthetic_forecast_tool, '.repeat(6)}. Confirm to continue.` },
  ] } }))
  await page.route('**/api/plugins/update', (route) => {
    const body = route.request().postDataJSON() as { key: string; accept_caution: boolean; consent_token?: string }
    if (!body.accept_caution) return route.fulfill({ json: { key: body.key, status: 'needs_consent', verdict: 'widened', findings: "Updating 'weather' to bbbbbbbb adds tools: forecast. Confirm to continue.", consent_token: 'synthetic-consent' } })
    expect(body.consent_token).toBe('synthetic-consent')
    updated = true
    return route.fulfill({ json: { key: body.key, status: 'updated' } })
  })
  await page.goto('/settings/agent')
  await settle(page)
  const section = page.locator('[data-section="plugins"]')
  const toggle = section.getByRole('switch', { name: 'Auto-update' })

  await toggle.click()
  await expect(toggle).toBeChecked()
  await expect(section.getByText('Every 24 h', { exact: true })).toBeVisible()
  await expect.poll(() => autoApply).toBe(true)

  await section.getByRole('button', { name: 'Update all', exact: true }).click()
  const results = section.getByRole('list', { name: 'Update all results' })
  await expect(results.getByRole('listitem').nth(1)).toContainText('Needs review')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  await section.getByRole('button', { name: 'Catalog', exact: true }).click()
  const catalog = section.getByRole('region', { name: 'Catalog' })
  await catalog.getByRole('button', { name: 'Update', exact: true }).click()
  const consent = page.getByRole('alertdialog')
  await expect(consent).toContainText('adds tools: forecast')
  await consent.getByRole('button', { name: 'Update', exact: true }).click()
  await expect(section.getByText('v2.0.0', { exact: true })).toBeVisible()
  await expect(catalog.getByRole('button', { name: 'Update', exact: true })).toHaveCount(0)
})
