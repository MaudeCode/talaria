import { mkdirSync } from 'node:fs'
import { expect, test } from './fixtures'
import { bootTestServer } from '../../server/dist/test/harness.js'
import { SpaShell } from '../../server/dist/spa.js'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'
import type { SidecarParams, SidecarResultInput } from '@maudecode/talaria-web-contracts'

test.use({ serviceWorkers: 'block' })
const completed = (params: SidecarParams<'chat.start'>): SidecarResultInput<'chat.start'> => ({
  status: 'completed', messages: [...params.conversation_history, { role: 'user', content: params.user_message }, { role: 'assistant', content: 'answer' }], final_response: 'answer', error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '',
  usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: { context_length: 200000 }, model: 'test-model', provider: 'test', compressed: false, agent_session_id: 'synthetic', token_sent: true, pending_steer: '', live_tool_calls: [],
})

test('builds, edits, explicitly starts and pauses a real cross-chat queue across reload', async ({ page }, info) => {
  const sidecar = new FakeSidecar()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started: string[] = []
  sidecar.respond('chat.start', async (params) => { started.push(params.session_id); await gate; return completed(params) })
  const server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' } })
  try {
    const sessions = []
    for (const title of ['Review changes', 'Write checks']) {
      const session = await server.deps.sessionStore.newSession({ profile: 'default' })
      session.title = title
      session.messages = [{ role: 'user', content: `Existing ${title}` }, { role: 'assistant', content: 'Ready' }]
      await server.deps.sessionStore.save(session)
      sessions.push(session)
    }
    const baseline = process.env.TALARIA_QUEUE_BASELINE_WEB
    if (baseline && process.env.TALARIA_QUEUE_EVIDENCE) {
      const spa = server.deps.spa
      server.deps.spa = new SpaShell(`${baseline}/static/dist`)
      await page.goto(`${server.base}/tasks`)
      await expect(page.getByRole('button', { name: 'New job', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'New queue', exact: true })).toHaveCount(0)
      mkdirSync(process.env.TALARIA_QUEUE_EVIDENCE, { recursive: true })
      await page.screenshot({ path: `${process.env.TALARIA_QUEUE_EVIDENCE}/before-${info.project.name}.png` })
      server.deps.spa = spa
    }
    await page.goto(`${server.base}/tasks`)
    await page.getByRole('button', { name: 'New queue', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'New queue' })).toBeVisible()
    for (const [title, message] of [['Review changes', 'Summarise the changes'], ['Write checks', 'Check the summary']] as const) {
      await page.getByRole('combobox', { name: 'Chat', exact: true }).click()
      await page.getByRole('option', { name: title, exact: true }).click()
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill(message)
      await page.getByRole('button', { name: 'Add message', exact: true }).click()
    }
    const rows = page.locator('.queue-card-list > li')
    await expect(rows).toHaveCount(2)
    await rows.first().getByRole('button', { name: 'Edit queued message' }).click()
    const editor = rows.first().getByRole('textbox')
    await editor.fill('Summarise the changes carefully')
    await editor.press('Enter')
    await page.getByRole('button', { name: 'Save queue', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible()
    expect(started).toEqual([])
    await page.reload()
    await expect(rows).toHaveCount(2)
    await expect(rows.first()).toContainText('Summarise the changes carefully')
    const evidence = process.env.TALARIA_QUEUE_EVIDENCE
    if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: `${evidence}/draft-${info.project.name}.png` }) }
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect.poll(() => started).toEqual([sessions[0]!.session_id])
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible()
    release()
    await expect(rows.first()).toContainText('Completed')
    await expect(rows.nth(1)).toContainText('Queued')
    expect(started).toHaveLength(1)
    if (evidence) await page.screenshot({ path: `${evidence}/paused-${info.project.name}.png` })
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    await expect.poll(() => started).toEqual(sessions.map((s) => s.session_id))
    await expect(rows.nth(1)).toContainText('Completed')
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0)
    await page.reload()
    await expect(rows.nth(1)).toContainText('Completed')
    expect(started).toHaveLength(2)
  } finally {
    release()
    await page.goto('about:blank')
    await server.close()
  }
})
