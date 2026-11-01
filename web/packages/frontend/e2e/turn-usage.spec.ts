import { expect, test } from './fixtures'
import { hydrateAnchorActivityScenes, withTurnIds } from '../../server/dist/sessions/anchor.js'
import { redactSessionData } from '../../server/dist/redact.js'

test.use({ serviceWorkers: 'block' })

// TAL-1076: each reply's footer shows the server's record of that turn's own usage, opening its cache and cost figures.
for (const shown of [true, false]) {
  test(`a reply shows its own token usage ${shown ? 'with' : 'without'} Show token usage`, async ({ context, page, request }, testInfo) => {
    const settings = { ...await (await request.get('/api/settings')).json(), show_token_usage: shown }
    await context.route('**/api/settings', (route) => route.fulfill({ json: settings }))
    const messages = [
      { role: 'user', id: 1, content: 'Summarize the release notes' },
      { role: 'assistant', id: 2, content: 'Three fixes and one new setting.', _turnDuration: 4.2, _usedModel: 'test-model', _turnUsage: { input_tokens: 12_345, output_tokens: 678, cache_read_tokens: 9_000, cache_write_tokens: 120, estimated_cost: 0.0123, cache_hit_percent: 73 } },
      { role: 'user', id: 3, content: 'And the second part?' },
      { role: 'assistant', id: 4, content: 'The setting is off by default.', _turnDuration: 2.1, _usedModel: 'test-model', _turnUsage: { input_tokens: 820, output_tokens: 44, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost: null, cache_hit_percent: null } },
    ]
    await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
      session_id: 'turn-usage', title: 'Release notes', messages: redactSessionData({ messages: hydrateAnchorActivityScenes(withTurnIds(messages), {}) }, true).messages,
    } } }))
    await page.goto('/session/turn-usage')
    await expect(page.locator('[data-final-answer="1"]').last()).toContainText('The setting is off by default.')
    const summaries = page.locator('.msg-turn-usage')
    if (!shown) {
      await expect(summaries).toHaveCount(0)
      await page.screenshot({ path: testInfo.outputPath(`turn-usage-off-${testInfo.project.name}.png`) })
      return
    }
    await expect(summaries).toHaveText(['12.3K in · 678 out', '820 in · 44 out'])
    await summaries.first().click()
    const popup = page.getByRole('dialog', { name: 'Token usage for this reply: 12.3K in, 678 out' })
    await expect(popup.locator('span')).toHaveText(['Input tokens: 12,345', 'Output tokens: 678', 'Estimated cost: $0.0123', 'Cache: 73% hit (9,000 read / 120 write)'])
    await page.screenshot({ path: testInfo.outputPath(`turn-usage-open-${testInfo.project.name}.png`) })
    await page.keyboard.press('Escape')
    await expect(popup).toBeHidden()
    await summaries.last().focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog').locator('span')).toHaveText(['Input tokens: 820', 'Output tokens: 44'])
    await page.screenshot({ path: testInfo.outputPath(`turn-usage-unpriced-${testInfo.project.name}.png`) })
  })
}
