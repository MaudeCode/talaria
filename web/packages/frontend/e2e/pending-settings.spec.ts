import { mkdir } from 'node:fs/promises'
import { test, expect } from './fixtures'
import { deferred } from '../src/test/fixtures'
import type { Page } from '@playwright/test'

test.use({ serviceWorkers: 'block' })
const baseline = process.env.TALARIA_SETTINGS_BASELINE === '1'

async function capture(page: Page, section: string, project: string) {
  if (!process.env.TALARIA_SETTINGS_EVIDENCE) return
  await mkdir(process.env.TALARIA_SETTINGS_EVIDENCE, { recursive: true })
  await page.screenshot({ path: `${process.env.TALARIA_SETTINGS_EVIDENCE}/${baseline ? 'before' : 'after'}-${section}-${project}.png` })
}

test('ordinary settings show local intent while saves are held', async ({ page, request }, info) => {
  let settings = { ...await (await request.get('/api/settings')).json(), send_key: 'enter', render_user_markdown: false, sound_enabled: false }
  const held = deferred<undefined>()
  let writes = 0
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'POST') {
      writes++
      await held.promise
      settings = { ...settings, ...route.request().postDataJSON() }
    }
    await route.fulfill({ json: settings })
  })
  try {
    await page.goto('/settings/preferences')
    const send = page.locator('#settingsSendKey')
    await send.click()
    await page.getByRole('option', { name: /Ctrl/ }).click()
    await expect.poll(() => writes).toBe(1)
    await expect(send).toContainText(baseline ? /^Enter to send/ : /Ctrl/)
    await capture(page, 'preferences', info.project.name)
    const sound = page.getByRole('switch', { name: 'Notification sound' })
    await sound.click()
    await expect(sound).toHaveAttribute('aria-checked', baseline ? 'false' : 'true')
    await page.goto('/settings/conversation')
    const markdown = page.getByRole('switch', { name: 'Render markdown in user messages' })
    await markdown.click()
    await expect(markdown).toHaveAttribute('aria-checked', baseline ? 'false' : 'true')
    await page.locator('#settingsChatActivityDisplayMode').scrollIntoViewIfNeeded()
    await capture(page, 'conversation', info.project.name)
  } finally {
    held.resolve(undefined)
  }
})

test('numeric settings reconcile a completed save while the input keeps focus', async ({ page, request }, info) => {
  const settings = { ...await (await request.get('/api/settings')).json(), pinned_sessions_limit: 3 }
  const held = deferred<undefined>()
  let reads = 0
  let writes = 0
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'POST') { writes++; await held.promise }
    else reads++
    // The server refuses 100 and returns the prior confirmed value.
    await route.fulfill({ json: settings })
  })
  try {
    await page.goto('/settings/preferences')
    const input = page.locator('#settingsPinnedLimit')
    await input.fill('100')
    await expect(input).toHaveValue('100')
    await expect.poll(() => writes).toBe(1)
    held.resolve(undefined)
    await expect.poll(() => reads).toBeGreaterThan(1)
    await expect(input).toHaveValue(baseline ? '100' : '3')
    await expect(input).toBeFocused()
    await input.evaluate((element) => element.scrollIntoView({ block: 'center' }))
    await capture(page, 'numeric', info.project.name)
  } finally {
    held.resolve(undefined)
  }
})
