import { createServer, type ServerResponse } from 'node:http'
import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** T3 Code-style composer placement and send motion (TAL-429), against synthetic sessions. */

const transcript = (sid: string, turns: number, question = (i: number) => `${sid} question ${i + 1}`) => Array.from({ length: turns }, (_, i) => [
  { role: 'user', id: i * 2 + 1, content: question(i) },
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

test('the context ring opens the usage figures and Compress now starts compression (TAL-614)', async ({ page }, testInfo) => {
  const usage = { context_used_tokens: 96_000, context_window_tokens: 128_000, context_usage_percent: 75, context_threshold_percent: 50, input_tokens: 412_000, output_tokens: 18_500, cache_read_tokens: 300_000, cache_write_tokens: 12_000, cache_hit_percent: 72, estimated_cost: 1.2345, can_compress: true }
  let started = 0
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'ring', title: 'Ring', messages: transcript('ring', 2), ...usage } } }))
  await page.route('**/api/session/compress/start', (route) => { started += 1; return route.fulfill({ json: { status: 'running' } }) })
  await page.route('**/api/session/compress/status?**', (route) => route.fulfill({ json: { status: 'running' } }))
  await page.route('**/api/session/draft', (route) => route.fulfill({ json: { ok: true } }))
  await page.goto('/session/ring')
  // Phones hide the ring; the same figures and action sit in the composer's overflow panel, shown once the idle row expands.
  const phone = testInfo.project.name === 'mobile'
  if (phone) { await page.locator('#msg').focus(); await page.locator('#composerMobileConfigBtn').click() }
  else await page.locator('#ctxIndicator').click()
  const details = page.locator(phone ? '#composerMobileContextAction' : '#ctxPopup')
  await expect(details).toContainText('Context window usage: 75%')
  await expect(details).toContainText('96,000 / 128,000')
  await expect(details).toContainText('Automatic compression: 50%')
  await expect(details).toContainText('Input tokens: 412,000')
  await expect(details).toContainText('Output tokens: 18,500')
  await expect(details).toContainText('Estimated cost: $1.2345')
  await expect(details).toContainText('Cache: 72% hit (300,000 read / 12,000 write)')
  await page.screenshot({ path: testInfo.outputPath('context-details.png') })
  await details.getByRole('button', { name: 'Compress now' }).click()
  await expect(page.locator('.composer-tab [data-notice="runtime:compressing"]')).toContainText('Compressing context…')
  await expect.poll(() => started).toBe(1)
  if (!phone) await expect(page.locator('#ctxPopup')).toHaveCount(0)
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

test('the wash under the composer has no edge around the card', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'one geometry is enough: the wash is the same at every width')
  const long = 'A background subagent you dispatched earlier has finished; the full task source is below. '.repeat(14)
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'wash', title: 'Wash', messages: transcript('wash', 6, () => long) } } }))
  await page.goto('/session/wash')
  await expect.poll(() => distance(page)).toBeLessThan(2)
  // A user bubble (a light surface) runs behind the whole dock, from above its top edge to below the card.
  const place = () => page.evaluate(() => {
    const dock = document.querySelector('.composer-dock')!.getBoundingClientRect()
    const bubbles = [...document.querySelectorAll('.msg-row[data-role="user"] .msg-body')]
    const bubble = bubbles[bubbles.length - 2]!
    document.getElementById('messages')!.scrollTop += bubble.getBoundingClientRect().bottom - (dock.bottom + 24)
    const b = bubble.getBoundingClientRect()
    return { top: Math.round(b.top), bottom: Math.round(b.bottom), right: Math.round(b.right) }
  })
  const placed = await place()
  // Layout settles (lazy markdown, the virtualizer): the bubble must still span the dock before sampling.
  await expect.poll(async () => JSON.stringify(await place())).toBe(JSON.stringify(placed))
  const dock = await box(page, '.composer-dock')
  const card = await box(page, '#composerBox')
  expect(placed.top).toBeLessThan(dock.y - 16)
  expect(placed.bottom).toBeGreaterThan(card.y + card.height + 8)
  const brightness = async (clip: { x: number; y: number; width: number; height: number }) => {
    const shot = await page.screenshot({ clip })
    return page.evaluate(async (png) => {
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
  }
  const biggestJump = (rows: number[]) => Math.max(...rows.slice(1).map((v, i) => Math.abs(v - rows[i]!)))
  // Across the dock's top edge, in the bubble's right padding where no text runs.
  const top = await brightness({ x: placed.right - 8, y: Math.round(dock.y) - 8, width: 4, height: 16 })
  // Across the card's bottom edge, in the rounded corner where the card itself does not paint.
  const bottom = await brightness({ x: Math.round(card.x + card.width) - 3, y: Math.round(card.y + card.height) - 6, width: 2, height: 12 })
  // A continuous wash changes by a fraction of a level per pixel; two layers that do not meet leave a jump.
  expect(biggestJump(top)).toBeLessThan(4)
  expect(biggestJump(bottom)).toBeLessThan(4)
})

test('typing never refits the composer footer; a viewport or chip change does (TAL-278)', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'the test sets its own viewport widths')
  let model = 'synthetic-model'
  await page.route('**/api/session/draft', (route) => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'fit', title: 'Fit', model, messages: [] } } }))
  await page.route('**/api/session/update', (route) => { model = (route.request().postDataJSON() as { model: string }).model; return route.fulfill({ json: { session: { session_id: 'fit', title: 'Fit', model, messages: [] } } }) })
  await page.goto('/session/fit')
  const footer = page.locator('.composer-footer')
  const msg = page.locator('#msg')
  await expect(msg).toBeVisible()
  await expect(footer).not.toHaveClass(/cf-icons|cf-burger/)
  // The fit pass is the only code that measures the chips in the footer's left group.
  await page.evaluate(() => {
    const w = window as unknown as { fits: number }
    w.fits = 0
    const rect = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect')!.value as (this: Element) => DOMRect
    Element.prototype.getBoundingClientRect = function (this: Element) { if (this.parentElement?.classList.contains('composer-left')) w.fits++; return rect.call(this) }
  })
  const fits = () => page.evaluate(() => (window as unknown as { fits: number }).fits)
  const typed = 'Every character lands in order, at once. '.repeat(2)
  await msg.pressSequentially(typed)
  await expect(msg).toHaveValue(typed)
  expect(await fits()).toBe(0)
  await expect(footer).not.toHaveClass(/cf-icons|cf-burger/)

  // Narrower than the full labels: icon-only chips; wide again: full labels; phone width: the burger.
  await page.setViewportSize({ width: 800, height: 800 })
  await expect(footer).toHaveClass(/cf-icons/)
  await expect(footer).not.toHaveClass(/cf-burger/)
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(footer).not.toHaveClass(/cf-icons|cf-burger/)
  await page.setViewportSize({ width: 600, height: 800 })
  await expect(footer).toHaveClass(/cf-burger/)
  await page.setViewportSize({ width: 860, height: 800 })
  await expect(footer).not.toHaveClass(/cf-icons|cf-burger/)

  // A longer model label (the chip's full 240 px) at the same width no longer fits: the chips change, the footer's size does not.
  await msg.fill(`/model ${'synthetic-provider/an-extremely-long-model-name'.repeat(3)}`)
  await msg.press('Enter')
  await expect(page.locator('#composerModelChip')).toContainText('an-extremely-long-model-name')
  await expect(footer).toHaveClass(/cf-icons/)
})

test('a draft typed with an IME just before a reload comes back (TAL-278)', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'one width is enough: the draft path is the same')
  await page.route('**/api/session/draft', (route) => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'reload', title: 'Reload', messages: [] } } }))
  await page.goto('/session/reload')
  const msg = page.locator('#msg')
  await msg.pressSequentially('Draft ')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 })
  await cdp.send('Input.insertText', { text: '日本' })
  await expect(msg).toHaveValue('Draft 日本')
  await page.reload()
  await expect(msg).toHaveValue('Draft 日本')
})

test('editing a message puts its text in the composer and Send resubmits it (TAL-516)', async ({ page }) => {
  let truncated = false
  let body: Record<string, unknown> | null = null
  const messages = [{ role: 'user', id: 1, content: 'Plan the release' }, { role: 'assistant', id: 2, content: 'Here is the plan.' }]
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'edit', title: 'Edit', messages: truncated ? [] : messages } } }))
  await page.route('**/api/session/truncate', (route) => { truncated = true; return route.fulfill({ json: { ok: true, session: { session_id: 'edit', title: 'Edit' } } }) })
  await page.route('**/api/session/draft', (route) => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/chat/start', async (route) => { body = route.request().postDataJSON() as Record<string, unknown>; await route.fulfill({ json: { status: 'suppressed' } }) })
  await page.goto('/session/edit')
  const row = page.locator('#messages .msg-row[data-role="user"]')
  await row.hover()
  await row.getByRole('button', { name: 'Edit message' }).click()
  await expect.poll(() => truncated).toBe(true)
  await expect(page.locator('#msg')).toHaveValue('Plan the release')
  await expect(page.locator('#msg')).toBeFocused()
  await page.locator('#btnSend').click()
  await expect.poll(() => body?.message).toBe('Plan the release')
})

test('a second Edit click while the first is pending returns the text once (TAL-516)', async ({ page }) => {
  const truncate = hold()
  let truncates = 0
  let truncated = false
  const messages = [{ role: 'user', id: 1, content: 'Plan the release' }, { role: 'assistant', id: 2, content: 'Here is the plan.' }]
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'edit-twice', title: 'Edit', messages: truncated ? [] : messages } } }))
  await page.route('**/api/session/truncate', async (route) => { truncates++; await truncate.gate; truncated = true; await route.fulfill({ json: { ok: true, session: { session_id: 'edit-twice', title: 'Edit' } } }) })
  await page.route('**/api/session/draft', (route) => route.fulfill({ json: { ok: true } }))
  await page.goto('/session/edit-twice')
  const edit = page.locator('#messages .msg-row[data-role="user"]').getByRole('button', { name: 'Edit message' })
  await edit.click({ force: true })
  await edit.click({ force: true })
  truncate.release()
  await expect(page.locator('#msg')).toHaveValue('Plan the release')
  expect(truncates).toBe(1)
})

for (const size of ['default', 'xlarge'] as const) {
  test(`hover and focus never change the composer's text size or layout: ${size} (TAL-249)`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'hover needs a fine pointer')
    if (size !== 'default') await page.addInitScript((s) => { localStorage.setItem('hermes-font-size', s) }, size)
    const streams: ServerResponse[] = []
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
      response.write(`id: type-run:1\nevent: token\ndata: ${JSON.stringify({ text: 'Working.' })}\n\n`)
      streams.push(response)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'type', title: 'Type', messages: transcript('type', 1), active_stream_id: 'type-run', is_streaming: true } } }))
    await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: 'type-run', replay_available: false } }))
    await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${String(address.port)}${new URL(route.request().url()).search}` }))
    await page.route('**/api/session/draft', (route) => route.fulfill({ json: { ok: true } }))
    try {
      await page.goto('/session/type')
      const msg = page.locator('#msg')
      await expect(msg).toHaveAttribute('placeholder', 'Enter = steer | /queue | /background | /interrupt')
      const measure = () => msg.evaluate((el) => {
        const style = getComputedStyle(el)
        const placeholder = getComputedStyle(el, '::placeholder')
        return {
          fontSize: style.fontSize, lineHeight: style.lineHeight, padding: style.padding,
          placeholderFontSize: placeholder.fontSize, placeholderLineHeight: placeholder.lineHeight,
          height: el.getBoundingClientRect().height,
          footerTop: document.querySelector('.composer-footer')!.getBoundingClientRect().top,
          cardHeight: document.getElementById('composerBox')!.getBoundingClientRect().height,
        }
      })
      // The text-size setting owns the size; default follows the skin's composer token.
      const intended = size === 'xlarge' ? '20px' : await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--composer-font-size').trim())
      for (const draft of ['', 'Check the backup logs too']) {
        await msg.fill(draft)
        await msg.blur()
        await page.mouse.move(0, 0)
        const rest = await measure()
        expect(rest.fontSize).toBe(intended)
        await msg.hover()
        expect(await measure(), `hover, draft ${JSON.stringify(draft)}`).toEqual(rest)
        await msg.focus()
        expect(await measure(), `hover and focus, draft ${JSON.stringify(draft)}`).toEqual(rest)
        await page.mouse.move(0, 0)
        expect(await measure(), `focus, draft ${JSON.stringify(draft)}`).toEqual(rest)
      }
    } finally {
      for (const response of streams) response.end()
      await new Promise<void>((resolve) => server.close(() => { resolve() }))
    }
  })
}

test('slash suggestions show the server catalog above the composer, aliases included (TAL-314)', async ({ page }) => {
  await page.goto('/')
  await page.locator('#msg').pressSequentially('/fo')
  const palette = page.getByRole('listbox', { name: 'Commands' })
  await expect(palette).toBeVisible()
  await expect(palette.getByRole('option').first()).toHaveText(/^\/branch/)
  await page.locator('#msg').fill('/term')
  await page.locator('#msg').pressSequentially('i')
  await expect(palette.getByRole('option', { name: /\/terminal/ })).toBeVisible()
})
