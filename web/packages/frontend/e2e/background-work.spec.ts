import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const task = (overrides: Record<string, unknown>) => ({
  task_id: 't', kind: 'background_command', status: 'running', title: 'x', started_at: 1770000100, updated_at: 1770000101, completed_at: null,
  result_available: false, child_session_id: null, exit_code: null, agents: null, pinned: true, dismissible: false, ...overrides,
})

/** The session's background work is the server's record: the composer's card and a delegation row show it (TAL-372). */
test('the background card shows the server\'s records with their result and Dismiss; a delegation row shows its progress', async ({ page }, testInfo) => {
  const sid = 'background-work'
  let dismissed = false
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Audit the repo', is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_duplicate: true, transcript_seq: null,
    messages: [
      { role: 'user', id: 1, content: 'Split the audit', _turn_id: 'split' },
      { role: 'assistant', id: 2, content: 'Started three subagents.', _turn_id: 'split', _anchor_activity_scene: {
        version: 'activity_scene_v1', final_answer: 'Started three subagents.', activity_rows_total: 1, activity_rows_offset: 0, activity_rows_complete: true, activity_rows_omitted: 0,
        activity_rows: [{ row_id: 'tool:c1', order_index: 0, role: 'tool', tool: { id: 'c1', name: 'delegate_task', kind: 'delegate', target: '', args: {}, preview: null, result: null, done: true, is_error: false, duration: 1.2, cost_usd: null,
          background: { task_ids: ['split-1', 'split-2'], status: 'completed', agents: { total: 3, completed: 2, failed: 1, running: 0 } } } }],
      } },
    ],
  } } }))
  await page.route('**/api/background/tasks?**', (route) => route.fulfill({ json: { session_id: sid, agent_available: true, tasks: [
    task({ task_id: 'd1', kind: 'delegation', title: 'Fix CI' }),
    task({ task_id: 'bg1', status: 'completed', title: 'Summarize the repo', result_available: true, pinned: !dismissed, dismissible: !dismissed }),
  ] } }))
  await page.route('**/api/background/result?**', (route) => route.fulfill({ json: { task_id: 'bg1', text: 'The repo has **three** packages.' } }))
  await page.route('**/api/background/dismiss', (route) => { dismissed = true; return route.fulfill({ json: { ok: true, task: task({ task_id: 'bg1', status: 'completed', pinned: false }) } }) })

  await page.goto(`/session/${sid}`)
  const card = page.getByRole('region', { name: 'Background work' })
  await expect(card).toContainText('Fix CI')
  await expect(card).toContainText('Summarize the repo')
  await card.getByRole('button', { name: 'Show result' }).click()
  await expect(card).toContainText('The repo has three packages.')
  await page.getByRole('button', { name: /Worked/ }).first().click()
  await expect(page.locator('.tool-card-background')).toBeVisible()
  await expect(page.locator('.tool-card-background')).toHaveText('2 of 3 done · 1 failed')
  if (process.env.TAL372_SHOTS) await page.screenshot({ path: `${process.env.TAL372_SHOTS}/background-${testInfo.project.name}.png` })

  await card.getByRole('button', { name: 'Dismiss' }).click()
  await expect(card).not.toContainText('Summarize the repo')
  await expect(card).toContainText('Fix CI')
})
