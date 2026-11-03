import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block', trace: 'off', screenshot: 'only-on-failure' })

/** TAL-1693: 300 turns whose answers carry the Markdown that changes a row's height once rendered. */
const transcript = (sid: string) => Array.from({ length: 300 }, (_, i) => [
  { role: 'user', id: i * 2 + 1, content: `${sid} question ${i + 1}` },
  { role: 'assistant', id: i * 2 + 2, content: [
    `Answer ${i + 1} with a [reference](https://example.test/${i}) and **emphasis**.`,
    '- first point\n- second point\n  - nested point\n- third point',
    '```ts\n' + Array.from({ length: 12 }, (_, line) => `const value${line} = ${line} * ${i}`).join('\n') + '\n```',
    '1. step one\n2. step two',
  ].join('\n\n') },
]).flat()

test('opening a long session does not shift the transcript while the renderer loads', async ({ page }) => {
  const sid = 'layout-shift'
  await page.addInitScript(() => {
    const shifts: number[] = []
    Object.assign(window, { __shifts: shifts })
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
        if (!entry.hadRecentInput) shifts.push(entry.value)
      }
    }).observe({ type: 'layout-shift', buffered: true })
  })
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: sid, title: 'Long history', messages: transcript(sid) } } }))
  await page.goto(`/session/${sid}`)
  await page.waitForTimeout(4_000)
  await expect(page.locator('#messages [data-role="assistant"] pre').last()).toBeAttached()

  const shift = await page.evaluate(() => (window as unknown as { __shifts: number[] }).__shifts.reduce((sum, value) => sum + value, 0))
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
