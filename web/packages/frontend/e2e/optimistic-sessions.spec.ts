import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** Writes stay held while the optimistic result is observed in the real build. */
test('session rename and delete show their result at once, then adopt the canonical answer', async ({ page }, info) => {
  const now = Math.floor(Date.now() / 1000)
  const base = { sort_ts: now, is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true, source_kind: 'webui', is_messaging_session: false }
  const session = { ...base, session_id: 'intent-fixture', title: 'Original conversation' }
  const doomed = { ...base, session_id: 'doomed-fixture', title: 'Conversation to delete' }
  let title = session.title
  let deleted = false
  const renameGate = Promise.withResolvers<undefined>(), deleteGate = Promise.withResolvers<undefined>()
  await page.route(/\/api\/sessions(\?|$)/, (route) => route.fulfill({ json: { sessions: [{ ...session, title }, ...(deleted ? [] : [doomed])] } }))
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { ...session, title, messages: [] } } }))
  await page.route('**/api/session/rename', async (route) => {
    await renameGate.promise
    title = 'Canonical conversation'
    await route.fulfill({ json: { session: { ...session, title } } })
  })
  await page.route('**/api/session/delete', async (route) => {
    await deleteGate.promise
    deleted = true
    await route.fulfill({ json: { ok: true, state_db_cleanup_failed: false } })
  })
  try {
    await page.goto('/session/intent-fixture')
    await settle(page)
    const mobile = info.project.name === 'mobile'
    // The narrow shell reveals the same sidebar resource owner.
    if (mobile) await page.locator('#btnHamburger').click()
    const row = page.locator('[data-sid="intent-fixture"]')
    await expect(row).toBeVisible()
    await page.screenshot({ path: info.outputPath('before.png') })
    if (mobile) {
      await page.locator('.mobile-sidebar-close').click()
      await page.locator('#msg').fill('/title Submitted conversation')
      await page.locator('#btnSend').click()
      await expect(page.locator('#topbarTitle')).toHaveText('Submitted conversation')
      await page.locator('#btnHamburger').click()
    } else {
      const actions = row.getByRole('button', { name: 'Conversation actions' })
      await actions.focus()
      await actions.press('Enter')
      await page.getByRole('menuitem', { name: 'Rename conversation' }).click()
      await page.getByRole('textbox', { name: 'Rename conversation' }).fill('Submitted conversation')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      // The dialog closes on submit, not on the response.
      await expect(page.getByRole('dialog')).toHaveCount(0)
    }
    await expect(row.locator('.session-title')).toHaveText('Submitted conversation')
    await expect(page.locator('#topbarTitle')).toHaveText('Submitted conversation')
    await expect(page.getByText(/^Pending/)).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('after-rename.png') })

    renameGate.resolve(undefined)
    await expect(row.locator('.session-title')).toHaveText('Canonical conversation')
    // Phones reach the row menu by long-press; the delete path is the same resource owner.
    if (mobile) return
    const victim = page.locator('[data-sid="doomed-fixture"]')
    const actions = victim.getByRole('button', { name: 'Conversation actions' })
    await actions.focus()
    await actions.press('Enter')
    await page.getByRole('menuitem', { name: 'Delete conversation' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(victim).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('after-delete.png') })
    deleteGate.resolve(undefined)
    await expect.poll(() => deleted).toBe(true)
    await expect(victim).toHaveCount(0)
  } finally {
    renameGate.resolve(undefined); deleteGate.resolve(undefined)
  }
})
