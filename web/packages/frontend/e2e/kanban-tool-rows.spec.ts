import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, settle, test } from './fixtures'

// Service-worker requests bypass page routing; these fixtures own every response.
test.use({ serviceWorkers: 'block' })

const fixture = (JSON.parse(readFileSync(join(import.meta.dirname, '../../../../contracts/fixtures/web-session.json'), 'utf8')) as { tool_kanban_views: { session: { messages: unknown[] } } }).tool_kanban_views
const actions = { block: false, unblock: false, complete: true, archive: true, move_to: ['ready', 'done'] }
const task = (id: string, title: string, status: string) => ({ id, title, status, priority: 0, available_actions: actions, requires_running_exit_confirmation: false })

test('a Kanban call shows its verb and tasks, and a task row opens that task at its own address (TAL-2327)', async ({ page }, testInfo) => {
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}-${testInfo.project.name}.png`) })
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'kanban-rows', title: 'Plan the release', messages: fixture.session.messages } } }))
  let current = 'default'
  const switched: string[] = []
  await page.route('**/api/kanban/boards**', (route) => {
    if (route.request().method() !== 'GET') { switched.push(route.request().url()); current = 'ops'; return route.fulfill({ json: { result: {}, current, read_only: false } }) }
    return route.fulfill({ json: { boards: [{ slug: 'default', name: 'Default', total: 1, removable: false }, { slug: 'ops', name: 'Ops', total: 1, removable: true }], current, read_only: false } })
  })
  await page.route(/\/api\/kanban\/board(\?|$)/, (route) => {
    const ops = new URL(route.request().url()).searchParams.get('board') === 'ops'
    const tasks = ops ? [task('t_9', 'Write release notes', 'running')] : [task('t_1', 'Fix login', 'ready')]
    return route.fulfill({ json: { changed: true, latest_event_id: 1, read_only: false, bulk_move_targets: ['done'], create_statuses: ['todo'], lane_by_profile: false, columns: ['ready', 'running'].map((name) => ({ name, label: name, tasks: tasks.filter((t) => t.status === name) })) } })
  })
  await page.route('**/api/kanban/stats**', (route) => route.fulfill({ json: { by_status: {}, total: 1, status_counts: [] } }))
  await page.route(/\/api\/kanban\/tasks\/[^/?]+(\?.*)?$/, (route) => route.fulfill({ json: { task: task('t_9', 'Write release notes', 'running'), last_card_action: null, links: { parents: [], children: [] }, link_tasks: [] } }))
  await page.route('**/api/kanban/tasks/*/log**', (route) => route.fulfill({ json: { log: [] } }))

  await page.goto('/session/kanban-rows')
  await settle(page)
  // A settled turn folds its calls under its summary; open it to see each call.
  await page.getByRole('button', { name: 'Worked' }).click()
  // The four Kanban calls fold under their kind's summary.
  await page.getByRole('button', { name: 'Worked on tasks' }).click()
  const created = page.locator('[data-tool-id="call-create"]')
  await expect(created).toHaveAttribute('data-tool-kind', 'kanban')
  await expect(created.locator('.tool-card-name')).toHaveText('Created Write release notes')
  await expect(page.locator('[data-tool-id="call-list"] .tool-card-name')).toHaveText('Listed tasks')
  await expect(page.locator('[data-tool-id="call-complete"] .tool-card-name')).toHaveText('Completed t_1')
  await created.locator('.tool-card-header').click()
  const link = created.getByRole('link', { name: 'Write release notes' })
  await expect(link).toHaveAttribute('href', '/kanban?board=ops&task=t_9')
  await expect(created.locator('.tool-card-result')).not.toContainText('"task_id"')
  await shot('kanban-tool-rows')

  await link.click()
  await expect(page).toHaveURL(/\/kanban\?board=ops&task=t_9$/)
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Write release notes')
  expect(switched).toHaveLength(1)
  await shot('kanban-task-address')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(/\/kanban$/)
})
