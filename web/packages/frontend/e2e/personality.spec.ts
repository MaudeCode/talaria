import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** TAL-612: `/personality` alone lists the available personalities and leaves the session's personality set. */

async function mockPersonality(page: Page, sid: string, personalities: { name: string; description?: string }[]) {
  const sets: Record<string, unknown>[] = []
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: sid, title: 'Personality', model: 'm1', workspace: '/tmp/p', personality: 'calm', messages: [] } } }))
  await page.route('**/api/personalities', (route) => route.fulfill({ json: { personalities } }))
  await page.route('**/api/personality/set', async (route) => { sets.push(route.request().postDataJSON() as Record<string, unknown>); await route.fulfill({ json: { ok: true, personality: null, prompt: '' } }) })
  return sets
}

test('/personality without arguments lists the personalities and changes nothing', async ({ page }) => {
  const sets = await mockPersonality(page, 'list', [{ name: 'pirate', description: 'Talk like a pirate' }, { name: 'calm', description: 'Calm helper' }])
  await page.goto('/session/list')
  await page.locator('#msg').fill('/personality')
  await page.locator('#btnSend').click()
  const toast = page.locator('.notification-toast', { hasText: 'Available personalities' })
  await expect(toast).toContainText('pirate')
  await expect(toast).toContainText('calm')
  expect(sets).toEqual([])
})

test('/personality without arguments says when none are configured', async ({ page }) => {
  const sets = await mockPersonality(page, 'empty', [])
  await page.goto('/session/empty')
  await page.locator('#msg').fill('/personality')
  await page.locator('#btnSend').click()
  await expect(page.locator('.notification-toast', { hasText: 'No personalities found' })).toBeVisible()
  expect(sets).toEqual([])
})
