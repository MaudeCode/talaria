import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, settle, test } from './fixtures'

// Service-worker requests bypass page routing; these fixtures own every response.
test.use({ serviceWorkers: 'block' })

const fixture = (JSON.parse(readFileSync(join(import.meta.dirname, '../../../../contracts/fixtures/web-session.json'), 'utf8')) as { tool_outcome_views: { session: { messages: unknown[] } } }).tool_outcome_views

/** Opens every folded turn and tool group, so each call's row shows. */
async function openRows(page: Page) {
  for (let i = 0; i < 12; i += 1) {
    const shut = page.locator('.tool-worklog-summary[aria-expanded="false"]')
    if (!(await shut.count())) return
    await shut.first().click()
  }
}

test('collapsed tool rows show the server\'s outcome after the label, in its tone (TAL-2335)', async ({ page }, testInfo) => {
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'outcome-session', title: 'Tool row outcomes', messages: fixture.session.messages } } }))
  const outcome = (id: string) => page.locator(`[data-tool-id="${id}"] .tool-card-outcome`)
  for (const theme of ['dark', 'light'] as const) {
    if (theme === 'light') {
      await page.goto('/settings/appearance')
      await page.locator('#main [data-theme-val="light"]').click()
      await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
    }
    await page.goto('/session/outcome-session')
    await settle(page)
    await openRows(page)
    for (const [id, text, tone] of [
      ['call-send', 'Sent', 'neutral'], ['call-approve', 'Approved', 'neutral'], ['call-goal', 'Goal set', 'neutral'], ['call-memory', 'Added 1 memory', 'neutral'],
      ['call-pause', 'Paused', 'neutral'], ['call-test', 'Exit 1', 'error'], ['call-grep', 'No matches', 'neutral'], ['call-web-none', 'No results', 'neutral'],
      ['call-ask', 'Answered: MaudeCode/talaria', 'neutral'], ['call-move', 'Moved to Review', 'neutral'],
      ['call-issue', 'Resource not accessible by integration', 'error'], ['call-skill', 'Waiting for approval', 'attention'],
    ] as const) {
      await expect(outcome(id), id).toHaveText(text)
      await expect(outcome(id), id).toHaveAttribute('data-outcome-tone', tone)
    }
    for (const id of ['call-list', 'call-status', 'call-read', 'call-patch', 'call-web', 'call-mail']) await expect(outcome(id), id).toHaveCount(0)
    // Routine outcomes stay muted, never the full text colour; a failure takes the error colour and a wait the warning colour.
    const colors = await page.evaluate(() => {
      const of = (selector: string) => getComputedStyle(document.querySelector(selector)!).color
      const token = (name: string) => {
        const probe = document.createElement('span')
        probe.style.color = `var(${name})`
        document.body.append(probe)
        const color = getComputedStyle(probe).color
        probe.remove()
        return color
      }
      return { neutral: of('[data-tool-id="call-send"] .tool-card-outcome'), error: of('[data-tool-id="call-test"] .tool-card-outcome'), attention: of('[data-tool-id="call-skill"] .tool-card-outcome'), text: token('--text'), errorToken: token('--error'), warning: token('--warning') }
    })
    expect(colors.neutral).not.toBe(colors.text)
    expect(colors.error).toBe(colors.errorToken)
    expect(colors.attention).toBe(colors.warning)
    // The label gives way first; the outcome keeps at most 55% of its row.
    const widths = await outcome('call-issue').evaluate((el) => ({ outcome: el.getBoundingClientRect().width, row: el.parentElement!.getBoundingClientRect().width }))
    expect(widths.outcome).toBeLessThanOrEqual(widths.row * 0.55 + 1)
    const lists = page.locator('.tool-worklog-list:has(.tool-card-outcome)')
    for (let i = 0; i < await lists.count(); i += 1) await lists.nth(i).screenshot({ path: testInfo.outputPath(`tool-row-outcomes-${theme}-${testInfo.project.name}-${String(i + 1)}.png`) })
  }
})
