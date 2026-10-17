import { mkdir } from 'node:fs/promises'
import { test, expect } from './fixtures'
import { deferred } from '../src/test/fixtures'

test.use({ serviceWorkers: 'block' })
const baseline = process.env.TALARIA_SETTINGS_BASELINE === '1'

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
  const capture = async (section: string) => {
    if (!process.env.TALARIA_SETTINGS_EVIDENCE) return
    await mkdir(process.env.TALARIA_SETTINGS_EVIDENCE, { recursive: true })
    await page.screenshot({ path: `${process.env.TALARIA_SETTINGS_EVIDENCE}/${baseline ? 'before' : 'after'}-${section}-${info.project.name}.png` })
  }
  try {
    await page.goto('/settings/preferences')
    const send = page.locator('#settingsSendKey')
    await send.click()
    await page.getByRole('option', { name: /Ctrl/ }).click()
    await expect.poll(() => writes).toBe(1)
    await expect(send).toContainText(baseline ? /^Enter to send/ : /Ctrl/)
    await capture('preferences')
    const sound = page.getByRole('switch', { name: 'Notification sound' })
    await sound.click()
    await expect(sound).toHaveAttribute('aria-checked', baseline ? 'false' : 'true')
    await page.goto('/settings/conversation')
    const markdown = page.getByRole('switch', { name: 'Render markdown in user messages' })
    await markdown.click()
    await expect(markdown).toHaveAttribute('aria-checked', baseline ? 'false' : 'true')
    await page.locator('#settingsChatActivityDisplayMode').scrollIntoViewIfNeeded()
    await capture('conversation')
  } finally {
    held.resolve(undefined)
  }
})
