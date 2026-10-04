import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { hydrateAnchorActivityScenes, withTurnIds } from '../../server/dist/sessions/anchor.js'
import { redactSessionData } from '../../server/dist/redact.js'

test.use({ serviceWorkers: 'block' })

const messages = [
  { role: 'user', id: 1, content: 'Where are the docs?' },
  { role: 'assistant', id: 2, content: 'See [the guide](https://docs.example.com/guide/getting-started?ref=chat) for setup.' },
]

async function openSession(page: Page) {
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: 'link-safety', title: 'Where are the docs?', messages: redactSessionData({ messages: hydrateAnchorActivityScenes(withTurnIds(messages), {}) }, true).messages,
  } } }))
  await page.context().route('https://docs.example.com/**', (route) => route.fulfill({ body: 'docs' }))
  await page.goto('/session/link-safety')
}

test('external links ask in a bounded, opaque app dialog (TAL-279)', async ({ page }, testInfo) => {
  await openSession(page)
  await page.getByRole('button', { name: 'the guide' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open external link?' })
  await expect(dialog).toContainText('docs.example.com')
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
  const box = (await dialog.boundingBox())!
  const viewport = page.viewportSize()!
  expect(box.width).toBeLessThanOrEqual(Math.min(520, viewport.width * 0.92) + 1)
  expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(1)
  expect(await dialog.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toMatch(/rgba\(.*, 0\)|transparent/)
  await page.screenshot({ path: testInfo.outputPath('link-safety-dialog.png') })
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('a trusted host opens directly after the server check (TAL-279)', async ({ page }) => {
  await openSession(page)
  expect((await page.request.post('/api/settings', { data: { trusted_link_hosts: ['docs.example.com'] } })).ok()).toBe(true)
  try {
    const popup = page.waitForEvent('popup')
    await page.getByRole('button', { name: 'the guide' }).click()
    expect((await popup).url()).toBe('https://docs.example.com/guide/getting-started?ref=chat')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  } finally {
    await page.request.post('/api/settings', { data: { trusted_link_hosts: [] } })
  }
})
