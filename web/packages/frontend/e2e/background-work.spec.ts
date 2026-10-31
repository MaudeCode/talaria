import { createServer, type ServerResponse } from 'node:http'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const task = (overrides: Record<string, unknown>) => ({
  task_id: 't', kind: 'background_command', status: 'running', title: 'x', started_at: 1770000100, updated_at: 1770000101, completed_at: null,
  result_available: false, child_sessions: [], exit_code: null, agents: null, pinned: true, dismissible: false, active: true, ...overrides,
})

/** The session's background work is the server's record: the composer's card and a delegation row show it (TAL-372). */
test('the background card shows the server\'s records with their result and Dismiss; a delegation row shows its progress', async ({ page }, testInfo) => {
  const sid = 'background-work'
  let dismissed = false
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Audit the repo', is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true, transcript_seq: null,
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
    task({ task_id: 'bg1', status: 'completed', title: 'Summarize the repo', result_available: true, pinned: !dismissed, dismissible: !dismissed, active: false }),
  ] } }))
  await page.route('**/api/background/result?**', (route) => route.fulfill({ json: { task_id: 'bg1', text: 'The repo has **three** packages.' } }))
  await page.route('**/api/background/dismiss', (route) => { dismissed = true; return route.fulfill({ json: { ok: true, task: task({ task_id: 'bg1', status: 'completed', pinned: false }) } }) })

  await page.goto(`/session/${sid}`)
  // TAL-1078: the pinned work is a count chip over the composer; the card opens in a dialog.
  const chip = page.locator('[data-notice="background"]').getByRole('button')
  await expect(chip).toHaveText('Background work · 2')
  await chip.click()
  const card = page.getByRole('dialog', { name: 'Background work' }).getByRole('region', { name: 'Background work' })
  await expect(card).toContainText('Fix CI')
  await expect(card).toContainText('Summarize the repo')
  await card.getByRole('button', { name: 'Show result' }).click()
  await expect(card).toContainText('The repo has three packages.')
  if (process.env.TAL372_SHOTS) await page.screenshot({ path: `${process.env.TAL372_SHOTS}/background-dialog-${testInfo.project.name}.png` })
  await page.keyboard.press('Escape')
  await expect(card).toHaveCount(0)
  await page.getByRole('button', { name: /Worked/ }).first().click()
  await expect(page.locator('.tool-card-background')).toBeVisible()
  await expect(page.locator('.tool-card-background')).toHaveText('2 of 3 done · 1 failed')
  if (process.env.TAL372_SHOTS) await page.screenshot({ path: `${process.env.TAL372_SHOTS}/background-${testInfo.project.name}.png` })

  await chip.click()
  await card.getByRole('button', { name: 'Dismiss' }).click()
  await expect(card).not.toContainText('Summarize the repo')
  await expect(card).toContainText('Fix CI')
  await page.keyboard.press('Escape')
  await expect(chip).toHaveText('Background work · 1')
})

/** TAL-1305: work the Agent starts mid-turn reaches the chip through the server's announcement, while the turn runs. */
test('background work the Agent starts during a turn shows on the chip when the server announces it', async ({ page }) => {
  const sid = 'background-live'
  const streamId = `${sid}-run`
  let started = false
  let sessions = null as ServerResponse | null
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    if (request.url?.startsWith('/sessions')) { sessions = response; response.write(': open\n\n'); return }
    response.write(`id: ${streamId}:1\nevent: token\ndata: ${JSON.stringify({ text: 'Delegating.' })}\n\n`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  const base = `http://127.0.0.1:${String(address.port)}`
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: sid, title: 'Delegate', messages: [{ role: 'user', id: 1, content: 'Split it' }], active_stream_id: streamId, is_streaming: true } } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: streamId, replay_available: false } }))
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `${base}/chat${new URL(route.request().url()).search}` }))
  await page.route('**/api/sessions/events*', (route) => route.continue({ url: `${base}/sessions` }))
  await page.route('**/api/session/draft', (route) => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/background/tasks?**', (route) => route.fulfill({ json: { session_id: sid, agent_available: true, tasks: started ? [task({ task_id: 'call_d', kind: 'delegation', title: 'Check logs' })] : [] } }))
  try {
    await page.goto(`/session/${sid}`)
    await expect(page.locator('.composer-notices [data-notice="live"]')).toContainText('Working')
    await expect.poll(() => sessions).not.toBeNull()
    await expect(page.locator('[data-notice="background"]')).toHaveCount(0)
    started = true
    sessions!.write(`event: sessions_changed\ndata: ${JSON.stringify({ type: 'sessions_changed', version: 2, reason: 'background_task', session_id: sid })}\n\n`)
    await expect(page.locator('[data-notice="background"]').getByRole('button')).toHaveText('Background work · 1')
    await expect(page.locator('.composer-notices [data-notice="live"]')).toContainText('Working')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => { resolve() }))
  }
})
