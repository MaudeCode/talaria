import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts/fixtures/web-session.json'), 'utf8')) as { messaging_session: Record<string, unknown>; delivery_session: { messages: unknown[] } }

/** TAL-816: a Telegram chat's mirrored webhook and cron deliveries render as notices, not as the user's messages. */
test('shows a messaging session\'s mirrored deliveries as delivery notices', async ({ page }, testInfo) => {
  const sid = 'delivery-notices'
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { ...fixture.messaging_session, session_id: sid, messages: fixture.delivery_session.messages } } }))
  await page.goto(`/session/${sid}`)
  await expect(page.getByRole('note', { name: 'Webhook “injury-report” delivered' })).toContainText('Henderson OUT Wednesday (hamstring).')
  await expect(page.getByRole('note', { name: 'Scheduled job “Morning Brief” delivered' })).toContainText('Rain until noon.')
  await expect(page.locator('[data-role="user"]')).toHaveCount(2)
  await expect(page.locator('#messages')).not.toContainText('[Webhook delivery:')
  if (process.env.TAL816_SHOTS) await page.screenshot({ path: `${process.env.TAL816_SHOTS}/delivery-${testInfo.project.name}.png` })
})
