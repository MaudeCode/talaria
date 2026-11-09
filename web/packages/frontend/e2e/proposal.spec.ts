import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { bootTestServer } from '../../server/dist/test/harness.js'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'
import { Session } from '../../server/dist/sessions/session.js'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** Phone, the Duo outer display and split view, and the Duo inner display (foldable-web viewports). */
const WIDTHS = [[382, 580], [385, 571], [669, 867], [951, 585]] as const

// TAL-1967: the agent proposes a setting change through the harness toolset; the owner approves it on its transcript
// card, the server applies it through the settings route, and the session hears the outcome.
test('shows a proposal on its tool card and applies it once approved', async ({ page }, testInfo) => {
  const sidecar = new FakeSidecar()
  const handed: string[] = []
  sidecar.respond('chat.start', (params) => {
    handed.push(params.user_message)
    return { status: 'completed', failed: false, partial: false, error: null, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '',
      usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: {},
      model: 'test-model', provider: 'test', compressed: false, agent_session_id: params.session_id, token_sent: true, pending_steer: '', live_tool_calls: [],
      messages: [...params.conversation_history, { role: 'user', content: params.user_message }, { role: 'assistant', content: 'Noted.' }], final_response: 'Noted.' }
  })
  const server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' } })
  const sid = '20261109_090000_propose'
  const now = Math.floor(Date.now() / 1000)
  const shot = async (name: string) => { if (process.env.TAL1967_SHOTS) await page.screenshot({ path: `${process.env.TAL1967_SHOTS}/${name}-${testInfo.project.name}.png`, fullPage: true }) }
  try {
    const workspace = join(server.state, 'workspace')
    mkdirSync(workspace, { recursive: true })
    // The agent proposes from its own session, which must exist first.
    await server.deps.sessionStore.save(new Session({ session_id: sid, title: 'Tune the chat', profile: 'default', workspace, messages: [] }, { workspace, model: null }))
    const reply = await sidecar.serverRequest('server.proposal_put', { caller_session_id: sid, kind: 'setting', payload: { key: 'show_token_usage', value: true }, timeout_seconds: 3600 })
    if (!('result' in reply)) throw new Error(JSON.stringify(reply))
    const result = reply.result as { proposal_id: string }
    const row = await server.deps.sessionStore.get(sid)
    row.messages = [
      { role: 'user', content: 'Show token usage under each answer', timestamp: now - 60 },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-propose', function: { name: 'propose', arguments: JSON.stringify({ kind: 'setting', payload: { key: 'show_token_usage', value: true } }) } }], timestamp: now - 55 },
      { role: 'tool', tool_call_id: 'call-propose', content: JSON.stringify(result), timestamp: now - 54 },
      { role: 'assistant', content: 'I proposed the change; approve it on the card.', timestamp: now - 50 },
    ]
    await server.deps.sessionStore.save(row)

    await page.goto(`${server.base}/session/${sid}`)
    await settle(page)
    const card = page.locator(`[data-proposal="${result.proposal_id}"]`)
    await expect(card).toHaveAttribute('data-proposal-status', 'pending')
    await expect(card).toContainText('Change setting show_token_usage')
    await expect(card).toContainText('-show_token_usage: false')
    await expect(card).toContainText('+show_token_usage: true')
    await shot('pending')
    const original = page.viewportSize()
    for (const [width, height] of WIDTHS) {
      await page.setViewportSize({ width, height })
      await card.scrollIntoViewIfNeeded()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal scroll at ${String(width)}px`).toBe(true)
      await expect(card.getByRole('button', { name: 'Approve' })).toBeVisible()
      await shot(`pending-${String(width)}`)
    }
    if (original) await page.setViewportSize(original)

    await card.getByRole('button', { name: 'Approve' }).click()
    await expect(card).toHaveAttribute('data-proposal-status', 'applied')
    await expect(card).toContainText('Set show_token_usage to true.')
    await expect(card.getByRole('button')).toHaveCount(0)
    await shot('applied')
    expect((await server.deps.settings.load()).show_token_usage).toBe(true)
    await expect.poll(() => handed.length).toBe(1)
    expect(handed[0]).toContain(`Proposal ${result.proposal_id} (Change setting show_token_usage) was approved and applied`)
  } finally {
    await page.goto('about:blank')
    await server.close()
  }
})
