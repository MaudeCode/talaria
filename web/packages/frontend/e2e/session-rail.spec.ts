import type { Locator, Page } from '@playwright/test'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** The session row's left rail shows run and attention status, never selection; the actions stay clear of it (TAL-365). */

const now = Math.floor(Date.now() / 1000)
const row = (session_id: string, title: string, extra: Record<string, unknown> = {}) => ({
  session_id, title, is_streaming: false, attention: null, last_message_at: now - 600, updated_at: now - 600, pinned: false, archived: false, project_id: null,
  is_cli_session: false, source_kind: 'webui', is_messaging_session: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_duplicate: true, ...extra,
})
const ROWS = [
  row('rail-idle', 'Idle and selected'),
  row('rail-running', 'Running with a long title that has to truncate before the actions column', { is_streaming: true }),
  row('rail-attention', 'Waiting on an approval', { attention: { kind: 'approval', count: 1 }, pinned: true }),
  row('rail-both', 'Running and waiting', { is_streaming: true, attention: { kind: 'approval', count: 1 } }),
]

const item = (page: Page, sid: string) => page.locator(`.session-item[data-sid="${sid}"]`)
const rail = (el: Locator) => el.evaluate((node) => {
  const s = getComputedStyle(node, '::before')
  return { content: s.content, color: s.backgroundColor, animation: s.animationName }
})
const dot = (el: Locator) => el.evaluate((node) => getComputedStyle(node, '::after').content)
const resolved = (page: Page, token: string) => page.evaluate((t) => {
  const probe = document.createElement('div')
  probe.style.background = `var(${t})`
  document.body.append(probe)
  const color = getComputedStyle(probe).backgroundColor
  probe.remove()
  return color
}, token)

async function openSidebar(page: Page): Promise<void> {
  await settle(page)
  const hamburger = page.locator('#btnHamburger')
  if (await hamburger.isVisible()) {
    await hamburger.click()
    await expect(page.locator('aside.sidebar')).toHaveAttribute('data-mobile-open', '1')
  }
  await expect(item(page, 'rail-idle')).toBeVisible()
}

async function expectStatus(page: Page): Promise<void> {
  const accent = await resolved(page, '--accent')
  const warning = await resolved(page, '--warning')
  // Selection alone draws no rail; status does, selected or not, and no dot sits by the actions.
  expect((await rail(item(page, 'rail-idle'))).content).toBe('none')
  for (const sid of ['rail-running', 'rail-both']) expect(await rail(item(page, sid))).toMatchObject({ content: '""', color: accent })
  expect(await rail(item(page, 'rail-attention'))).toMatchObject({ content: '""', color: warning })
  for (const sid of ['rail-idle', 'rail-running', 'rail-attention', 'rail-both']) expect(await dot(item(page, sid))).toBe('none')
  // Status reaches assistive technology as text, not only color or motion; idle rows say nothing extra.
  expect(await item(page, 'rail-running').ariaSnapshot()).toContain('Streaming')
  expect(await item(page, 'rail-attention').ariaSnapshot()).toContain('Waiting for permission decision')
  expect(await item(page, 'rail-both').ariaSnapshot()).toContain('Streaming')
  expect(await item(page, 'rail-both').ariaSnapshot()).not.toContain('Waiting for permission decision')
  // Where the actions always show (narrow, with a pointer), no timestamp sits under them.
  for (const sid of ['rail-idle', 'rail-running', 'rail-attention', 'rail-both']) {
    const actions = item(page, sid).locator('.session-actions')
    if (await actions.evaluate((node) => getComputedStyle(node).opacity !== '1' || getComputedStyle(node).display === 'none')) continue
    const time = await item(page, sid).locator('.session-time').boundingBox()
    const box = await actions.boundingBox()
    expect(time && box && time.x + time.width <= box.x, `${sid} timestamp clears the actions`).toBe(true)
  }
  // A running row keeps its ordinary timestamp and stays single-line.
  await expect(item(page, 'rail-running').locator('.session-time')).toBeVisible()
  const [idle, running] = await Promise.all(['rail-idle', 'rail-running'].map(async (sid) => (await item(page, sid).boundingBox())?.height ?? 0))
  expect(Math.abs((idle ?? 0) - (running ?? 0))).toBeLessThan(2)
}

test('the left rail carries run and attention status, apart from selection and the row actions', async ({ page }, testInfo) => {
  await page.route(/\/api\/sessions(\?|$)/, async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...(await response.json()), sessions: ROWS } })
  })
  await page.route('**/api/session?**', (route) => {
    const sid = new URL(route.request().url()).searchParams.get('session_id') ?? ''
    return route.fulfill({ json: { session: { session_id: sid, title: sid, messages: [{ role: 'user', id: 1, content: `${sid} question` }] } } })
  })

  const widths = testInfo.project.name === 'mobile' ? [390] : [1280, 600]
  for (const width of widths) {
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/session/rail-idle')
    await openSidebar(page)
    await expect(item(page, 'rail-idle')).toHaveAttribute('aria-current', 'page')
    await expectStatus(page)

    const running = item(page, 'rail-running')
    const trigger = running.locator('.session-actions-trigger')
    // Touch rows hide the actions column and open the menu by long press instead.
    if (testInfo.project.name !== 'mobile') {
      // Hovering for the actions keeps the rail, and the menu opens by pointer and by keyboard during the run.
      await running.hover()
      expect((await rail(running)).content).toBe('""')
      await trigger.click()
      await expect(page.getByRole('menu')).toBeVisible()
      expect((await rail(running)).content).toBe('""')
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menu')).toBeHidden()
      await trigger.focus()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('menu')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(running.locator('.session-archive-toggle')).toBeEnabled()
    }
    if (process.env.TAL365_SHOTS) await page.screenshot({ path: `${process.env.TAL365_SHOTS}/rail-${testInfo.project.name}-${String(width)}.png` })

    // Selecting the running row keeps its rail and leaves the old selection without one.
    await page.goto('/session/rail-running')
    await openSidebar(page)
    await expect(running).toHaveAttribute('aria-current', 'page')
    expect(await rail(running)).toMatchObject({ content: '""', color: await resolved(page, '--accent') })
    expect((await rail(item(page, 'rail-idle'))).content).toBe('none')
  }
})

test('the running rail pulses only when motion is allowed', async ({ page }) => {
  await page.route(/\/api\/sessions(\?|$)/, async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...(await response.json()), sessions: ROWS } })
  })
  await page.goto('/')
  await openSidebar(page)
  // The project runs with reduced motion: a static rail.
  expect((await rail(item(page, 'rail-running'))).animation).toBe('none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  expect((await rail(item(page, 'rail-running'))).animation).toBe('session-pulse')
})
