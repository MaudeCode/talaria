import { expect, test } from './fixtures'
import { sessionFixture } from '../src/test/fixtures'

const sid = 'sidebar-row-link'

// TAL-1120: jsdom leaves nested button labels out of a link's name; a real browser does not.
test('a sidebar row is a link named by its conversation, not its action buttons', async ({ page }, info) => {
  const now = Math.floor(Date.now() / 1000)
  const row = {
    session_id: sid, title: 'Linked row', updated_at: now, sort_ts: now, last_message_at: now,
    pinned: false, archived: false, project_id: null, is_streaming: false, attention: null,
    is_cli_session: false, source_kind: 'webui', is_messaging_session: false, read_only: false,
    can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true, sidebar_group: 'recent',
  }
  await page.route(/\/api\/sessions(\?|$)/, async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...await response.json() as object, sessions: [row], sidebar_groups: [{ kind: 'recent', title: 'Recent' }] } })
  })
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: sessionFixture({ session_id: sid, title: 'Linked row', sort_ts: now }) } }))
  await page.goto(`/session/${sid}`)
  if (info.project.name === 'mobile') await page.locator('#btnHamburger').click()
  const link = page.locator('#sessionList').getByRole('listitem').getByRole('link', { name: /^Linked row/ })
  await expect(link).toHaveAttribute('href', `/session/${sid}`)
  await expect(link).toHaveAttribute('aria-current', 'page')
  await expect(link).not.toHaveAccessibleName(/Archive|Conversation actions/)
})
