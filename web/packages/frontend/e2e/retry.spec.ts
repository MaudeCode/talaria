import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** TAL-515: Regenerate and `/retry` drop the last exchange and resend its prompt and attachments as a new turn. */

const FILE = { filename: 'notes.txt', name: 'notes.txt', path: '/tmp/retry/notes.txt', size: 5, mime: 'text/plain' }

async function mockRetry(page: Page, sid: string) {
  let retried = false
  const starts: Record<string, unknown>[] = []
  const messages = [
    { role: 'user', id: 1, content: 'Summarize the logs', attachments: [FILE], _turn_id: 't1' },
    { role: 'assistant', id: 2, content: 'The logs look fine.', _turn_id: 't1' },
  ]
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: sid, title: 'Retry', model: 'm1', workspace: '/tmp/retry', messages: retried ? [] : messages } } }))
  await page.route('**/api/session/draft', (route) => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/session/retry', async (route) => {
    retried = true
    await route.fulfill({ json: { ok: true, last_user_text: '[Workspace::v1: /tmp/retry]\nSummarize the logs\n\n[Attached files: /tmp/retry/notes.txt]', last_user_prompt: 'Summarize the logs', last_user_attachments: [FILE], removed_count: 2 } })
  })
  await page.route('**/api/chat/start', async (route) => { starts.push(route.request().postDataJSON() as Record<string, unknown>); await route.fulfill({ json: { status: 'suppressed' } }) })
  return starts
}

test('Regenerate resends the last prompt with its attachments', async ({ page }) => {
  const starts = await mockRetry(page, 'regen')
  await page.goto('/session/regen')
  await page.getByRole('button', { name: 'Regenerate response' }).click()
  await expect.poll(() => starts.length).toBe(1)
  expect(starts[0]).toMatchObject({ session_id: 'regen', message: 'Summarize the logs', model: 'm1', workspace: '/tmp/retry', attachments: [FILE] })
})

test('/retry resends the last prompt with its attachments', async ({ page }) => {
  const starts = await mockRetry(page, 'slash')
  await page.goto('/session/slash')
  await page.locator('#msg').fill('/retry')
  await page.locator('#btnSend').click()
  await expect.poll(() => starts.length).toBe(1)
  expect(starts[0]).toMatchObject({ session_id: 'slash', message: 'Summarize the logs', attachments: [FILE] })
})

test('against a server without the resend fields, Regenerate puts the stored text in the composer instead of sending it', async ({ page }) => {
  const starts = await mockRetry(page, 'old')
  const stored = '[Workspace::v1: /tmp/retry]\nSummarize the logs\n\n[Attached files: /tmp/retry/notes.txt]'
  await page.route('**/api/session/retry', (route) => route.fulfill({ json: { ok: true, last_user_text: stored, removed_count: 2 } }))
  await page.goto('/session/old')
  await page.getByRole('button', { name: 'Regenerate response' }).click()
  await expect(page.locator('#msg')).toHaveValue(stored)
  // `/retry` clears the composer before the text returns.
  await page.locator('#msg').fill('/retry')
  await page.locator('#btnSend').click()
  await expect(page.locator('#msg')).toHaveValue(stored)
  expect(starts).toEqual([])
})
