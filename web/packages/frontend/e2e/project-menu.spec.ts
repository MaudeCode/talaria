import type { Page } from '@playwright/test'
import { expect, openChatFilters, openProjectActions, settle, test } from './fixtures'

/** The Chats filter menu selects a project and reaches its rename, recolor and delete, and creates one (TAL-565, TAL-1869). */

const shot = async (page: Page, name: string) => { if (process.env.TAL565_SHOTS) await page.screenshot({ path: `${process.env.TAL565_SHOTS}/${name}.png` }) }
const serverProjects = async (page: Page) => ((await (await page.request.get('/api/projects')).json()) as { projects: { project_id: string; name: string; color?: string | null }[] }).projects
const serverProject = async (page: Page, id: string) => (await serverProjects(page)).find((p) => p.project_id === id)

// Optimistic rows update before their writes reach the server.
const expectServerProject = (page: Page, id: string) => expect.poll(() => serverProject(page, id))

test('the filter menu selects, renames, recolors, creates and deletes projects', async ({ page }, testInfo) => {
  const name = `Alpha ${testInfo.project.name}`
  const created = await page.request.post('/api/projects/create', { data: { name } })
  expect(created.ok()).toBe(true)
  const id = ((await created.json()) as { project: { project_id: string } }).project.project_id

  await page.goto('/')
  await settle(page)
  const hamburger = page.locator('#btnHamburger')
  if (await hamburger.isVisible()) await hamburger.click()
  const detail = page.locator('[data-chats-detail]')
  const row = async (label: string) => (await openChatFilters(page)).getByRole('menuitemradio', { name: label, exact: true })
  const trigger = page.getByRole('button', { name: /^Chat filters/ })

  // Select: the heading names the project and the trigger says it is filtering.
  await expect(detail).toHaveCount(0)
  await expect(trigger).toHaveAccessibleName('Chat filters')
  await (await row(name)).click()
  await expect(detail).toHaveText(name)
  await expect(trigger).toHaveAccessibleName('Chat filters, filtered')
  await shot(page, `filtered-${testInfo.project.name}`)

  // Rename: the dialog saves the new name and the heading follows.
  const menu = await openProjectActions(page)
  await shot(page, `menu-${testInfo.project.name}`)
  await menu.getByRole('menuitem', { name: 'Rename' }).click()
  const dialog = page.getByRole('dialog', { name: 'Rename project' })
  await dialog.getByRole('textbox').fill(`${name} renamed`)
  await shot(page, `rename-${testInfo.project.name}`)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(detail).toHaveText(`${name} renamed`)
  await expectServerProject(page, id).toMatchObject({ name: `${name} renamed` })

  // Recolor: picking a swatch stores it, closes both menus, and the project's row shows it.
  await (await openProjectActions(page)).getByRole('menuitemradio', { name: 'Green' }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect((await row(`${name} renamed`)).locator('.session-project-dot')).toHaveCSS('background-color', 'rgb(80, 200, 120)')
  await page.keyboard.press('Escape')
  await expectServerProject(page, id).toMatchObject({ color: '#50c878' })
  const green = (await openProjectActions(page)).getByRole('menuitemradio', { name: 'Green' })
  await expect(green).toHaveAttribute('aria-checked', 'true')
  // Swatches are touch targets, not just their 16px dots.
  expect((await green.boundingBox())?.width).toBeGreaterThanOrEqual(32)
  await shot(page, `recolored-${testInfo.project.name}`)
  await green.click()
  await expect(page.getByRole('menu')).toHaveCount(0)

  // Keyboard: ArrowRight opens the submenu on its first action, ArrowLeft steps back to its row.
  await trigger.focus()
  await page.keyboard.press('Enter')
  const filters = page.getByRole('menu', { name: /^Chat filters/ })
  const selected = filters.getByRole('menuitem', { name: 'Selected project' })
  await expect.poll(async () => {
    await page.keyboard.press('ArrowDown')
    return selected.evaluate((el) => el === document.activeElement)
  }).toBe(true)
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('menu', { name: 'Selected project' }).getByRole('menuitem', { name: 'New chat' })).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('menu', { name: 'Selected project' })).toHaveCount(0)
  await expect(selected).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)

  // Search: the field leaves the trigger reachable, so a search can change its own scope.
  await page.locator('.sidebar-row', { hasText: 'Search' }).click()
  await expect(page.locator('#sessionSearch')).toBeFocused()
  await (await openChatFilters(page)).getByRole('menuitemradio', { name: 'All' }).click()
  await expect(detail).toHaveCount(0)
  await expect(page.locator('#sessionSearch')).toBeVisible()
  await (await row(`${name} renamed`)).click()
  await expect(detail).toHaveText(`${name} renamed`)

  // New project: the prompt's name is listed and stored.
  const fresh = `Fresh ${testInfo.project.name}`
  page.once('dialog', (prompt) => { void prompt.accept(fresh) })
  await (await openChatFilters(page)).getByRole('menuitem', { name: 'New project' }).click()
  await expect(await row(fresh)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await serverProjects(page)).some((p) => p.name === fresh)).toBe(true)

  // Delete: only after confirmation; a deleted filter falls back to All.
  await (await openProjectActions(page)).getByRole('menuitem', { name: 'Delete' }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText(`Delete project "${name} renamed"?`)
  await shot(page, `delete-confirm-${testInfo.project.name}`)
  await confirm.getByRole('button', { name: 'Delete project' }).click()
  await expect(detail).toHaveCount(0)
  await expect(trigger).toHaveAccessibleName('Chat filters')
  await expect(await row('All')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('menuitemradio', { name: `${name} renamed`, exact: true })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Selected project' })).toHaveCount(0)
  await expectServerProject(page, id).toBeUndefined()
  const keeper = (await serverProjects(page)).find((p) => p.name === fresh)!
  await page.request.post('/api/projects/delete', { data: { project_id: keeper.project_id } })
})
