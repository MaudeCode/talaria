import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { bootTestServer } from '../../server/dist/test/harness.js'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'
import { Session } from '../../server/dist/sessions/session.js'
import type { Page, TestInfo } from '@playwright/test'
import { expect, expectNoOverflow, settle, test } from './fixtures'
import { decisionItem as item } from './demo-server'

test.use({ serviceWorkers: 'block' })

/** `shot` saves a full-page screenshot when DECISION_SHOTS names a folder. */
function shooter(page: Page, testInfo: TestInfo) {
  return async (name: string) => { if (process.env.DECISION_SHOTS) await page.screenshot({ path: `${process.env.DECISION_SHOTS}/${name}-${testInfo.project.name}.png`, fullPage: true }) }
}

// TAL-1964: the agent opens a review through the harness toolset; the user answers it on its page and hands it back.
test('answers, defers, reviews and submits a decision review the agent opened', async ({ page }, testInfo) => {
  const sidecar = new FakeSidecar()
  const handed: string[] = []
  sidecar.respond('chat.start', (params) => {
    handed.push(params.user_message)
    return { status: 'completed', failed: false, partial: false, error: null, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '',
      usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: {},
      model: 'test-model', provider: 'test', compressed: false, agent_session_id: params.session_id, token_sent: true, pending_steer: '', live_tool_calls: [],
      messages: [...params.conversation_history, { role: 'user', content: params.user_message }, { role: 'assistant', content: 'Reading the answers.' }], final_response: 'Reading the answers.' }
  })
  const server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' } })
  const sid = '20261108_120000_decide'
  const now = Math.floor(Date.now() / 1000)
  const shot = shooter(page, testInfo)
  try {
    const workspace = join(server.state, 'workspace')
    mkdirSync(workspace, { recursive: true })
    await server.deps.sessionStore.save(new Session({ session_id: sid, title: 'Audit the settings', profile: 'default', workspace, messages: [{ role: 'user', content: 'Audit the settings', timestamp: now - 60 }, { role: 'assistant', content: 'I have three decisions for you.', timestamp: now - 50 }] }, { workspace, model: null }))
    const put = await sidecar.serverRequest('server.decision_review_put', { caller_session_id: sid, title: 'Settings audit', items: [item('retention', 'Retention'), item('telemetry', 'Telemetry'), item('autosave', 'Autosave')] })
    if (!('result' in put)) throw new Error(JSON.stringify(put))
    const reviewId = (put.result as { review_id: string }).review_id

    // The chat shows the open review above the composer, and the sidebar row asks for attention.
    await page.goto(`${server.base}/session/${sid}`)
    await settle(page)
    const chip = page.locator('#composerWrap [data-notice="decision-review"]')
    await expect(chip).toContainText('Decision review: 0 of 3 answered')
    await shot('chat-chip')
    await chip.getByRole('button', { name: 'Open' }).click()
    await expect(page).toHaveURL(new RegExp(`/decisions/${reviewId}$`))

    const decide = page.locator('[data-section="decisions"]')
    await expect(page.getByRole('heading', { name: 'Retention policy' })).toBeVisible()
    await expect(decide.locator('[data-recommended]')).toHaveAttribute('data-choice', 'keep')
    await shot('decide')
    await expectNoOverflow(page, 'decide', shot)
    await page.getByRole('radio', { name: /Change Retention/ }).check()
    await page.getByRole('textbox', { name: 'Notes' }).fill('Thirty days is enough')
    await page.getByRole('button', { name: 'Save & next' }).click()
    await expect(page.getByRole('heading', { name: 'Telemetry policy' })).toBeVisible()
    await page.getByRole('radio', { name: /Keep Telemetry/ }).check()
    await page.getByRole('button', { name: 'Save & next' }).click()
    await expect(page.getByRole('heading', { name: 'Autosave policy' })).toBeVisible()
    await page.getByRole('button', { name: 'Come back to this later' }).click()
    await expect(page).toHaveURL(/view=answers/)
    await expect.poll(() => server.deps.decisions.get(reviewId).then((review) => review.progress)).toEqual({ total: 3, answered: 2, deferred: 1, needs_review: 0 })

    // All three answers survive a reload.
    await page.reload()
    const row = (id: string) => page.locator(`[data-decision-item="${id}"]`)
    await expect(row('retention')).toHaveAttribute('data-answer', 'answered')
    await expect(row('retention')).toContainText('Change Retention')
    await expect(row('telemetry')).toContainText('Keep Telemetry')
    await expect(row('autosave')).toHaveAttribute('data-answer', 'deferred')
    await expect(page.locator('[data-review-status]')).toContainText('Open · 2 of 3 answered')
    await shot('answers')
    await expectNoOverflow(page, 'answers', shot)

    await page.getByRole('button', { name: 'Submit' }).click()
    await expect(page.locator('[data-review-status]')).toHaveAttribute('data-review-status', 'submitted')
    await expect(page.getByRole('button', { name: 'Submit' })).toBeDisabled()
    await shot('submitted')
    await expect.poll(() => handed.length).toBe(1)
    expect(handed[0]).toContain(`(${reviewId}) was submitted`)

    // Back in the chat: the handoff turn is there and the chip is gone.
    await page.getByRole('button', { name: 'Back to chat' }).click()
    await expect(page).toHaveURL(new RegExp(`/session/${sid}$`))
    await expect(page.getByText(`The decision review "Settings audit" (${reviewId}) was submitted.`, { exact: false })).toBeVisible()
    await expect(chip).toHaveCount(0)
    await shot('handoff')
  } finally {
    await page.goto('about:blank')
    await server.close()
  }
})

// TAL-1966: the profile's reviews outlive their chat on the Decisions page, reached from the sidebar's More.
test('lists the profile\'s reviews on Decisions and opens a review and its chat', async ({ page }, testInfo) => {
  const sidecar = new FakeSidecar()
  const server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' } })
  const shot = shooter(page, testInfo)
  const now = Math.floor(Date.now() / 1000)
  try {
    const workspace = join(server.state, 'workspace')
    mkdirSync(workspace, { recursive: true })
    const ids: string[] = []
    for (const [sid, chat, title] of [['20261108_120000_older', 'Audit the settings', 'Settings audit'], ['20261108_130000_newer', 'Plan the release', 'Release choices']] as const) {
      await server.deps.sessionStore.save(new Session({ session_id: sid, title: chat, profile: 'default', workspace, messages: [{ role: 'user', content: chat, timestamp: now - 60 }] }, { workspace, model: null }))
      const put = await sidecar.serverRequest('server.decision_review_put', { caller_session_id: sid, title, items: [item('retention', 'Retention'), item('telemetry', 'Telemetry')] })
      if (!('result' in put)) throw new Error(JSON.stringify(put))
      ids.push((put.result as { review_id: string }).review_id)
    }

    await page.goto(`${server.base}/decisions`)
    await settle(page)
    const rows = page.locator('[data-section="decisions"] [data-decision-review]')
    await expect(rows).toHaveCount(2)
    // Newest first, as the server orders them.
    expect(await rows.evaluateAll((all) => all.map((row) => row.getAttribute('data-decision-review')))).toEqual([ids[1], ids[0]])
    await expect(rows.first()).toContainText('Release choices')
    await expect(rows.first()).toContainText('Plan the release')
    await expect(rows.first()).toContainText('0 of 2 answered')
    await shot('decisions')
    await expectNoOverflow(page, 'decisions', shot)

    await rows.first().getByRole('link', { name: 'Release choices' }).click()
    await expect(page).toHaveURL(new RegExp(`/decisions/${ids[1]!}$`))
    await page.goBack()
    await rows.last().getByRole('link', { name: 'Open chat: Audit the settings' }).click()
    await expect(page).toHaveURL(/\/session\/20261108_120000_older$/)
  } finally {
    await page.goto('about:blank')
    await server.close()
  }
})
