import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** A synthetic overflowing transcript; every session numbers its messages from 1, so their first row keys collide. */
const transcript = (sid: string, turns: number, from = 0) => Array.from({ length: turns }, (_, i) => [
  { role: 'user', id: (from + i) * 2 + 1, content: `${sid} question ${from + i + 1}` },
  { role: 'assistant', id: (from + i) * 2 + 2, content: `${sid} answer ${from + i + 1}. `.repeat(8) },
]).flat()

const distance = (page: Page) => page.locator('#messages').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)

/** A virtualized transcript renders only the rows near the viewport, so any row of the session proves it rendered. */
const shows = (page: Page, sid: string) => expect(page.locator('#messages').getByText(new RegExp(`^${sid} question`)).first()).toBeAttached()

/** Sidebar-style entry: the router changes the session without reloading the page, so the cached transcript shows at once. */
async function enter(page: Page, sid: string): Promise<void> {
  await page.evaluate((path) => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')) }, `/session/${sid}`)
  await shows(page, sid)
}

async function readUpward(page: Page): Promise<void> {
  await page.locator('#messages').evaluate((el) => { el.scrollTop = el.scrollHeight / 3 })
  await expect.poll(() => distance(page)).toBeGreaterThan(200)
}

const cases = [
  { name: 'auto-follow on', settings: {}, turns: 20 },
  { name: 'auto-follow off', settings: { auto_scroll_follow: false }, turns: 20 },
  { name: 'virtualized', settings: { virtualize_transcript: true }, turns: 130 },
]

for (const { name, settings, turns } of cases) {
  test(`returning to a session opens at its latest message: ${name}`, async ({ page }) => {
    await page.route('**/api/settings', (route) => route.fulfill({ json: settings }))
    await page.route('**/api/session?**', (route) => {
      const sid = new URL(route.request().url()).searchParams.get('session_id') ?? ''
      return route.fulfill({ json: { session: { session_id: sid, title: sid, messages: transcript(sid, turns) } } })
    })
    await page.goto('/session/entry-a')
    await shows(page, 'entry-a')
    await expect.poll(() => distance(page)).toBeLessThan(2)
    await readUpward(page)
    await enter(page, 'entry-b')
    await expect.poll(() => distance(page)).toBeLessThan(2)
    await readUpward(page)
    await enter(page, 'entry-a')
    await expect.poll(() => distance(page)).toBeLessThan(2)
    // A layout change after entry (here, a narrower window rewrapping every row) settles at the bottom too.
    const viewport = page.viewportSize()!
    await page.setViewportSize({ width: Math.round(viewport.width * 0.8), height: viewport.height })
    await expect.poll(() => distance(page)).toBeLessThan(2)
  })
}

test('a message deep link wins over the entry jump to the bottom', async ({ page }) => {
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'entry-link', title: 'Link', messages: transcript('entry-link', 20) } } }))
  await page.goto('/session/entry-link?msg=5')
  const target = page.locator('[data-message-key="5"]')
  await expect(target).toBeInViewport()
  await expect.poll(() => distance(page)).toBeGreaterThan(200)
  await page.waitForTimeout(500)
  await expect(target).toBeInViewport()
})

test('loading older rows keeps the reader where they are', async ({ page }) => {
  const turns = 20
  await page.route('**/api/session?**', (route) => {
    const before = new URL(route.request().url()).searchParams.get('msg_before')
    const messages = before ? transcript('entry-older', turns) : transcript('entry-older', turns, turns)
    return route.fulfill({ json: { session: { session_id: 'entry-older', title: 'Older', messages, _messages_truncated: !before, _messages_offset: before ? 0 : turns * 2 } } })
  })
  await page.goto('/session/entry-older')
  await expect(page.getByText(`entry-older question ${turns * 2}`, { exact: true })).toBeAttached()
  await expect.poll(() => distance(page)).toBeLessThan(2)
  await page.locator('#messages').evaluate((el) => { el.scrollTop = 0 })
  await expect(page.getByText('entry-older question 1', { exact: true })).toBeAttached()
  await page.waitForTimeout(300)
  expect(await distance(page)).toBeGreaterThan(200)
})
