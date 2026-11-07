import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ConnectorsPage } from '@maudecode/talaria-web-contracts'
import type { Locator, Page } from '@playwright/test'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** TAL-1159: workspace, profile and connector-account rows offer their buttons' actions on right-click. */

const desktopOnly = (project: string) => { test.skip(project !== 'desktop', 'right-click is the desktop route') }
const rowMenu = (page: Page, name: string) => page.getByRole('menu', { name })
const items = (menu: Locator) => menu.getByRole('menuitem')

test('a workspace row offers its buttons, with the same disabled ends, and Rename runs from the menu', async ({ page }, info) => {
  desktopOnly(info.project.name)
  let workspaces = [{ path: '/srv/alpha', name: 'Alpha' }, { path: '/srv/beta', name: 'Beta' }]
  const renames: unknown[] = []
  await page.route(/\/api\/workspaces(\?|$)/, (route) => route.fulfill({ json: { workspaces, last: null } }))
  await page.route('**/api/workspaces/rename', async (route) => {
    const write = route.request().postDataJSON() as { path: string; name: string }
    renames.push(write)
    workspaces = workspaces.map((w) => w.path === write.path ? { ...w, name: write.name } : w)
    await route.fulfill({ json: { ok: true, workspaces, last: null } })
  })
  await page.goto('/workspaces')
  await settle(page)

  const menu = rowMenu(page, 'Workspace actions')
  const row = (name: string) => page.locator('#workspacesPanel li', { hasText: name })
  await row('Beta').click({ button: 'right' })
  await expect(items(menu)).toHaveText(['Move up', 'Move down', 'Rename', 'Remove'])
  await expect(menu.getByRole('menuitem', { name: 'Move up' })).toBeEnabled()
  await expect(menu.getByRole('menuitem', { name: 'Move down' })).toBeDisabled()
  await page.screenshot({ path: info.outputPath('workspace-menu-desktop.png') })
  await page.keyboard.press('Escape')

  await row('Alpha').click({ button: 'right' })
  await expect(menu.getByRole('menuitem', { name: 'Move up' })).toBeDisabled()
  await expect(menu.getByRole('menuitem', { name: 'Move down' })).toBeEnabled()
  await menu.getByRole('menuitem', { name: 'Rename' }).click()

  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox').fill('Alpha renamed')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(row('Alpha renamed')).toBeVisible()
  await expect.poll(() => renames).toEqual([{ path: '/srv/alpha', name: 'Alpha renamed' }])
})

test('a profile row offers Delete only when its button shows, and Delete keeps its confirmation', async ({ page }, info) => {
  desktopOnly(info.project.name)
  const session = { tip_session_id: 'bot-chat' }
  await page.route('**/api/profiles', (route) => route.fulfill({ json: { active: 'work', profiles: [
    { name: 'default', is_default: true },
    { name: 'work', canonical_session: session },
    { name: 'research', canonical_session: session },
  ] } }))
  const deletes: unknown[] = []
  await page.route('**/api/profile/delete', async (route) => { deletes.push(route.request().postDataJSON()); await route.fulfill({ json: { ok: true } }) })
  await page.goto('/profiles')
  await settle(page)

  const menu = rowMenu(page, 'Profile actions')
  const row = (name: string) => page.locator(`[data-profile="${name}"]`)
  await row('work').click({ button: 'right' })
  await expect(items(menu)).toHaveText(['Open Bot Chat'])
  await page.keyboard.press('Escape')
  await row('default').click({ button: 'right' })
  await expect(items(menu)).toHaveText(['Use'])
  await page.keyboard.press('Escape')

  await row('research').click({ button: 'right' })
  await expect(items(menu)).toHaveText(['Open Bot Chat', 'Use', 'Delete this profile'])
  await page.screenshot({ path: info.outputPath('profile-menu-desktop.png') })
  await menu.getByRole('menuitem', { name: 'Delete this profile' }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toBeVisible()
  expect(deletes).toEqual([])
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect.poll(() => deletes).toEqual([{ name: 'research' }])
})

test('a connector account disconnects from its menu through the confirmation', async ({ page }, info) => {
  desktopOnly(info.project.name)
  const shared = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts/fixtures/connectors.json'), 'utf8')) as { page: ConnectorsPage }
  await page.route('**/api/connectors/available', (route) => route.fulfill({ json: { available: true } }))
  await page.route('**/api/connectors', (route) => route.fulfill({ json: shared.page }))
  const removals: unknown[] = []
  await page.route('**/api/connectors/accounts/*', async (route) => { removals.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`); await route.fulfill({ json: { ok: true } }) })
  await page.goto('/settings/connectors')
  await settle(page)

  const accounts = page.getByRole('list', { name: 'Notion accounts' })
  await accounts.getByRole('listitem').filter({ hasText: 'work' }).click({ button: 'right' })
  const menu = rowMenu(page, 'Account actions')
  await expect(items(menu)).toHaveText(['Disconnect'])
  await page.screenshot({ path: info.outputPath('connector-account-menu-desktop.png') })
  await menu.getByRole('menuitem', { name: 'Disconnect' }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toBeVisible()
  expect(removals).toEqual([])
  await confirm.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect.poll(() => removals).toEqual(['DELETE /api/connectors/accounts/new'])
})
