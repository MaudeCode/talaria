import type { Page } from '@playwright/test'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** A shared conversation's menu copies the existing link, refreshes the snapshot, and revokes only after confirmation (TAL-563). */

const now = Math.floor(Date.now() / 1000)
const SID = 'share-me'
const row = (share_token: string | null) => ({
  session_id: SID, title: 'Shared conversation', is_streaming: false, attention: null, last_message_at: now - 600, updated_at: now - 600, pinned: false, archived: false, project_id: null,
  is_cli_session: false, source_kind: 'webui', is_messaging_session: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true,
  share_token, share_created_at: share_token ? now - 300 : null,
})

async function openMenu(page: Page) {
  const item = page.locator(`.session-item[data-sid="${SID}"]`)
  await item.hover()
  await item.locator('.session-actions-trigger').click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  return menu
}

async function choose(page: Page, name: string, shot?: string) {
  const action = (await openMenu(page)).getByRole('menuitem', { name })
  await expect(action).toBeVisible()
  if (shot && process.env.TAL563_SHOTS) await page.screenshot({ path: `${process.env.TAL563_SHOTS}/${shot}.png` })
  await action.click()
}

test('a shared conversation copies its link, refreshes its snapshot, and revokes behind a confirmation', async ({ page, context }, testInfo) => {
  // Touch rows hide the actions column; the menu itself is the same on every layout.
  test.skip(testInfo.project.name === 'mobile', 'the row actions trigger is hidden on touch layouts')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  let token: string | null = 'tok-old'
  const calls = { create: 0, revoke: 0 }
  await page.route(/\/api\/sessions(\?|$)/, async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...(await response.json()), sessions: [row(token)] } })
  })
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: SID, title: 'Shared conversation', messages: [{ role: 'user', id: 1, content: 'hello' }] } } }))
  await page.route('**/api/share/create', (route) => {
    calls.create += 1
    token = 'tok-new'
    return route.fulfill({ json: { ok: true, share: { token, url: `/share/${token}`, title: 'Shared conversation', message_count: 1, created_at: now, updated_at: now }, session: row(token) } })
  })
  await page.route('**/api/share/revoke', (route) => {
    calls.revoke += 1
    token = null
    return route.fulfill({ json: { ok: true, session: row(null) } })
  })
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText())

  await page.goto(`/session/${SID}`)
  await settle(page)

  // Copy share link reuses the existing token without rebuilding the snapshot.
  await choose(page, 'Copy share link', 'menu-shared')
  await expect(page.getByText('Share link copied to clipboard')).toBeVisible()
  expect(await clipboard()).toBe(new URL('/share/tok-old', page.url()).href)
  expect(calls.create).toBe(0)

  // Refresh snapshot re-creates the share and copies the link it returns.
  await choose(page, 'Refresh snapshot')
  await expect.poll(() => calls.create).toBe(1)
  await expect.poll(clipboard).toBe(new URL('/share/tok-new', page.url()).href)

  // Revoke asks first; cancelling keeps the share.
  await choose(page, 'Revoke public link')
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText('Anyone opening the old link')
  if (process.env.TAL563_SHOTS) await page.screenshot({ path: `${process.env.TAL563_SHOTS}/revoke-confirm.png` })
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm).toBeHidden()
  expect(calls.revoke).toBe(0)

  await choose(page, 'Revoke public link')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke public link' }).click()
  await expect(page.getByText('Public share link revoked')).toBeVisible()
  expect(calls.revoke).toBe(1)

  // Once revoked, the menu offers sharing again and none of the existing-share actions.
  const menu = await openMenu(page)
  await expect(menu.getByRole('menuitem', { name: 'Share publicly' })).toBeVisible()
  for (const gone of ['Copy share link', 'Refresh snapshot', 'Revoke public link']) await expect(menu.getByRole('menuitem', { name: gone })).toHaveCount(0)
})
