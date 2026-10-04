import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** TAL-519: the Files page creates, renames, moves and deletes entries in a real synthetic workspace and shows the server's refusals. */
test('the Files page creates, renames, moves and deletes workspace entries', async ({ page, errors }, testInfo) => {
  // The test owns its workspace: the server's default one sits under /dev/shm on Linux CI, which the server refuses to browse.
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'tal519-')))
  writeFileSync(join(workspace, 'seed.txt'), '')
  symlinkSync('seed.txt', join(workspace, 'link'))
  expect((await page.request.post('/api/workspaces/add', { data: { path: workspace } })).ok()).toBe(true)
  const created = (await (await page.request.post('/api/session/new', { data: { workspace } })).json()) as { session: { session_id: string } }
  const sid = created.session.session_id
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
  await expect(tree.getByRole('treeitem', { name: /^link/ })).toBeVisible()

  await expect(page.getByRole('button', { name: 'New Folder' })).toBeVisible()
  await page.getByRole('button', { name: 'New Folder' }).click()
  await page.getByRole('textbox', { name: 'New folder name:' }).fill('docs')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(item('docs')).toBeVisible()

  await page.getByRole('button', { name: 'New File' }).click()
  await page.getByRole('textbox', { name: 'New file name (e.g. notes.md):' }).fill('notes.txt')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(item('notes.txt')).toBeVisible()
  await item('notes.txt').click()
  await page.getByRole('textbox', { name: 'Preview' }).fill('old text')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
  await page.getByRole('button', { name: 'Back' }).click()

  // A name that already exists: the dialog stays open with the server's refusal.
  await page.getByRole('button', { name: 'New File' }).click()
  await page.getByRole('textbox', { name: 'New file name (e.g. notes.md):' }).fill('notes.txt')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('File already exists')
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()

  await actions('notes.txt', 'Rename')
  await page.getByRole('textbox', { name: 'New name:' }).fill('plan.txt')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(item('plan.txt')).toBeVisible()
  await expect(item('notes.txt')).toHaveCount(0)
  // A new file at the renamed file's old path opens empty, not with the old file's cached text.
  await page.getByRole('button', { name: 'New File' }).click()
  await page.getByRole('textbox', { name: 'New file name (e.g. notes.md):' }).fill('notes.txt')
  await page.getByRole('button', { name: 'Create' }).click()
  await item('notes.txt').click()
  await expect(page.getByRole('textbox', { name: 'Preview' })).toHaveValue('')
  await page.getByRole('button', { name: 'Back' }).click()

  await item('plan.txt').dragTo(item('docs'))
  await expect(item('plan.txt')).toHaveCount(0)
  if (process.env.TAL519_SHOTS) {
    await item('docs').click({ button: 'right' })
    await page.screenshot({ path: `${process.env.TAL519_SHOTS}/menu-${testInfo.project.name}.png` })
    await page.keyboard.press('Escape')
  }
  await item('docs').click()
  await expect(item('plan.txt')).toBeVisible()
  await page.getByRole('button', { name: 'Up one level' }).click()

  await actions('docs', 'Reveal in file manager')
  await actions('docs', 'Open in VS Code')
  await expect.poll(() => launched).toEqual([{ route: 'reveal', path: 'docs' }, { route: 'open-vscode', path: 'docs' }])

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

  await page.request.post('/api/workspaces/remove', { data: { path: workspace } })
  rmSync(workspace, { recursive: true, force: true })
  errors.splice(0, errors.length, ...errors.filter((e) => !/400 POST .*\/api\/file\/(create|delete)$|status of 400/.test(e)))
})
