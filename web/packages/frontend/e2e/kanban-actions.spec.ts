import { expect, settle, test } from './fixtures'

// Service-worker requests bypass page routing; these fixtures own every response.
test.use({ serviceWorkers: 'block' })

// Server output shapes (TAL-557): every task carries the actions the server offers for its status.
const actions = (block: boolean, unblock: boolean, complete: boolean, archive: boolean, move_to: string[]) => ({ block, unblock, complete, archive, move_to })
const task = (id: string, status: string, available_actions: ReturnType<typeof actions>) => ({ id, title: `Task ${id}`, status, priority: 0, available_actions, requires_running_exit_confirmation: status === 'running' })
const board = {
  changed: true, latest_event_id: 1, read_only: false, tenants: [], assignees: [], bulk_move_targets: ['triage', 'todo', 'ready', 'blocked', 'done'],
  filters: { tenant: null, assignee: null, include_archived: false, only_mine: false, profile: null },
  columns: [
    { name: 'todo', tasks: [task('T1', 'todo', actions(false, false, false, true, ['triage', 'ready']))] },
    { name: 'running', tasks: [task('R1', 'running', actions(true, false, true, true, ['triage', 'todo', 'ready']))] },
    { name: 'blocked', tasks: [task('B1', 'blocked', actions(false, true, true, true, ['triage', 'todo']))] },
  ],
}

/** The Column picker's options: the current status, then the server's `move_to`. */
async function expectMoves(page: import('@playwright/test').Page, dialog: import('@playwright/test').Locator, options: string[]) {
  await dialog.getByRole('combobox', { name: 'Column' }).click()
  await expect(page.getByRole('option')).toHaveText(options)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('option')).toHaveCount(0)
}

test("kanban card dialog shows only the server's actions and confirms leaving Running", async ({ page }, testInfo) => {
  const writes: { path: string; body: unknown }[] = []
  await page.route('**/api/kanban/boards?**', (route) => route.fulfill({ json: { boards: [{ slug: 'default', name: 'Default', is_current: true, total: 3 }], current: 'default', read_only: false } }))
  await page.route('**/api/kanban/boards', (route) => route.fulfill({ json: { boards: [{ slug: 'default', name: 'Default', is_current: true, total: 3 }], current: 'default', read_only: false } }))
  await page.route('**/api/kanban/board?**', (route) => route.fulfill({ json: board }))
  await page.route('**/api/kanban/board', (route) => route.fulfill({ json: board }))
  await page.route('**/api/kanban/tasks/*/log**', (route) => route.fulfill({ json: { log: [] } }))
  await page.route(/\/api\/kanban\/tasks\/[^/]+\/(patch|block|unblock)$/, (route) => {
    const req = route.request()
    writes.push({ path: new URL(req.url()).pathname, body: req.postDataJSON() })
    const id = new URL(req.url()).pathname.split('/')[4] ?? ''
    return route.fulfill({ json: { task: task(id, 'done', actions(false, false, false, true, ['triage', 'todo', 'ready'])), read_only: false } })
  })
  await page.goto('/kanban')
  await settle(page)

  // Running: Block, Complete, Archive; moves to triage/todo/ready; no Unblock.
  await page.locator('[data-task-id="R1"]').click()
  const dialog = page.getByRole('dialog', { name: 'Task R1' })
  await expect(dialog.getByRole('button', { name: 'Block', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Complete', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Archive', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Unblock', exact: true })).toHaveCount(0)
  await expectMoves(page, dialog, ['running', 'triage', 'todo', 'ready'])
  await page.screenshot({ path: testInfo.outputPath(`kanban-running-${testInfo.project.name}.png`) })
  await dialog.getByRole('button', { name: 'Complete', exact: true }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Leave Running?' })
  await expect(confirm).toBeVisible()
  expect(writes).toEqual([])
  await page.screenshot({ path: testInfo.outputPath(`kanban-leave-running-${testInfo.project.name}.png`) })
  await confirm.getByRole('button', { name: 'Continue' }).click()
  await expect.poll(() => writes).toEqual([{ path: '/api/kanban/tasks/R1/patch', body: { status: 'done' } }])
  await page.keyboard.press('Escape')

  // Blocked: Unblock and Complete without confirmation; no Block; Ready is reached through Unblock.
  await page.locator('[data-task-id="B1"]').click()
  const blocked = page.getByRole('dialog', { name: 'Task B1' })
  await expect(blocked.getByRole('button', { name: 'Block', exact: true })).toHaveCount(0)
  await expectMoves(page, blocked, ['blocked', 'triage', 'todo'])
  await blocked.getByRole('button', { name: 'Unblock', exact: true }).click()
  await expect.poll(() => writes.at(-1)).toMatchObject({ path: '/api/kanban/tasks/B1/unblock' })
  await page.keyboard.press('Escape')

  // Todo: only Archive.
  await page.locator('[data-task-id="T1"]').click()
  const todo = page.getByRole('dialog', { name: 'Task T1' })
  await expect(todo.getByRole('button', { name: 'Archive', exact: true })).toBeVisible()
  for (const name of ['Block', 'Unblock', 'Complete']) await expect(todo.getByRole('button', { name, exact: true })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath(`kanban-todo-${testInfo.project.name}.png`) })
})
