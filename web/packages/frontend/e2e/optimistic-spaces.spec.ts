import { DUO_VIEWPORTS, expect, settle, test } from './fixtures'

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
    await page.goto('/settings/workspaces')
    await settle(page)
    const names = page.locator('#workspacesPanel li .truncate:not(.font-mono)')
    await expect(names).toHaveText(['Alpha', 'Beta', 'Gamma'])
    await page.locator('#workspacesPanel li', { hasText: 'Gamma' }).getByRole('button', { name: 'Workspace actions' }).click()
    await page.getByRole('menuitem', { name: 'Move up' }).click()
    await expect(names).toHaveText(['Alpha', 'Gamma', 'Beta'])
    await expect(page.getByText(/^Pending/)).toHaveCount(0)
    await page.screenshot({ path: info.outputPath(`reorder-${info.project.name}.png`) })
    gate.resolve(undefined)
    await expect(names).toHaveText(['Alpha', 'Gamma', 'Beta'])
  } finally {
    gate.resolve(undefined)
  }
})

test('TAL-2141: a space is added with taps only, descending from the home directory', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'the taps-only route is the phone one')
  const workspaces = [{ path: '/home/me', name: 'Home', is_default: true, exists: true, display_path: '~' }]
  const tree: Record<string, string[]> = { '': ['/home/me'], '/home/me/': ['/home/me/git', '/home/me/notes'], '/home/me/git/': ['/home/me/git/talaria', '/home/me/git/website'] }
  const adds: unknown[] = []
  await page.route(/\/api\/workspaces(\?|$)/, (route) => route.fulfill({ json: { workspaces, last: null } }))
  await page.route('**/api/workspaces/suggest?*', (route) => {
    const prefix = new URL(route.request().url()).searchParams.get('prefix') ?? ''
    const suggestions = tree[prefix] ?? []
    const folders = suggestions.map((path) => ({ path, name: path.split('/').pop()!, target: `${path}/` }))
    return route.fulfill({ json: { prefix, suggestions, folders, parent: prefix ? prefix.replace(/[^/]+\/$/, '') : null, default_name: null } })
  })
  await page.route('**/api/workspaces/add', async (route) => {
    const body = route.request().postDataJSON() as { path: string }
    adds.push(body)
    workspaces.push({ path: '/home/me/git/talaria', name: 'talaria', is_default: false, exists: true, display_path: '~/git/talaria' })
    await route.fulfill({ json: { ok: true, workspaces } })
  })
  await page.goto('/settings/workspaces')
  await settle(page)
  await page.getByRole('button', { name: 'Add space' }).tap()
  const dialog = page.getByRole('dialog')
  const folders = dialog.getByRole('listbox', { name: 'Folders' })
  await expect(dialog.locator('datalist')).toHaveCount(0)
  await folders.getByRole('option', { name: 'me', exact: true }).tap()
  await folders.getByRole('option', { name: 'git', exact: true }).tap()
  await expect(folders.getByRole('option')).toHaveText(['..', 'talaria', 'website'])
  await page.screenshot({ path: info.outputPath('add-space-descended-mobile.png') })
  await folders.getByRole('option', { name: 'talaria', exact: true }).tap()
  await expect(dialog.getByRole('combobox')).toHaveValue('/home/me/git/talaria/')
  await dialog.getByRole('button', { name: 'Add', exact: true }).tap()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => adds).toEqual([{ path: '/home/me/git/talaria/' }])
  await expect(page.locator('#workspacesPanel li', { hasText: '~/git/talaria' })).toBeVisible()
})

test('TAL-2141: a long space path keeps its last folders on screen at every tour viewport', async ({ page }, info) => {
  const long = '/home/me/clients/northwind/engagements/2026/q4/platform-migration'
  const workspaces = [
    { path: '/home/me/projects/home', name: 'Home', is_default: true, exists: true, display_path: '~/projects/home', chat_count: 12 },
    { path: long, name: 'Migration', is_default: false, exists: true, display_path: '~/clients/northwind/engagements/2026/q4/platform-migration', chat_count: 48 },
    { path: '/tmp/scratch', name: 'Scratch', is_default: false, exists: false, display_path: '/tmp/scratch', chat_count: 0 },
  ]
  await page.route(/\/api\/workspaces(\?|$)/, (route) => route.fulfill({ json: { workspaces, last: null } }))
  await page.route('**/api/workspaces/suggest?*', (route) => route.fulfill({ json: { prefix: '', suggestions: [] } }))
  await page.goto('/settings/workspaces')
  await settle(page)
  const line = page.locator(`#workspacesPanel [title="${long}"]`)
  await expect(line).toBeVisible()
  await page.screenshot({ path: info.outputPath(`spaces-${info.project.name}.png`) })
  const viewports = [{ name: info.project.name, ...page.viewportSize()! }, ...DUO_VIEWPORTS]
  for (const { name, width, height } of viewports) {
    await page.setViewportSize({ width, height })
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    // The path's end sits inside its line; when the line is too narrow, the start is what is cut.
    await expect.poll(() => line.evaluate((el) => {
      const box = el.getBoundingClientRect(), text = el.firstElementChild!.getBoundingClientRect()
      return text.right <= box.right + 1
    }), `the last folders show at ${name}`).toBe(true)
  }
})
