import { expect, test } from './fixtures'

test('toolset selection respects operator policy and saves the draft', async ({ page }, testInfo) => {
  await page.route('**/api/toolsets', (route) => route.fulfill({ json: {
    toolsets: [
      { name: 'file', description: 'Read and write files', available: true, selected: true, unavailable_reason: null },
      { name: 'web', description: 'Search the web', available: true, selected: false, unavailable_reason: null },
      { name: 'todo', description: 'Task lists', available: false, selected: false, unavailable_reason: 'disabled' },
    ], selected_toolsets: ['file'], using_defaults: true,
  } }))
  await page.goto('/')
  await page.locator('#msg').fill('Plan a small project')
  await page.locator('.composer-toolsets-chip').click()
  await expect(page.getByRole('checkbox', { name: /todo/ })).toBeDisabled()
  await expect(page.getByRole('checkbox', { name: 'file', exact: true })).toBeChecked()
  await page.getByRole('checkbox', { name: 'web', exact: true }).check()
  await page.screenshot({ path: testInfo.outputPath(`toolsets-${testInfo.project.name}.png`) })
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.composer-toolsets-chip')).toContainText('file, web')
  await page.locator('.composer-toolsets-chip').click()
  await page.getByRole('button', { name: 'Use profile defaults' }).click()
  await expect(page.locator('.composer-toolsets-chip')).toContainText('Global')
})
