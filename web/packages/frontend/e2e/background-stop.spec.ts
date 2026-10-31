import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block', video: 'on' })

// The boundary fixtures supply server-owned permissions; the real built UI performs the request and refresh.
test('Stop uses the shared action in Background work and Agents and waits for completion', async ({ page }, testInfo) => {
  const sid = 'background-stop'
  const before = Boolean(process.env.TAL1172_BEFORE)
  let requested = ''
  let completed = false
  const row = (id: string, kind: string, title: string) => ({
    task_id: id, kind, title, status: completed ? 'cancelled' : 'running', can_stop: !completed,
    started_at: 1770000100, updated_at: 1770000101, completed_at: completed ? 1770000110 : null,
    result_available: false, child_sessions: [], exit_code: null, agents: null, pinned: !completed, dismissible: false, active: !completed,
  })
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Background work', workspace: '/repo', is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true, transcript_seq: null,
    messages: [{ role: 'user', id: 1, content: 'Check the tests and review the logs.' }],
  } } }))
  await page.route('**/api/background/tasks?**', (route) => {
    const tasks = [row('d1', 'delegation', 'Review the logs'), row('proc_1', 'process', 'Run the tests')]
    return route.fulfill({ json: { session_id: sid, agent_available: true, agents_working: !completed,
      tasks: new URL(route.request().url()).searchParams.get('kind') === 'delegation' ? tasks.slice(0, 1) : tasks } })
  })
  await page.route('**/api/background/stop', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ session_id: sid, task_id: requested })
    await route.fulfill({ json: { outcome: 'stopped' } })
  })
  await page.route('**/api/git-info?**', (route) => route.fulfill({ json: { git: { is_git: false } } }))
  await page.route('**/api/list?**', (route) => route.fulfill({ json: { path: '.', entries: [] } }))
  await page.goto(`/session/${sid}`)
  await page.locator('[data-notice="background"]').getByRole('button').click()
  const card = page.getByRole('dialog', { name: 'Background work' })
  await expect(card.getByText('Run the tests', { exact: false })).toBeVisible()
  const shot = async (state: string) => {
    if (process.env.TAL1172_SHOTS) await page.screenshot({ path: `${process.env.TAL1172_SHOTS}/${state}-${testInfo.project.name}.png` })
  }
  await shot(before ? 'before-background' : 'after-background')
  if (!before) {
    requested = 'proc_1'
    await card.locator('[data-task-id="proc_1"]').getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(card.locator('[data-task-id="proc_1"]')).toHaveAttribute('data-status', 'running')
  }
  await page.keyboard.press('Escape')
  if (testInfo.project.name === 'mobile') await page.locator('#btnTitlebarSidePanel').click()
  else await page.getByRole('button', { name: 'Show workspace panel' }).click()
  await page.getByRole('tab', { name: 'Agents', exact: true }).click()
  const agents = page.getByRole('list', { name: 'Agents' })
  await expect(agents).toContainText('Review the logs')
  await shot(before ? 'before-agents' : 'after-agents')
  if (!before) {
    requested = 'd1'
    await agents.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(agents.locator('[data-task-id="d1"]')).toHaveAttribute('data-status', 'running')
    completed = true
    await page.reload()
    await expect(agents.locator('[data-task-id="d1"]')).toHaveAttribute('data-status', 'cancelled')
    await expect(agents.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
    await shot('completed-agents')
  }
})
