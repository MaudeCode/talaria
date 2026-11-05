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
const controls = (page: Page) => page.locator('nav[aria-label="Primary navigation"]').locator('a[aria-label], button[aria-label]').evaluateAll((nodes) => nodes.filter((node) => !node.closest('#panelChat, #panelSettings')).map((node) => node.getAttribute('aria-label')))
const desktopOnly = (name: string) => { test.skip(name !== 'desktop', 'the tiled column is desktop chrome') }

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
  expect(await controls(page)).toEqual(['New conversation', 'Search', 'Chat', 'Spaces', 'Discussions', 'Tasks', 'Kanban', 'Todos', 'Skills', 'Memory', 'Profiles', 'Insights', 'Logs', 'Notifications', 'Settings'])
  for (const name of ['Chat', 'Spaces', 'Discussions', 'Tasks', 'Kanban', 'Todos', 'Skills', 'Memory', 'Profiles', 'Insights', 'Logs', 'Settings']) await expect(row(page, name), name).toBeInViewport({ ratio: 1 })
  for (const name of ['Search', 'Notifications']) await expect(button(page, name), name).toBeInViewport({ ratio: 1 })
  await expect(sidebar(page).locator('[aria-current="page"]')).toHaveAttribute('aria-label', 'Skills')
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

  // Settings has no chat list, so its Search goes to the chat that has one.
  await page.goto('/settings')
  await settle(page)
  await button(page, 'Search').click()
  await expect(page).not.toHaveURL(/settings/)
  await expect(page.locator('#sessionSearch')).toBeFocused()
})

test('the chat list keeps its filter, groups and scroll across pages and is out of reach while collapsed', async ({ page }, info) => {
  desktopOnly(info.project.name)
  const now = Math.floor(Date.now() / 1000)
  const sessions = Array.from({ length: 40 }, (_, i) => ({
    session_id: `rail-${String(i)}`, title: `Row ${String(i)}`, is_streaming: false, attention: null, last_message_at: now - i * 60, updated_at: now - i * 60, sort_ts: now - (i < 30 ? i : 86_400 + i) * 60, pinned: false, archived: false, project_id: null,
    is_cli_session: false, source_kind: 'webui', is_messaging_session: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true,
  }))
  await page.route(/\/api\/sessions(\?|$)/, async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...(await response.json() as object), sessions } })
  })
  await page.goto('/')
  await settle(page)
  const list = page.locator('#sessionList')
  const header = page.locator('.session-date-header').last()
  await button(page, 'Search').click()
  await page.locator('#sessionSearch').fill('R')
  await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'false')
  await list.evaluate((el) => { el.scrollTop = 200 })

  await row(page, 'Skills').click()
  await expect(page).toHaveURL(/\/skills$/)
  await page.goBack()
  await expect(page.locator('#sessionSearch')).toHaveValue('R')
  await expect(header).toHaveAttribute('aria-expanded', 'false')
  expect(await list.evaluate((el) => el.scrollTop)).toBe(200)

  await page.locator('#btnSidebarEdgeToggle').click()
  await expect(list).toBeHidden()
  await expect(page.locator('#sessionSearch')).toBeHidden()
  await page.locator('#sessionSearch').evaluate((el) => { (el as HTMLElement).focus() })
  await expect(page.locator('#sessionSearch')).not.toBeFocused()
  await page.locator('.session-item').first().evaluate((el) => { (el as HTMLElement).focus() })
  await expect(page.locator('.session-item').first()).not.toBeFocused()
  await page.locator('#btnSidebarEdgeToggle').click()
  await expect(list).toBeVisible()
  expect(await list.evaluate((el) => el.scrollTop)).toBe(200)
  await expect(page.locator('#sessionSearch')).toHaveValue('R')
})

test('More holds the rest and opens itself on a page inside it', async ({ page }, info) => {
  desktopOnly(info.project.name)
  await page.goto('/skills')
  await settle(page)
  const more = button(page, 'More')
  await expect(more).toHaveAttribute('aria-expanded', 'false')
  await expect(row(page, 'Logs')).toHaveCount(0)
  await more.click()
  for (const name of ['Spaces', 'Discussions', 'Todos', 'Profiles', 'Logs']) await expect(row(page, name), name).toBeVisible()
  expect(await stored(page, 'hermes-webui-sidebar-more-open')).toBe('1')
  await more.click()
  await expect(row(page, 'Logs')).toHaveCount(0)
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

/** TAL-1870: synthetic sources; `urgency.pace` and the pace window differ per source so a level or figure can only come from the right field. */
const quotaWindow = (label: string, used: number, level: string, expectedUsed: number | null) => ({
  label, used_percent: used, remaining_percent: 100 - used, reset_at: '2030-01-03T12:00:00Z', detail: null, window_seconds: label === 'Weekly' ? 604800 : 18000, urgency: { remaining: level, pace: level },
  pace: expectedUsed === null ? null : { expected_remaining_percent: 100 - expectedUsed, expected_used_percent: expectedUsed, pace_delta_percent: expectedUsed - used, burn_rate: 1.1, minutes_to_reset: 3600, projected_minutes_to_empty: 3270, elapsed_minutes: 6480, valid_until: '2030-01-03T12:00:00Z', status: 'over' }, forecast: null,
})
const quotas = {
  version: 1, computed_at: '2030-01-01T00:00:00Z', scope_id: 'qscope_e2e', profile_id: 'default', active_provider: 'anthropic', requested_source_id: null, missing_source: false,
  sources: [
    { source_id: 'qsrc_weekly', provider_id: 'anthropic', provider_label: 'Claude', status: 'available', urgency: { remaining: 'healthy', pace: 'warning' }, pace_window_index: 1, windows: [quotaWindow('Session', 25, 'healthy', 40), quotaWindow('Weekly', 70, 'warning', 64)] },
    { source_id: 'qsrc_stale', provider_id: 'openai-codex', provider_label: 'Codex', account_label: 'Work', status: 'stale', message: 'Last known usage', urgency: { remaining: 'stale', pace: 'stale' }, pace_window_index: 0, windows: [quotaWindow('Weekly', 40, 'healthy', null)] },
    { source_id: 'qsrc_down', provider_id: 'zai', provider_label: 'Z.ai', status: 'unavailable', unavailable_reason: 'Sign in again', pace_window_index: 0, windows: [quotaWindow('Weekly', 90, 'critical', null)] },
    { source_id: 'qsrc_credits', provider_id: 'openrouter', provider_label: 'OpenRouter', status: 'available', quota: { limit_remaining: 12.5 }, urgency: { remaining: 'healthy', pace: 'healthy' }, pace_window_index: null, windows: [] },
  ],
}
const pin = (page: Page, sources: string[]) => page.request.post('/api/settings', { data: { sidebar_quota_sources: sources } })
const quotaGroup = (page: Page) => sidebar(page).locator('[data-section="sidebar-quotas"]')
const quotaRow = (page: Page, source: string) => quotaGroup(page).locator(`[data-quota-source="${source}"]`)

/** Pin before the first load: the shell restores settings from its snapshot, so a later write would not show on a reload. */
async function withPins(page: Page, sources: string[], run: () => Promise<void>) {
  await page.route('**/api/provider/quotas**', (route) => route.fulfill({ json: quotas }))
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

test('an unavailable source shows its server status, and a source the server no longer lists takes its row with it', async ({ page }, info) => {
  desktopOnly(info.project.name)
  await withPins(page, ['qsrc_gone', 'qsrc_down'], async () => {
    await expect(quotaGroup(page).locator('[data-quota-source]')).toHaveCount(1)
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
    await expect(quotaGroup(page)).toHaveCount(0)
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

test('Preferences pins up to two listed sources and the sidebar follows at once', async ({ page }, info) => {
  desktopOnly(info.project.name)
  await page.route('**/api/provider/quotas**', (route) => route.fulfill({ json: quotas }))
  await pin(page, ['qsrc_gone'])
  try {
    await page.goto('/settings/preferences')
    await settle(page)
    const picker = page.locator('#settingsSidebarQuotas')
    const source = (name: string) => picker.getByRole('switch', { name })
    await expect(picker.getByRole('switch')).toHaveCount(4)
    await expect(quotaGroup(page)).toHaveCount(0)
    await source('Claude').click()
    await expect(quotaRow(page, 'qsrc_weekly')).toBeVisible()
    await source('OpenRouter').click()
    await expect(source('OpenRouter')).toBeChecked()
    await expect(source('Z.ai')).toBeDisabled()
    await expect(source('Claude')).toBeEnabled()
    await source('Claude').click()
    await expect(quotaRow(page, 'qsrc_weekly')).toHaveCount(0)
    await expect(source('Z.ai')).toBeEnabled()
    await expect.poll(async () => (await (await page.request.get('/api/settings')).json() as { sidebar_quota_sources: string[] }).sidebar_quota_sources).toEqual(['qsrc_credits'])
  } finally {
    await pin(page, [])
  }
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
