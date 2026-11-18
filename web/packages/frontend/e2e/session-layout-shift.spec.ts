import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block', trace: 'off', screenshot: 'only-on-failure' })

/** TAL-1693: 300 turns whose answers carry the Markdown that changes a row's height once rendered. TAL-2410: a 24-line
 *  fence, so a desktop row's placeholder misses by more than the limit too. */
const transcript = (sid: string) => Array.from({ length: 300 }, (_, i) => [
  { role: 'user', id: i * 2 + 1, content: `${sid} question ${i + 1}` },
  { role: 'assistant', id: i * 2 + 2, content: [
    `Answer ${i + 1} with a [reference](https://example.test/${i}) and **emphasis**.`,
    '- first point\n- second point\n  - nested point\n- third point',
    '```ts\n' + Array.from({ length: 24 }, (_, line) => `const value${line} = ${line} * ${i}`).join('\n') + '\n```',
    '1. step one\n2. step two',
  ].join('\n\n') },
]).flat()

test('opening a long session does not shift the transcript while the renderer loads', async ({ page }) => {
  const sid = 'layout-shift'
  // TAL-2410: every shift counts. The test sends no input, but Chromium's mobile emulation reports one as the page
  // starts and marks the next half second of shifts `hadRecentInput`, which hid them unless a slow runner pushed them later.
  await page.addInitScript(() => {
    const shifts: number[] = []
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & { value: number })[]) shifts.push(entry.value)
    })
    Object.assign(window, { __shifts: shifts, __shiftObserver: observer })
    observer.observe({ type: 'layout-shift', buffered: true })
  })
  // TAL-2410: hold the renderer chunk until the session has arrived, as a slow connection does. The client preloads it
  // (TAL-1693), so on a fast runner it lands first and the late path only ran when a runner happened to be slow.
  const chunk = Promise.withResolvers<undefined>()
  await page.route(/\/MarkdownRenderer-[^/]*\.js$/, async (route) => { await chunk.promise; await route.continue() })
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: sid, title: 'Long history', messages: transcript(sid) } } }))
  await page.goto(`/session/${sid}`)
  // The title comes from the same session response as the history; the release waits until that response is on screen.
  await expect(page.getByText('Long history', { exact: true }).filter({ visible: true }).first()).toBeVisible()
  await expect(page.locator('#messages [data-message-key]').last().or(page.getByTestId('transcript-skeleton'))).toBeInViewport()
  chunk.resolve(undefined)
  // The oldest answer renders last.
  await expect(page.locator('#messages [data-role="assistant"]').first().locator('pre')).toBeAttached()

  // Two frames after the last render, every shift is recorded; take the ones not yet delivered.
  const shift = await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const w = window as unknown as { __shifts: number[]; __shiftObserver: PerformanceObserver }
    const pending = w.__shiftObserver.takeRecords() as (PerformanceEntry & { value: number })[]
    return [...w.__shifts, ...pending.map((entry) => entry.value)].reduce((sum, value) => sum + value, 0)
  })
  expect(shift, 'cumulative layout shift after opening the session').toBeLessThan(0.1)

  const timing = await page.evaluate(() => {
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
    const renderer = entries.find((entry) => /\/MarkdownRenderer-[^/]*\.js$/.test(new URL(entry.name).pathname))
    const session = entries.find((entry) => new URL(entry.name).pathname.endsWith('/api/session'))
    return { renderer: renderer?.startTime, session: session?.responseStart }
  })
  expect(timing.renderer, 'the renderer chunk was requested').toBeDefined()
  expect(timing.session, 'the session was fetched').toBeDefined()
  expect(timing.renderer!, 'the renderer chunk starts before the session response arrives').toBeLessThan(timing.session!)
})
