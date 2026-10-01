import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** T3 Code-style composer placement and send motion (TAL-429), against synthetic sessions. */

const transcript = (sid: string, turns: number) => Array.from({ length: turns }, (_, i) => [
  { role: 'user', id: i * 2 + 1, content: `${sid} question ${i + 1}` },
  { role: 'assistant', id: i * 2 + 2, content: `${sid} answer ${i + 1}. `.repeat(12) },
]).flat()

const box = async (page: Page, selector: string) => (await page.locator(selector).boundingBox())!
const distance = (page: Page) => page.locator('#messages').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)

/** A request held until the test releases it, so the page can be inspected while it is in flight. */
function hold() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  return { gate, release }
}

test('a new chat centres the composer card with the headline above it', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.composer-dock--hero')).toBeVisible()
  const stage = await box(page, '.chat-stage')
  const card = await box(page, '#composerBox')
  expect(Math.abs(card.y + card.height / 2 - (stage.y + stage.height / 2))).toBeLessThan(24)
  const title = await box(page, '#emptyHeroTitle')
  expect(title.y + title.height).toBeLessThanOrEqual(card.y)
})

test('the first send leaves the hero and shows the message before the session or turn exist', async ({ page }) => {
  const created = hold()
  const started = hold()
  let persisted = false
  await page.route('**/api/session/new', async (route: Route) => {
    await created.gate
    await route.fulfill({ json: { session: { session_id: 'first-send', title: '', messages: [] } } })
  })
  await page.route('**/api/chat/start', async (route: Route) => {
    await started.gate
    persisted = true
    // A turn admitted without a stream settles at once; the session payload then carries the message.
    await route.fulfill({ json: { status: 'suppressed' } })
  })
  await page.route('**/api/session/draft', (route) => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'first-send', title: 'First', messages: persisted ? [{ role: 'user', id: 1, content: 'Plan the release' }] : [] } } }))
  await page.goto('/')
  await page.locator('#msg').fill('Plan the release')
  await page.locator('#btnSend').click()

  // Neither request has answered: the message already shows once and the composer is docked and empty.
  const messages = page.locator('#messages')
  await expect(messages.getByText('Plan the release', { exact: true })).toHaveCount(1)
  await expect(page.locator('.composer-dock--hero')).toHaveCount(0)
  await expect(page.locator('#msg')).toHaveValue('')
  const stage = await box(page, '.chat-stage')
  await expect.poll(async () => { const dock = await box(page, '.composer-dock'); return Math.abs(stage.y + stage.height - (dock.y + dock.height)) }).toBeLessThan(2)

  created.release()
  await expect(page).toHaveURL(/\/session\/first-send$/)
  await expect(messages.getByText('Plan the release', { exact: true })).toHaveCount(1)
  started.release()
  await expect.poll(() => persisted).toBe(true)
  await expect(messages.getByText('Plan the release', { exact: true })).toHaveCount(1)
  await expect(page.locator('.composer-dock--hero')).toHaveCount(0)
})

test('a failed first send returns the text to the composer', async ({ page, errors }) => {
  await page.route('**/api/session/new', (route) => route.fulfill({ status: 500, json: { error: 'synthetic failure' } }))
  await page.goto('/')
  await page.locator('#msg').fill('Keep this draft')
  await page.locator('#btnSend').click()
  await expect(page.locator('#msg')).toHaveValue('Keep this draft')
  await expect(page.locator('.composer-dock--hero')).toBeVisible()
  await expect(page.locator('#messages').getByText('Keep this draft')).toHaveCount(0)
  // The synthetic 500 is the point of this test.
  errors.splice(0, errors.length, ...errors.filter((e) => !/api\/session\/new|status of 500/.test(e)))
})

test('sending from a session scrolled up returns the transcript to its end', async ({ page }) => {
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'scrolled', title: 'Scrolled', messages: transcript('scrolled', 20) } } }))
  await page.route('**/api/chat/start', (route) => route.fulfill({ json: { status: 'suppressed' } }))
  await page.goto('/session/scrolled')
  await expect.poll(() => distance(page)).toBeLessThan(2)
  await page.locator('#messages').evaluate((el) => { el.scrollTop = el.scrollHeight / 3 })
  await expect.poll(() => distance(page)).toBeGreaterThan(200)
  await page.locator('#msg').fill('One more thing')
  await page.locator('#btnSend').click()
  await expect.poll(() => distance(page)).toBeLessThan(2)
})

test('opening a session paints every frame at its end', async ({ page }) => {
  await page.route('**/api/session?**', async (route) => {
    await new Promise((r) => setTimeout(r, 200))
    await route.fulfill({ json: { session: { session_id: 'entry', title: 'Entry', messages: transcript('entry', 25) } } })
  })
  await page.goto('/')
  await expect(page.locator('#msg')).toBeVisible()
  const frames = await page.evaluate(async () => {
    const seen: number[] = []
    history.pushState({}, '', '/session/entry')
    dispatchEvent(new PopStateEvent('popstate'))
    const t0 = performance.now()
    await new Promise<void>((done) => {
      const tick = () => {
        const el = document.getElementById('messages')
        if (el && document.querySelector('[data-message-key]')) seen.push(el.scrollHeight - el.scrollTop - el.clientHeight)
        if (performance.now() - t0 < 1500) requestAnimationFrame(tick)
        else done()
      }
      requestAnimationFrame(tick)
    })
    return seen
  })
  expect(frames.length).toBeGreaterThan(10)
  expect(Math.max(...frames)).toBeLessThan(2)
})

test('the top tab reports a Talaria server it cannot reach and clears when it answers again', async ({ page, errors }) => {
  let down = false
  await page.route('**/api/health/agent', (route) => (down ? route.abort('connectionrefused') : route.fulfill({ json: { alive: true } })))
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'reach', title: 'Reach', messages: transcript('reach', 2) } } }))
  await page.goto('/session/reach')
  await expect(page.locator('#msg')).toBeVisible()
  down = true
  const row = page.locator('.composer-tab [data-notice="runtime:server_unreachable"]')
  await expect(row).toContainText("Can't reach the Talaria server", { timeout: 15_000 })
  // Probes back off exponentially (1 s, 2 s, 4 s, …) and the row counts down to the next one.
  await expect(row).toContainText('Retrying in 4s', { timeout: 10_000 })
  // Retry probes now: with the server back, the row clears well before the scheduled probe would run.
  down = false
  await row.getByRole('button', { name: 'Retry' }).click()
  await expect(row).toHaveCount(0, { timeout: 1_500 })
  // The refused requests are the point of this test.
  errors.splice(0, errors.length, ...errors.filter((e) => !/health\/agent|ERR_CONNECTION_REFUSED|Failed to load resource/.test(e)))
})

test('a manual compression shows in the top tab while it runs', async ({ page }) => {
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'squeeze', title: 'Squeeze', messages: transcript('squeeze', 2) } } }))
  await page.route('**/api/session/compress/start', (route) => route.fulfill({ json: { status: 'running' } }))
  await page.route('**/api/session/compress/status?**', (route) => route.fulfill({ json: { status: 'running' } }))
  await page.route('**/api/session/draft', (route) => route.fulfill({ json: { ok: true } }))
  await page.goto('/session/squeeze')
  await page.locator('#msg').fill('/compress')
  await page.locator('#btnSend').click()
  await expect(page.locator('.composer-tab [data-notice="runtime:compressing"]')).toContainText('Compressing context…')
})
