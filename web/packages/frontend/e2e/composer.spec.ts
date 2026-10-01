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
  expect(Math.abs(card.y + card.height / 2 - (stage.y + stage.height / 2))).toBeLessThan(4)
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
  // Every frame from the click on: how many rows show the text, and whether the hero is back.
  await page.evaluate(() => {
    const w = window as unknown as { frames_: { rows: number; hero: boolean }[] }
    w.frames_ = []
    const tick = () => {
      const rows = [...document.querySelectorAll('#messages .msg-row[data-role="user"]')].filter((r) => r.textContent?.includes('Plan the release')).length
      w.frames_.push({ rows, hero: !!document.querySelector('.composer-dock--hero') })
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
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
  // Through session creation, the route change, and reconciliation: never two rows, and once shown never gone or back in the hero.
  const frames = await page.evaluate(() => (window as unknown as { frames_: { rows: number; hero: boolean }[] }).frames_)
  const shown = frames.findIndex((f) => f.rows > 0)
  expect(shown).toBeGreaterThanOrEqual(0)
  expect(Math.max(...frames.map((f) => f.rows))).toBe(1)
  expect(frames.slice(shown).every((f) => f.rows === 1 && !f.hero)).toBe(true)
})

test('a chat start that fails after the session exists returns the text to its composer', async ({ page, errors }) => {
  await page.route('**/api/session/new', (route) => route.fulfill({ json: { session: { session_id: 'start-fails', title: '', messages: [] } } }))
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'start-fails', title: '', messages: [] } } }))
  await page.route('**/api/session/draft', (route) => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/chat/start', (route) => route.fulfill({ status: 500, json: { error: 'synthetic start failure' } }))
  await page.goto('/')
  await page.locator('#msg').fill('Keep this draft')
  await page.locator('#btnSend').click()
  // The index view unmounted with the navigation; the session view's composer takes the text back.
  await expect(page).toHaveURL(/\/session\/start-fails$/)
  await expect(page.locator('#msg')).toHaveValue('Keep this draft')
  await expect(page.locator('#messages').getByText('Keep this draft')).toHaveCount(0)
  // The synthetic 500 is the point of this test.
  errors.splice(0, errors.length, ...errors.filter((e) => !/api\/chat\/start|status of 500/.test(e)))
})

test('a failed session create returns the text to the composer', async ({ page, errors }) => {
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
  // The draft autosave fires 1.2 s after typing; on a slow runner it lands before the test ends.
  await page.route('**/api/session/draft', (route) => route.fulfill({ json: { ok: true } }))
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

for (const { name, settings } of [{ name: 'auto-follow on', settings: {} }, { name: 'auto-follow off', settings: { auto_scroll_follow: false } }]) {
  test(`a hand scroll flattens the composer until it is used again, without covering the end: ${name}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'phones keep their own collapsed row')
    await page.route('**/api/settings', (route) => route.fulfill({ json: settings }))
    await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'rest', title: 'Rest', messages: transcript('rest', 20) } } }))
    await page.route('**/api/session/draft', (route) => route.fulfill({ json: { ok: true } }))
    await page.goto('/session/rest')
    await expect.poll(() => distance(page)).toBeLessThan(2)
    const card = page.locator('#composerBox')
    const expanded = (await box(page, '#composerBox')).height
    await page.locator('#messages').hover()
    await page.mouse.wheel(0, -400)
    await expect(card).toHaveClass(/is-resting/)
    await expect.poll(async () => (await box(page, '#composerBox')).height).toBeLessThan(expanded - 30)
    // Back at the end while resting. Focus alone (no pointer) lifts it, and every frame of the 200 ms expansion keeps
    // the newest message in view.
    await page.mouse.wheel(0, 8000)
    await expect.poll(() => distance(page)).toBeLessThan(2)
    await page.evaluate(() => {
      const w = window as unknown as { gaps: number[] }
      w.gaps = []
      const el = document.getElementById('messages')!
      const t0 = performance.now()
      const tick = () => { w.gaps.push(el.scrollHeight - el.scrollTop - el.clientHeight); if (performance.now() - t0 < 500) requestAnimationFrame(tick) }
      requestAnimationFrame(tick)
    })
    await page.locator('#msg').focus()
    await expect(card).not.toHaveClass(/is-resting/)
    await expect.poll(async () => (await box(page, '#composerBox')).height).toBeGreaterThan(expanded - 2)
    await page.waitForTimeout(600)
    const gaps = await page.evaluate(() => (window as unknown as { gaps: number[] }).gaps)
    expect(gaps.length).toBeGreaterThan(10)
    expect(Math.max(...gaps)).toBeLessThan(2)
    // A multi-line draft stays readable: an explicit line break or a soft wrap never flattens it.
    for (const draft of ['line one\nline two', 'a long single line that wraps. '.repeat(12)]) {
      await page.locator('#msg').fill(draft)
      await page.locator('#messages').hover()
      await page.mouse.wheel(0, -400)
      await page.waitForTimeout(300)
      await expect(card).not.toHaveClass(/is-resting/)
    }
  })
}

test('the wash under the composer has no edge where the dock begins', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'one geometry is enough: the wash is the same at every width')
  const long = 'A background subagent you dispatched earlier has finished; the full task source is below. '.repeat(12)
  const messages = Array.from({ length: 6 }, (_, i) => [{ role: 'user', id: i * 2 + 1, content: long }, { role: 'assistant', id: i * 2 + 2, content: `Answer ${i + 1}. `.repeat(40) }]).flat()
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'wash', title: 'Wash', messages } } }))
  await page.goto('/session/wash')
  await expect.poll(() => distance(page)).toBeLessThan(2)
  // A user bubble (a light surface) across the dock's top edge, sampled in its right padding where no text runs.
  const { x, y } = await page.evaluate(() => {
    const pane = document.getElementById('messages')!
    const dock = document.querySelector('.composer-dock')!.getBoundingClientRect()
    const bubbles = [...document.querySelectorAll('.msg-row[data-role="user"] .msg-body')]
    const bubble = bubbles[bubbles.length - 2]!.getBoundingClientRect()
    pane.scrollTop += bubble.bottom - (dock.top + 40)
    const moved = bubbles[bubbles.length - 2]!.getBoundingClientRect()
    return { x: Math.round(moved.right - 8), y: Math.round(document.querySelector('.composer-dock')!.getBoundingClientRect().top) }
  })
  await expect.poll(async () => (await box(page, '.composer-dock')).y).toBe(y)
  const shot = await page.screenshot({ clip: { x, y: y - 8, width: 4, height: 16 } })
  const rows = await page.evaluate(async (png) => {
    const img = new Image()
    img.src = `data:image/png;base64,${png}`
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    return Array.from({ length: img.height }, (_, row) => {
      const d = ctx.getImageData(0, row, img.width, 1).data
      let sum = 0
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!
      return sum / (d.length / 4)
    })
  }, shot.toString('base64'))
  // A continuous wash changes by a fraction of a level per pixel; the old fade stopped at the dock's edge and jumped.
  const jumps = rows.slice(1).map((v, i) => Math.abs(v - rows[i]!))
  expect(Math.max(...jumps)).toBeLessThan(4)
})
