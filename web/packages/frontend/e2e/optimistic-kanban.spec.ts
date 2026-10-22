import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const actions = { block: true, unblock: false, complete: true, archive: true, move_to: ['ready', 'done'] }
const task = (id: string, status = 'todo') => ({ id, title: `Task ${id}`, status, priority: 0, claim_live: false, has_completion_evidence: false, available_actions: actions, requires_running_exit_confirmation: false, current_run_started_at: null })

test('held Kanban writes move cards, links, lanes and boards at once', async ({ page }, testInfo) => {
  let status = 'todo', parent = false, lanes = false, current = 'default'
  const statusGate = Promise.withResolvers<undefined>(), linkGate = Promise.withResolvers<undefined>()
  const configGate = Promise.withResolvers<undefined>(), switchGate = Promise.withResolvers<undefined>()
  const writes: string[] = []
  await page.route('**/api/kanban/boards**', async (route) => {
    if (route.request().method() !== 'GET') { writes.push('switch'); await switchGate.promise; current = 'other'; return route.fulfill({ json: { current, read_only: false } }) }
    return route.fulfill({ json: { current, boards: [{ slug: 'default', name: 'Default', removable: false }, { slug: 'other', name: 'Other', removable: true }], read_only: false } })
  })
  await page.route(/\/api\/kanban\/board(\?|$)/, (route) => {
    const other = new URL(route.request().url()).searchParams.get('board') === 'other'
    const columns = [
      { name: 'todo', label: 'Todo', tasks: other ? [task('C')] : status === 'todo' ? [task('A'), task('B')] : [task('B')] },
      { name: 'done', label: 'Done', tasks: !other && status === 'done' ? [task('A', 'done')] : [] },
    ]
    return route.fulfill({ json: { columns, latest_event_id: other ? 31 : 7, read_only: false, bulk_move_targets: ['done'], create_statuses: ['todo'], lane_by_profile: lanes, ...(lanes ? { lanes: [{ assignee: 'scout', count: other ? 1 : 2, columns }] } : {}) } })
  })
  await page.route('**/api/kanban/stats**', (route) => {
    const total = new URL(route.request().url()).searchParams.get('board') === 'other' ? 1 : 2
    return route.fulfill({ json: { total, by_status: { todo: total }, status_counts: [{ status: 'todo', count: total }] } })
  })
  await page.route('**/api/kanban/tasks/*/log**', (route) => route.fulfill({ json: { log: [] } }))
  await page.route(/\/api\/kanban\/tasks\/[^/?]+(\?.*)?$/, (route) => route.fulfill({ json: { task: task('A', status), links: { parents: parent ? ['P1'] : [], children: [] }, link_tasks: [], last_card_action: null } }))
  await page.route('**/api/kanban/tasks/A/patch', async (route) => { writes.push('status'); await statusGate.promise; status = 'done'; await route.fulfill({ json: { task: task('A', status), read_only: false } }) })
  await page.route('**/api/kanban/links', async (route) => { writes.push('link'); await linkGate.promise; parent = true; await route.fulfill({ json: { ok: true } }) })
  await page.route('**/api/kanban/config', async (route) => { writes.push('config'); await configGate.promise; lanes = true; await route.fulfill({ json: {} }) })
  // Keep the stream response held while mutation reconciliation happens; its old cursor cannot replace intent.
  const streamGate = Promise.withResolvers<undefined>()
  await page.route('**/api/kanban/events/stream**', async (route) => { await streamGate.promise; await route.fulfill({ headers: { 'content-type': 'text/event-stream' }, body: 'event: hello\ndata: {"cursor":7}\n\n' }) })
  try {
    await page.goto('/kanban')
    await page.locator('[data-task-id="A"]').click()
    const dialog = page.getByRole('dialog', { name: 'Task A' })
    await dialog.getByRole('combobox', { name: 'Column' }).click()
    await page.getByRole('option', { name: 'done', exact: true }).click()
    await expect.poll(() => writes.includes('status')).toBe(true)
    await expect(dialog.getByRole('combobox', { name: 'Column' })).toHaveText('done')
    await expect(dialog.getByRole('button', { name: 'Complete' })).toBeEnabled()
    await expect(page.getByText(/^Pending/)).toHaveCount(0)
    await expect(page.locator('.kanban-column').nth(1).locator('[data-task-id="A"]')).toHaveCount(1)
    await page.screenshot({ path: testInfo.outputPath(`after-status-${testInfo.project.name}.png`) })
    statusGate.resolve(undefined)
    await dialog.getByRole('textbox', { name: 'Parent task ID' }).fill('P1')
    await dialog.getByRole('button', { name: 'Add dependency' }).click()
    await expect(dialog.getByRole('listitem')).toHaveText('P1')
    await expect(dialog.getByRole('textbox', { name: 'Parent task ID' })).toHaveValue('')
    linkGate.resolve(undefined)
    await expect(dialog.getByRole('listitem')).toHaveText('P1')
    await page.keyboard.press('Escape')
    // Lanes come from the server, so turning them on keeps only the switch busy until they arrive.
    const toggle = page.getByRole('switch', { name: 'Lanes by profile' })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-busy', 'true')
    configGate.resolve(undefined)
    await expect(page.getByRole('region', { name: 'scout' })).toBeVisible()
    await expect(toggle).toBeChecked()
    await page.getByRole('combobox', { name: 'Board' }).click()
    await page.getByRole('option', { name: 'Other', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Board' })).toHaveText('Other')
    await expect(page.locator('[data-task-id="A"]')).toHaveCount(0)
    await expect(page.locator('[data-task-id="C"]')).toBeVisible()
    await expect(page.getByRole('checkbox', { name: 'Select Task C' })).toBeEnabled()
    await page.screenshot({ path: testInfo.outputPath(`after-switch-${testInfo.project.name}.png`) })
    switchGate.resolve(undefined)
    await expect(page.getByRole('combobox', { name: 'Board' })).toHaveText('Other')
  } finally {
    statusGate.resolve(undefined); linkGate.resolve(undefined); configGate.resolve(undefined); switchGate.resolve(undefined); streamGate.resolve(undefined)
  }
})
