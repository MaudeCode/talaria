import { expect, settle, test } from './fixtures'

/** TAL-611: Settings > Extensions renders an extension's settings_schema as a form and saves it where the extension reads it. */
const tuner = {
  id: 'tuner', name: 'Tuner', source: 'manifest', enabled: true, panel: null, nav: null, capabilities: ['settings'], permissions: { storage: true },
  settings_schema: [
    { key: 'show_badge', type: 'boolean', label: 'Show badge', description: '', default: false },
    { key: 'refresh', type: 'integer', label: 'Refresh seconds', description: '', default: 30 },
    { key: 'mode', type: 'enum', label: 'Mode', description: '', default: 'fast', options: [{ value: 'fast', label: 'Fast' }, { value: 'thorough', label: 'Thorough' }] },
    { key: 'greeting', type: 'string', label: 'Greeting', description: 'Shown on the panel.', default: 'hi' },
  ],
  theme: null, tts: null, sidecar: null, legacy_injection: false, can_toggle: true, warnings: [],
}
const KEY = 'hermes.ext.settings.tuner'

test('an extension settings schema renders all four input types and saves values', async ({ page }) => {
  await page.route('**/api/extensions/manifests', (route) => route.fulfill({ json: { protocol_version: 1, manifests: [tuner] } }))
  await page.goto('/settings/extensions')
  await settle(page)
  const row = page.locator('[data-extension-id="tuner"]')
  const badge = row.getByRole('switch', { name: 'Show badge' })
  const refresh = row.getByRole('spinbutton', { name: 'Refresh seconds' })
  const mode = row.getByRole('combobox', { name: 'Mode' })
  const greeting = row.getByRole('textbox', { name: 'Greeting' })
  await expect(badge).not.toBeChecked()
  await expect(refresh).toHaveValue('30')
  await expect(mode).toHaveText(/Fast/)
  await expect(greeting).toHaveValue('hi')

  await badge.click()
  await refresh.fill('45')
  await mode.click()
  await page.getByRole('option', { name: 'Thorough' }).click()
  await greeting.fill('hello')
  await expect.poll(() => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), KEY))
    .toEqual({ show_badge: true, refresh: 45, mode: 'thorough', greeting: 'hello' })
  // A value the schema rejects (a fraction in an integer field, or blank) is flagged, then shows the saved value again.
  await refresh.fill('4.5')
  await expect(refresh).toHaveAttribute('aria-invalid', 'true')
  await refresh.blur()
  await expect(refresh).toHaveValue('45')
  await refresh.fill('')
  await refresh.blur()
  await expect(refresh).toHaveValue('45')
  await expect(refresh).not.toHaveAttribute('aria-invalid', 'true')

  await page.reload()
  await settle(page)
  await expect(badge).toBeChecked()
  await expect(refresh).toHaveValue('45')
  await expect(mode).toHaveText(/Thorough/)
  await expect(greeting).toHaveValue('hello')
})
