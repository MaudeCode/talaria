import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

test('native sidebar drag pins and unpins through the optimistic action', async ({ page }, info) => {
  const now = Math.floor(Date.now() / 1000)
  const base = { sort_ts: now, is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true, source_kind: 'webui', is_messaging_session: false }
  let pinned = false
  let lastReadPinned: boolean | null = null
  const gate = Promise.withResolvers<undefined>()
  const writes: { session_id: string; pinned: boolean }[] = []
  await page.route(/\/api\/sessions(\?|$)/, async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...await response.json(), sessions: [
      { ...base, session_id: 'pin-alpha', title: 'Project notes', pinned: true, sidebar_group: 'pinned' },
      { ...base, session_id: 'pin-beta', title: 'Release checklist', pinned, sidebar_group: pinned ? 'pinned' : 'recent' },
      { ...base, session_id: 'pin-gamma', title: 'Design discussion', sidebar_group: 'recent' },
      { ...base, session_id: 'pin-readonly', title: 'Read-only transcript', read_only: true, can_pin: false, sidebar_group: 'recent' },
    ] } })
    lastReadPinned = pinned
  })
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { ...base, session_id: 'pin-gamma', title: 'Design discussion', messages: [] } } }))
  await page.route('**/api/session/pin', async (route) => {
    const write = route.request().postDataJSON() as { session_id: string; pinned: boolean }
    writes.push(write)
    if (writes.length === 1) await gate.promise
    pinned = write.pinned
    await route.fulfill({ json: { ok: true } })
  })
  try {
    await page.goto('/session/pin-gamma')
    await settle(page)
    if (await page.locator('#btnHamburger').isVisible()) await page.locator('#btnHamburger').click()
    const beta = page.locator('[data-sid="pin-beta"]')
    const pinnedGroup = page.locator('.session-date-group').filter({ has: page.getByRole('button', { name: 'Pinned', exact: true }) })
    const today = page.getByRole('button', { name: 'Today', exact: true })
    await expect(beta).toBeVisible()
    await expect(page.locator('[data-sid="pin-readonly"]')).toHaveAttribute('draggable', 'false')
    await page.screenshot({ path: info.outputPath('before.png') })
    await beta.hover()
    await page.mouse.down()
    await pinnedGroup.locator('.session-date-header').hover()
    await pinnedGroup.locator('.session-date-header').hover()
    await expect(pinnedGroup).toHaveClass(/session-drop-target/)
    await page.screenshot({ path: info.outputPath('drop-target.png') })
    await page.mouse.up()
    await expect.poll(() => writes).toEqual([{ session_id: 'pin-beta', pinned: true }])
    await expect(pinnedGroup.locator('[data-sid="pin-beta"]')).toBeVisible()
    await page.screenshot({ path: info.outputPath('after-pin.png') })
    gate.resolve(undefined)
    await expect.poll(() => pinned).toBe(true)
    await expect.poll(() => lastReadPinned).toBe(true)
    await beta.dragTo(page.locator('[data-sid="pin-alpha"]'))
    expect(writes).toHaveLength(1)
    await beta.dragTo(today)
    await expect.poll(() => writes).toEqual([{ session_id: 'pin-beta', pinned: true }, { session_id: 'pin-beta', pinned: false }])
    await expect(pinnedGroup.locator('[data-sid="pin-beta"]')).toHaveCount(0)
    await expect(beta).toBeVisible()
    await page.screenshot({ path: info.outputPath('after-unpin.png') })
    await expect(beta).toHaveCSS('touch-action', 'pan-y')
    // Navigation and keyboard/menu pinning remain the accessible equivalent.
    if (info.project.name === 'desktop') {
      const actions = beta.getByRole('button', { name: 'Conversation actions' })
      await actions.focus()
      await actions.press('Enter')
      await page.getByRole('menuitem', { name: 'Pin conversation', exact: true }).click()
      await expect.poll(() => writes.length).toBe(3)
      await page.setViewportSize({ width: 900, height: 800 })
      await page.screenshot({ path: info.outputPath('after-laptop.png') })
      await page.setViewportSize({ width: 600, height: 800 })
      if (await page.locator('#btnHamburger').isVisible()) await page.locator('#btnHamburger').click()
      await expect(beta).toBeVisible()
      for (const title of await page.locator('#sessionList .session-title').all()) await expect(title).toBeInViewport()
      await page.screenshot({ path: info.outputPath('after-narrow.png') })
    }
  } finally { gate.resolve(undefined) }
})
