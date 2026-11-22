import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, expectNoOverflow, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

// TAL-2684: the composer wiring and layout of the Bot Chat's teammate requests; their states and a failed reread are
// owned by src/features/background/BotDeliveries.test.tsx.
test('the Bot Chat\'s composer chip opens its teammate requests without overflowing', async ({ page }, testInfo) => {
  const shared = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts/fixtures/bot-deliveries.json'), 'utf8')) as Record<string, unknown>
  const sid = 'bot-chat-tip'
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Bot Chat', is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_rename: true, can_move: true, can_duplicate: true, can_share: true, transcript_seq: null,
    messages: [{ role: 'user', content: 'Get the Q3 summary ready' }, { role: 'assistant', content: 'I asked Scout for the numbers and Writer for the draft.' }],
  } } }))
  await page.route('**/api/session/bot-deliveries?**', (route) => route.fulfill({ json: shared.available }))
  await page.goto(`/session/${sid}`)
  await expect(page.locator('#msg')).toBeVisible()
  const shot = async (name: string) => {
    if (process.env.TAL2684_SHOTS) await page.screenshot({ path: `${process.env.TAL2684_SHOTS}/${name}-${testInfo.project.name}.png` })
  }
  const chip = page.locator('[data-notice="bot-deliveries"]').getByRole('button')
  await expect(chip).toHaveText('Teammate requests · 4')
  await shot('chip')
  await expectNoOverflow(page, 'chip', shot)
  await chip.click()
  const dialog = page.getByRole('dialog', { name: 'Teammate requests' })
  await expect(dialog.getByRole('listitem')).toHaveCount(4)
  await shot('dialog')
  await expectNoOverflow(page, 'dialog', shot)
})
