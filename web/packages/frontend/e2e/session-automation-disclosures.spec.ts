import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

// TAL-1639: the server files cron and webhook rows under its Scheduled and Webhook groups; the sidebar shows them as disclosures.
test('Scheduled and Webhook sessions sit in collapsed disclosures with a View all list', async ({ page }, info) => {
  const now = Math.floor(Date.now() / 1000)
  const base = { is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true, is_messaging_session: false }
  const chat = (id: string, title: string, ago: number) => ({ ...base, session_id: id, title, sort_ts: now - ago, source_kind: 'webui', sidebar_group: 'recent' })
  const cron = Array.from({ length: 7 }, (_, i) => ({ ...base, session_id: `cron_daily_${String(i)}`, title: `Daily digest ${String(i + 1)}`, sort_ts: now - 3600 * (i + 1), source_kind: 'cron', read_only: true, sidebar_group: 'scheduled' }))
  const hooks = [{ ...base, session_id: 'hook-deploy', title: 'Deploy hook', sort_ts: now - 7200, source_kind: 'webhook', read_only: true, sidebar_group: 'webhook' }]
  await page.route(/\/api\/sessions(\?|$)/, async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...await response.json(), sessions: [chat('chat-plan', 'Plan the release', 60), chat('chat-notes', 'Meeting notes', 600), ...cron, ...hooks],
      scheduled_session_count: 7, scheduled_sessions_truncated: false, webhook_session_count: 1, webhook_sessions_truncated: false } })
  })
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { ...chat('chat-plan', 'Plan the release', 60), messages: [] } } }))
  await page.goto('/session/chat-plan')
  await settle(page)
  if (await page.locator('#btnHamburger').isVisible()) await page.locator('#btnHamburger').click()

  const scheduled = page.getByRole('button', { name: /Scheduled sessions/ })
  const webhook = page.getByRole('button', { name: /Webhook sessions/ })
  await expect(scheduled).toHaveAttribute('aria-expanded', 'false')
  await expect(webhook).toHaveAttribute('aria-expanded', 'false')
  await expect(scheduled).toContainText('7')
  await expect(page.locator('[data-sid="cron_daily_0"]')).toBeHidden()
  await expect(page.locator('[data-sid="chat-notes"]')).toBeVisible()
  await page.screenshot({ path: info.outputPath('collapsed.png') })

  await scheduled.click()
  await expect(page.locator('[data-sid^="cron_daily_"]:visible')).toHaveCount(5)
  await page.screenshot({ path: info.outputPath('expanded.png') })

  await page.getByRole('button', { name: 'View all' }).click()
  const dialog = page.getByRole('dialog', { name: 'Scheduled sessions' })
  await expect(dialog.locator('[data-sid]')).toHaveCount(7)
  await page.screenshot({ path: info.outputPath('view-all.png') })
})
