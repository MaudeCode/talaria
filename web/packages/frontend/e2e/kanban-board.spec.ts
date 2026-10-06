import { expect, settle, test } from './fixtures'
import type { Page, Route } from '@playwright/test'

// Service-worker requests bypass page routing; these fixtures own every response.
test.use({ serviceWorkers: 'block' })

// Server output shapes (TAL-567): the server filters, searches, groups lanes and counts; the page renders those fields.
const actions = { block: false, unblock: false, complete: false, archive: true, move_to: ['triage', 'ready'] }
const task = (id: string, status: string, assignee?: string) => ({ id, title: `Task ${id}`, status, priority: 0, ...(assignee ? { assignee } : {}), available_actions: actions, requires_running_exit_confirmation: false })
const column = (name: string, tasks: ReturnType<typeof task>[]) => ({ name, tasks })
const board = (columns: ReturnType<typeof column>[], extra: Record<string, unknown> = {}) => ({
  changed: true, latest_event_id: 4, read_only: false, tenants: ['acme'], assignees: ['builder', 'reviewer'], bulk_move_targets: ['triage', 'todo', 'ready', 'blocked', 'done'],
  filters: {}, lane_by_profile: false, columns, ...extra,
})
const boards = { boards: [{ slug: 'default', name: 'Default', is_current: false, total: 1, removable: false }, { slug: 'ops', name: 'Ops', is_current: true, total: 3, removable: true }], current: 'ops', read_only: false }
const stats = { by_status: { todo: 2, ready: 1 }, total: 3, status_counts: [{ status: 'todo', count: 2 }, { status: 'ready', count: 1 }] }

/** Routes every Kanban read; `boardFor` answers each board request from its query. Returns the board queries and writes seen. */
async function routeKanban(page: Page, boardFor: (q: URLSearchParams) => unknown) {
  const queries: URLSearchParams[] = []
  const writes: { method: string; path: string; body: unknown }[] = []
  const record = (route: Route) => { const req = route.request(); writes.push({ method: req.method(), path: new URL(req.url()).pathname, body: req.postData() ? req.postDataJSON() : null }) }
  await page.route('**/api/kanban/boards**', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: boards })
    record(route)
    return route.fulfill({ json: route.request().method() === 'POST' ? { board: { slug: 'q3-launch' }, current: 'q3-launch', read_only: false } : { result: {}, current: 'default', read_only: false } })
  })
  await page.route(/\/api\/kanban\/board(\?|$)/, async (route) => { const q = new URL(route.request().url()).searchParams; queries.push(q); return route.fulfill({ json: await boardFor(q) }) })
  await page.route('**/api/kanban/stats**', (route) => route.fulfill({ json: stats }))
  await page.route('**/api/kanban/config', (route) => { record(route); return route.fulfill({ json: { lane_by_profile: false } }) })
  // Later routes win: the task detail pattern also matches `tasks/bulk`, so it goes first.
  await page.route(/\/api\/kanban\/tasks\/[^/?]+(\?.*)?$/, (route) => route.fulfill({ json: { task: task('T1', 'todo'), last_card_action: null, links: { parents: ['P1'], children: ['C1'] } } }))
  await page.route('**/api/kanban/tasks/bulk', (route) => { record(route); return route.fulfill({ json: { results: [{ id: 'T1', ok: true }, { id: 'T2', ok: true }], read_only: false } }) })
  await page.route('**/api/kanban/links**', (route) => { record(route); return route.fulfill({ json: { ok: true } }) })
  await page.route('**/api/kanban/tasks/*/log**', (route) => route.fulfill({ json: { log: [] } }))
  return { queries, writes }
}

test('kanban filters, stats, profile lanes and live refresh render the server fields', async ({ page }, testInfo) => {
  let live = false
  let lanes = true
  const { queries, writes } = await routeKanban(page, (q) => {
    const tasks = live ? [task('T9', 'todo', 'builder')] : [task('T1', 'todo', 'builder'), task('T2', 'todo')]
    const columns = [column('todo', q.get('search') ? tasks.slice(0, 1) : tasks), column('ready', [task('T3', 'ready', 'reviewer')])]
    return board(columns, lanes ? { lane_by_profile: true, lanes: [{ assignee: 'builder', count: 1, columns: [column('todo', [columns[0]!.tasks[0]!]), column('ready', [])] }, { assignee: 'reviewer', count: 1, columns: [column('todo', []), column('ready', columns[1]!.tasks)] }, ...(columns[0]!.tasks.length > 1 ? [{ assignee: null, count: 1, columns: [column('todo', [columns[0]!.tasks[1]!]), column('ready', [])] }] : [])] } : {})
  })
  // Another client's write reaches this page as an `events` frame; EventSource reconnects every second until then.
  let streamed = false
  const streamUrls: string[] = []
  await page.route('**/api/kanban/events/stream**', (route) => {
    streamUrls.push(route.request().url())
    const frames = ['retry: 1000', '', 'event: hello', 'data: {"cursor":4,"board":null}', '']
    if (live && !streamed) { streamed = true; frames.push('id: 5', 'event: events', 'data: {"events":[{"id":5,"task_id":"T9","run_id":null,"kind":"created","payload":null,"created_at":1}],"cursor":5}', '') }
    return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body: frames.join('\n') + '\n' })
  })
  await page.goto('/kanban')
  await settle(page)

  // Reads and the event stream name the shown board, so a switch elsewhere cannot swap the data under this view.
  expect(queries.at(-1)?.get('board')).toBe('ops')
  expect(new URL(streamUrls[0] ?? 'http://x/').searchParams.get('board')).toBe('ops')

  // Stats strip: the server's total and per-status counts, in its order.
  const strip = page.getByRole('group', { name: 'Stats' })
  await expect(strip).toHaveText(/3 total.*2 Todo.*1 Ready/)

  // Profile lanes: one section per assignee, unassigned last.
  await expect(page.getByRole('region', { name: /^builder/ })).toBeVisible()
  await expect(page.locator('.kanban-lane > header')).toHaveText([/builder/, /reviewer/, /Unassigned/])
  await expect(page.getByRole('region', { name: /^Unassigned/ }).locator('[data-task-id="T2"]')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath(`kanban-lanes-${testInfo.project.name}.png`) })

  // The lanes switch saves the view; the board then renders consolidated columns.
  lanes = false
  await page.getByRole('switch', { name: 'Lanes by profile' }).click()
  await expect.poll(() => writes.at(-1)).toEqual({ method: 'PATCH', path: '/api/kanban/config', body: { lane_by_profile: false } })
  await expect(page.locator('.kanban-lane')).toHaveCount(0)
  await expect(page.locator('[data-task-id="T2"]')).toBeVisible()

  // Every filter is a board query; the server answers with the matching tasks.
  await page.getByRole('searchbox', { name: 'Search tasks' }).fill('login')
  await expect.poll(() => queries.at(-1)?.get('search')).toBe('login')
  await expect(page.locator('[data-task-id="T2"]')).toHaveCount(0)
  await page.getByRole('combobox', { name: 'Assignee' }).click()
  await page.getByRole('option', { name: 'builder' }).click()
  await expect.poll(() => queries.at(-1)?.get('assignee')).toBe('builder')
  await page.getByRole('combobox', { name: 'Tenant' }).click()
  await page.getByRole('option', { name: 'acme' }).click()
  await expect.poll(() => queries.at(-1)?.get('tenant')).toBe('acme')
  await page.getByRole('switch', { name: 'Only mine' }).click()
  await expect.poll(() => queries.at(-1)?.get('only_mine')).toBe('1')
  // Only mine replaces the assignee filter on the server, so its picker is disabled meanwhile.
  await expect(page.getByRole('combobox', { name: 'Assignee' })).toBeDisabled()
  expect(queries.at(-1)?.get('search')).toBe('login')
  await page.screenshot({ path: testInfo.outputPath(`kanban-filters-${testInfo.project.name}.png`) })

  // A task created elsewhere appears once its event arrives, without a manual refresh.
  await page.getByRole('searchbox', { name: 'Search tasks' }).fill('')
  await expect.poll(() => queries.at(-1)?.get('search')).toBeNull()
  await expect(page.locator('[data-task-id="T2"]')).toBeVisible()
  live = true
  await expect(page.locator('[data-task-id="T9"]')).toBeVisible({ timeout: 5_000 })
  expect(streamed).toBe(true)
})

test('kanban bulk status, task links and board create and archive write through the server', async ({ page }, testInfo) => {
  // A `slow` search holds the server's answer until the test releases it.
  const { promise: held, resolve: release } = Promise.withResolvers<undefined>()
  const { writes } = await routeKanban(page, async (q) => {
    if (q.get('search') === 'slow') await held
    return board([column('todo', q.get('search') ? [task('T1', 'todo')] : [task('T1', 'todo'), task('T2', 'todo')]), column('ready', [task('T3', 'ready')])])
  })
  await page.goto('/kanban')
  await settle(page)

  // Bulk: select cards, pick one of the server's targets, apply.
  await expect(page.getByRole('checkbox', { name: 'Select Task T1' })).toBeVisible()
  await page.getByRole('checkbox', { name: 'Select Task T1' }).click()
  await page.getByRole('checkbox', { name: 'Select Task T2' }).click()
  const bulk = page.getByRole('group', { name: 'Bulk action' })
  await expect(bulk).toContainText('2 selected')
  // A selected card the search hides is left out of the bulk action until it shows again.
  await page.getByRole('searchbox', { name: 'Search tasks' }).fill('T1')
  await expect(bulk).toContainText('1 selected')
  await page.getByRole('searchbox', { name: 'Search tasks' }).fill('')
  await expect(bulk).toContainText('2 selected')
  // While the next filter's answer is pending, the cards on screen are stale, so writes wait for it.
  await bulk.getByRole('combobox', { name: 'Status' }).click()
  await page.getByRole('option', { name: 'done' }).click()
  await page.getByRole('searchbox', { name: 'Search tasks' }).fill('slow')
  await expect(bulk.getByRole('button', { name: 'Apply' })).toBeDisabled()
  release(undefined)
  await expect(bulk).toContainText('1 selected')
  await page.getByRole('searchbox', { name: 'Search tasks' }).fill('')
  await expect(bulk).toContainText('2 selected')
  await expect(bulk.getByRole('button', { name: 'Apply' })).toBeEnabled()
  await bulk.getByRole('combobox', { name: 'Status' }).click()
  await expect(page.getByRole('option')).toHaveText(['triage', 'todo', 'ready', 'blocked', 'done'])
  await page.getByRole('option', { name: 'done' }).click()
  await page.screenshot({ path: testInfo.outputPath(`kanban-bulk-${testInfo.project.name}.png`) })
  await bulk.getByRole('button', { name: 'Apply' }).click()
  await expect.poll(() => writes.at(-1)).toEqual({ method: 'POST', path: '/api/kanban/tasks/bulk', body: { ids: ['T1', 'T2'], status: 'done', board: 'ops' } })
  await expect(bulk).toHaveCount(0)

  // Links: the task's parents and children, removable, and a new parent by id.
  await page.locator('[data-task-id="T1"]').click()
  const dialog = page.getByRole('dialog', { name: 'Task T1' })
  const links = dialog.getByRole('group', { name: 'Links' })
  await expect(links).toContainText('P1')
  await expect(links).toContainText('C1')
  await page.screenshot({ path: testInfo.outputPath(`kanban-links-${testInfo.project.name}.png`) })
  await links.getByRole('button', { name: 'Remove dependency P1' }).click()
  await expect.poll(() => writes.at(-1)).toEqual({ method: 'POST', path: '/api/kanban/links/delete', body: { parent_id: 'P1', child_id: 'T1', board: 'ops' } })
  await links.getByRole('button', { name: 'Remove dependency C1' }).click()
  await expect.poll(() => writes.at(-1)).toEqual({ method: 'POST', path: '/api/kanban/links/delete', body: { parent_id: 'T1', child_id: 'C1', board: 'ops' } })
  await links.getByRole('textbox', { name: 'Parent task ID' }).fill('P2')
  await links.getByRole('button', { name: 'Add dependency' }).click()
  await expect.poll(() => writes.at(-1)).toEqual({ method: 'POST', path: '/api/kanban/links', body: { parent_id: 'P2', child_id: 'T1', board: 'ops' } })
  await page.keyboard.press('Escape')

  // Boards: create by name (the server derives the slug) and archive the removable current board.
  await page.getByRole('button', { name: 'New board' }).click()
  const create = page.getByRole('dialog', { name: 'New board' })
  await create.getByRole('textbox', { name: 'Name' }).fill('Q3 Launch')
  await create.getByRole('button', { name: 'Create' }).click()
  await expect.poll(() => writes.at(-1)).toEqual({ method: 'POST', path: '/api/kanban/boards', body: { name: 'Q3 Launch', switch: true } })
  await expect(create).toHaveCount(0)
  await page.getByRole('button', { name: 'Archive board' }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Archive board' })
  await expect(confirm).toContainText('Ops')
  await page.screenshot({ path: testInfo.outputPath(`kanban-archive-board-${testInfo.project.name}.png`) })
  await confirm.getByRole('button', { name: 'Archive' }).click()
  await expect.poll(() => writes.at(-1)).toEqual({ method: 'DELETE', path: '/api/kanban/boards/ops', body: null })
})
