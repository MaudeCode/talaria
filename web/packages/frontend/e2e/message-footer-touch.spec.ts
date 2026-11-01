import { mkdirSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// TAL-1651: earlier message footers (time, model, actions) wait for hover. A no-hover touch screen of any width shows
// them; a fine-pointer desktop keeps them quiet until hover or keyboard focus.
const sid = 'touch-footers'
const at = 1767225600
const session = {
  session_id: sid, title: 'Touch footers', read_only: true, message_count: 4,
  owner_attachment: { state: 'attached', reason: null, can_submit: true, can_interrupt: false, can_attach: false, restarting: false, revision: 1, execution_generation: 1, admissions: [] },
  messages: [
    { role: 'user', message_id: 'q1', content: 'First question', timestamp: at },
    { role: 'assistant', message_id: 'a1', content: 'First answer', timestamp: at + 5, _usedModel: 'model-one', _turnDuration: 3 },
    { role: 'user', message_id: 'q2', content: 'Second question', timestamp: at + 60 },
    { role: 'assistant', message_id: 'a2', content: 'Second answer', timestamp: at + 65, _usedModel: 'model-one', _turnDuration: 3 },
  ],
}

async function open(page: Page) {
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session } }))
  await page.route('**/api/session/stream?**', (route) => route.fulfill({ contentType: 'text/event-stream', body: `event: initial\ndata: {"session_id":"${sid}"}\n\n` }))
  await page.route('**/api/health/agent', (route) => route.fulfill({ json: { alive: true, chat: { available: true, condition: null } } }))
  await page.goto(`/session/${sid}`)
  await expect(page.getByText('Second answer')).toBeVisible()
  const rows = page.locator('.msg-row')
  return {
    earlierUser: rows.filter({ hasText: 'First question' }).locator('.msg-foot'),
    earlierAssistant: rows.filter({ hasText: 'First answer' }).locator('.msg-foot'),
    latestUser: rows.filter({ hasText: 'Second question' }).locator('.msg-foot'),
    latestAssistant: rows.filter({ hasText: 'Second answer' }).locator('.msg-foot'),
  }
}

async function capture(page: Page, name: string) {
  const dir = process.env.TALARIA_EVIDENCE_DIR
  if (dir) { mkdirSync(dir, { recursive: true }); await page.screenshot({ path: `${dir}/${name}.png` }) }
}

const desktopOnly = 'Each case sets its own viewport and input.'

for (const width of [382, 820, 1024]) {
  test.describe(`no-hover touch at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: true, isMobile: true })
    test('earlier footers show time and actions without a tap', async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', desktopOnly)
      expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true)
      const foot = await open(page)
      await expect(foot.latestAssistant).toHaveCSS('opacity', '1')
      await capture(page, `touch-${width}`)
      for (const f of Object.values(foot)) await expect(f).toHaveCSS('opacity', '1')
      for (const f of [foot.earlierUser, foot.earlierAssistant]) {
        await expect(f.locator('.msg-time')).toBeVisible()
        await expect(f.getByRole('button', { name: 'Copy' })).toBeVisible()
      }
    })
  })
}

test.describe('fine-pointer desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false })
  test('earlier footers stay quiet until hover or keyboard focus', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', desktopOnly)
    expect(await page.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(true)
    const foot = await open(page)
    await page.mouse.move(0, 0)
    await expect(foot.latestAssistant).toHaveCSS('opacity', '1')
    for (const f of [foot.earlierUser, foot.earlierAssistant]) await expect(f).toHaveCSS('opacity', '0')
    await foot.earlierAssistant.getByRole('button', { name: 'Copy' }).focus()
    await expect(foot.earlierAssistant).toHaveCSS('opacity', '1')
    await foot.earlierUser.hover()
    await expect(foot.earlierUser).toHaveCSS('opacity', '1')
  })
})
