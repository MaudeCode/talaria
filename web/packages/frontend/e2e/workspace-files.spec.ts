import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, longPress, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** A row's accessible name is its file name, then its kind and size (TAL-1606). */
const row = (name: string) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')},`)

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
  const item = (name: string) => tree.getByRole('treeitem', { name: row(name) })
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

  // A name that already exists: the dialog closes on Create, then the server's refusal shows above the tree and the
  // entry the page showed for it goes away (TAL-1384).
  await page.getByRole('button', { name: 'New File' }).click()
  await page.getByRole('textbox', { name: 'New file name (e.g. notes.md):' }).fill('notes.txt')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('alert').filter({ hasText: 'File already exists' })).toBeVisible()
  await expect(item('notes.txt')).toHaveCount(1)

  await actions('notes.txt', 'Rename')
  await page.getByRole('textbox', { name: 'New name:' }).fill('plan.txt')
  // The row renames at once; the old path is only free to reuse when the server has answered.
  const renamed = page.waitForResponse('**/api/file/rename')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(item('plan.txt')).toBeVisible()
  await expect(item('notes.txt')).toHaveCount(0)
  await renamed
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

/** A synthetic workspace (the `docs` folder, `plan.txt`, `seed.txt`) open on the Files page. */
const start = async (page: Page, projectName: string) => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'tal1935-')))
  mkdirSync(join(workspace, 'docs'))
  writeFileSync(join(workspace, 'plan.txt'), 'plan')
  writeFileSync(join(workspace, 'seed.txt'), 'seed')
  expect((await page.request.post('/api/workspaces/add', { data: { path: workspace } })).ok()).toBe(true)
  const created = (await (await page.request.post('/api/session/new', { data: { workspace } })).json()) as { session: { session_id: string } }
  await page.goto(`/session/${created.session.session_id}`)
  if (projectName === 'mobile') await page.locator('#btnTitlebarSidePanel').click()
  else await page.getByRole('button', { name: 'Show workspace panel' }).click()
  await page.getByRole('tablist', { name: 'Side panel' }).getByRole('tab', { name: 'Files' }).click()
  const tree = page.getByRole('tree', { name: 'Files' })
  const item = (name: string) => tree.getByRole('treeitem', { name: row(name) })
  await expect(item('seed.txt')).toBeVisible()
  const newFile = async () => {
    await page.getByRole('button', { name: 'New File' }).click()
    await page.getByRole('textbox', { name: 'New file name (e.g. notes.md):' }).fill('notes.txt')
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(item('notes.txt')).toBeVisible()
  }
  const finish = async () => {
    await page.request.post('/api/workspaces/remove', { data: { path: workspace } })
    rmSync(workspace, { recursive: true, force: true })
  }
  return { workspace, tree, item, newFile, finish }
}

/** TAL-1935: a new file's row can be opened at once, however late the server answers the create and the reread after it. */
test.describe('a just-created file', () => {
  test('opens its preview when opened before the server has created it', async ({ page }, testInfo) => {
    const { item, newFile, finish } = await start(page, testInfo.project.name)
    const create = Promise.withResolvers<undefined>()
    const listed = Promise.withResolvers<undefined>()
    const reads: string[] = []
    await page.route('**/api/file/create', async (route) => { await create.promise; await route.continue() })
    await page.route('**/api/list?**', async (route) => {
      const answer = await route.fetch()
      await route.fulfill({ response: answer })
      if (((await answer.json()) as { entries: { name: string }[] }).entries.some((entry) => entry.name === 'notes.txt')) listed.resolve(undefined)
    })
    // A read the server answers before it has created the file finds nothing, and that answer can arrive after the create's.
    await page.route('**/api/file?**', async (route) => {
      const answer = await route.fetch()
      reads.push(String(answer.status()))
      await listed.promise
      await route.fulfill({ response: answer }).catch(() => undefined)
    })

    await newFile()
    await item('notes.txt').click()
    await expect(page.getByRole('button', { name: 'Back' })).toBeVisible()
    create.resolve(undefined)
    await expect(page.getByRole('textbox', { name: 'Preview' })).toHaveValue('')
    expect(reads).toEqual(['200'])
    await finish()
  })

  test('keeps a press on its row when the listing arrives before the release', async ({ page }, testInfo) => {
    const { tree, item, newFile, finish } = await start(page, testInfo.project.name)
    const reread = Promise.withResolvers<undefined>()
    await page.route('**/api/list?**', async (route) => { await reread.promise; await route.continue() })
    const created = page.waitForResponse('**/api/file/create')
    await newFile()
    await created

    const box = await item('notes.txt').boundingBox()
    if (!box) throw new Error('the new row has no box')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    reread.resolve(undefined)
    // The server's listing has arrived and settled: its rows, once each, in its order.
    await expect.poll(() => tree.getByRole('treeitem').evaluateAll((rows) => rows.map((el) => el.getAttribute('aria-label')?.split(',')[0]))).toEqual(['docs', 'notes.txt', 'plan.txt', 'seed.txt'])
    await expect(item('notes.txt')).toHaveAccessibleName('notes.txt, file, 0 B')
    await page.mouse.up()
    await expect(page.getByRole('textbox', { name: 'Preview' })).toHaveValue('')
    await finish()
  })
})

/** TAL-1156: a row's menu has the kebab's items and opens at the pointer; the tree's empty area creates in the current folder. */
test.describe('the Files tree context menus', () => {
  const ROW_ITEMS = ['Rename', 'Reveal in file manager', 'Open in VS Code', 'Delete']

  /** Right-clicks `target` at `at` and checks that a corner of the menu is there; the menu flips when it lacks room. */
  const rightClick = async (page: Page, target: Locator, at: (box: { width: number; height: number }) => { x: number; y: number }) => {
    const box = await target.boundingBox()
    if (!box) throw new Error('right-click target is not visible')
    const position = at(box)
    await target.click({ button: 'right', position })
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    const opened = await menu.boundingBox()
    if (!opened) throw new Error('the menu is not visible')
    const fromEdge = (pointer: number, start: number, size: number) => Math.min(Math.abs(pointer - start), Math.abs(pointer - start - size))
    expect(fromEdge(box.x + position.x, opened.x, opened.width)).toBeLessThan(8)
    expect(fromEdge(box.y + position.y, opened.y, opened.height)).toBeLessThan(8)
    return menu
  }

  test('a right-click on a row opens its menu at the pointer, the same list as its kebab', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'right-click is the desktop route')
    const { tree, item, finish } = await start(page, testInfo.project.name)
    const menu = await rightClick(page, item('seed.txt'), () => ({ x: 30, y: 8 }))
    await expect(menu.getByRole('menuitem')).toHaveText(ROW_ITEMS)
    await menu.getByRole('menuitem', { name: 'Rename' }).click()
    await page.getByRole('textbox', { name: 'New name:' }).fill('renamed.txt')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(item('renamed.txt')).toBeVisible()

    await item('plan.txt').hover()
    await tree.locator('.group').filter({ has: page.getByRole('treeitem', { name: row('plan.txt') }) }).getByRole('button', { name: 'More actions' }).click()
    await expect(menu.getByRole('menuitem')).toHaveText(ROW_ITEMS)
    await finish()
  })

  test('a right-click on the empty area creates in the current folder', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'right-click is the desktop route')
    const { workspace, tree, item, finish } = await start(page, testInfo.project.name)
    await item('docs').click()
    await expect(tree.getByRole('status')).toBeVisible()
    const menu = await rightClick(page, tree, ({ width, height }) => ({ x: width / 2, y: height / 2 }))
    await expect(menu.getByRole('menuitem')).toHaveText(['New File', 'New Folder'])
    await menu.getByRole('menuitem', { name: 'New Folder' }).click()
    await page.getByRole('textbox', { name: 'New folder name:' }).fill('made')
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(item('made')).toBeVisible()
    await expect.poll(() => existsSync(join(workspace, 'docs', 'made'))).toBe(true)
    await finish()
  })

  test('a long-press opens the row menu alone, without opening the row', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'long-press is the touch route')
    const { item, finish } = await start(page, testInfo.project.name)
    await longPress(page, item('seed.txt'))
    await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(ROW_ITEMS)
    await expect(page.getByRole('button', { name: 'Back' })).toHaveCount(0)
    await finish()
  })
})

/** TAL-639: until an existing chat's record loads, the Files page names no workspace, so the session's workspace arriving never remounts it. */
test('the Files page waits for the session record instead of showing the default workspace', async ({ page }, testInfo) => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'tal639-')))
  writeFileSync(join(workspace, 'seed.txt'), 'seed text')
  expect((await page.request.post('/api/workspaces/add', { data: { path: workspace } })).ok()).toBe(true)
  const created = (await (await page.request.post('/api/session/new', { data: { workspace } })).json()) as { session: { session_id: string } }
  const { promise: loaded, resolve: release } = Promise.withResolvers<undefined>()
  await page.route('**/api/session?**', async (route) => { await loaded; await route.continue() })

  await page.goto(`/session/${created.session.session_id}`)
  if (testInfo.project.name === 'mobile') await page.locator('#btnTitlebarSidePanel').click()
  else await page.getByRole('button', { name: 'Show workspace panel' }).click()
  await page.getByRole('tablist', { name: 'Side panel' }).getByRole('tab', { name: 'Files' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'This chat has no workspace.' })).toBeVisible()
  await expect(page.locator('[data-files-toolbar]')).toHaveCount(0)

  release(undefined)
  await expect(page.locator('[data-files-toolbar]')).toContainText(workspace)
  await page.getByRole('tree', { name: 'Files' }).getByRole('treeitem', { name: row('seed.txt') }).click()
  await expect(page.getByRole('textbox', { name: 'Preview' })).toHaveValue('seed text')

  await page.request.post('/api/workspaces/remove', { data: { path: workspace } })
  rmSync(workspace, { recursive: true, force: true })
})

/** TAL-1606: the tree is one tab stop; arrow keys, Home and End move among rows; names carry kind and size. */
test('the Files tree moves focus with the keyboard and names rows with their kind and size', async ({ page }, testInfo) => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'tal1606-')))
  mkdirSync(join(workspace, 'docs'))
  writeFileSync(join(workspace, 'docs', 'inner.txt'), 'inner')
  writeFileSync(join(workspace, 'a.txt'), 'abc')
  writeFileSync(join(workspace, 'b.txt'), 'b'.repeat(2048))
  expect((await page.request.post('/api/workspaces/add', { data: { path: workspace } })).ok()).toBe(true)
  const created = (await (await page.request.post('/api/session/new', { data: { workspace } })).json()) as { session: { session_id: string } }

  await page.goto(`/session/${created.session.session_id}`)
  if (testInfo.project.name === 'mobile') await page.locator('#btnTitlebarSidePanel').click()
  else await page.getByRole('button', { name: 'Show workspace panel' }).click()
  await page.getByRole('tablist', { name: 'Side panel' }).getByRole('tab', { name: 'Files' }).click()
  const tree = page.getByRole('tree', { name: 'Files' })
  const docs = tree.getByRole('treeitem', { name: 'docs, folder', exact: true })
  const a = tree.getByRole('treeitem', { name: 'a.txt, file, 3 B', exact: true })
  const b = tree.getByRole('treeitem', { name: 'b.txt, file, 2.0 KB', exact: true })
  await expect(a).toContainText('3 B')
  await expect(tree.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1)

  await docs.focus()
  await page.keyboard.press('ArrowDown')
  await expect(a).toBeFocused()
  await page.keyboard.press('End')
  await expect(b).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(a).toBeFocused()
  if (process.env.TAL1606_SHOTS) await page.screenshot({ path: `${process.env.TAL1606_SHOTS}/keyboard-${testInfo.project.name}.png` })
  // Tab leaves the rows after the focused row's More actions; Shift+Tab comes back to the same row.
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'More actions' }).and(page.locator(':focus'))).toHaveCount(1)
  await page.keyboard.press('Shift+Tab')
  await expect(a).toBeFocused()
  await page.keyboard.press('Home')
  await expect(docs).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(tree.getByRole('treeitem', { name: 'inner.txt, file, 5 B', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Up one level' }).click()
  await expect(docs).toHaveAttribute('tabindex', '0')

  await page.request.post('/api/workspaces/remove', { data: { path: workspace } })
  rmSync(workspace, { recursive: true, force: true })
})
