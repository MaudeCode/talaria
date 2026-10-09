import { expect, settle, test } from './fixtures'

test.describe('shell', () => {
  test('home renders the chat shell without console errors', async ({ page, errors }) => {
    await page.goto('/')
    await settle(page)
    await expect(page.getByRole('textbox').first()).toBeVisible()
    expect(errors).toEqual([])
  })

  const HUBS = ['/tasks', '/kanban', '/skills', '/memory', '/workspaces', '/profiles', '/todos', '/insights', '/logs']

  test('every hub renders', async ({ page }, testInfo) => {
    await page.goto('/')
    await settle(page)
    if (testInfo.project.name === 'mobile') {
      // The rail is desktop-only; mobile reaches hubs by URL.
      for (const path of HUBS) {
        await page.goto(path)
        await settle(page)
        await expect(page, path).toHaveURL(new RegExp(`${path}$`))
      }
      return
    }
    const rail = page.locator('nav[aria-label="Primary navigation"] a[href]')
    const count = await rail.count()
    expect(count).toBeGreaterThanOrEqual(HUBS.length)
    const visited = new Set<string>()
    for (let i = 0; i < count; i += 1) {
      const link = rail.nth(i)
      const href = await link.getAttribute('href')
      if (!href || /^https?:/.test(href)) continue
      await link.click()
      await expect(page.locator('#app')).not.toBeEmpty()
      visited.add(new URL(page.url()).pathname)
    }
    for (const path of HUBS) expect(visited, path).toContain(path)
  })

  test('settings route renders and navigates between sections', async ({ page }) => {
    await page.goto('/settings')
    await settle(page)
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
    await page.goto('/settings/appearance')
    await settle(page)
    await expect(page).toHaveURL(/\/settings\/appearance$/)
  })

  test('deep links load assets through the relative base href', async ({ page, errors }) => {
    const failed: string[] = []
    page.on('response', (res) => { if (res.status() >= 400 && res.url().includes('/static/dist/')) failed.push(`${res.status()} ${res.url()}`) })
    await page.goto('/session/not-a-real-session')
    await settle(page)
    expect(failed).toEqual([])
    // The entry freezes the mount root from the injected <base href="../">.
    expect(new URL(await page.evaluate(() => document.baseURI)).pathname).toBe('/')
    // The bogus session id is expected to 404; the shell must still render its error state.
    const expected404 = errors.filter((e) => e.includes('session_id=not-a-real-session'))
    expect(expected404).toHaveLength(1)
    errors.splice(0, errors.length, ...errors.filter((e) => !expected404.includes(e)))
    await expect(page.locator('#app')).not.toBeEmpty()
  })

  test('unknown paths are not shadowed by the shell', async ({ request }) => {
    const res = await request.get('/definitely-not-a-route')
    expect(res.status()).toBe(404)
  })

  test('legacy hash routes redirect to canonical paths', async ({ page }) => {
    await page.goto('/#settings')
    await settle(page)
    await expect(page).toHaveURL(/\/settings(\/[a-z-]+)?$/)
  })

  test('theme switch persists across reload', async ({ page }) => {
    await page.goto('/settings/appearance')
    await settle(page)
    const before = await page.locator('html').getAttribute('class')
    await page.evaluate(() => { localStorage.setItem('hermes-theme', 'light') })
    await page.reload()
    await settle(page)
    const after = await page.locator('html').getAttribute('class')
    expect(after).not.toBe(before)
    expect(after ?? '').not.toContain('dark')
  })

  test('corner seams follow the sidebar collapse animation', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'seams only render on desktop')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.goto('/')
    await settle(page)
    const seams = () => page.evaluate(() => {
      const shown = (sel: string) => [...document.querySelectorAll(sel)].map((el) => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility === 'visible' })
      return { rail: shown('.rail-seam'), sidebar: shown('.sidebar .seam'), sidebarWidth: document.querySelector('.sidebar')!.getBoundingClientRect().width }
    })
    // Toggle, wait for the sidebar's width transition to start, then freeze every transition at `at` ms so the check is frame-exact.
    const toggleAt = (at: number) => page.evaluate(async (at) => {
      const layout = document.querySelector('.layout')!
      const wasCollapsed = layout.classList.contains('sidebar-collapsed')
      document.getElementById('btnSidebarEdgeToggle')!.click()
      const transitions = () => document.getAnimations().filter((a): a is CSSTransition => a instanceof CSSTransition)
      while (layout.classList.contains('sidebar-collapsed') === wasCollapsed || !transitions().some((a) => a.transitionProperty === 'width')) await new Promise(requestAnimationFrame)
      for (const a of transitions()) { a.pause(); a.currentTime = at }
    }, at)
    const finish = () => page.evaluate(() => { for (const a of document.getAnimations()) if (a instanceof CSSTransition) a.finish() })
    const both = (n: boolean) => [n, n]

    expect(await seams()).toMatchObject({ rail: both(false), sidebar: both(true) })

    // Mid-collapse the sidebar still has width, so its own seams stay and the rail's wait.
    await toggleAt(120)
    const mid = await seams()
    expect(mid.sidebarWidth).toBeGreaterThan(0)
    expect(mid).toMatchObject({ rail: both(false), sidebar: both(true) })
    await finish()
    expect(await seams()).toMatchObject({ rail: both(true), sidebar: both(false), sidebarWidth: 0 })

    // Expanding hands the corners back to the sidebar at once, never showing both sets.
    await toggleAt(0)
    expect(await seams()).toMatchObject({ rail: both(false), sidebar: both(true) })
    await finish()
    await toggleAt(0)
    await finish()

    // A persisted collapse renders the final corners on load without running a seam transition.
    await page.reload()
    await settle(page)
    expect(await page.evaluate(() => document.getAnimations().some((a) => a instanceof CSSTransition && a.effect instanceof KeyframeEffect && !!a.effect.target?.matches('.seam')))).toBe(false)
    expect(await seams()).toMatchObject({ rail: both(true), sidebar: both(false), sidebarWidth: 0 })

    // With reduced motion the sidebar snaps closed, so the seams must not wait either.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await page.locator('.rail-seam').first().evaluate((el) => getComputedStyle(el).transitionDelay)).toBe('0s')
  })

  test('chat width setting sizes the chat column and persists', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'chat width only applies above the phone breakpoint')
    await page.setViewportSize({ width: 1600, height: 900 })
    const composerMax = () => page.locator('.composer-box').evaluate((el) => getComputedStyle(el).maxWidth)
    await page.goto('/')
    await settle(page)
    expect(await composerMax()).toBe('768px')

    for (const [width, max] of [['wide', '1152px'], ['full', 'none'], ['comfortable', '768px']] as const) {
      await page.goto('/settings/appearance')
      await settle(page)
      await expect(page.locator(`[data-chat-width-val="${width}"]`)).toBeVisible()
      const saved = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/api/settings'))
      await page.locator(`[data-chat-width-val="${width}"]`).click()
      expect((await saved).postDataJSON()).toMatchObject({ chat_width: width, full_width_chat: width === 'full' })
      const tile = page.locator(`[data-chat-width-val="${width}"]`)
      await expect(tile).toHaveAttribute('aria-pressed', 'true')
      // The selected tile carries the theme accent border. The pointer moves off first so the hover border cannot stand in
      // for it, and toHaveCSS retries past the frame in which the new class has not reached the computed style yet.
      await page.mouse.move(0, 0)
      const accent = await tile.evaluate((el) => {
        const probe = document.createElement('span')
        probe.style.color = 'var(--accent)'
        el.append(probe)
        const color = getComputedStyle(probe).color
        probe.remove()
        return color
      })
      await expect(tile).toHaveCSS('border-color', accent)
      await expect(page.locator('.chat-width-pick-btn[aria-pressed="false"]').first()).not.toHaveCSS('border-color', accent)
      expect((await (await page.request.get('/api/settings')).json()).chat_width).toBe(width)
      await page.goto('/')
      await settle(page)
      expect(await composerMax()).toBe(max)
    }

    // A browser that only has the legacy full-width toggle boots in Full.
    await page.evaluate(() => { localStorage.removeItem('hermes-chat-width'); localStorage.setItem('hermes-full-width-chat', 'true') })
    await page.reload()
    await settle(page)
    expect(await composerMax()).toBe('none')
  })
})
