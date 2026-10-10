import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** J and K open the next and previous session in sidebar order, and type normally in text fields (TAL-613). */

const now = Math.floor(Date.now() / 1000)
const row = (session_id: string, age: number) => ({
  session_id, title: session_id, is_streaming: false, attention: null, last_message_at: now - age, updated_at: now - age, sort_ts: now - age, pinned: false, archived: false, project_id: null,
  is_cli_session: false, source_kind: 'webui', is_messaging_session: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true,
})
const ROWS = [row('jk-first', 60), row('jk-second', 120), row('jk-third', 180), row('jk-hidden', 30 * 86_400)]

test('J and K move between sessions and are ignored while typing', async ({ page }) => {
  await page.route(/\/api\/sessions(\?|$)/, async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...(await response.json()), sessions: ROWS } })
  })
  await page.route('**/api/session?**', (route) => {
    const sid = new URL(route.request().url()).searchParams.get('session_id') ?? ''
    return route.fulfill({ json: { session: { session_id: sid, title: sid, messages: [{ role: 'user', id: 1, content: `${sid} question` }] } } })
  })
  await page.route('**/api/session/draft', (route) => route.fulfill({ json: { ok: true } }))
  await page.goto('/session/jk-first')
  await settle(page)
  await expect(page.locator('.session-item[data-sid="jk-third"]')).toBeAttached()
  // A collapsed group's rows are hidden, so J and K skip them.
  await page.locator('.session-date-header', { hasText: 'Older' }).dispatchEvent('click')
  await expect(page.locator('.session-item[data-sid="jk-hidden"]')).toBeHidden()
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur() })

  await page.keyboard.press('j')
  await expect(page).toHaveURL(/\/session\/jk-second$/)
  await page.keyboard.press('j')
  await expect(page).toHaveURL(/\/session\/jk-third$/)
  // The ends hold: J on the last shown session stays put.
  await page.keyboard.press('j')
  await page.keyboard.press('k')
  await expect(page).toHaveURL(/\/session\/jk-second$/)
  // Modified keys belong to other shortcuts.
  await page.keyboard.press('Alt+k')
  await expect(page).toHaveURL(/\/session\/jk-second$/)

  await page.locator('#msg').focus()
  await page.keyboard.type('jk')
  await expect(page.locator('#msg')).toHaveValue('jk')
  await expect(page).toHaveURL(/\/session\/jk-second$/)
})
