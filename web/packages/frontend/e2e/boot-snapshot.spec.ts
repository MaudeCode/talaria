import { expect, test } from './fixtures'
import { deferred, sessionFixture } from '../src/test/fixtures'

test.use({ serviceWorkers: 'block' })
const sid = 'boot-snapshot'

test('a reload paints the sidebar and open session from the boot snapshot', async ({ page }) => {
  const now = Math.floor(Date.now() / 1000)
  const session = sessionFixture({ session_id: sid, title: 'Snapshot session', sort_ts: now, messages: [{ role: 'user', id: 1, content: 'Snapshot question' }, { role: 'assistant', id: 2, content: 'Snapshot answer' }] })
  const row = {
    session_id: sid, title: 'Snapshot session', updated_at: now, sort_ts: now, last_message_at: now,
    pinned: false, archived: false, project_id: null, is_streaming: false, attention: null,
    is_cli_session: false, source_kind: 'webui', is_messaging_session: false, read_only: false,
    can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true, sidebar_group: 'recent',
  }
  // After the reload both reads hang, so whatever paints came from the boot snapshot.
  const release = deferred<undefined>()
  let held = false
  // The real list carries every field the snapshot validates; only its rows are replaced.
  await page.route(/\/api\/sessions(\?|$)/, async (route) => {
    if (held) await release.promise
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...await response.json() as object, sessions: [row], sidebar_groups: [{ kind: 'recent', title: 'Recent' }] } })
  })
  await page.route('**/api/session?**', async (route) => { if (held) await release.promise; await route.fulfill({ json: { session } }) })
  try {
    await page.goto(`/session/${sid}`)
    await expect(page.getByText('Snapshot answer', { exact: true })).toBeVisible()
    const stored = () => page.evaluate(() => localStorage.getItem('hermes-boot:queries') ?? '')
    await expect.poll(stored).toContain('Snapshot answer')
    await expect.poll(stored).toContain(`"list"`)
    held = true
    await page.reload()
    await expect(page.getByText('Snapshot answer', { exact: true })).toBeVisible()
    const hamburger = page.locator('#btnHamburger')
    if (await hamburger.isVisible()) await hamburger.click()
    await expect(page.locator(`.session-item[data-sid="${sid}"] .session-title`)).toHaveText('Snapshot session')
  } finally {
    // Drop the held handlers first: once released they would fetch from a page that is closing.
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    release.resolve(undefined)
  }
})
