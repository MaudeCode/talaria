import { expect, settle, test } from './fixtures'

/** TAL-685: Settings > Extensions shows an enable switch where the server sets `can_toggle`, including dashboard plugins. */
const row = (over: Record<string, unknown>) => ({
  name: 'Row', source: 'manifest', enabled: false, panel: null, nav: null, capabilities: [], permissions: {}, settings_schema: [],
  theme: null, tts: null, sidecar: null, legacy_injection: false, can_toggle: true, warnings: [], ...over,
})

test('a dashboard plugin row toggles through the extensions toggle; a row the server locks shows no switch', async ({ page }) => {
  let boardEnabled = false
  const toggles: unknown[] = []
  await page.route('**/api/extensions/manifests', (route) => route.fulfill({ json: { protocol_version: 1, manifests: [
    row({ id: 'board', name: 'Board', source: 'plugin', enabled: boardEnabled, panel: 'dashboard-plugins/board/index.html', nav: { label: 'Board' } }),
    row({ id: 'locked', name: 'Locked', can_toggle: false }),
  ] } }))
  await page.route('**/api/extensions/toggle', async (route) => {
    const body = route.request().postDataJSON() as { enabled: boolean }
    toggles.push(body)
    boardEnabled = body.enabled
    await route.fulfill({ json: { enabled: true, extensions: [] } })
  })
  await page.goto('/settings/extensions')
  await settle(page)

  await expect(page.locator('[data-extension-id="locked"]')).toBeVisible()
  await expect(page.locator('[data-extension-id="locked"]').getByRole('switch')).toHaveCount(0)
  const board = page.locator('[data-extension-id="board"]')
  const toggle = board.getByRole('switch', { name: 'Board: Disabled' })
  await expect(toggle).not.toBeChecked()
  await toggle.click()
  await expect.poll(() => toggles).toEqual([{ id: 'board', enabled: true }])
  await expect(board.getByRole('switch', { name: 'Board: Enabled' })).toBeChecked()
  await expect(board.getByRole('link', { name: 'Open' })).toBeVisible()

  await board.getByRole('switch', { name: 'Board: Enabled' }).click()
  await expect.poll(() => toggles).toEqual([{ id: 'board', enabled: true }, { id: 'board', enabled: false }])
  await expect(board.getByRole('switch', { name: 'Board: Disabled' })).not.toBeChecked()
})
