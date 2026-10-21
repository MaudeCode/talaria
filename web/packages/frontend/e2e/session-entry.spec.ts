import type { Page, Route } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { expect, test } from './fixtures'

// Per-action DOM traces serialize the full 2,000-row fixture; retain failure screenshots.
test.use({ serviceWorkers: 'block', trace: 'off', screenshot: 'only-on-failure' })

/** A synthetic overflowing transcript; every session numbers its messages from 1, so their first row keys collide. */
const transcript = (sid: string, turns: number, from = 0) => Array.from({ length: turns }, (_, i) => [
  { role: 'user', id: (from + i) * 2 + 1, content: `${sid} question ${from + i + 1}` },
  { role: 'assistant', id: (from + i) * 2 + 2, content: `${sid} answer ${from + i + 1}. `.repeat(8) },
]).flat()

const distance = (page: Page) => page.locator('#messages').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
const withoutContainment = 'html.without-containment .msg-row{content-visibility:visible!important}'

test('off-screen rows stay searchable and reveal their measured content', async ({ page }, testInfo) => {
  const sid = 'contained-search'
  await page.route('**/api/settings', (route) => route.fulfill({ json: { virtualize_transcript: false } }))
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: sid, title: 'Long history', messages: transcript(sid, 300) } } }))
  await page.goto(`/session/${sid}`)
  await shows(page, sid)
  await expect(page.locator('[data-message-key]')).toHaveCount(600)
  await expect.poll(() => distance(page)).toBeLessThan(2)
  await page.addStyleTag({ content: withoutContainment })
  for (const baseline of [true, false]) {
    await page.evaluate((disabled) => document.documentElement.classList.toggle('without-containment', disabled), baseline)
    await expect.poll(() => distance(page)).toBeLessThan(2)
    const path = testInfo.outputPath(`${baseline ? 'before' : 'after'}-${testInfo.project.name}.png`)
    await page.screenshot({ path })
    await testInfo.attach(baseline ? 'Before' : 'After', { path, contentType: 'image/png' })
  }
  const first = page.locator('[data-message-key="1"] .msg-body')
  await expect.poll(() => first.evaluate((el) => el.checkVisibility({ contentVisibilityAuto: true }))).toBe(false)
  // Browser text search still selects skipped content; keyed navigation reveals and measures it.
  expect(await page.evaluate(() => (window as unknown as { find: (text: string) => boolean }).find('contained-search question 1'))).toBe(true)
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('contained-search question 1')
  await page.locator('[data-message-key="1"]').evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await expect(first).toBeInViewport()
  await expect.poll(() => first.evaluate((el) => el.checkVisibility({ contentVisibilityAuto: true }))).toBe(true)
  await expect(page.locator('[data-message-key]')).toHaveCount(600)
})

test('off-screen history halves long tasks during a 200-token stream', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'paired CPU measurements use one fixed viewport')
  test.setTimeout(180_000)
  const sid = 'contained-history', streamId = 'contained-run'
  const messages = transcript(sid, 300).map((message) => message.role === 'assistant' ? {
    ...message,
    content: Array.from({ length: 8 }, (_, paragraph) => `Paragraph ${paragraph + 1}: ${message.content} **Verified** with a [reference](https://example.test/report).`).join('\n\n'),
  } : message)
  let stream: ServerResponse | undefined
  const server = createServer((_request, response) => {
    stream = response
    response.writeHead(200, { 'content-type': 'text/event-stream', 'access-control-allow-origin': process.env.HERMES_E2E_BASE_URL!, 'access-control-allow-credentials': 'true' })
    response.write(`event: server_turn_started\ndata: ${JSON.stringify({ session_id: sid, stream_id: streamId })}\n\n`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  await page.route('**/api/settings', (route) => route.fulfill({ json: { virtualize_transcript: false } }))
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: sid, title: 'Long history', messages, active_stream_id: streamId } } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: streamId, replay_available: true } }))
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${address.port}/stream` }))
  const cpu = await page.context().newCDPSession(page)
  await cpu.send('Performance.enable')
  const readTimings = async () => {
    const result = await cpu.send('Performance.getMetrics')
    return Object.fromEntries((result.metrics as { name: string; value: number }[]).map((metric) => [metric.name, metric.value]))
  }
  try {
    const samples: number[] = []
    const timings: Record<string, number>[] = []
    // Fixed paired repetitions keep one scheduling outlier from deciding a threshold-count benchmark.
    for (let trial = 0; trial < 3; trial++) {
      for (const baseline of [true, false]) {
        stream?.end()
        stream = undefined
        await page.goto(`/session/${sid}`)
        await expect(page.locator('[data-message-key="600"] .msg-body')).toContainText('Paragraph 8:')
        await expect(page.locator('[data-message-key]')).toHaveCount(600)
        await expect.poll(() => !!stream).toBe(true)
        await expect.poll(() => distance(page)).toBeLessThan(2)
        // Only this test can disable containment; no benchmark switch ships in the app.
        await page.addStyleTag({ content: withoutContainment })
        await page.evaluate((disabled) => document.documentElement.classList.toggle('without-containment', disabled), baseline)
        await page.waitForTimeout(500)
        // Changing containment can resize the history; both phases must start in the same follow mode.
        await page.locator('#messages').evaluate((el) => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll', { bubbles: true })) })
        await expect.poll(() => distance(page)).toBeLessThan(2)
        await expect(page.locator('.scroll-to-bottom-btn')).toHaveCount(0)
        await cpu.send('Emulation.setCPUThrottlingRate', { rate: 6 })
        const before = await readTimings()
        await page.evaluate(() => {
          const w = window as unknown as { longTasks: number; observer: PerformanceObserver }
          w.longTasks = 0
          w.observer = new PerformanceObserver((list) => { w.longTasks += list.getEntries().length })
          w.observer.observe({ type: 'longtask' })
        })
        for (let token = 0; token < 200; token++) {
          stream!.write(`event: token\ndata: ${JSON.stringify({ text: 'word ' })}\n\n`)
          await page.waitForTimeout(30)
        }
        await expect(page.locator('.live-turn .msg-body')).toContainText('word '.repeat(200).trim())
        await expect.poll(() => distance(page)).toBeLessThan(2)
        await page.waitForTimeout(100)
        samples.push(await page.evaluate(() => {
          const w = window as unknown as { longTasks: number; observer: PerformanceObserver }
          w.longTasks += w.observer.takeRecords().length
          w.observer.disconnect()
          return w.longTasks
        }))
        const after = await readTimings()
        timings.push(Object.fromEntries(['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'].map((name) => [name, (after[name] ?? 0) - (before[name] ?? 0)])))
        await cpu.send('Emulation.setCPUThrottlingRate', { rate: 1 })
      }
    }
    const median = (offset: number) => samples.filter((_, i) => i % 2 === offset).toSorted((a, b) => a - b)[1]!
    const baseline = median(0), contained = median(1)
    console.info('Long-task samples', { baseline, contained, samples, tokens: 200, timings })
    await testInfo.attach('long-task-counts', { body: JSON.stringify({ baseline, contained, samples, tokens: 200, timings }), contentType: 'application/json' })
    expect(baseline, 'baseline must exercise long tasks').toBeGreaterThan(0)
    expect(contained, 'contained long tasks must be at most half the baseline').toBeLessThanOrEqual(baseline / 2)
  } finally {
    await cpu.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    await cpu.detach()
    await page.goto('about:blank')
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

/** Wait for the selected session and lazy Markdown before measuring scroll geometry. */
async function shows(page: Page, sid: string): Promise<void> {
  await expect(page.locator('#messages').getByText(new RegExp(`^${sid} question`)).first()).toBeAttached()
  // Markdown is lazy: mounted user rows alone do not mean the transcript has finished laying out.
  await expect(page.locator('#messages [data-role="assistant"] .msg-body').last()).not.toBeEmpty()
}

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

/** A first window of the newest `turns` turns over `turns` older ones, as the server pages `msg_before`. */
const paged = (sid: string, turns: number) => (route: Route) => {
  const before = new URL(route.request().url()).searchParams.get('msg_before')
  const messages = before ? transcript(sid, turns) : transcript(sid, turns, turns)
  return route.fulfill({ json: { session: { session_id: sid, title: sid, messages, _messages_truncated: !before, _messages_offset: before ? 0 : turns * 2 } } })
}

test('a message deep link loads older rows until it finds its message', async ({ page }) => {
  await page.route('**/api/session?**', paged('entry-deep', 20))
  await page.goto('/session/entry-deep?msg=5')
  const target = page.locator('[data-message-key="5"]')
  await expect(target).toBeInViewport()
  await page.waitForTimeout(500)
  await expect(target).toBeInViewport()
})

test('a message deep link finds a later message inside a grouped turn', async ({ page }) => {
  // Each turn is a prompt and two assistant rows the server stamped with one turn id; the grouped row is keyed by the first.
  const messages = Array.from({ length: 20 }, (_, i) => [
    { role: 'user', id: i * 3 + 1, content: `entry-turn question ${i + 1}` },
    { role: 'assistant', id: i * 3 + 2, content: `entry-turn first part ${i + 1}. `.repeat(4), _turn_id: `turn-${i}` },
    { role: 'assistant', id: i * 3 + 3, content: `entry-turn second part ${i + 1}. `.repeat(4), _turn_id: `turn-${i}` },
  ]).flat()
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'entry-turn', title: 'Turns', messages } } }))
  await page.goto('/session/entry-turn?msg=6')
  const turn = page.locator('[data-message-key="5"]')
  await expect(turn).toBeInViewport()
  await expect.poll(() => distance(page)).toBeGreaterThan(200)
})

test('a message deep link pages through one turn that spans several windows', async ({ page }) => {
  // One server-stamped turn of 60 assistant rows, then 20 ordinary turns; the server pages 20 messages at a time.
  const messages = [
    { role: 'user', id: 1, content: 'entry-long question' },
    ...Array.from({ length: 60 }, (_, i) => ({ role: 'assistant', id: i + 2, content: `entry-long step ${i + 1}.`, _turn_id: 'long-turn' })),
    ...transcript('entry-long', 20).map((m) => ({ ...m, id: m.id + 61 })),
  ]
  const size = 20
  await page.route('**/api/session?**', (route) => {
    const end = Number(new URL(route.request().url()).searchParams.get('msg_before') ?? messages.length)
    const start = Math.max(0, end - size)
    return route.fulfill({ json: { session: { session_id: 'entry-long', title: 'Long turn', messages: messages.slice(start, end), _messages_truncated: start > 0, _messages_offset: start } } })
  })
  await page.goto('/session/entry-long?msg=3')
  await expect(page.locator('[data-message-key="2"]')).toBeInViewport()
})

test('a message deep link pages past a window with no visible rows', async ({ page }) => {
  // A persisted steer renders inside its turn, so a page holding only steers adds no rows; 20 messages per page.
  const messages = [
    { role: 'user', id: 1, content: 'entry-hidden question' },
    { role: 'assistant', id: 2, content: 'entry-hidden answer.' },
    ...Array.from({ length: 20 }, (_, i) => ({ role: 'user', id: i + 3, content: `steer ${i + 1}`, _steer: true, _display: 'in_scene' })),
    ...transcript('entry-hidden', 20).map((m) => ({ ...m, id: m.id + 22 })),
  ]
  const size = 20
  await page.route('**/api/session?**', (route) => {
    const end = Number(new URL(route.request().url()).searchParams.get('msg_before') ?? messages.length)
    const start = Math.max(0, end - size)
    return route.fulfill({ json: { session: { session_id: 'entry-hidden', title: 'Hidden page', messages: messages.slice(start, end), _messages_truncated: start > 0, _messages_offset: start } } })
  })
  await page.goto('/session/entry-hidden?msg=1')
  await expect(page.locator('[data-message-key="1"]')).toBeInViewport()
})

test('loading older rows keeps the reader where they are', async ({ page }) => {
  const turns = 20
  await page.route('**/api/session?**', paged('entry-older', turns))
  await page.goto('/session/entry-older')
  await expect(page.getByText(`entry-older question ${turns * 2}`, { exact: true })).toBeAttached()
  await expect.poll(() => distance(page)).toBeLessThan(2)
  await page.locator('#messages').evaluate((el) => { el.scrollTop = 0 })
  await expect(page.getByText('entry-older question 1', { exact: true })).toBeAttached()
  await page.waitForTimeout(300)
  expect(await distance(page)).toBeGreaterThan(200)
})

for (const virtualize of [false, true]) {
  test(`history scrolls through 2,000 rows without duplicate pages or moving the reader: virtualize=${virtualize}`, async ({ page }, testInfo) => {
    const messages = transcript('history', 1_000)
    const requests: number[] = []
    let release: (() => void) | undefined
    await page.route('**/api/settings', (route) => route.fulfill({ json: { virtualize_transcript: virtualize } }))
    await page.route('**/api/session?**', async (route) => {
      const params = new URL(route.request().url()).searchParams
      const end = Number(params.get('msg_before') ?? messages.length)
      const start = Math.max(0, end - 120)
      if (params.has('msg_before')) {
        requests.push(end)
        await new Promise<void>((resolve) => { release = resolve })
      }
      await route.fulfill({ json: { session: { session_id: 'history', title: 'History', messages: messages.slice(start, end), _messages_truncated: start > 0, _messages_offset: start } } })
    })
    await page.goto('/session/history')
    await shows(page, 'history')
    await expect.poll(() => distance(page)).toBeLessThan(2)
    for (let end = 1880; end > 0; end -= 120) {
      await page.locator('#messages').evaluate((el) => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true })); el.scrollTop = el.clientHeight / 2 })
      await expect.poll(() => requests.at(-1)).toBe(end)
      if (end === 1880 && !virtualize) {
        await page.screenshot({ path: testInfo.outputPath('history-loading.png') })
        await testInfo.attach('History prefetch', { path: testInfo.outputPath('history-loading.png'), contentType: 'image/png' })
      }
      // Capture the row actually under the reader while the response is held.
      const anchor = await page.locator('#messages').evaluate((pane) => {
        const top = pane.getBoundingClientRect().top
        const row = [...pane.querySelectorAll<HTMLElement>('[data-message-key]')].find((row) => row.getBoundingClientRect().bottom > top)!
        return { key: row.dataset.messageKey!, top: row.getBoundingClientRect().top }
      })
      release!()
      await expect.poll(() => page.locator('[data-history-sentinel]').getByRole('status').count()).toBe(0)
      const row = page.locator(`[data-message-key="${anchor.key}"]`)
      await expect(row).toBeAttached()
      await expect.poll(async () => Math.abs((await row.boundingBox())!.y - anchor.top), { message: `Page ending at ${end}, anchor ${JSON.stringify(anchor)}` }).toBeLessThan(2)
    }
    expect(requests).toEqual(Array.from({ length: 16 }, (_, index) => 1880 - index * 120))
    await expect(page.getByRole('button', { name: 'Load older messages' })).toHaveCount(0)
    await expect(page.locator('[data-history-sentinel]')).toHaveCount(0)
    await page.locator('#messages').evaluate((el) => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true })); el.scrollTop = 0 })
    await expect(page.getByText('history question 1', { exact: true })).toBeInViewport()
    if (!virtualize) {
      const path = testInfo.outputPath(`history-start-${testInfo.project.name}.png`)
      await page.screenshot({ path })
      await testInfo.attach('History start', { path, contentType: 'image/png' })
    }
    expect(await page.locator('[data-message-key]').evaluateAll((rows) => new Set(rows.map((row) => row.getAttribute('data-message-key'))).size === rows.length)).toBe(true)
  })
}

test('history errors wait for retry and resume a paged message deep link', async ({ page, errors }, testInfo) => {
  const messages = transcript('retry-history', 120)
  let requests = 0
  await page.route('**/api/session?**', (route) => {
    const before = new URL(route.request().url()).searchParams.get('msg_before')
    if (before && ++requests === 1) return route.fulfill({ status: 400, json: { error: 'Synthetic history failure' } })
    const end = Number(before ?? messages.length)
    const start = Math.max(0, end - 120)
    return route.fulfill({ json: { session: { session_id: 'retry-history', messages: messages.slice(start, end), _messages_truncated: start > 0, _messages_offset: start } } })
  })
  await page.goto('/session/retry-history?msg=1')
  const retry = page.locator('[data-history-sentinel]').getByRole('button', { name: 'Retry' })
  await expect(retry).toBeVisible()
  expect(errors).toHaveLength(2)
  expect(errors).toEqual(expect.arrayContaining([expect.stringMatching(/^400 GET .*session_id=retry-history/), expect.stringContaining('status of 400')]))
  errors.length = 0
  await page.locator('#messages').evaluate((el) => { el.scrollTop = 500; el.dispatchEvent(new Event('scroll')); el.scrollTop = 0 })
  await page.screenshot({ path: testInfo.outputPath('history-retry.png') })
  expect(requests).toBe(1)
  await retry.click()
  await expect(page.locator('[data-message-key="1"]')).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('history-retry-restored.png') })
  expect(requests).toBe(2)
})

for (const [virtualize, repeats] of [[false, 1], [true, 1], [false, 50], [true, 50]] as const) {
  test(`a boundary-spanning assistant turn keeps its visible text after rekeying: virtualize=${virtualize}, repeats=${repeats}`, async ({ page }) => {
    const messages = transcript('boundary', 300).map((message, index) => index >= 330 && index < 370
      ? { ...message, role: 'assistant', content: `Boundary piece ${index + 1}.`.repeat(repeats), _turn_id: 'boundary-turn' }
      : message)
    const requests: number[] = []
    let release: (() => void) | undefined
    await page.route('**/api/settings', (route) => route.fulfill({ json: { virtualize_transcript: virtualize } }))
    await page.route('**/api/session?**', async (route) => {
      const params = new URL(route.request().url()).searchParams
      expect(params.get('msg_limit')).toBe('120')
      const end = Number(params.get('msg_before') ?? messages.length)
      const start = Math.max(0, end - 120)
      if (params.has('msg_before')) {
        requests.push(end)
        await new Promise<void>((resolve) => { release = resolve })
      }
      await route.fulfill({ json: { session: { session_id: 'boundary', messages: messages.slice(start, end), _messages_offset: start, _messages_truncated: start > 0 } } })
    })
    await page.goto('/session/boundary')
    await shows(page, 'boundary')
    await expect.poll(() => distance(page)).toBeLessThan(2)
    const readTop = () => page.locator('#messages').evaluate((pane) => {
      pane.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }))
      pane.scrollTop = 180
    })
    try {
      await expect.poll(async () => { await readTop(); return requests.at(-1) }).toBe(480)
      await expect(page.locator('[data-history-sentinel]').getByRole('status')).toHaveCount(1)
      release!()
      // Loading may not have painted when the route first arrives. Wait for the first
      // prepend to commit before scrolling into the next page's prefetch region.
      await expect(page.locator(virtualize ? '[data-virtual-history]' : '[data-message-key="361"]')).toBeAttached()
      await expect(page.locator('[data-history-sentinel]').getByRole('status')).toHaveCount(0)
      await expect.poll(async () => { await readTop(); return requests.at(-1) }).toBe(360)
      const group = page.locator('[data-message-key="361"]')
      await expect(group).toBeInViewport()
      const anchor = await group.evaluate((row) => {
        const top = document.getElementById('messages')!.getBoundingClientRect().top
        const paragraph = [...row.querySelectorAll('p')].find((part) => part.getBoundingClientRect().bottom > top)!
        return { text: paragraph.textContent, top: paragraph.getBoundingClientRect().top }
      })
      release!()
      await expect(group).toHaveCount(0)
      const preserved = page.getByText(anchor.text, { exact: true })
      if (!virtualize) await expect(page.locator('[data-message-key="331"]')).toHaveCSS('content-visibility', 'auto')
      await expect(preserved).toBeInViewport()
      await expect.poll(async () => Math.abs((await preserved.boundingBox())!.y - anchor.top)).toBeLessThan(2)
      await expect(page.locator('[data-history-sentinel]').getByRole('status')).toHaveCount(0)
      expect(requests).toEqual([480, 360])
    } finally {
      release?.()
    }
  })
}
