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
