import type { Page } from '@playwright/test'
import { expect, settle, test } from './fixtures'

/** TAL-1867: one left column on every page, expanded or as an icon rail, tiled from 641px and a drawer below. */
test.use({ serviceWorkers: 'block' })

const sidebar = (page: Page) => page.locator('aside.sidebar')
const row = (page: Page, name: string) => sidebar(page).getByRole('link', { name, exact: true })
const button = (page: Page, name: string) => sidebar(page).getByRole('button', { name, exact: true })
const left = (page: Page, selector: string) => page.locator(selector).evaluate((el) => el.getBoundingClientRect().left)
const width = (page: Page, selector: string) => page.locator(selector).evaluate((el) => el.getBoundingClientRect().width)
const stored = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key)
/** The destinations and footer controls in DOM order, which is also the tab order. */
const controls = (page: Page) => page.locator('nav[aria-label="Primary navigation"]').locator('a[aria-label]:visible, button[aria-label]:visible').evaluateAll((nodes) => nodes.filter((node) => !node.closest('#panelChat, #panelSettings')).map((node) => node.getAttribute('aria-label')))
const desktopOnly = (name: string) => { test.skip(name !== 'desktop', 'the tiled column is desktop chrome') }
/** Clicks the edge tab and measures every animation frame until the motion has settled. */
const framesOfToggle = (page: Page) => page.evaluate(async () => {
  const aside = document.querySelector('aside.sidebar') as HTMLElement
  const frames: { aside: number; icon: number | null; rowOpacity: number | null; list: number | null; opacity: number | null; handle: string | null }[] = []
  const tasks = aside.querySelector('[data-panel="tasks"]')
  // What the eye gets: a parent's fade or hiding counts against the row.
  const shownOpacity = (el: Element) => {
    let shown = getComputedStyle(el).visibility === 'visible' ? 1 : 0
    for (let node: Element | null = el; node && node !== aside; node = node.parentElement) shown *= Number(getComputedStyle(node).opacity)
    return shown
  }
  document.getElementById('btnSidebarEdgeToggle')!.click()
  const start = performance.now()
  while (performance.now() - start < 500) {
    await new Promise(requestAnimationFrame)
    const panel = document.querySelector('.sidebar-panel')
    const handle = aside.querySelector('.resize-handle')
    frames.push({
      aside: aside.getBoundingClientRect().width,
      icon: tasks?.querySelector('svg')?.getBoundingClientRect().left ?? null,
      rowOpacity: tasks ? shownOpacity(tasks) : null,
      list: panel?.firstElementChild?.getBoundingClientRect().width ?? null,
      opacity: panel ? Number(getComputedStyle(panel).opacity) : null,
      handle: handle ? getComputedStyle(handle).visibility : null,
    })
  }
  return frames
})
/** Records every layout or fade transition the column starts, from the very first paint. */
const recordTransitions = (page: Page) => page.addInitScript(() => {
  const runs: string[] = []
  Object.assign(window, { sidebarTransitions: runs })
  document.addEventListener('transitionrun', (event) => {
    if ((event.target as Element).closest('aside.sidebar') && !event.pseudoElement && ['width', 'min-width', 'opacity', 'visibility', 'translate', 'clip-path'].includes(event.propertyName)) runs.push(event.propertyName)
  }, true)
})
const transitions = (page: Page) => page.evaluate(() => (window as unknown as { sidebarTransitions: string[] }).sidebarTransitions)

async function collapsedOn(page: Page, path: string) {
  await page.goto(path)
  await page.evaluate(() => { localStorage.setItem('hermes-webui-sidebar-collapsed', '1') })
  await page.reload()
  await settle(page)
}

test('every route has the one column, and the page starts at its stored width', async ({ page }, info) => {
  desktopOnly(info.project.name)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.route('**/api/extensions/manifests', (route) => route.fulfill({ json: { protocol_version: 1, manifests: [{ id: 'demo', name: 'Demo Extension', version: '1.0.0', enabled: false, can_toggle: true, source: 'manifest', panel: null, nav: null, capabilities: [], permissions: {}, settings_schema: [], theme: null, tts: null, sidecar: null, legacy_injection: false, warnings: [] }] } }))
  const moreRows = ['Spaces', 'Discussions', 'Todos', 'Profiles', 'Logs']
  for (const [path, more] of [['/', []], ['/skills', []], ['/tasks', []], ['/groups', moreRows], ['/ext/demo', moreRows]] as const) {
    await page.goto(path)
    await settle(page)
    await expect(sidebar(page), path).toHaveCount(1)
    await expect(page.locator('nav[aria-label="Primary navigation"]'), path).toHaveCount(1)
    await expect(sidebar(page).locator('#sessionList'), path).toBeVisible()
    expect(await left(page, '#main'), path).toBe(300)
    expect(await controls(page), path).toEqual(['New conversation', 'New chat', 'Search', 'Tasks', 'Kanban', 'Skills', 'Memory', 'Insights', 'More', ...more, 'Settings', 'Notifications'])
  }
  await page.goto('/settings')
  await settle(page)
  await expect(sidebar(page).locator('#panelSettings')).toBeVisible()
  await expect(page.locator('#sessionList')).toHaveCount(0)
  expect(await left(page, '#main')).toBe(300)

  await page.evaluate(() => { localStorage.setItem('hermes-webui-sidebar-width', '360') })
  await page.goto('/skills')
  await settle(page)
  expect(await left(page, '#main')).toBe(360)
})

test('collapsed, the column is the labelled icon rail, and first paint draws the same width', async ({ page }, info) => {
  desktopOnly(info.project.name)
  await page.setViewportSize({ width: 1440, height: 900 })
  await collapsedOn(page, '/skills')
  expect(await width(page, 'aside.sidebar')).toBe(64)
  expect(await left(page, '#main')).toBe(64)
  expect(await controls(page)).toEqual(['New conversation', 'Search', 'Chat', 'Tasks', 'Kanban', 'Skills', 'Memory', 'Insights', 'Spaces', 'Discussions', 'Todos', 'Profiles', 'Logs', 'Settings', 'Notifications'])
  for (const name of ['Chat', 'Spaces', 'Discussions', 'Tasks', 'Kanban', 'Todos', 'Skills', 'Memory', 'Profiles', 'Insights', 'Logs', 'Settings']) await expect(row(page, name), name).toBeInViewport({ ratio: 1 })
  for (const name of ['Search', 'Notifications']) await expect(button(page, name), name).toBeInViewport({ ratio: 1 })
  await expect(sidebar(page).locator('[aria-current="page"]:visible')).toHaveAttribute('aria-label', 'Skills')
  await page.locator('aside.sidebar').screenshot({ path: info.outputPath('rail.png') })

  // A short window scrolls the destinations and keeps the footer on screen.
  await page.setViewportSize({ width: 1440, height: 480 })
  await expect(row(page, 'Settings')).toBeInViewport({ ratio: 1 })
  await expect(button(page, 'Notifications')).toBeInViewport({ ratio: 1 })

  const frame = () => page.evaluate(() => {
    const probe = document.createElement('div')
    probe.id = 'app'
    document.body.append(probe)
    const measured = getComputedStyle(probe, '::before').width
    probe.remove()
    return measured
  })
  expect(await frame()).toBe('300px')
  await page.evaluate(() => { document.documentElement.dataset.sidebarCollapsed = '1' })
  expect(await frame()).toBe('64px')
})

test('collapsed Search expands and focuses the filter; the edge tab and the shortcut persist the choice', async ({ page }, info) => {
  desktopOnly(info.project.name)
  await collapsedOn(page, '/skills')
  await button(page, 'Search').click()
  await expect(page.locator('#sessionSearch')).toBeFocused()
  await expect.poll(() => width(page, 'aside.sidebar')).toBe(300)
  expect(await stored(page, 'hermes-webui-sidebar-collapsed')).toBe('0')

  await page.keyboard.press('Escape')
  await expect(page.locator('#sessionSearch')).toBeHidden()
  await page.locator('#btnSidebarEdgeToggle').click()
  expect(await stored(page, 'hermes-webui-sidebar-collapsed')).toBe('1')
  await expect(sidebar(page).locator('#sessionList')).toBeHidden()
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur() })
  await page.keyboard.press('ControlOrMeta+b')
  await expect(sidebar(page).locator('#sessionList')).toBeVisible()
  expect(await stored(page, 'hermes-webui-sidebar-collapsed')).toBe('0')
})

async function seedSidebarSessions(page: Page) {
  const now = Math.floor(Date.now() / 1000)
  const sessions = Array.from({ length: 40 }, (_, i) => ({
    session_id: `rail-${String(i)}`, title: `Row ${String(i)}`, is_streaming: false, attention: null, last_message_at: now - i * 60, updated_at: now - i * 60, sort_ts: now - (i < 30 ? i : 86_400 + i) * 60, pinned: false, archived: false, project_id: null,
    is_cli_session: false, source_kind: 'webui', is_messaging_session: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true,
  }))
  await page.route(/\/api\/sessions(\?|$)/, async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...(await response.json() as object), sessions } })
  })
}

test('the chat list keeps its filter, groups and scroll across pages and is out of reach while collapsed', async ({ page }, info) => {
  desktopOnly(info.project.name)
  await seedSidebarSessions(page)
  await page.goto('/')
  await settle(page)
  const list = page.locator('#sessionList')
  const scroll = sidebar(page).locator('.sidebar-scroll')
  const header = page.locator('.session-date-header').last()
  await button(page, 'Search').click()
  await page.locator('#sessionSearch').fill('R')
  await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'false')
  // Leave Skills in view so activating it does not first scroll the shared column.
  await scroll.evaluate((el) => { el.scrollTop = 120 })

  await row(page, 'Skills').click()
  await expect(page).toHaveURL(/\/skills$/)
  await page.goBack()
  await expect(page.locator('#sessionSearch')).toHaveValue('R')
  await expect(header).toHaveAttribute('aria-expanded', 'false')
  expect(await scroll.evaluate((el) => el.scrollTop)).toBe(120)

  await page.locator('#btnSidebarEdgeToggle').click()
  await expect(list).toBeHidden()
  await expect(page.locator('#sessionSearch')).toBeHidden()
  await page.locator('#sessionSearch').evaluate((el) => { (el as HTMLElement).focus() })
  await expect(page.locator('#sessionSearch')).not.toBeFocused()
  await page.locator('.session-item').first().evaluate((el) => { (el as HTMLElement).focus() })
  await expect(page.locator('.session-item').first()).not.toBeFocused()
  await page.locator('#btnSidebarEdgeToggle').click()
  await expect(list).toBeVisible()
  expect(await scroll.evaluate((el) => el.scrollTop)).toBe(120)
  await expect(page.locator('#sessionSearch')).toHaveValue('R')
})

for (const viewport of [
  { width: 390, height: 844 }, { width: 390, height: 480 },
  { width: 382, height: 580 }, { width: 594, height: 368 },
  { width: 385, height: 571 }, { width: 669, height: 867 },
  { width: 951, height: 585 }, { width: 1280, height: 480 },
]) {
  test(`destinations scroll away so chats fill the column at ${String(viewport.width)}x${String(viewport.height)}`, async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'one responsive scroll matrix on the mobile project')
    await page.setViewportSize(viewport)
    await seedSidebarSessions(page)
    await page.goto('/skills')
    await settle(page)
    if (viewport.width <= 900) await page.locator('#btnHamburger').click()
    const list = page.locator('#sessionList')
    const destinations = sidebar(page).locator('.sidebar-rows')
    const visibleHeight = () => list.evaluate((el) => {
      const list = el.getBoundingClientRect()
      const content = el.closest('.sidebar-primary')!
      const brand = content.querySelector('.sidebar-brand')!.getBoundingClientRect()
      const footer = content.querySelector('.sidebar-footer')!.getBoundingClientRect()
      return Math.max(0, Math.min(list.bottom, footer.top) - Math.max(list.top, brand.bottom))
    })
    for (const more of [false, true]) {
      if (more) await button(page, 'More').click()
      await page.screenshot({ path: info.outputPath(`destinations-${more ? 'more' : 'primary'}.png`) })
      if (more) {
        for (const name of ['Spaces', 'Discussions', 'Todos', 'Profiles', 'Logs']) {
          await row(page, name).scrollIntoViewIfNeeded()
          await expect(row(page, name)).toBeInViewport({ ratio: 1 })
        }
      }
      await list.locator('.session-item').first().scrollIntoViewIfNeeded()
      await list.locator('.session-item').first().hover()
      await page.mouse.wheel(0, 1000)
      await expect(destinations, 'destinations leave the viewport when scrolling chats').not.toBeInViewport()
      await expect.poll(visibleHeight, { message: 'chats use most of the column after destinations scroll away' }).toBeGreaterThan(viewport.height * 0.6)
      expect(await visibleHeight()).toBeGreaterThanOrEqual(160)
      await expect(row(page, 'Settings')).toBeInViewport({ ratio: 1 })
      await expect(button(page, 'Notifications')).toBeInViewport({ ratio: 1 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: info.outputPath(`chats-${more ? 'more' : 'primary'}.png`) })
      await page.mouse.wheel(0, -5000)
      await expect(button(page, 'New chat')).toBeInViewport({ ratio: 1 })
    }
  })
}

test('More holds the rest and opens itself on a page inside it', async ({ page }, info) => {
  desktopOnly(info.project.name)
  await page.goto('/skills')
  await settle(page)
  const more = button(page, 'More')
  await expect(more).toHaveAttribute('aria-expanded', 'false')
  await expect(row(page, 'Logs')).toBeHidden()
  await more.click()
  for (const name of ['Spaces', 'Discussions', 'Todos', 'Profiles', 'Logs']) await expect(row(page, name), name).toBeVisible()
  expect(await stored(page, 'hermes-webui-sidebar-more-open')).toBe('1')
  await more.click()
  await expect(row(page, 'Logs')).toBeHidden()
  expect(await stored(page, 'hermes-webui-sidebar-more-open')).toBe('0')

  await page.goto('/logs')
  await settle(page)
  await expect(more).toHaveAttribute('aria-expanded', 'true')
  await expect(row(page, 'Logs')).toHaveAttribute('aria-current', 'page')
  await page.goto('/skills')
  await settle(page)
  await expect(more).toHaveAttribute('aria-expanded', 'false')

})

test('hidden tabs leave both states', async ({ page }, info) => {
  desktopOnly(info.project.name)
  expect((await page.request.post('/api/settings', { data: { hidden_tabs: ['logs', 'kanban'] } })).ok()).toBe(true)
  try {
    await page.goto('/skills')
    await settle(page)
    await button(page, 'More').click()
    await expect(row(page, 'Todos')).toBeVisible()
    for (const name of ['Logs', 'Kanban']) await expect(row(page, name), name).toHaveCount(0)
    await page.locator('#btnSidebarEdgeToggle').click()
    await expect(row(page, 'Chat')).toBeVisible()
    await expect(row(page, 'Todos')).toBeVisible()
    for (const name of ['Logs', 'Kanban']) await expect(row(page, name), name).toHaveCount(0)
  } finally {
    await page.request.post('/api/settings', { data: { hidden_tabs: [] } })
  }
})

test('at tablet width the rail stays tiled and the hamburger overlays the panel without touching the stored choice', async ({ page }, info) => {
  desktopOnly(info.project.name)
  await page.setViewportSize({ width: 800, height: 900 })
  await page.goto('/skills')
  await settle(page)
  const hamburger = page.locator('#btnHamburger')
  const scrim = page.locator('.sidebar-scrim')
  const list = sidebar(page).locator('#sessionList')
  const open = async () => {
    await hamburger.click()
    await expect(list).toBeVisible()
    await expect.poll(() => width(page, 'aside.sidebar')).toBe(300)
    expect(await left(page, '#main')).toBe(64)
  }
  expect(await width(page, 'aside.sidebar')).toBe(64)
  expect(await left(page, '#main')).toBe(64)
  await expect(hamburger).toHaveCount(1)
  await open()
  await page.screenshot({ path: info.outputPath('tablet-open.png') })
  await page.keyboard.press('Escape')
  await expect(list).toBeHidden()
  await open()
  await scrim.click({ position: { x: 700, y: 400 } })
  await expect(list).toBeHidden()
  await open()
  await row(page, 'Memory').click()
  await expect(page).toHaveURL(/\/memory$/)
  await expect(list).toBeHidden()
  await expect.poll(() => width(page, 'aside.sidebar')).toBe(64)

  await button(page, 'Search').click()
  await expect(page.locator('#sessionSearch')).toBeFocused()
  await expect(list).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(list).toBeHidden()
  await expect(hamburger).toBeFocused()
  await page.keyboard.press('ControlOrMeta+b')
  await expect(list).toBeVisible()
  await expect(page.locator('#btnNewChat')).toBeFocused()
  await page.keyboard.press('ControlOrMeta+b')
  await expect(list).toBeHidden()
  expect(await stored(page, 'hermes-webui-sidebar-collapsed')).toBeNull()
})

test('the phone drawer has the expanded content and no icon strip, and the tab bar is unchanged', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'the drawer is phone chrome')
  await page.goto('/skills')
  await settle(page)
  const drawer = page.locator('aside.sidebar.mobile-open')
  await expect(drawer).toHaveCount(0)
  await expect(page.locator('.tabbar [data-tab]')).toHaveText(['Chat', 'Tasks', 'Kanban', 'Agent', 'More'])
  await page.locator('#btnHamburger').click()
  await expect(drawer).toBeInViewport({ ratio: 1 })
  expect(await width(page, 'aside.sidebar')).toBe(390)
  expect(await controls(page)).toEqual(['New conversation', 'New chat', 'Search', 'Tasks', 'Kanban', 'Skills', 'Memory', 'Insights', 'More', 'Settings', 'Notifications'])
  await expect(page.locator('#sessionList')).toBeVisible()
  await page.screenshot({ path: info.outputPath('drawer.png') })
  await row(page, 'Memory').click()
  await expect(page).toHaveURL(/\/memory$/)
  await expect(drawer).toHaveCount(0)
  await page.locator('#btnHamburger').click()
  await expect(drawer).toBeInViewport({ ratio: 1 })
  await page.locator('.mobile-sidebar-close').click()
  await expect(drawer).toHaveCount(0)
})

test('tab order follows the column, and J and K stay inert on a page with no active session', async ({ page }, info) => {
  desktopOnly(info.project.name)
  await page.goto('/skills')
  await settle(page)
  const walked: (string | null)[] = []
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press('Tab')
    walked.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null))
  }
  expect(walked).toEqual(['New conversation', 'New chat', 'Search', 'Tasks'])
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur() })
  await page.keyboard.press('j')
  await page.keyboard.press('k')
  await expect(page).toHaveURL(/\/skills$/)
})

test('a hub keeps its page beside the widest panel with no page-level horizontal overflow', async ({ page }, info) => {
  desktopOnly(info.project.name)
  await page.setViewportSize({ width: 960, height: 800 })
  await page.goto('/kanban')
  await page.evaluate(() => { localStorage.setItem('hermes-webui-sidebar-width', '480') })
  await page.reload()
  await settle(page)
  expect(await width(page, '#main')).toBeGreaterThanOrEqual(420)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

/** TAL-1870: synthetic sources; the server owns `display_level` (`api/settings.test.ts`), and each surface must render the same one. */
const quotaWindow = (label: string, used: number, level: string, expectedUsed: number | null) => ({
  label, used_percent: used, remaining_percent: 100 - used, reset_at: '2030-01-03T12:00:00Z', detail: null, window_seconds: label === 'Weekly' ? 604800 : 18000, display_level: level,
  pace: expectedUsed === null ? null : { expected_remaining_percent: 100 - expectedUsed, expected_used_percent: expectedUsed, pace_delta_percent: expectedUsed - used, burn_rate: 1.1, minutes_to_reset: 3600, projected_minutes_to_empty: 3270, elapsed_minutes: 6480, valid_until: '2030-01-03T12:00:00Z', status: 'over' }, forecast: null,
})
const quotas = {
  version: 1, computed_at: '2030-01-01T00:00:00Z', scope_id: 'qscope_e2e', profile_id: 'default', active_provider: 'anthropic', requested_source_id: null, missing_source: false,
  sources: [
    { source_id: 'qsrc_weekly', provider_id: 'anthropic', provider_label: 'Claude', display_name: 'Claude', status: 'available', display_level: 'warning', pace_window_index: 1, headline_window_index: 1, windows: [quotaWindow('Session', 25, 'healthy', 40), quotaWindow('Weekly', 70, 'warning', 64)] },
    { source_id: 'qsrc_stale', provider_id: 'openai-codex', provider_label: 'Codex', account_label: 'Work', display_name: 'Codex · Work', status: 'stale', status_message: 'Last known usage', display_level: 'stale', pace_window_index: 0, headline_window_index: 0, windows: [quotaWindow('Weekly', 40, 'stale', null)] },
    { source_id: 'qsrc_down', provider_id: 'zai', provider_label: 'Z.ai', display_name: 'Z.ai', status: 'unavailable', status_message: 'Sign in again', display_level: 'unavailable', pace_window_index: 0, headline_window_index: 0, windows: [quotaWindow('Weekly', 90, 'unavailable', null)] },
    { source_id: 'qsrc_credits', provider_id: 'openrouter', provider_label: 'OpenRouter', display_name: 'OpenRouter', status: 'available', quota: { limit_remaining: 12.5 }, display_level: 'healthy', pace_window_index: null, headline_window_index: null, windows: [] },
  ],
}
const pin = (page: Page, sources: string[]) => page.request.post('/api/settings', { data: { sidebar_quota_sources: sources } })
const quotaGroup = (page: Page) => sidebar(page).locator('[data-section="sidebar-quotas"]')
const quotaRow = (page: Page, source: string) => quotaGroup(page).locator(`[data-quota-source="${source}"]`)

/** Pin before the first load: the shell restores settings from its snapshot, so a later write would not show on a reload. The server's projection is owned by `api/settings.test.ts`. */
async function withPins(page: Page, sources: string[], run: () => Promise<void>) {
  await page.route('**/api/provider/quotas**', (route) => route.fulfill({ json: { ...quotas, sidebar_source_ids: sources, sidebar_can_pin: sources.length < 2 } }))
  await pin(page, sources)
  try {
    await page.goto('/skills')
    await settle(page)
    await run()
  } finally {
    await pin(page, [])
  }
}
const insightsLevel = (page: Page, source: string) => page.locator(`[data-section="insights-quotas"] [data-quota-source="${source}"] [data-quota-window="Weekly"]`).getAttribute('data-level')
const openInsightsFrom = async (page: Page, source: string) => {
  await quotaRow(page, source).click()
  await expect(page).toHaveURL(/\/insights\?tab=quotas$/)
  await expect(page.getByRole('tab', { name: 'Quotas' })).toHaveAttribute('aria-selected', 'true')
}

test('pinned quotas show the pace window figures in pinned order and open Insights at the same levels', async ({ page }, info) => {
  desktopOnly(info.project.name)
  await withPins(page, ['qsrc_stale', 'qsrc_weekly'], async () => {
    await expect(quotaGroup(page).getByRole('heading', { level: 3, name: 'Quotas' })).toBeVisible()
    await expect(quotaGroup(page).locator('[data-quota-source]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-quota-source')))).resolves.toEqual(['qsrc_stale', 'qsrc_weekly'])
    await expect(quotaRow(page, 'qsrc_weekly')).toHaveAttribute('aria-label', 'Claude: 70% Used')
    await expect(quotaRow(page, 'qsrc_weekly')).toContainText('70%')
    const meter = quotaRow(page, 'qsrc_weekly').getByRole('meter')
    await expect(meter).toHaveAttribute('aria-valuenow', '70')
    await expect(meter.locator('div').first()).toHaveAttribute('style', /width: 70%/)
    await expect(meter.locator('div').first()).toHaveClass(/bg-warning/)
    await expect(meter.locator('div').nth(1)).toHaveAttribute('style', /left: 64%/)
    await expect(quotaRow(page, 'qsrc_stale')).toHaveAttribute('aria-label', 'Codex · Work: 40% Used, Last known usage')
    await expect(quotaRow(page, 'qsrc_stale')).toContainText('Last known usage')
    await expect(quotaRow(page, 'qsrc_stale').locator('[role="meter"] > div').first()).toHaveClass(/bg-muted/)
    await page.locator('aside.sidebar').screenshot({ path: info.outputPath('quotas-expanded.png') })

    await openInsightsFrom(page, 'qsrc_weekly')
    await expect(quotaRow(page, 'qsrc_weekly')).toHaveAttribute('data-level', 'warning')
    expect(await insightsLevel(page, 'qsrc_weekly')).toBe('warning')
    await expect(quotaRow(page, 'qsrc_stale')).toHaveAttribute('data-level', 'stale')
    expect(await insightsLevel(page, 'qsrc_stale')).toBe('stale')
  })
})

test('an unavailable source shows its server status at its Insights level', async ({ page }, info) => {
  desktopOnly(info.project.name)
  await withPins(page, ['qsrc_down'], async () => {
    await expect(quotaRow(page, 'qsrc_down')).toContainText('Sign in again')
    await expect(quotaRow(page, 'qsrc_down')).toHaveAttribute('data-level', 'unavailable')
    await openInsightsFrom(page, 'qsrc_down')
    expect(await insightsLevel(page, 'qsrc_down')).toBe('unavailable')
  })
})

test('a credit source shows its amount without a meter, and the rail has no quota element', async ({ page }, info) => {
  desktopOnly(info.project.name)
  await withPins(page, ['qsrc_credits'], async () => {
    await expect(quotaRow(page, 'qsrc_credits')).toContainText('12.5')
    await expect(quotaRow(page, 'qsrc_credits').getByRole('meter')).toHaveCount(0)
    await page.locator('#btnSidebarEdgeToggle').click()
    await expect(row(page, 'Chat')).toBeVisible()
    await expect(page.locator('[data-section="sidebar-quotas"]')).toBeHidden()
    await expect(quotaGroup(page)).toBeHidden()
  })
})

test('with nothing pinned the sidebar has no group and reads no quotas', async ({ page }, info) => {
  desktopOnly(info.project.name)
  let reads = 0
  await page.route('**/api/provider/quotas**', (route) => { reads++; return route.fulfill({ json: quotas }) })
  await page.goto('/skills')
  await settle(page)
  await expect(row(page, 'Skills')).toBeVisible()
  await expect(quotaGroup(page)).toHaveCount(0)
  expect(reads).toBe(0)
})

test('Sidebar settings pin from the server projection, shows a choice at once and rolls a refusal back', async ({ page, errors }, info) => {
  desktopOnly(info.project.name)
  let projection = { sidebar_source_ids: [] as string[], sidebar_can_pin: true }
  await page.route('**/api/provider/quotas**', (route) => route.fulfill({ json: { ...quotas, ...projection } }))
  // Synthetic quota IDs need the same projection on successful saves and reads.
  await page.route(/\/api\/settings$/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...await response.json(), ...projection } })
  })
  await page.goto('/settings/sidebar')
  await settle(page)
  const picker = page.locator('#settingsSidebarQuotas')
  const source = (name: string) => picker.getByRole('switch', { name })
  const toggle = (name: string) => Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/settings') && r.request().method() === 'POST'), source(name).click()])
  await expect(picker.getByRole('switch')).toHaveCount(4)
  try {
    // The choice shows while the write is still held, before the server has answered.
    let release!: () => void
    await page.route('**/api/settings', async (route) => {
      if (route.request().method() === 'POST') await new Promise<void>((resolve) => { release = resolve })
      await route.fallback()
    })
    await source('Claude').click()
    await expect(source('Claude')).toBeChecked()
    projection = { sidebar_source_ids: ['qsrc_weekly'], sidebar_can_pin: true }
    release()
    await expect.poll(async () => (await (await page.request.get('/api/settings')).json() as { sidebar_quota_sources: string[] }).sidebar_quota_sources).toEqual(['qsrc_weekly'])
    await page.unroute('**/api/settings')

    // The server's `sidebar_can_pin` closes the picker at two, and removing one reopens it.
    projection = { sidebar_source_ids: ['qsrc_weekly', 'qsrc_credits'], sidebar_can_pin: false }
    await toggle('OpenRouter')
    await expect(source('OpenRouter')).toBeChecked()
    await expect(source('Z.ai')).toBeDisabled()
    await expect(source('Claude')).toBeEnabled()
    projection = { sidebar_source_ids: ['qsrc_credits'], sidebar_can_pin: true }
    await toggle('Claude')
    await expect(source('Claude')).not.toBeChecked()
    await expect(source('Z.ai')).toBeEnabled()

    // Overlapping refusals restore the confirmed projection without a read, across a remount, even when the read also fails.
    let refuse!: () => void
    const refused = new Promise<void>((resolve) => { refuse = resolve })
    await page.route('**/api/provider/quotas**', (route) => route.fulfill({ status: 500, json: { error: 'Down' } }))
    await page.route('**/api/settings', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      await refused
      return route.fulfill({ status: 400, json: { error: 'Refused' } })
    })
    await source('Z.ai').click()
    await expect(source('Z.ai')).toBeChecked()
    // Leaving the section unmounts the picker while the write is still held.
    await sidebar(page).getByRole('link', { name: 'Appearance' }).click()
    await expect(picker).toHaveCount(0)
    await sidebar(page).getByRole('link', { name: 'Sidebar', exact: true }).click()
    await source('OpenRouter').click()
    await expect(source('OpenRouter')).not.toBeChecked()
    refuse()
    await expect(page.getByText('Refused').first()).toBeVisible()
    await expect(source('Z.ai')).not.toBeChecked()
    await expect(source('OpenRouter')).toBeChecked()

    // A write that succeeded survives a later refusal, even with the reread failing.
    await page.unroute('**/api/settings')
    let settle!: () => void
    const held = new Promise<void>((resolve) => { settle = resolve })
    let posts = 0
    // The save's own projection decides the rollback state, not the stored pins, which still hold a source no longer listed.
    const saved = { sidebar_quota_sources: ['qsrc_gone', 'qsrc_weekly'], sidebar_source_ids: ['qsrc_credits', 'qsrc_weekly'], sidebar_can_pin: false }
    await page.route('**/api/settings', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      await held
      return ++posts === 1 ? route.fulfill({ json: saved }) : route.fulfill({ status: 400, json: { error: 'Refused' } })
    })
    await source('Claude').click()
    await expect(source('Claude')).toBeChecked()
    await source('OpenRouter').click()
    await expect(source('OpenRouter')).not.toBeChecked()
    const refusal = page.waitForResponse((r) => r.url().endsWith('/api/settings') && r.status() === 400)
    settle()
    await refusal
    await expect(source('OpenRouter')).toBeChecked()
    await expect(source('Claude')).toBeChecked()

    // Settings has no destinations column, so the rows show on leaving it.
    await sidebar(page).getByRole('button', { name: 'Back', exact: true }).click()
    await expect(quotaRow(page, 'qsrc_credits')).toBeVisible()
    await expect(quotaRow(page, 'qsrc_down')).toHaveCount(0)
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await pin(page, [])
    errors.splice(0, errors.length, ...errors.filter((e) => !/POST .*\/api\/settings|GET .*\/api\/provider\/quotas|status of (400|500)/.test(e)))
  }
})

test('a confirmed first pin stays in the sidebar when a later choice is refused and the settings reread fails', async ({ page, errors }, info) => {
  desktopOnly(info.project.name)
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let posts = 0
  let readsFail = false
  await page.route('**/api/provider/quotas**', (route) => route.fulfill({ json: { ...quotas, sidebar_source_ids: posts ? ['qsrc_weekly'] : [], sidebar_can_pin: true } }))
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'POST') return readsFail ? route.fulfill({ status: 500, json: { error: 'Down' } }) : route.fallback()
    await held
    return ++posts === 1 ? route.fulfill({ json: { sidebar_quota_sources: ['qsrc_weekly'], sidebar_source_ids: ['qsrc_weekly'], sidebar_can_pin: true } }) : route.fulfill({ status: 400, json: { error: 'Refused' } })
  })
  await page.goto('/settings/sidebar')
  await settle(page)
  const source = (name: string) => page.locator('#settingsSidebarQuotas').getByRole('switch', { name })
  await source('Claude').click()
  await expect(source('Claude')).toBeChecked()
  await source('Z.ai').click()
  await expect(source('Z.ai')).toBeChecked()
  readsFail = true
  const refusal = page.waitForResponse((r) => r.url().endsWith('/api/settings') && r.status() === 400)
  release()
  await refusal
  await sidebar(page).getByRole('button', { name: 'Back', exact: true }).click()
  await expect(quotaRow(page, 'qsrc_weekly')).toBeVisible()
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  errors.splice(0, errors.length, ...errors.filter((e) => !/\/api\/settings|status of (400|500)/.test(e)))
})

test('the phone drawer shows pinned quotas and a row closes it into Insights', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'the drawer is phone chrome')
  await withPins(page, ['qsrc_weekly', 'qsrc_stale'], async () => {
    await page.locator('#btnHamburger').click()
    await expect(quotaRow(page, 'qsrc_weekly')).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: info.outputPath('quotas-drawer.png') })
    await quotaRow(page, 'qsrc_weekly').click()
    await expect(page).toHaveURL(/\/insights\?tab=quotas$/)
    await expect(page.locator('aside.sidebar.mobile-open')).toHaveCount(0)
  })
})

/** TAL-1868: Settings shows Back and its section list in the one column, never the destinations or a second column. */
test('Settings swaps the column for Back and its sections, whatever the stored choice, and leaving restores it', async ({ page }, info) => {
  desktopOnly(info.project.name)
  await page.setViewportSize({ width: 1440, height: 900 })
  await collapsedOn(page, '/skills')
  await sidebar(page).evaluate((el) => { el.dataset.shellMarker = 'kept' })
  await row(page, 'Settings').click()
  await expect(page).toHaveURL(/\/settings\/appearance$/)
  await expect(sidebar(page)).toHaveAttribute('data-shell-marker', 'kept')
  await expect.poll(() => width(page, 'aside.sidebar')).toBe(300)
  expect(await left(page, '#main')).toBe(300)
  expect(await controls(page)).toEqual(['Back'])
  await expect(page.locator('nav[aria-label="Primary navigation"]')).toHaveCount(1)
  await expect(sidebar(page).locator('#settingsMenu [data-settings-section="system"]')).toBeVisible()
  await expect(sidebar(page).locator('[data-panel], .sidebar-brand, .sidebar-footer, #sessionList')).toHaveCount(0)
  await expect(page.locator('#btnSidebarEdgeToggle')).toHaveCount(0)
  await expect(page.locator('main#main')).toHaveClass(/showing-settings/)
  await expect(page.locator('html')).not.toHaveClass(/hub-active/)
  await page.screenshot({ path: info.outputPath('settings-desktop.png') })

  await page.keyboard.press('ControlOrMeta+b')
  expect(await width(page, 'aside.sidebar')).toBe(300)
  expect(await stored(page, 'hermes-webui-sidebar-collapsed')).toBe('1')

  // Moving between sections does not change where Back goes.
  await page.locator('[data-settings-section="system"]').click()
  await expect(page).toHaveURL(/\/settings\/system$/)
  await button(page, 'Back').click()
  await expect(page).toHaveURL(/\/skills$/)
  await expect.poll(() => width(page, 'aside.sidebar')).toBe(64)
  expect(await stored(page, 'hermes-webui-sidebar-collapsed')).toBe('1')
  await expect(page.locator('#btnSidebarEdgeToggle')).toHaveCount(1)
})

test('Back keeps the query of the page it returns to, and goes to the chat after a direct load of Settings', async ({ page }, info) => {
  desktopOnly(info.project.name)
  await page.goto('/insights?tab=usage')
  await settle(page)
  await row(page, 'Settings').click()
  await expect(page).toHaveURL(/\/settings\/appearance$/)
  await expect(button(page, 'Back')).toBeVisible()
  await button(page, 'Back').click()
  await expect(page).toHaveURL(/\/insights\?tab=usage$/)

  await page.goto('/settings/about')
  await settle(page)
  await button(page, 'Back').click()
  await expect(page).not.toHaveURL(/settings/)
  await expect(sidebar(page).locator('#sessionList')).toBeVisible()
  await expect(page.locator('main#main')).not.toHaveClass(/showing-/)
})

test('at tablet width Settings tiles its section list, and an open overlay does not follow it there', async ({ page }, info) => {
  desktopOnly(info.project.name)
  await page.setViewportSize({ width: 800, height: 900 })
  await page.goto('/skills')
  await settle(page)
  await page.locator('#btnHamburger').click()
  await expect(sidebar(page).locator('#sessionList')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+,')
  await expect(page).toHaveURL(/\/settings\/appearance$/)
  await expect(page.locator('.sidebar-scrim')).toHaveCount(0)
  await expect(page.locator('#btnHamburger')).toHaveCount(0)
  await expect.poll(() => width(page, 'aside.sidebar')).toBe(300)
  expect(await left(page, '#main')).toBe(300)
  await page.keyboard.press('ControlOrMeta+b')
  await expect(page.locator('.sidebar-scrim')).toHaveCount(0)
  expect(await width(page, 'aside.sidebar')).toBe(300)
  await page.screenshot({ path: info.outputPath('settings-tablet.png') })
  await button(page, 'Back').click()
  await expect(page).toHaveURL(/\/skills$/)
  await expect.poll(() => width(page, 'aside.sidebar')).toBe(64)
  await expect(page.locator('.sidebar-scrim')).toHaveCount(0)
})

test('first paint on Settings draws the expanded column whatever the stored choice', async ({ page }, info) => {
  desktopOnly(info.project.name)
  await page.addInitScript(() => { localStorage.setItem('hermes-webui-sidebar-collapsed', '1') })
  // Only the pre-paint script runs, so the frame is what the page shows before the module entry mounts.
  await page.route(/\.js(\?|$)/, (route) => (route.request().url().includes('prepaint') ? route.continue() : route.fulfill({ contentType: 'text/javascript', body: '' })))
  const frame = () => page.locator('#app').evaluate((el) => (el.childElementCount === 0 ? getComputedStyle(el, '::before').width : 'mounted'))
  for (const [viewport, path, expected] of [[1440, '/settings/appearance', '300px'], [800, '/settings/appearance', '300px'], [1440, '/skills', '64px'], [800, '/skills', '64px']] as const) {
    await page.setViewportSize({ width: viewport, height: 900 })
    await page.goto(path)
    expect(await frame(), `${path} at ${String(viewport)}`).toBe(expected)
  }
})

test('the phone drawer on Settings has Back and the sections, and Back closes it on the page the user came from', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'the drawer is phone chrome')
  await page.goto('/skills')
  await settle(page)
  const drawer = page.locator('aside.sidebar.mobile-open')
  await page.locator('#btnHamburger').click()
  await row(page, 'Settings').click()
  await expect(page).toHaveURL(/\/settings\/appearance$/)
  await expect(drawer).toHaveCount(0)
  await page.locator('#btnHamburger').click()
  await expect(drawer).toBeInViewport({ ratio: 1 })
  expect(await width(page, 'aside.sidebar')).toBe(390)
  expect(await controls(page)).toEqual(['Back'])
  await expect(sidebar(page).locator('#settingsMenu [data-settings-section="system"]')).toBeVisible()
  await expect(sidebar(page).locator('#sessionList, .sidebar-footer')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('settings-drawer.png') })
  await page.locator('[data-settings-section="system"]').click()
  await expect(page).toHaveURL(/\/settings\/system$/)
  await expect(drawer).toHaveCount(0)
  await page.locator('#btnHamburger').click()
  await button(page, 'Back').click()
  await expect(page).toHaveURL(/\/skills$/)
  await expect(drawer).toHaveCount(0)
  await expect(page.locator('.tabbar [data-tab]')).toHaveText(['Chat', 'Tasks', 'Kanban', 'Agent', 'More'])
})

test('collapsing and expanding morph one set of rows: icons stay put, nothing blanks and the list never squeezes', async ({ page }, info) => {
  desktopOnly(info.project.name)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await page.evaluate(() => { localStorage.setItem('hermes-webui-sidebar-width', '360'); localStorage.setItem('hermes-webui-sidebar-collapsed', '1') })
  await page.reload()
  await settle(page)

  const assertMorph = (frames: Awaited<ReturnType<typeof framesOfToggle>>) => {
    const widths = frames.map((frame) => frame.aside)
    expect(widths.filter((w) => w > 64 && w < 360).length, 'the width animates').toBeGreaterThan(2)
    const direction = Math.sign(widths.at(-1)! - widths[0]!)
    expect(widths.filter((w, i) => i > 0 && (w - widths[i - 1]!) * direction < 0), 'the width never reverses').toEqual([])
    expect(frames.filter((frame) => frame.rowOpacity !== 1), 'the destination rows never fade').toEqual([])
    const icons = frames.map((frame) => frame.icon ?? 0)
    expect(Math.max(...icons) - Math.min(...icons), 'the icon stays put').toBeLessThanOrEqual(12)
    expect(frames.filter((frame) => (frame.list ?? 0) < 344), 'the list holds its stored width').toEqual([])
  }

  const expanding = await framesOfToggle(page)
  assertMorph(expanding)
  expect(expanding.at(-1)?.aside).toBe(360)
  expect(expanding.at(-1)?.opacity).toBe(1)
  expect(expanding.filter((frame) => frame.aside < 360 && frame.handle === 'visible'), 'the resize handle takes no hover as it sweeps past a pointer on the edge tab').toEqual([])

  const collapsing = await framesOfToggle(page)
  assertMorph(collapsing)
  expect(collapsing.at(-1)?.aside).toBe(64)
  expect(collapsing.at(-1)?.opacity).toBe(0)
})

test('once the motion settles, rows the state hides take no focus', async ({ page }, info) => {
  desktopOnly(info.project.name)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await collapsedOn(page, '/skills')
  const newChat = page.locator('#btnNewChat')
  const chat = page.locator('aside.sidebar [data-panel="chat"]')
  const logs = page.locator('aside.sidebar [data-panel="logs"]')
  const takesFocus = (control: typeof chat) => control.evaluate((el) => { (el as HTMLElement).focus(); return document.activeElement === el })
  await expect(newChat).toBeHidden()
  expect(await takesFocus(newChat)).toBe(false)
  expect(await takesFocus(chat)).toBe(true)
  expect(await takesFocus(logs)).toBe(true)

  await page.locator('#btnSidebarEdgeToggle').click()
  await expect(chat).toBeHidden()
  await expect(logs).toBeHidden()
  expect(await takesFocus(chat)).toBe(false)
  expect(await takesFocus(logs)).toBe(false)
  expect(await takesFocus(newChat)).toBe(true)
})

test('reduced motion toggles at once with no fade', async ({ page }, info) => {
  desktopOnly(info.project.name)
  await page.goto('/')
  await settle(page)
  const instant = (frames: Awaited<ReturnType<typeof framesOfToggle>>) => frames.filter((frame) => (frame.aside !== 300 && frame.aside !== 64) || frame.opacity !== (frame.aside === 64 ? 0 : 1))
  const collapsing = await framesOfToggle(page)
  expect(instant(collapsing)).toEqual([])
  expect(collapsing.at(-1)?.aside).toBe(64)
  const expanding = await framesOfToggle(page)
  expect(instant(expanding)).toEqual([])
  expect(expanding.at(-1)?.aside).toBe(300)
})

test('a stored collapse paints on load with no transition', async ({ page }, info) => {
  desktopOnly(info.project.name)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await recordTransitions(page)
  await collapsedOn(page, '/')
  expect(await width(page, 'aside.sidebar')).toBe(64)
  expect(await transitions(page)).toEqual([])
})

test('dragging the edge resizes the column and its content with the pointer, with no transition lag', async ({ page }, info) => {
  desktopOnly(info.project.name)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/')
  await settle(page)
  const box = await page.locator('#sidebarResize').boundingBox()
  if (!box) throw new Error('no resize handle')
  await page.mouse.move(box.x + 3, box.y + 100)
  await page.mouse.down()
  await page.mouse.move(box.x + 103, box.y + 100)
  expect(await width(page, 'aside.sidebar')).toBe(400)
  expect(await width(page, '.sidebar-panel > *')).toBe(384)
  await page.mouse.up()
  expect(await stored(page, 'hermes-webui-sidebar-width')).toBe('400')
})
