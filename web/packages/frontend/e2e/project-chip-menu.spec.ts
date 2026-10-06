import type { Page } from '@playwright/test'
import { expect, settle, test } from './fixtures'

/** A sidebar project chip renames, recolors and deletes its project through a context menu (TAL-565). */

const shot = async (page: Page, name: string) => { if (process.env.TAL565_SHOTS) await page.screenshot({ path: `${process.env.TAL565_SHOTS}/${name}.png` }) }
const serverProject = async (page: Page, id: string) => ((await (await page.request.get('/api/projects')).json()) as { projects: { project_id: string; name: string; color?: string | null }[] }).projects.find((p) => p.project_id === id)

test('a project chip renames, recolors and deletes its project', async ({ page }, testInfo) => {
  const name = `Alpha ${testInfo.project.name}`
  const created = await page.request.post('/api/projects/create', { data: { name } })
  expect(created.ok()).toBe(true)
  const id = ((await created.json()) as { project: { project_id: string } }).project.project_id
  // A second project keeps the filter bar on screen after the delete.
  const keeper = ((await (await page.request.post('/api/projects/create', { data: { name: `Keep ${testInfo.project.name}` } })).json()) as { project: { project_id: string } }).project.project_id

  await page.goto('/')
  await settle(page)
  const hamburger = page.locator('#btnHamburger')
  if (await hamburger.isVisible()) await hamburger.click()
  const bar = page.locator('.project-bar')
  const chip = (label: string) => bar.getByRole('button', { name: label, exact: true })
  const openMenu = async (label: string) => {
    await chip(label).click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Project actions' })
    await expect(menu).toBeVisible()
    return menu
  }

  // Rename: the dialog saves the new name and the chip follows.
  const menu = await openMenu(name)
  await shot(page, `menu-${testInfo.project.name}`)
  await menu.getByRole('menuitem', { name: 'Rename' }).click()
  const dialog = page.getByRole('dialog', { name: 'Rename project' })
  await dialog.getByRole('textbox').fill(`${name} renamed`)
  await shot(page, `rename-${testInfo.project.name}`)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(chip(`${name} renamed`)).toBeVisible()
  await expect(chip(name)).toHaveCount(0)
  expect((await serverProject(page, id))?.name).toBe(`${name} renamed`)

  // Recolor: picking a swatch stores it and the chip's dot shows it.
  await (await openMenu(`${name} renamed`)).getByRole('menuitemradio', { name: 'Green' }).click()
  await expect(chip(`${name} renamed`).locator('.color-dot')).toHaveCSS('background-color', 'rgb(80, 200, 120)')
  expect((await serverProject(page, id))?.color).toBe('#50c878')
  const green = (await openMenu(`${name} renamed`)).getByRole('menuitemradio', { name: 'Green' })
  await expect(green).toHaveAttribute('aria-checked', 'true')
  await shot(page, `recolored-${testInfo.project.name}`)
  await green.click()
  await expect(page.getByRole('menu')).toHaveCount(0)

  // Delete: only after confirmation; a deleted filter falls back to All.
  await chip(`${name} renamed`).click()
  await expect(chip(`${name} renamed`)).toHaveClass(/active/)
  await (await openMenu(`${name} renamed`)).getByRole('menuitem', { name: 'Delete' }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText(`Delete project "${name} renamed"?`)
  await shot(page, `delete-confirm-${testInfo.project.name}`)
  await confirm.getByRole('button', { name: 'Delete project' }).click()
  await expect(chip(`${name} renamed`)).toHaveCount(0)
  await expect(chip('All')).toHaveClass(/active/)
  expect(await serverProject(page, id)).toBeUndefined()
  await page.request.post('/api/projects/delete', { data: { project_id: keeper } })
})
