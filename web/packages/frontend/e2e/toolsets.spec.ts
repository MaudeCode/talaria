import { expect, test } from './fixtures'

test('toolset rows apply at once, group by availability and search by description (TAL-2096)', async ({ page }, testInfo) => {
  // The sidecar's answer for the choice it is read with: `file` is the profile default.
  const toolsets = [
    { name: 'file', description: 'Read and write files', available: true, unavailable_reason: null },
    { name: 'web', description: 'Search the web', available: true, unavailable_reason: null },
    { name: 'research', description: 'Search and read', available: true, unavailable_reason: null, stripped_tools: ['web_search', 'web_extract'], stripped_by: ['search', 'web_tools'] },
    { name: 'todo', description: 'Task lists', available: false, unavailable_reason: 'disabled' },
  ]
  await page.route('**/api/toolsets', (route) => {
    const choice = (route.request().postDataJSON() as { toolsets: string[] | null }).toolsets
    const selected = choice ?? ['file']
    return route.fulfill({ json: { toolsets: toolsets.map((row) => ({ ...row, selected: selected.includes(row.name) })), selected_toolsets: selected, using_defaults: choice === null } })
  })
  await page.goto('/')
  await page.locator('#msg').fill('Plan a small project')
  const chip = page.locator('.composer-toolsets-chip')
  await expect(chip).toHaveText('Profile defaults')
  await chip.click()
  const menu = page.getByRole('menu')
  const row = (name: RegExp) => menu.getByRole('menuitemcheckbox', { name })
  await expect(row(/^Use profile defaults$/)).toHaveAttribute('aria-checked', 'true')
  await expect(menu.getByRole('group', { name: 'Not available' }).getByRole('menuitemcheckbox', { name: /^todo/ })).toHaveAttribute('aria-disabled', 'true')
  await expect(row(/^research/)).toContainText('Missing web_search, web_extract (disabled by search, web_tools)')
  await expect(row(/^file/)).toHaveAttribute('aria-checked', 'true')
  // The only selected toolset stays selected.
  await expect(row(/^file/)).toHaveAttribute('aria-disabled', 'true')
  await row(/^web/).click()
  // The choice applies at once and the menu stays open for the next one.
  await expect(chip).toHaveText('2 toolsets')
  await expect(chip).toHaveAttribute('title', 'Session toolsets: file, web')
  await expect(row(/^web/)).toHaveAttribute('aria-checked', 'true')
  await expect(row(/^Use profile defaults$/)).toHaveAttribute('aria-checked', 'false')
  const settled = () => menu.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))))
  await settled()
  await page.screenshot({ path: process.env.TAL2096_SHOTS ? `${process.env.TAL2096_SHOTS}/toolsets-${testInfo.project.name}.png` : testInfo.outputPath(`toolsets-${testInfo.project.name}.png`) })
  await menu.getByRole('searchbox', { name: 'Search toolsets' }).fill('TASK')
  await expect(menu.getByRole('menuitemcheckbox')).toHaveText(['Use profile defaults', /^todo/])
  await settled()
  await page.screenshot({ path: process.env.TAL2096_SHOTS ? `${process.env.TAL2096_SHOTS}/toolsets-search-${testInfo.project.name}.png` : testInfo.outputPath(`toolsets-search-${testInfo.project.name}.png`) })
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await chip.click()
  await row(/^Use profile defaults$/).click()
  await expect(chip).toHaveText('Profile defaults')
})
