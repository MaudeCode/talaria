import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

test('plugin updates show Agent scan consent and block dangerous revisions', async ({ page }, testInfo) => {
  let updated = false
  let dangerous = false
  const calls: unknown[] = []
  await page.route('**/api/plugins', (route) => route.fulfill({ json: {
    read_only: false,
    plugins: [
      { key: 'weather', name: 'Weather', version: updated ? '2.0.0' : '1.0.0', description: 'Local weather tools', enabled: true, activation: 'enabled', update: { available: !updated, latest_revision: 'new-revision' } },
      { key: 'notes', name: 'Notes', version: '1.0.0', description: 'Read and write project notes', enabled: false, activation: 'disabled' },
    ],
  } }))
  await page.route('**/api/plugins/update', (route) => {
    const body = route.request().postDataJSON() as { key: string; accept_caution: boolean }
    calls.push(body)
    if (dangerous) return route.fulfill({ json: { key: body.key, status: 'blocked', verdict: 'dangerous', findings: 'Security scan blocked this revision. Credential exfiltration in plugin.py:14.' } })
    if (!body.accept_caution) return route.fulfill({ json: { key: body.key, status: 'needs_consent', verdict: 'caution', findings: 'Security scan verdict: caution.\nReview outbound network access in plugin.py:14 before updating.' } })
    updated = true
    return route.fulfill({ json: { key: body.key, status: 'updated' } })
  })
  await page.goto('/settings/plugins')
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
  await expect(section.getByText('v2.0.0', { exact: true })).toBeVisible()
  await expect(section.getByText('Update available', { exact: true })).toHaveCount(0)
  expect(calls).toEqual([{ key: 'weather', accept_caution: false }, { key: 'weather', accept_caution: false }, { key: 'weather', accept_caution: true }])

  updated = false
  dangerous = true
  await page.reload()
  await section.getByRole('button', { name: 'Update', exact: true }).click()
  await expect(section.getByRole('alert')).toContainText('Credential exfiltration')
  await expect(consent).toHaveCount(0)
  await page.screenshot({ path: `/tmp/TAL-1275-evidence/blocked-${testInfo.project.name}.png` })
})
