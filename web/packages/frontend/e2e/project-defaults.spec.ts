import type { Page, TestInfo } from '@playwright/test'
import { ProjectStore } from '../../server/dist/projects.js'
import { JsonDocuments } from '../../server/dist/sessions/storage/json-documents.js'
import { openServerState } from './server'
import { expect, openChatFilters, openProjectActions, settle, test } from './fixtures'

/** A project saves chat defaults, and its New chat starts on them (TAL-1032). */

const shot = async (page: Page, name: string) => { if (process.env.TAL1032_SHOTS) await page.screenshot({ path: `${process.env.TAL1032_SHOTS}/${name}.png` }) }
interface Bound { project_id: string; workspaces?: string[]; default_workspace?: string | null; model?: string | null; model_option_id?: string | null }
const serverProject = async (page: Page, id: string) => ((await (await page.request.get('/api/projects')).json()) as { projects: Bound[] }).projects.find((p) => p.project_id === id)

/**
 * A project of its own with two workspaces of its own, selected in the Chats filter; `saveDefaults` binds both, Deep as
 * the default. A generated hex ID can read as a JSON number; `id` is numeric to prove the URL still carries it bare.
 */
async function boundProject(page: Page, testInfo: TestInfo, id: number, { saveDefaults = false } = {}) {
  const suffix = `${testInfo.project.name}-${String(id)}`
  const projectId = String(id + (testInfo.project.name === 'mobile' ? 0 : 1))
  const projects = new ProjectStore(new JsonDocuments(openServerState()), () => [])
  await projects.mutate((rows) => {
    const project = { project_id: projectId, name: `Bound ${suffix}`, profile: 'default' }
    const at = rows.findIndex((row) => row.project_id === projectId)
    if (at === -1) rows.push(project)
    else rows[at] = project
  }, { migrate: false })
  const home = ((await (await page.request.get('/api/workspaces')).json()) as { workspaces: { path: string }[] }).workspaces[0]!.path
  const add = async (name: string, path: string) => {
    const res = await page.request.post('/api/workspaces/add', { data: { path, name, create: true } })
    expect(res.ok(), await res.text()).toBe(true)
  }
  const alpha = `${home}/alpha-${suffix}`
  const deep = `${home}/a-very-long-directory-name-for-narrow-layouts/${'nested-segment/'.repeat(6)}deep-${suffix}`
  await add(`Alpha ${suffix}`, alpha)
  await add(`Deep ${suffix}`, deep)
  if (saveDefaults) {
    const bound = await page.request.post('/api/projects/bind', { data: { project_id: projectId, workspaces: [alpha, deep], default_workspace: deep } })
    expect(bound.ok(), await bound.text()).toBe(true)
  }

  await page.goto('/')
  await settle(page)
  const hamburger = page.locator('#btnHamburger')
  if (await hamburger.isVisible()) await hamburger.click()
  await (await openChatFilters(page)).getByRole('menuitemradio', { name: `Bound ${suffix}`, exact: true }).click()
  const menuItem = async (name: string) => { await (await openProjectActions(page)).getByRole('menuitem', { name }).click() }
  return { id: projectId, suffix, hamburger, menuItem }
}

/** Opens Chat defaults and drafts both workspaces, Deep as the default, and a catalog model when the fixture catalog offers one. */
async function draftDefaults(page: Page, { suffix, menuItem }: Awaited<ReturnType<typeof boundProject>>) {
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
  await dialog.getByRole('combobox', { name: 'Default model' }).click()
  await expect(page.getByRole('listbox')).toBeVisible()
  const models = page.getByRole('option').filter({ hasNotText: 'Profile default' })
  const modelCount = await models.count()
  if (modelCount) await models.first().click()
  else await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  return { dialog, modelCount }
}

test('a refused Chat defaults save closes at once, then reopens on the draft with the server error', async ({ page, errors }, testInfo) => {
  const project = await boundProject(page, testInfo, 589985371805)
  const { dialog } = await draftDefaults(page, project)
  await page.route('**/api/projects/bind', (route) => route.fulfill({ status: 400, json: { error: 'Synthetic refusal' } }), { times: 1 })
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Synthetic refusal')).toBeVisible()
  await expect(dialog.getByRole('combobox', { name: 'Default workspace' })).toContainText(`Deep ${project.suffix}`)
  await expect(dialog.getByRole('button', { name: `Remove Alpha ${project.suffix}` })).toBeVisible()
  errors.splice(0, errors.length, ...errors.filter((line) => !/400 POST .*\/api\/projects\/bind$|status of 400/.test(line)))
})

test('Chat defaults saves the project defaults and reopens on them', async ({ page }, testInfo) => {
  const project = await boundProject(page, testInfo, 589985371815)
  const { dialog, modelCount } = await draftDefaults(page, project)
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeInViewport()
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeInViewport()
  await shot(page, `defaults-${project.suffix}`)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(async () => (await serverProject(page, project.id))?.default_workspace).toMatch(new RegExp(`deep-${project.suffix}$`))
  const saved = (await serverProject(page, project.id))!
  expect(saved.workspaces).toHaveLength(2)
  if (modelCount) expect(saved.model_option_id).toBeTruthy()

  await project.menuItem('Chat defaults')
  await expect(dialog.getByRole('combobox', { name: 'Default workspace' })).toContainText(`Deep ${project.suffix}`)
})

// The server applying a project's saved model and workspace to the new chat is owned by server projects-bindings.test.ts.
test('a project\'s New chat starts in the project and sends only the project, which the server applies', async ({ page }, testInfo) => {
  const project = await boundProject(page, testInfo, 589985371825, { saveDefaults: true })
  const saved = (await serverProject(page, project.id))!

  await project.menuItem('New chat')
  await expect(page).toHaveURL(new RegExp(`[?&]project=${project.id}`))
  if (await project.hamburger.isVisible()) await page.keyboard.press('Escape')
  // A phone shows the composer chips once the prompt has focus.
  await page.locator('#msg').click()
  await expect(page.locator('#composerWorkspaceChip')).toContainText(`Deep ${project.suffix}`)
  await shot(page, `new-chat-${project.suffix}`)
  const created = page.waitForRequest((req) => req.url().endsWith('/api/session/new') && req.method() === 'POST')
  const response = page.waitForResponse((res) => res.url().endsWith('/api/session/new'))
  await page.locator('#msg').fill('Hello project')
  await page.getByRole('button', { name: 'Send message' }).click()
  const body = (await created).postDataJSON() as Record<string, unknown>
  expect(body).toMatchObject({ project_id: project.id })
  expect(body).not.toHaveProperty('workspace')
  expect(body).not.toHaveProperty('model')
  const session = ((await (await response).json()) as { session: { workspace: string; project_id: string; model: string } }).session
  expect(session).toMatchObject({ project_id: project.id, workspace: saved.default_workspace })
})
