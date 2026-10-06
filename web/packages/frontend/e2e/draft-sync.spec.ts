import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** TAL-564: the server keeps each session's composer draft, so a browser without its own copy restores it. */
test('a draft saved on the server returns in a fresh browser context', async ({ page }) => {
  await page.unroute('**/api/session/draft**')
  const created = (await (await page.request.post('/api/session/new', { data: {} })).json()) as { session: { session_id: string } }
  const sid = created.session.session_id
  const saved = await page.request.post('/api/session/draft', { data: { session_id: sid, text: 'Draft from another device', files: [], draft_version: String(Date.now() * 1000) } })
  expect(saved.ok()).toBe(true)

  await page.goto(`/session/${sid}`)
  await expect(page.locator('#msg')).toHaveValue('Draft from another device')
})
