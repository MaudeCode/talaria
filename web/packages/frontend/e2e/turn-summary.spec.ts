import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, settle, test } from './fixtures'

// Service-worker requests bypass page routing; these fixtures own every response.
test.use({ serviceWorkers: 'block' })

type Row = Record<string, unknown>
const fixture = (JSON.parse(readFileSync(join(import.meta.dirname, '../../../../contracts/fixtures/web-session.json'), 'utf8')) as { tool_outcome_views: { session: { messages: Row[] } } }).tool_outcome_views
// The server's three turns, each reply with its run's duration and model as a settled turn records them.
const messages = fixture.session.messages.map((m) => (typeof m.message_id === 'string' && m.message_id.startsWith('outcome-answer-') ? { ...m, _turnDuration: 12, _usedModel: 'claude-sonnet-5-5' } : m))

test('a reply\'s footer says what its turn changed on its one line, cut with an ellipsis when narrow (TAL-2339)', async ({ page }, testInfo) => {
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'summary-session', title: 'Turn summary', messages } } }))
  await page.goto('/session/summary-session')
  await settle(page)
  const foot = (turn: number) => page.locator('.msg-row.assistant-turn').nth(turn - 1).locator('.msg-foot')
  // A phone drops the duration and model (as before) and keeps the summary.
  const phone = testInfo.project.name === 'mobile'
  await expect(foot(1).locator('.msg-run-meta')).toHaveText('12s · claude-sonnet-5-5 · Saved 1 memory · Changed 1 schedule · Sent 1 message')
  await expect(foot(1).locator('.msg-run-info')).toBeVisible({ visible: !phone })
  await expect(foot(1).locator('.msg-turn-summary')).toBeVisible()
  await expect(foot(2).locator('.msg-turn-summary')).toHaveText('Changed 1 file')
  // The failed GitHub call and the skill write waiting for approval count for nothing.
  await expect(foot(3).locator('.msg-turn-summary')).toHaveText('Updated 1 task')
  await page.locator('.msg-row.assistant-turn').first().hover()
  await page.locator('.msg-row.assistant-turn').first().screenshot({ path: testInfo.outputPath(`turn-summary-${testInfo.project.name}.png`) })
  for (const turn of [1, 2, 3]) {
    const line = await foot(turn).evaluate((el) => {
      const meta = el.querySelector<HTMLElement>('.msg-run-meta')!
      const tops = [...el.children].filter((child) => child.getBoundingClientRect().width > 0).map((child) => Math.round(child.getBoundingClientRect().top + child.getBoundingClientRect().height / 2))
      return { rows: new Set(tops.map((top) => Math.round(top / 8))).size, cut: meta.scrollWidth > meta.clientWidth, overflow: el.scrollWidth > el.clientWidth + 1, ellipsis: getComputedStyle(meta).textOverflow }
    })
    // One line at every width; only the run meta gives way, so the action icons never leave the row.
    expect(line.rows, `turn ${String(turn)}`).toBe(1)
    expect(line.overflow, `turn ${String(turn)}`).toBe(false)
    expect(line.ellipsis).toBe('ellipsis')
    if (turn === 1) expect(line.cut).toBe(phone)
  }
  const colors = await foot(1).evaluate((el) => ({ summary: getComputedStyle(el.querySelector('.msg-turn-summary')!).color, meta: getComputedStyle(el.querySelector('.msg-run-meta')!).color }))
  expect(colors.summary).not.toBe(colors.meta)
})
