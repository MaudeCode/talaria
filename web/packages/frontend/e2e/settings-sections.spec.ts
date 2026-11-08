import { expect, settle, test } from './fixtures'

/** TAL-1691: a retired section URL lands on the section (and Agent tab) that took its settings, replacing the old entry. */
const MOVED = [['preferences', 'sidebar'], ['conversation', 'chat'], ['providers', 'models'], ['auxiliary', 'models'], ['plugins', 'agent?tab=plugins'], ['extensions', 'agent?tab=extensions'], ['connectors', 'agent?tab=connectors'], ['help', 'about']] as const

for (const [old, target] of MOVED) {
  test(`/settings/${old} redirects to /settings/${target}`, async ({ page }) => {
    await page.route('**/api/connectors/available', (route) => route.fulfill({ json: { available: true } }))
    await page.goto(`/settings/${old}`)
    await expect(page).toHaveURL((url) => `${url.pathname}${url.search}` === `/settings/${target}`)
    await expect(page.locator(`[data-section="${target.split('?')[0]}"]`)).toBeVisible()
    if (target.includes('?tab=')) await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('aria-controls', `agent-${target.split('=')[1]}`)
    await settle(page)
  })
}

test('/settings/system still opens System, the App\'s settings.system destination', async ({ page }) => {
  await page.goto('/settings/system')
  await expect(page).toHaveURL(/\/settings\/system$/)
  await expect(page.locator('[data-section="system"]')).toBeVisible()
})

test('an Agent tab keeps its list in the URL', async ({ page }) => {
  await page.goto('/settings/agent')
  await settle(page)
  await page.getByRole('tablist', { name: 'Agent' }).getByRole('tab', { name: 'MCP Servers' }).click()
  await expect(page).toHaveURL(/\/settings\/agent\?tab=mcp$/)
  await expect(page.locator('[data-section="mcp-servers"]')).toBeVisible()
})
