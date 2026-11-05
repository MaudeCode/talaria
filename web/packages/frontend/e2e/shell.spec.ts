import { expect, settle, test } from './fixtures'

test.describe('shell', () => {
  test('home renders the chat shell without console errors', async ({ page, errors }) => {
    await page.goto('/')
    await settle(page)
    await expect(page.getByRole('textbox').first()).toBeVisible()
    expect(errors).toEqual([])
  })

  const HUBS = ['/tasks', '/kanban', '/skills', '/memory', '/workspaces', '/groups', '/profiles', '/todos', '/insights', '/logs']

  test('every hub renders', async ({ page }, testInfo) => {
    await page.goto('/')
    await settle(page)
    if (testInfo.project.name === 'mobile') {
      // The tiled column is desktop-only; mobile reaches hubs by URL.
      for (const path of HUBS) {
        await page.goto(path)
        await settle(page)
        await expect(page, path).toHaveURL(new RegExp(`${path}$`))
      }
      return
    }
    // The icon rail shows every destination at once.
    await page.locator('#btnSidebarEdgeToggle').click()
    const rail = page.locator('nav[aria-label="Primary navigation"] a[href]:visible')
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
    expect(expected404.length).toBeGreaterThan(0)
    errors.splice(0, errors.length, ...errors.filter((e) => !expected404.includes(e)))
    await expect(page.locator('#app')).not.toBeEmpty()
  })

  test('the served document asks the on-screen keyboard to resize content and keeps pinch zoom (TAL-1129)', async ({ request }) => {
    const html = await (await request.get('/')).text()
    const tags = html.match(/<meta[^>]*name="viewport"[^>]*>/g) ?? []
    expect(tags).toHaveLength(1)
    const content = (/content="([^"]*)"/.exec(tags[0] ?? '')?.[1] ?? '').split(',').map((part) => part.trim())
    expect(content).toEqual(expect.arrayContaining(['width=device-width', 'initial-scale=1', 'viewport-fit=cover', 'interactive-widget=resizes-content']))
    expect(content.filter((part) => /^(maximum-scale|user-scalable)=/.test(part))).toEqual([])
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

  test('the sidebar owns one pair of corner seams in both states', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'seams only render on desktop')
    await page.goto('/')
    await settle(page)
    const seams = () => page.evaluate(() => [...document.querySelectorAll('.layout > :not(.rightpanel) .seam')].map((el) => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility === 'visible' && el.closest('aside.sidebar') !== null }))
    expect(await seams()).toEqual([true, true])
    await page.locator('#btnSidebarEdgeToggle').click()
    expect(await seams()).toEqual([true, true])
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

  test('switching the language re-translates the open settings page', async ({ page, errors }) => {
    try {
      await page.goto('/settings/appearance')
      await settle(page)
      await expect(page.getByText('Language', { exact: true })).toBeVisible()
      await page.locator('#settingsLanguage').click()
      await page.getByRole('option', { name: 'Deutsch' }).click()
      await expect(page.locator('html')).toHaveAttribute('lang', 'de-DE')
      await expect(page.getByText('Sprache', { exact: true })).toBeVisible()
      await expect(page.getByText('Language', { exact: true })).toHaveCount(0)
      expect(errors).toEqual([])
    } finally {
      expect((await page.request.post('/api/settings', { data: { language: 'en' } })).ok()).toBe(true)
    }
  })

  test('one shell survives every section, which still sets its own sidebar and markers (TAL-1866)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'the tiled column is desktop-only')
    await page.goto('/')
    await settle(page)
    const rail = page.locator('aside.sidebar')
    await rail.evaluate((el) => { el.dataset.shellMarker = 'kept' })
    await page.locator('#btnSidebarEdgeToggle').click()
    const sections = [
      { panel: 'kanban', sidebar: '#panelChat', hub: true },
      { panel: 'tasks', sidebar: '#panelChat', hub: true },
      { panel: 'groups', sidebar: '#panelChat', hub: true },
      { panel: 'chat', sidebar: '#panelChat', hub: false },
    ]
    for (const { panel, sidebar, hub } of sections) {
      const tab = rail.locator(`[data-panel="${panel}"]`)
      await tab.click()
      await expect(tab, panel).toHaveAttribute('aria-current', 'page')
      await expect(rail, panel).toHaveAttribute('data-shell-marker', 'kept')
      await expect(page.locator(sidebar), panel).toBeAttached()
      await expect(page.locator('main#main'), panel).toHaveClass(panel === 'chat' ? /^(?!.*showing-)/ : new RegExp(`showing-${panel}`))
      await expect(page.locator('html'), panel).toHaveClass(hub ? /hub-active/ : /^(?!.*hub-active)/)
    }
  })

  test('an extension route names itself in the titlebar over the session list (TAL-1866)', async ({ page }) => {
    await page.route('**/api/extensions/manifests', (route) => route.fulfill({ json: { protocol_version: 1, manifests: [{ id: 'demo', name: 'Demo Extension', version: '1.0.0', enabled: false, can_toggle: true, source: 'manifest', panel: null, nav: null, capabilities: [], permissions: {}, settings_schema: [], theme: null, tts: null, sidecar: null, legacy_injection: false, warnings: [] }] } }))
    const subtitle = page.locator('#appTitlebarSub')
    await page.goto('/ext/demo')
    await settle(page)
    await expect(subtitle).toHaveText('Demo Extension')
    await expect(page.locator('#sessionList')).toBeAttached()
    await page.goto('/ext/missing')
    await settle(page)
    await expect(subtitle).toHaveText('missing')
    await page.getByRole('link', { name: 'Extensions', exact: true }).last().click()
    await expect(page).toHaveURL(/\/settings\/extensions$/)
    await expect(subtitle).toHaveCount(0)
  })

  test('a chat right panel is gone on a hub and reopens on return (TAL-1866)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'the tiled column is desktop-only')
    const { session } = await (await page.request.post('/api/session/new', { data: {} })).json() as { session: { session_id: string } }
    try {
      await page.goto(`/session/${session.session_id}`)
      await settle(page)
      const html = page.locator('html')
      const panel = page.locator('.rightpanel[data-panel="pages"]')
      await page.locator('#btnWorkspacePanelEdgeToggle').click()
      await expect(panel).toBeVisible()
      await expect(html).toHaveAttribute('data-workspace-panel', 'open')
      await page.locator('aside.sidebar [data-panel="kanban"]').click()
      await expect(panel).toHaveCount(0)
      await expect(html).toHaveAttribute('data-workspace-panel', 'closed')
      await page.goBack()
      await expect(panel).toBeVisible()
      await expect(html).toHaveAttribute('data-workspace-panel', 'open')
    } finally {
      expect((await page.request.post('/api/session/delete', { data: { session_id: session.session_id } })).ok()).toBe(true)
    }
  })

  test('going back dismisses the open tab bar sheet (TAL-1866)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'the tab bar is phone-only')
    await page.goto('/tasks')
    await settle(page)
    await page.locator('.tabbar [data-tab="kanban"]').click()
    await expect(page).toHaveURL(/\/kanban$/)
    await page.locator('.tabbar [data-tab="more"]').click()
    await expect(page.locator('.tabbar-sheet')).toBeVisible()
    await page.goBack()
    await expect(page).toHaveURL(/\/tasks$/)
    await expect(page.locator('.tabbar-sheet')).toHaveCount(0)
  })
})
