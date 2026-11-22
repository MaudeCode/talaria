import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })
/** The views the server ships (contracts/fixtures/native-handoff.json); the server suite pins them. */
const views = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/native-handoff.json', import.meta.url), 'utf8')) as Record<string, { session_id: string; state: string }>
const sid = views.read!.session_id
/** iPhone Duo's outer, inner and split Safari viewports (CSS px), where the dialog must stay usable. */
const POSES = [[382, 580], [594, 368], [669, 867], [951, 585], [385, 571]] as const

async function openChat(page: Page, answers: Record<string, unknown>[]) {
  const sent: unknown[] = []
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Native chat', workspace: '/workspace/native', messages: [],
    owner_attachment: { state: 'attached', reason: null, can_submit: true, can_interrupt: false, can_attach: false, restarting: false, revision: 1, execution_generation: 1, admissions: [], queued_input_count: 0 },
  } } }))
  await page.route('**/api/session/native-handoff', (route) => {
    sent.push(route.request().postDataJSON())
    return route.fulfill({ json: answers.length > 1 ? answers.shift() : answers[0] })
  })
  await page.goto(`/session/${sid}`)
  await page.locator('#msg').fill('/handoff')
  await page.locator('#btnSend').click()
  return sent
}

test('/handoff shows the destination, requests once on Hand off and follows the gateway', async ({ page }, testInfo) => {
  const completed = { ...views.queued, state: 'completed', outcome: null, can_request: true, can_cancel: false }
  const sent = await openChat(page, [views.read!, views.queued!, completed])
  const dialog = page.getByRole('dialog', { name: 'Hand off chat' })
  await expect(dialog.getByRole('combobox', { name: 'Destination' })).toHaveText('Phone (telegram)')
  await page.screenshot({ path: testInfo.outputPath('handoff-ready.png') })
  expect(sent).toEqual([{ session_id: sid, action: 'read' }])
  await dialog.getByRole('button', { name: 'Hand off' }).click()
  await expect(dialog.getByRole('button', { name: 'Cancel handoff' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('handoff-queued.png') })
  await expect(dialog.getByRole('status')).toHaveText('Handed off to telegram')
  await page.screenshot({ path: testInfo.outputPath('handoff-completed.png') })
  expect(sent.filter((body) => (body as { action: string }).action === 'request')).toEqual([{ session_id: sid, action: 'request', platform: 'telegram' }])
})

test('the handoff dialog stays usable in every foldable pose', async ({ page }, testInfo) => {
  await openChat(page, [views.failed!])
  const dialog = page.getByRole('dialog', { name: 'Hand off chat' })
  await expect(dialog.getByRole('status')).toContainText('not active in this gateway')
  for (const [width, height] of POSES) {
    await page.setViewportSize({ width, height })
    await expect(dialog.getByRole('button', { name: 'Hand off' })).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`handoff-failed-${width}x${height}.png`) })
  }
})
