import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

test('a space moves at once while the reorder is held', async ({ page }, info) => {
  let workspaces = [{ path: '/srv/alpha', name: 'Alpha' }, { path: '/srv/beta', name: 'Beta' }, { path: '/srv/gamma', name: 'Gamma' }]
  const gate = Promise.withResolvers<undefined>()
  await page.route(/\/api\/workspaces(\?|$)/, (route) => route.fulfill({ json: { workspaces, last: null } }))
  await page.route('**/api/workspaces/reorder', async (route) => {
    await gate.promise
    const { paths } = route.request().postDataJSON() as { paths: string[] }
    workspaces = paths.map((path) => workspaces.find((w) => w.path === path)!)
    await route.fulfill({ json: { ok: true, workspaces, last: null } })
  })
  try {
    await page.goto('/workspaces')
    await settle(page)
    const names = page.locator('#workspacesPanel li .truncate:not(.font-mono)')
    await expect(names).toHaveText(['Alpha', 'Beta', 'Gamma'])
    await page.locator('#workspacesPanel li', { hasText: 'Gamma' }).getByRole('button', { name: 'Move up' }).click()
    await expect(names).toHaveText(['Alpha', 'Gamma', 'Beta'])
    await expect(page.getByText(/^Pending/)).toHaveCount(0)
    await page.screenshot({ path: info.outputPath(`reorder-${info.project.name}.png`) })
    gate.resolve(undefined)
    await expect(names).toHaveText(['Alpha', 'Gamma', 'Beta'])
  } finally {
    gate.resolve(undefined)
  }
})
