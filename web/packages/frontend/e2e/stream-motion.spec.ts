import { writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { DUO_VIEWPORTS, expect, test } from './fixtures'

test.use({ serviceWorkers: 'block', reducedMotion: 'no-preference', video: 'on' })

const CHUNKS = ['Use fake timers, ', 'then pin the system time ', 'before each test so every date ', 'your code reads is fixed:\n\n', '```ts\nbeforeEach(() => {\n', '  vi.useFakeTimers()\n', "  vi.setSystemTime(new Date('2026-01-15T09:00:00Z'))\n", '})\n```\n\n', '- `setSystemTime` pins ', '`Date.now()` and every new `Date`.\n', '- Timers stay paused until ', '`vi.advanceTimersByTime` moves them.']

// Browser ownership: real Streamdown CSS, WAAPI layout, and pre-paint transcript following.
for (const style of ['on', 'off', 'reduced'] as const) {
  test(`streamed words and height follow the ${style} style`, async ({ page }, info) => {
    const sid = 'stream-motion', run = 'stream-motion-run'
    if (style === 'reduced') await page.emulateMedia({ reducedMotion: 'reduce' })
    const streams: ServerResponse[] = []
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
      response.write(': connected\n\n')
      streams.push(response)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing stream fixture port')
    let sequence = 0
    const send = (text: string) => { for (const response of streams) response.write(`id: ${run}:${String(++sequence)}\nevent: token\ndata: ${JSON.stringify({ text })}\n\n`) }
    await page.route('**/api/settings', async (route) => {
      const response = await route.fetch()
      await route.fulfill({ response, json: { ...await response.json(), fade_text_effect: style !== 'off' } })
    })
    await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
      session_id: sid, title: 'Vitest clock', is_streaming: true, active_stream_id: run,
      messages: [{ role: 'user', id: 1, content: 'Earlier context' }, { role: 'assistant', id: 2, content: 'Earlier context.\n\n'.repeat(35) }, { role: 'user', id: 3, content: 'How do I freeze the clock in Vitest?' }],
    } } }))
    await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: run, replay_available: false } }))
    await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${String(address.port)}${new URL(route.request().url()).search}` }))
    const shot = async (name: string) => {
      await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined))))
      await page.screenshot({ path: info.outputPath(`${name}.png`) })
    }
    try {
      await page.goto(`/session/${sid}`)
      await expect.poll(() => streams.length).toBeGreaterThan(0)
      await page.evaluate(() => {
        const samples: { height: number; gap: number; animated: boolean; blur: boolean }[] = []
        const state = { samples, frame: 0 }
        Object.assign(window, { streamMotion: state })
        const draw = () => {
          const wrapper = document.querySelector('[data-stream-height]')
          const pane = document.getElementById('messages')!
          const blur = [...document.querySelectorAll('[data-live] [data-sd-animate]')].some((span) => {
            const css = getComputedStyle(span)
            return css.animationName === 'sd-blurIn' && css.animationDuration === '0.4s' && Number(css.opacity) > 0 && Number(css.opacity) < 1 && css.filter !== 'none'
          })
          // rAF precedes ResizeObserver. Inspect the scroll after its pre-paint correction.
          setTimeout(() => samples.push({ height: wrapper?.getBoundingClientRect().height ?? 0, gap: pane.scrollHeight - pane.clientHeight - pane.scrollTop, animated: !!wrapper?.getAnimations().length, blur }), 0)
          state.frame = requestAnimationFrame(draw)
        }
        draw()
      })
      send(CHUNKS[0]!)
      const live = page.locator('[data-live] .hermes-prose').last()
      await expect(live).toContainText('Use fake timers')
      await shot('before')
      for (const chunk of CHUNKS.slice(1)) {
        send(chunk)
        // Match the approved recording's uneven runs, and let real frames paint between arrivals.
        await page.waitForTimeout(chunk.includes('\n') ? 300 : 120)
      }
      await expect(live).toContainText('moves them.')
      const spans = live.locator('p [data-sd-animate]')
      if (style === 'on') {
        expect(await spans.count()).toBeGreaterThan(0)
        await expect(spans.first()).toHaveCSS('animation-name', 'sd-blurIn')
        await expect(live.locator('[data-streamdown="inline-code"] [data-sd-animate]').first()).toHaveCSS('animation-name', 'none')
        await expect(live.locator('[data-streamdown="code-block"] [data-sd-animate]')).toHaveCount(0)
      } else {
        await expect(spans).toHaveCount(0)
        await expect(page.locator('[data-stream-height]')).toHaveCount(0)
      }
      await page.evaluate(() => Promise.all((document.querySelector('[data-stream-height]')?.getAnimations() ?? []).map((animation) => animation.finished)))
      const samples = await page.evaluate(() => {
        const state = (window as unknown as { streamMotion: { samples: { height: number; gap: number; animated: boolean; blur: boolean }[]; frame: number } }).streamMotion
        cancelAnimationFrame(state.frame)
        return state.samples
      })
      if (style === 'on') {
        expect(samples.some((sample) => sample.blur), 'new words visibly fade from a blur over 400 ms').toBe(true)
        writeFileSync(info.outputPath('frames.json'), JSON.stringify(samples))
        const moving = samples.filter((sample) => sample.animated)
        expect(moving.length).toBeGreaterThan(3)
        expect(new Set(moving.map((sample) => Math.round(sample.height))).size).toBeGreaterThan(3)
        expect(Math.max(...moving.map((sample) => Math.abs(sample.gap))), 'the pinned transcript follows every painted growth frame').toBeLessThanOrEqual(1)
      }
      await shot('after')
      if (style === 'on' && info.project.name === 'desktop') {
        for (const viewport of DUO_VIEWPORTS) {
          await page.setViewportSize(viewport)
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
          await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          await shot(viewport.name)
        }
      }
      if (style === 'on') {
        await page.setViewportSize(info.project.use.viewport!)
        await page.goto('/settings/appearance')
        await page.locator('#main [data-theme-val="light"]').click()
        await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
        const connections = streams.length
        await page.goto(`/session/${sid}`)
        await expect.poll(() => streams.length).toBeGreaterThan(connections)
        send(CHUNKS.join(''))
        await expect(page.locator('[data-live] .hermes-prose').last()).toContainText('moves them.')
        await shot('light')
      }
    } finally {
      await page.goto('about:blank')
      for (const response of streams) response.end()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
}
