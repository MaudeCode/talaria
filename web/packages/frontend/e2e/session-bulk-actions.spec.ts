import { expect, openChatFilters, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** TAL-606: select mode archives and deletes chosen chats through one server bulk call each; a chat the server refuses stays selected. */
test('selected chats archive in one bulk request, a refused chat stays selected, and Delete confirms first', async ({ page }, info) => {
  const now = Math.floor(Date.now() / 1000)
  const base = { sort_ts: now, is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_rename: true, can_move: true, can_duplicate: true, can_share: true, source_kind: 'webui', is_messaging_session: false }
  const ids = ['bulk-a', 'bulk-b', 'bulk-c', 'bulk-d', 'bulk-e']
  const archived = new Set<string>()
  const deleted = new Set<string>()
  const bulkBodies: unknown[] = []
  let gate = Promise.withResolvers<undefined>()
  await page.route(/\/api\/sessions(\?|$)/, (route) => route.fulfill({ json: { sessions: ids.filter((id) => !archived.has(id) && !deleted.has(id)).map((id) => ({ ...base, session_id: id, title: `Chat ${id}` })) } }))
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { ...base, session_id: 'bulk-a', title: 'Chat bulk-a', messages: [] } } }))
  await page.route('**/api/sessions/bulk', async (route) => {
    const body = route.request().postDataJSON() as { action: string; session_ids: string[] }
    bulkBodies.push(body)
    await gate.promise
    if (body.action === 'delete') {
      for (const id of body.session_ids) deleted.add(id)
      await route.fulfill({ json: { results: body.session_ids.map((id) => ({ session_id: id, ok: true })) } })
      return
    }
    // The server refuses to archive bulk-e; every other id is archived.
    const results = body.session_ids.map((id) => id === 'bulk-e' ? { session_id: id, ok: false, status: 409, error: 'session has an active run' } : (archived.add(id), { session_id: id, ok: true }))
    await route.fulfill({ json: { results } })
  })
  await page.goto('/')
  await settle(page)
  if (info.project.name === 'mobile') await page.locator('#btnHamburger').click()
  await (await openChatFilters(page)).getByRole('menuitem', { name: 'Select', exact: true }).click()
  const row = (id: string) => page.getByRole('checkbox', { name: new RegExp(`Chat ${id}`) })
  for (const id of ['bulk-a', 'bulk-b', 'bulk-c']) await row(id).click()
  await expect(page.getByText('3 selected')).toBeVisible()
  await page.screenshot({ path: info.outputPath('selected.png') })
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  // The rows leave at once, before the server answers.
  for (const id of ['bulk-a', 'bulk-b', 'bulk-c']) await expect(page.locator(`[data-sid="${id}"]`)).toHaveCount(0)
  gate.resolve(undefined)
  await expect.poll(() => bulkBodies).toEqual([{ action: 'archive', session_ids: ['bulk-a', 'bulk-b', 'bulk-c'] }])
  await page.screenshot({ path: info.outputPath('archived.png') })

  // Partial failure: bulk-d is archived, bulk-e is refused and comes back selected with a notice.
  gate = Promise.withResolvers<undefined>()
  if (!(await row('bulk-d').isVisible())) await (await openChatFilters(page)).getByRole('menuitem', { name: 'Select', exact: true }).click()
  await row('bulk-d').click()
  await row('bulk-e').click()
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  gate.resolve(undefined)
  await expect(page.locator('[data-sid="bulk-d"]')).toHaveCount(0)
  await expect(row('bulk-e')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByText('1 selected')).toBeVisible()
  await expect(page.getByText(/session has an active run/)).toBeVisible()
  expect(bulkBodies).toHaveLength(2)
  await page.screenshot({ path: info.outputPath('partial.png') })

  // Delete asks first, then sends one bulk delete for the selected chat.
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText('Delete this conversation?')
  await expect(confirm).toHaveCSS('opacity', '1')
  await page.screenshot({ path: info.outputPath('delete-confirm.png') })
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.locator('[data-sid="bulk-e"]')).toHaveCount(0)
  await expect.poll(() => bulkBodies.at(-1)).toEqual({ action: 'delete', session_ids: ['bulk-e'] })
  // Nothing was refused, so select mode ends.
  await expect(page.getByText(/selected$/)).toHaveCount(0)
})
