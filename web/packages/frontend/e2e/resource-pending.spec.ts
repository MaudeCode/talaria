import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** Writes stay held until the pending state has been observed in the real build. */
test('session rename keeps sidebar and detail pending until the canonical answer', async ({ page }, info) => {
  const now = Math.floor(Date.now() / 1000)
  const session = { session_id: 'intent-fixture', title: 'Original conversation', sort_ts: now, is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, source_kind: 'webui', is_messaging_session: false }
  let title = session.title
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route(/\/api\/sessions(\?|$)/, (route) => route.fulfill({ json: { sessions: [{ ...session, title }] } }))
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { ...session, title, messages: [] } } }))
  await page.route('**/api/session/rename', async (route) => {
    await held
    title = 'Canonical conversation'
    await route.fulfill({ json: { session: { ...session, title } } })
  })
  await page.goto('/session/intent-fixture')
  await settle(page)
  // The narrow shell reveals the same sidebar resource owner.
  if (info.project.name === 'mobile') {
    await page.locator('#btnHamburger').click()
  }
  const row = page.locator('[data-sid="intent-fixture"]')
  await expect(row).toBeVisible()
  await page.screenshot({ path: info.outputPath('before.png') })
  if (info.project.name === 'mobile') {
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
    const input = page.getByRole('textbox', { name: 'Rename conversation' })
    await input.fill('Submitted conversation')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
  }
  await expect(row.locator('.session-title')).toHaveText('Submitted conversation')
  await expect(row.getByText('Pending: Rename', { exact: true })).toBeVisible()
  await expect(page.locator('#topbarTitle')).toHaveText('Submitted conversation')
  // Dismiss the pending form to inspect the actual list presentation underneath it.
  if (info.project.name === 'desktop') await page.keyboard.press('Escape')
  await page.screenshot({ path: info.outputPath('after.png') })
  release()
  await expect(row.locator('.session-title')).toHaveText('Canonical conversation')
  await expect(row.locator('[data-resource-pending]')).toHaveCount(0)
})
