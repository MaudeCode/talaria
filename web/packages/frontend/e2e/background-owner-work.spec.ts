import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

// TAL-1336: an owner chat's processes and subagents in Background work and Agents. The boundary fixtures supply the
// server-owned rows and permissions; the real built UI shows them, reads a tail and sends a steer.
test('an owner chat shows its owner\'s work, reads a tail and steers a resident subagent', async ({ page }, testInfo) => {
  const sid = 'owner-work'
  const owner = { state: 'attached', reason: null, can_submit: true, can_interrupt: false, can_attach: false, restarting: false, revision: 2, execution_generation: 1, admissions: [] }
  const base = { started_at: 1770000100, updated_at: 1770000101, completed_at: null, child_sessions: [], exit_code: null, pinned: true, dismissible: false, active: true, status: 'running' }
  const tasks = [
    { ...base, task_id: 'owner-work-process', kind: 'process', title: 'npm run dev', agents: null, result_available: true, can_stop: true },
    { ...base, task_id: 'owner-work-resident', kind: 'delegation', title: 'Read the logs', agents: { total: 1, completed: 0, failed: 0, running: 1 }, result_available: true, can_stop: true, can_steer: true },
    { ...base, task_id: 'owner-work-rebuilt', kind: 'delegation', title: 'Check the tests', agents: { total: 1, completed: 0, failed: 0, running: 1 }, result_available: false, can_stop: false, can_steer: false },
  ]
  let steered: unknown = null
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Gateway chat', workspace: '/repo', is_streaming: false, read_only: true, can_branch: false, can_pin: true, can_archive: true, can_delete: false, can_duplicate: false, can_share: false, transcript_seq: null,
    owner_attachment: owner, messages: [{ role: 'user', id: 1, content: 'Start the dev server and check the logs.' }],
  } } }))
  await page.route('**/api/background/tasks?**', (route) => {
    const delegations = new URL(route.request().url()).searchParams.get('kind') === 'delegation'
    return route.fulfill({ json: { session_id: sid, agent_available: true, agents_working: true, owner_work: 'available',
      delegation_status: { availability: 'unsupported', running_count: null, awaiting_delivery_count: null, memory_live: null, visible: true, refresh: false },
      tasks: delegations ? tasks.filter((t) => t.kind === 'delegation') : tasks } })
  })
  await page.route('**/api/background/result?**', (route) => route.fulfill({ json: { task_id: 'owner-work-process', text: 'VITE ready in 312 ms\n\n  Local: http://localhost:5173/' } }))
  await page.route('**/api/background/steer', async (route) => {
    steered = route.request().postDataJSON()
    await route.fulfill({ json: { outcome: 'queued' } })
  })
  await page.route('**/api/git-info?**', (route) => route.fulfill({ json: { git: { is_git: false } } }))
  await page.route('**/api/list?**', (route) => route.fulfill({ json: { path: '.', entries: [] } }))
  const shot = async (state: string) => {
    if (process.env.TAL1336_SHOTS) await page.screenshot({ path: `${process.env.TAL1336_SHOTS}/${state}-${testInfo.project.name}.png` })
  }

  await page.goto(`/session/${sid}`)
  await page.locator('[data-notice="background"]').getByRole('button').click()
  const card = page.getByRole('dialog', { name: 'Background work' })
  const resident = card.locator('[data-task-id="owner-work-resident"]')
  await expect(resident.getByRole('button', { name: 'Steer' })).toBeVisible()
  await expect(card.locator('[data-task-id="owner-work-rebuilt"]').getByRole('button')).toHaveCount(0)
  await card.locator('[data-task-id="owner-work-process"]').getByRole('button', { name: 'Show result' }).click()
  await expect(card.getByText('VITE ready in 312 ms')).toBeVisible()
  await shot('background')
  await resident.getByRole('button', { name: 'Steer' }).click()
  await resident.getByRole('textbox', { name: 'Message for this agent' }).fill('Look at stderr too')
  await shot('steer')
  await resident.getByRole('button', { name: 'Send' }).click()
  await expect(resident.getByRole('textbox', { name: 'Message for this agent' })).toHaveCount(0)
  expect(steered).toEqual({ session_id: sid, task_id: 'owner-work-resident', text: 'Look at stderr too' })

  await page.keyboard.press('Escape')
  // Each width opens the side panel from its own control: the title bar, the panel toggle or the workspace control.
  for (const toggle of [page.locator('#btnTitlebarSidePanel'), page.getByRole('button', { name: 'Side panel', exact: true }), page.getByRole('button', { name: 'Show workspace panel' })]) {
    if (await toggle.isVisible()) { await toggle.click(); break }
  }
  await page.getByRole('tab', { name: 'Agents', exact: true }).click()
  const agents = page.getByRole('list', { name: 'Agents' })
  await expect(agents).toContainText('Check the tests')
  await expect(agents.locator('[data-task-id="owner-work-resident"]').getByRole('button', { name: 'Steer' })).toBeVisible()
  await shot('agents')
})
