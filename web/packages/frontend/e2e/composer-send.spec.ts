import { createServer, type ServerResponse } from 'node:http'
import { expect, test } from './fixtures'

// Browser ownership: CSS motion, reduced motion, focusability, and the phone layout use real styles.
test.use({ video: 'on', reducedMotion: 'no-preference' })
test.describe('composer send motion (TAL-1796)', () => {
  test('morphs Send into Stop, switches held modes, and fits the foldable viewports', async ({ page }, testInfo) => {
    const sid = 'send-motion'
    const streamId = 'send-motion-run'
    let active = false
    const streams: ServerResponse[] = []
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
      response.write(`id: ${streamId}:1\nevent: token\ndata: {"text":"Checking the release."}\n\n`)
      streams.push(response)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: sid, title: 'Release checks', messages: [{ role: 'user', id: 1, content: 'Check the release' }, { role: 'assistant', id: 2, content: 'Ready to check.' }], is_streaming: active, ...(active ? { active_stream_id: streamId } : {}) } } }))
    await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active, stream_id: streamId, replay_available: false } }))
    await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${String(address.port)}${new URL(route.request().url()).search}` }))
    await page.route('**/api/chat/start', (route) => { active = true; return route.fulfill({ json: { status: 'streaming', stream_id: streamId, turn_id: 'send-motion-turn' } }) })
    const shot = async (name: string) => {
      await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined))))
      await page.screenshot({ path: process.env.TAL1796_SHOTS ? `${process.env.TAL1796_SHOTS}/${name}-${testInfo.project.name}.png` : testInfo.outputPath(`${name}.png`) })
    }
    try {
      await page.goto(`/session/${sid}`)
      const input = page.locator('#msg')
      const primary = page.locator('.send-primary')
      const idleBackground = await primary.evaluate((element) => getComputedStyle(element).backgroundColor)
      await input.fill('Run the full suite')
      await expect(primary).not.toHaveCSS('background-color', idleBackground)
      await shot('ready')
      await page.locator('#btnSend').click()
      await expect(page.locator('#btnStop')).toBeVisible()
      await input.fill('Also run the linter')
      await shot('busy')
      const busy = page.locator('.send-busy')
      await expect(busy).toHaveAttribute('data-visible', 'true')
      await expect(page.locator('.send-primary > .send-btn:not(.stop)')).toHaveAttribute('inert', '')
      await page.keyboard.down('Control')
      await expect(page.locator('#btnSend')).toHaveAttribute('aria-label', 'Queue message')
      await expect(page.locator('.send-mode-label')).toHaveCSS('opacity', '1')
      await shot('control')
      await page.keyboard.up('Control')
      await page.keyboard.down('Alt')
      await expect(page.locator('#btnSend')).toHaveAttribute('aria-label', 'Interrupt and send')
      await shot('option')
      await page.keyboard.up('Alt')
      await page.keyboard.down('Control')
      await input.press('Enter')
      await page.keyboard.up('Control')
      await expect(input).toHaveValue('')
      const queue = page.locator('[data-notice="queue"]')
      await expect(queue).toHaveText('1 queued')
      await expect(page.locator('.composer-notices')).toHaveClass(/is-grouped/)
      await expect(busy).toHaveAttribute('data-visible', 'false')
      await expect.poll(async () => (await busy.boundingBox())!.width).toBeLessThan(1)
      await shot('queued')
      // The shared queue dialog and both primary actions must remain inside every Duo viewport.
      for (const [width, height] of [[382, 580], [594, 368], [385, 571], [669, 867], [951, 585]] as const) {
        await page.setViewportSize({ width, height })
        await input.fill('Next step')
        await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        const send = page.locator('#btnSend')
        await expect(send).toBeInViewport()
        await expect(page.locator('#btnStop')).toBeInViewport()
        await shot(`viewport-${String(width)}x${String(height)}`)
        await queue.getByRole('button').click()
        await expect(page.getByRole('dialog')).toBeInViewport()
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await expect(queue.getByRole('button')).toBeFocused()
      }
      // Reduced motion disables the transitions, while the held label remains visible.
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await input.focus()
      await page.keyboard.down('Alt')
      await expect(page.locator('.send-mode-label')).toHaveCSS('opacity', '1')
      for (const selector of ['.send-primary', '.send-primary > .send-btn', '.send-busy', '.send-mode-icon', '.send-mode-label']) {
        await expect(page.locator(selector).first()).toHaveCSS('transition-property', 'none')
      }
      await page.keyboard.up('Alt')
      // Cancel the queued follow-up before ending the run so it cannot auto-start another response.
      await queue.getByRole('button').click()
      await page.getByRole('button', { name: 'Cancel queued message' }).click()
      await expect(queue).toHaveCount(0)
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      active = false
      for (const stream of streams) stream.end(`id: ${streamId}:2\nevent: done\ndata: {}\n\n`)
      await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled()
      await input.fill('')
      await expect(primary).toHaveCSS('background-color', idleBackground)
      await shot('finished')
    } finally {
      await page.close()
      for (const stream of streams) stream.end()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => { resolve() }))
    }
  })
})
