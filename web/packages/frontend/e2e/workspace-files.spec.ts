import { symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** TAL-519: the Files page creates, renames, moves and deletes entries in a real synthetic workspace and shows the server's refusals. */
test('the Files page creates, renames, moves and deletes workspace entries', async ({ page, errors }, testInfo) => {
  const created = (await (await page.request.post('/api/session/new', { data: {} })).json()) as { session: { session_id: string } }
  const sid = created.session.session_id
  // Both projects share one server workspace, so each run works in its own folder.
  const root = `tal519-${testInfo.project.name}-${String(Date.now())}`
  expect((await page.request.post('/api/file/create-dir', { data: { session_id: sid, path: root } })).ok()).toBe(true)
  const listing = (await (await page.request.get(`/api/list?session_id=${sid}&path=${root}`)).json()) as { workspace: string }
  expect((await page.request.post('/api/file/create', { data: { session_id: sid, path: `${root}/seed.txt` } })).ok()).toBe(true)
  symlinkSync('seed.txt', join(listing.workspace, root, 'link'))
  // Reveal and Open in VS Code launch desktop apps on the server's machine; record their requests instead.
  const launched: { route: string; path: string }[] = []
  for (const name of ['reveal', 'open-vscode']) {
    await page.route(`**/api/file/${name}`, (route) => {
      const body = route.request().postDataJSON() as { path: string }
      launched.push({ route: name, path: body.path })
      return route.fulfill({ json: { ok: true, path: body.path } })
    })
  }

  await page.goto(`/session/${sid}`)
  if (testInfo.project.name === 'mobile') await page.locator('#btnTitlebarSidePanel').click()
  else await page.getByRole('button', { name: 'Show workspace panel' }).click()
  await page.getByRole('tablist', { name: 'Side panel' }).getByRole('tab', { name: 'Files' }).click()
  const tree = page.getByRole('tree', { name: 'Files' })
  const item = (name: string) => tree.getByRole('treeitem', { name, exact: true })
  const actions = async (name: string, action: string) => {
    await item(name).click({ button: 'right' })
    await page.getByRole('menu').getByRole('menuitem', { name: action }).click()
  }
  await item(root).click()
  await expect(tree.getByRole('treeitem', { name: /^link/ })).toBeVisible()

  await expect(page.getByRole('button', { name: 'New Folder' })).toBeVisible()
  await page.getByRole('button', { name: 'New Folder' }).click()
  await page.getByRole('textbox', { name: 'New folder name:' }).fill('docs')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(item('docs')).toBeVisible()

  await page.getByRole('button', { name: 'New File' }).click()
  await page.getByRole('textbox', { name: 'New file name (e.g. notes.md):' }).fill('notes.md')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(item('notes.md')).toBeVisible()

  // A name that already exists: the dialog stays open with the server's refusal.
  await page.getByRole('button', { name: 'New File' }).click()
  await page.getByRole('textbox', { name: 'New file name (e.g. notes.md):' }).fill('notes.md')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('File already exists')
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()

  await actions('notes.md', 'Rename')
  await page.getByRole('textbox', { name: 'New name:' }).fill('plan.md')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(item('plan.md')).toBeVisible()
  await expect(item('notes.md')).toHaveCount(0)

  await item('plan.md').dragTo(item('docs'))
  await expect(item('plan.md')).toHaveCount(0)
  if (process.env.TAL519_SHOTS) {
    await item('docs').click({ button: 'right' })
    await page.screenshot({ path: `${process.env.TAL519_SHOTS}/menu-${testInfo.project.name}.png` })
    await page.keyboard.press('Escape')
  }
  await item('docs').click()
  await expect(item('plan.md')).toBeVisible()
  await page.getByRole('button', { name: 'Up one level' }).click()

  await actions('docs', 'Reveal in file manager')
  await actions('docs', 'Open in VS Code')
  await expect.poll(() => launched).toEqual([{ route: 'reveal', path: `${root}/docs` }, { route: 'open-vscode', path: `${root}/docs` }])

  // Delete asks first; cancelling keeps the entry.
  await actions('docs', 'Delete')
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText('Delete folder "docs" and all its contents?')
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(item('docs')).toBeVisible()
  // The server refuses to delete a symlink; the panel says so.
  await actions('link', 'Delete')
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Cannot delete a symlinked entry' })).toBeVisible()
  await expect(item('link')).toBeVisible()
  if (process.env.TAL519_SHOTS) await page.screenshot({ path: `${process.env.TAL519_SHOTS}/refusal-${testInfo.project.name}.png` })
  await actions('docs', 'Delete')
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await expect(item('docs')).toHaveCount(0)

  errors.splice(0, errors.length, ...errors.filter((e) => !/400 POST .*\/api\/file\/(create|delete)$|status of 400/.test(e)))
})
