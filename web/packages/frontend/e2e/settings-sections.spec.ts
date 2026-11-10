import { expect, settle, test } from './fixtures'

/**
 * TAL-1691, TAL-2100: a retired section URL lands on the section (and Tools tab) that took its settings, replacing the
 * old entry. Covers every retired id, including the pre-TAL-1691 ones.
 */
const MOVED = [
  ['sidebar', 'navigation'], ['preferences', 'navigation'], ['conversation', 'chat'], ['auxiliary', 'models'], ['help', 'about'],
  ['agent', 'tools'], ['agent?tab=plugins', 'tools?tab=plugins'], ['agent?tab=connectors', 'tools?tab=connectors'], ['agent?tab=mcp', 'tools?tab=mcp'],
  ['agent?tab=extensions', 'extensions'], ['plugins', 'tools?tab=plugins'], ['connectors', 'tools?tab=connectors'],
] as const

for (const [old, target] of MOVED) {
  test(`/settings/${old} redirects to /settings/${target}`, async ({ page }) => {
    await page.route('**/api/connectors/available', (route) => route.fulfill({ json: { available: true } }))
    await page.goto('/settings/appearance')
    await settle(page)
    await page.goto(`/settings/${old}`)
    await expect(page).toHaveURL((url) => `${url.pathname}${url.search}` === `/settings/${target}`)
    await expect(page.locator(`[data-section="${target.split('?')[0]}"]`)).toBeVisible()
    if (target.includes('?tab=')) await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('aria-controls', `tools-${target.split('=')[1]}`)
    // `replace`: Back skips the retired URL and returns to the page before it.
    await page.goBack()
    await expect(page).toHaveURL(/\/settings\/appearance$/)
    await settle(page)
  })
}

test('/settings/system still opens Updates, the update notification\'s settings.system destination', async ({ page }) => {
  await page.goto('/settings/system')
  await expect(page).toHaveURL(/\/settings\/system$/)
  await expect(page.locator('[data-section="system"]')).toBeVisible()
  await expect(page.locator('[data-group="updates"]')).toBeVisible()
})

test('a Tools tab keeps its list in the URL', async ({ page }) => {
  await page.goto('/settings/tools')
  await settle(page)
  await page.getByRole('tablist', { name: 'Tools' }).getByRole('tab', { name: 'MCP Servers' }).click()
  await expect(page).toHaveURL(/\/settings\/tools\?tab=mcp$/)
  await expect(page.locator('[data-section="mcp-servers"]')).toBeVisible()
})

test('the Settings menu groups its sections by scope, naming the active profile (TAL-2100)', async ({ page }, info) => {
  let active = 'default'
  const listed = () => ({ active, profiles: [{ name: 'default', is_default: true }, { name: 'research' }] })
  await page.route('**/api/profiles', (route) => route.fulfill({ json: listed() }))
  await page.goto('/settings/appearance')
  await settle(page)
  const groups = page.locator('#settingsMenu [data-settings-group]')
  await expect(groups).toHaveCount(3)
  const menu = await groups.evaluateAll((nodes) => nodes.map((group) => [group.querySelector('h3')?.textContent, [...group.querySelectorAll('[data-settings-section]')].map((link) => link.getAttribute('data-settings-section'))]))
  expect(menu).toEqual([
    ['Interface', ['appearance', 'chat', 'navigation', 'notifications', 'speech']],
    ['Profile', ['models', 'providers', 'tools']],
    ['Server', ['profiles', 'workspaces', 'extensions', 'access', 'system', 'logs', 'about']],
  ])
  const profile = page.locator('#settingsMenu [data-settings-group="profile"]')
  await expect(profile).toContainText('default')
  // TAL-2085: the header's profile name opens that profile's detail; on a phone the menu is in the drawer.
  if (info.project.name === 'mobile') await page.locator('#btnHamburger').click()
  await profile.getByRole('link', { name: 'default', exact: true }).click()
  await expect(page).toHaveURL(/\/settings\/profiles\?name=default$/)
  await expect(page.locator('[data-profile-detail="default"]')).toBeVisible()
  // TAL-2099: switching profile from its detail page happens in place; the header then names the new profile.
  await page.route('**/api/profile/switch', (route) => { active = 'research'; return route.fulfill({ json: { ...listed(), is_default: false, default_model: null, default_model_provider: null, default_workspace: null } }) })
  await page.goto('/settings/profiles')
  await settle(page)
  await page.locator('[data-profile="research"]').getByRole('link', { name: 'research' }).click()
  await page.locator('[data-profile-detail="research"]').getByRole('button', { name: 'Use' }).click()
  await expect(profile).toContainText('research')
  await page.goto('/settings/appearance')
  await settle(page)
  await expect(profile).toContainText('research')
})

test('Profiles, Spaces and Logs live in Settings under Server, and their old URLs redirect there (TAL-2101)', async ({ page }) => {
  // TAL-2139: Logs' Copy sits in the section heading, like the other pages' actions.
  for (const [section, heading, action, actionHome] of [['profiles', 'Profiles', 'Create profile', '.settings-section-head'], ['workspaces', 'Spaces', 'Add workspace', '.settings-section-head'], ['logs', 'Logs', 'Copy', '.settings-section-head']] as const) {
    await page.goto('/')
    await settle(page)
    await page.goto(`/${section}?from=bookmark`)
    await expect(page, section).toHaveURL(new RegExp(`/settings/${section}\\?from=bookmark$`))
    await expect(page.locator('#settingsMenu [aria-current="page"]'), section).toHaveAttribute('data-settings-section', section)
    // One heading, from Settings, and the page's own action.
    await expect(page.locator('#main h1'), section).toHaveText([heading])
    await expect(page.locator(`#main ${actionHome}`).getByRole('button', { name: action }), section).toBeVisible()
    // The redirect replaces the old entry, so Back returns to the page before it.
    await page.goBack()
    await expect(page, section).toHaveURL(/\/$/)
  }
})
