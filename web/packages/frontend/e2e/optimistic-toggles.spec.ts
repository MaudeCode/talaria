import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

// OptimisticToggles.test.tsx owns the shared optimistic toggle (shown at once, never busy, peers usable, rollback) for every
// kind; this browser check owns what jsdom cannot lay out: the extension row's whole-label hit target.
test('an extension flips from its 44 px label at once and stays usable while the write is held', async ({ page }, testInfo) => {
  let release!: () => void
  let started!: () => void
  const held = new Promise<void>((done) => { release = done })
  const writing = new Promise<void>((done) => { started = done })
  let enabled = false
  const names = ['alpha', 'beta']
  await page.route('**/api/extensions/registry', (route) => route.fulfill({ json: { entries: [], total: 0 } }))
  await page.route('**/api/extensions/manifests', (route) => route.fulfill({ json: { protocol_version: 1, total: names.length, enabled_count: enabled ? 1 : 0, manifests: names.map((id) => ({ id, name: id, enabled: id === 'alpha' && enabled, can_toggle: true, source: 'manifest', description: 'Review changes', panel: null, nav: null, capabilities: [], permissions: {}, settings_schema: [], theme: null, tts: null, sidecar: null, legacy_injection: false, warnings: [] })) } }))
  await page.route('**/api/extensions/toggle', async (route) => {
    started()
    await held
    enabled = true
    await route.fulfill({ json: { ok: true, name: 'alpha', enabled: true } })
  })
  await page.goto('/settings/extensions')
  await settle(page)
  const scope = page.locator('[data-section="extensions"]')
  const toggle = scope.getByRole('switch', { name: /^alpha(?:[: ]|$)/ })
  await toggle.scrollIntoViewIfNeeded()
  const label = page.locator('[data-extension-id="alpha"] label')
  expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await label.getByText('Disabled', { exact: true }).click()
  await writing
  try {
    await expect(toggle).toBeChecked()
    await expect(toggle).not.toHaveAttribute('aria-busy', 'true')
    await expect(scope.getByRole('switch', { name: /^beta(?:[: ]|$)/ })).toBeEnabled()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally {
    await page.screenshot({ path: testInfo.outputPath('extension-shown.png'), animations: 'disabled' })
    release()
  }
  await expect(toggle).toBeChecked()
})
