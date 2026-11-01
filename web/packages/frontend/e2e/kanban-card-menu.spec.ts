import { expect, settle, test } from './fixtures'
import type { Page } from '@playwright/test'

// Service-worker requests bypass page routing; these fixtures own every response.
test.use({ serviceWorkers: 'block' })

// Server output shapes (TAL-557): every task carries the actions the server offers for its status.
const actions = (block: boolean, unblock: boolean, complete: boolean, archive: boolean, move_to: string[]) => ({ block, unblock, complete, archive, move_to })
const task = (id: string, status: string, available_actions: ReturnType<typeof actions>) => ({ id, title: `Task ${id}`, status, priority: 0, available_actions, requires_running_exit_confirmation: status === 'running' })
const board = (readOnly: boolean) => ({
  changed: true, latest_event_id: 1, read_only: readOnly, tenants: [], assignees: [], bulk_move_targets: ['triage', 'todo', 'ready', 'blocked', 'done'], create_statuses: ['triage', 'todo', 'ready', 'blocked'],
  filters: { tenant: null, assignee: null, include_archived: false, only_mine: false, profile: null },
  columns: [
    { name: 'todo', label: 'todo', tasks: [task('T1', 'todo', actions(false, false, false, true, ['triage', 'ready']))] },
    { name: 'ready', label: 'ready', tasks: [] },
    { name: 'running', label: 'running', tasks: [task('R1', 'running', actions(true, false, true, true, ['triage', 'todo', 'ready']))] },
    { name: 'done', label: 'done', tasks: [] },
  ],
})

async function routeKanban(page: Page, readOnly = false) {
  const writes: { path: string; body: unknown }[] = []
  const boards = { boards: [{ slug: 'default', name: 'Default', is_current: true, total: 2 }], current: 'default', read_only: readOnly }
  await page.route('**/api/kanban/boards**', (route) => route.fulfill({ json: boards }))
  await page.route(/\/api\/kanban\/board(\?|$)/, (route) => route.fulfill({ json: board(readOnly) }))
  await page.route('**/api/kanban/tasks/*/log**', (route) => route.fulfill({ json: { log: [] } }))
  await page.route(/\/api\/kanban\/tasks\/[^/?]+(\?.*)?$/, (route) => route.fulfill({ json: { task: task('T1', 'todo', actions(false, false, false, true, [])), last_card_action: null, links: { parents: [], children: [] }, link_tasks: [] } }))
  // The write is held, so the card shows the user's requested column until the server answers.
  await page.route(/\/api\/kanban\/tasks\/[^/]+\/(patch|block|unblock|dispatch)$/, (route) => {
    const req = route.request()
    writes.push({ path: new URL(req.url()).pathname, body: req.postDataJSON() })
  })
  return writes
}

const menu = (page: Page) => page.getByRole('menu', { name: 'Task actions' })

test("right-click on a card offers the server's actions and moves it to another column", async ({ page }, testInfo) => {
  const writes = await routeKanban(page)
  await page.goto('/kanban')
  await settle(page)

  await page.locator('[data-task-id="T1"]').click({ button: 'right' })
  await expect(menu(page)).toBeVisible()
  // Todo: Move to lists the current status (checked) and exactly the server's move_to; only Archive among the verbs.
  await expect(menu(page).getByRole('menuitemradio')).toHaveText(['Todo', 'Triage', 'Ready'])
  await expect(menu(page).getByRole('menuitemradio', { name: 'Todo' })).toHaveAttribute('aria-checked', 'true')
  await expect(menu(page).getByRole('menuitem')).toHaveText(['Open', 'Dispatch to agent', 'Archive', 'Select'])
  await page.screenshot({ path: testInfo.outputPath(`kanban-card-menu-${testInfo.project.name}.png`) })

  await menu(page).getByRole('menuitemradio', { name: 'Ready' }).click()
  await expect(menu(page)).toHaveCount(0)
  await expect.poll(() => writes).toEqual([{ path: '/api/kanban/tasks/T1/patch', body: { status: 'ready', confirm_running_exit: false, board: 'default' } }])
  await expect(page.getByRole('region', { name: 'Ready' }).locator('[data-task-id="T1"]')).toBeVisible()

  // Select toggles the card's bulk checkbox.
  await page.locator('[data-task-id="R1"]').click({ button: 'right' })
  await menu(page).getByRole('menuitem', { name: 'Select' }).click()
  await expect(page.getByRole('checkbox', { name: 'Select Task R1' })).toBeChecked()
  await page.locator('[data-task-id="R1"]').click({ button: 'right' })
  await menu(page).getByRole('menuitem', { name: 'Deselect' }).click()
  await expect(page.getByRole('checkbox', { name: 'Select Task R1' })).not.toBeChecked()

  // Open shows the card's dialog.
  await page.locator('[data-task-id="R1"]').click({ button: 'right' })
  await menu(page).getByRole('menuitem', { name: 'Open' }).click()
  await expect(page.getByRole('dialog', { name: 'Task R1' })).toBeVisible()
})

test('Complete from a Running card asks for the server-required confirmation', async ({ page }, testInfo) => {
  const writes = await routeKanban(page)
  await page.goto('/kanban')
  await settle(page)

  await page.locator('[data-task-id="R1"]').click({ button: 'right' })
  await expect(menu(page).getByRole('menuitem')).toHaveText(['Open', 'Dispatch to agent', 'Block', 'Complete', 'Archive', 'Select'])
  await menu(page).getByRole('menuitem', { name: 'Complete' }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Leave Running?' })
  await expect(confirm).toBeVisible()
  expect(writes).toEqual([])
  await page.screenshot({ path: testInfo.outputPath(`kanban-card-menu-leave-running-${testInfo.project.name}.png`) })
  await confirm.getByRole('button', { name: 'Continue' }).click()
  await expect.poll(() => writes).toEqual([{ path: '/api/kanban/tasks/R1/patch', body: { status: 'done', confirm_running_exit: true, board: 'default' } }])
  await expect(page.getByRole('region', { name: 'Done' }).locator('[data-task-id="R1"]')).toBeVisible()
})

test('a read-only board offers only Open', async ({ page }) => {
  await routeKanban(page, true)
  await page.goto('/kanban')
  await settle(page)

  await page.locator('[data-task-id="R1"]').click({ button: 'right' })
  await expect(menu(page).getByRole('menuitem')).toHaveText(['Open'])
  await expect(menu(page).getByRole('menuitemradio')).toHaveCount(0)
})
