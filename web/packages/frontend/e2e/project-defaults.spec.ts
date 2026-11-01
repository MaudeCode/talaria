import type { Page } from '@playwright/test'
import { expect, settle, test } from './fixtures'

/** A project saves chat defaults, and its New chat starts on them (TAL-1032). */

const shot = async (page: Page, name: string) => { if (process.env.TAL1032_SHOTS) await page.screenshot({ path: `${process.env.TAL1032_SHOTS}/${name}.png` }) }
interface Bound { project_id: string; workspaces?: string[]; default_workspace?: string | null; model?: string | null; model_option_id?: string | null }
const serverProject = async (page: Page, id: string) => ((await (await page.request.get('/api/projects')).json()) as { projects: Bound[] }).projects.find((p) => p.project_id === id)

test('a project saves chat defaults and its new chat starts on them', async ({ page, errors }, testInfo) => {
  const suffix = testInfo.project.name
  const id = ((await (await page.request.post('/api/projects/create', { data: { name: `Bound ${suffix}` } })).json()) as { project: { project_id: string } }).project.project_id
  const home = ((await (await page.request.get('/api/workspaces')).json()) as { workspaces: { path: string }[] }).workspaces[0]!.path
  const add = async (name: string, path: string) => {
    const res = await page.request.post('/api/workspaces/add', { data: { path, name, create: true } })
    expect(res.ok(), await res.text()).toBe(true)
  }
  const alpha = `${home}/alpha-${suffix}`
  const deep = `${home}/a-very-long-directory-name-for-narrow-layouts/${'nested-segment/'.repeat(6)}deep-${suffix}`
  await add(`Alpha ${suffix}`, alpha)
  await add(`Deep ${suffix}`, deep)

  await page.goto('/')
  await settle(page)
  const hamburger = page.locator('#btnHamburger')
  if (await hamburger.isVisible()) await hamburger.click()
  const chip = page.locator('.project-bar').getByRole('button', { name: `Bound ${suffix}`, exact: true })
  const menuItem = async (name: string) => {
    await chip.click({ button: 'right' })
    await page.getByRole('menu', { name: 'Project actions' }).getByRole('menuitem', { name }).click()
  }

  await menuItem('Chat defaults')
  const dialog = page.getByRole('dialog', { name: 'Chat defaults' })
  const pick = async (label: string, option: string | RegExp) => {
    await dialog.getByRole('combobox', { name: label }).click()
    await page.getByRole('option', { name: option }).first().click()
    await expect(page.getByRole('listbox')).toHaveCount(0)
  }
  await pick('Add workspace', `Alpha ${suffix}`)
  await pick('Add workspace', `Deep ${suffix}`)
  await pick('Default workspace', `Deep ${suffix}`)
  // Pick a catalog model when the fixture catalog offers one.
  await dialog.getByRole('combobox', { name: 'Default model' }).click()
  await expect(page.getByRole('listbox')).toBeVisible()
  const models = page.getByRole('option').filter({ hasNotText: 'Profile default' })
  const modelCount = await models.count()
  if (modelCount) await models.first().click()
  else await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeInViewport()
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeInViewport()
  await shot(page, `defaults-${suffix}`)
  // A refused save closes at once, then reopens on the draft with the server's error.
  await page.route('**/api/projects/bind', (route) => route.fulfill({ status: 400, json: { error: 'Synthetic refusal' } }), { times: 1 })
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Synthetic refusal')).toBeVisible()
  await expect(dialog.getByRole('combobox', { name: 'Default workspace' })).toContainText(`Deep ${suffix}`)
  await expect(dialog.getByRole('button', { name: `Remove Alpha ${suffix}` })).toBeVisible()
  errors.splice(0, errors.length, ...errors.filter((line) => !/400 POST .*\/api\/projects\/bind$|status of 400/.test(line)))
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(async () => (await serverProject(page, id))?.default_workspace).toMatch(new RegExp(`deep-${suffix}$`))
  const saved = (await serverProject(page, id))!
  expect(saved.workspaces).toHaveLength(2)
  if (modelCount) expect(saved.model_option_id).toBeTruthy()

  // Reopen: the editor shows the saved defaults.
  await menuItem('Chat defaults')
  await expect(dialog.getByRole('combobox', { name: 'Default workspace' })).toContainText(`Deep ${suffix}`)
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  // New chat starts in the project on its defaults; only the project goes to the server, which applies them.
  await menuItem('New chat')
  await expect(page).toHaveURL(new RegExp(`[?&]project=${id}`))
  if (await hamburger.isVisible()) await page.keyboard.press('Escape')
  // A phone shows the composer chips once the prompt has focus.
  await page.locator('#msg').click()
  await expect(page.locator('#composerWorkspaceChip')).toContainText(`Deep ${suffix}`)
  await shot(page, `new-chat-${suffix}`)
  const created = page.waitForRequest((req) => req.url().endsWith('/api/session/new') && req.method() === 'POST')
  const response = page.waitForResponse((res) => res.url().endsWith('/api/session/new'))
  await page.locator('#msg').fill('Hello project')
  await page.getByRole('button', { name: 'Send message' }).click()
  const body = (await created).postDataJSON() as Record<string, unknown>
  expect(body).toMatchObject({ project_id: id })
  expect(body).not.toHaveProperty('workspace')
  expect(body).not.toHaveProperty('model')
  const session = ((await (await response).json()) as { session: { workspace: string; project_id: string; model: string } }).session
  expect(session).toMatchObject({ project_id: id, workspace: saved.default_workspace })
  if (saved.model) expect(session.model).toBe(saved.model)
})
