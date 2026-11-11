import { bootDemoServer, DEMO_SESSION_ID } from './demo-server'
import { DUO_VIEWPORTS, expect, longPress, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block', reducedMotion: 'no-preference', video: 'on' })

test('background activity travels between groups and archive folds in the real sidebar', async ({ page }, info) => {
  const { server } = await bootDemoServer()
  const sid = '20261103_090000_demo'
  // Sample the real browser's drawn frames, including CSS/WAAPI composition and the grouped DOM remount.
  await page.addInitScript(() => {
    const native = Reflect.get(Element.prototype, 'animate')
    const samples: { id: string; boxes: { y: number; height: number }[] }[] = []
    Object.assign(window, { listMotionSamples: samples })
    Element.prototype.animate = function (...args) {
      const animation = native.apply(this, args)
      const id = this.getAttribute('data-motion-key')
      if (id) {
        const sample = { id, boxes: [] as { y: number; height: number }[] }; samples.push(sample)
        const draw = () => {
          if (!this.isConnected || animation.playState === 'idle') return
          const rect = this.getBoundingClientRect(); sample.boxes.push({ y: rect.y, height: rect.height })
          if (animation.playState !== 'finished') requestAnimationFrame(draw)
        }
        requestAnimationFrame(draw)
      }
      return animation
    }
  })
  try {
    await page.goto(`${server.base}/session/${DEMO_SESSION_ID}`)
    await settle(page)
    const hamburger = page.locator('#btnHamburger')
    if (await hamburger.isVisible()) await hamburger.click()
    const mover = page.locator(`[data-sid="${sid}"]`)
    await expect(mover).toBeVisible()
    await page.screenshot({ animations: 'disabled', path: info.outputPath('before.png') })
    const session = await server.deps.sessionStore.load(sid)
    if (!session) throw new Error('Missing seeded session')
    session.messages.push({ role: 'user', content: 'Background activity', timestamp: Date.now() / 1000 })
    await server.deps.sessionStore.save(session)
    server.deps.events.publish('session_changed', { sessionId: sid })
    await expect(page.locator('[data-motion-group="today"]')).toContainText('Draft the changelog')
    await page.evaluate(() => Promise.all((document.getElementById('sessionList')?.getAnimations({ subtree: true }) ?? []).map((animation) => animation.finished.catch(() => undefined))))
    const travels = await page.evaluate(() => (window as unknown as { listMotionSamples: { id: string; boxes: { y: number; height: number }[] }[] }).listMotionSamples)
    const travel = travels.find((sample) => sample.id === sid)
    expect(travel?.boxes.length).toBeGreaterThan(2)
    expect(Math.max(...travel!.boxes.map((box) => box.y)) - Math.min(...travel!.boxes.map((box) => box.y))).toBeGreaterThan(10)
    if (info.project.name === 'mobile') {
      await longPress(page, mover)
      await page.getByRole('menuitem', { name: 'Archive conversation', exact: true }).click()
    } else {
      await mover.hover()
      await mover.getByRole('button', { name: 'Archive', exact: true }).click()
    }
    await expect(mover).toHaveCount(0)
    const folds = await page.evaluate(() => (window as unknown as { listMotionSamples: { id: string; boxes: { y: number; height: number }[] }[] }).listMotionSamples)
    expect(folds.filter((sample) => sample.id === sid).some((sample) => {
      const heights = sample.boxes.map((box) => box.height)
      return heights.length > 2 && Math.max(...heights) - Math.min(...heights) > 10
    })).toBe(true)
    await page.screenshot({ animations: 'disabled', path: info.outputPath('after.png') })

    if (info.project.name === 'desktop') {
      for (const viewport of DUO_VIEWPORTS) {
        await page.setViewportSize(viewport)
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        // The sidebar is a rail at tablet widths; open its real drawer for the row review.
        if (viewport.width <= 900 && await page.locator('.sidebar').getAttribute('data-mobile-open') !== '1') await hamburger.click()
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.locator('#sessionList [data-sid]').first().scrollIntoViewIfNeeded()
        await page.screenshot({ animations: 'disabled', path: info.outputPath(`${viewport.name}.png`) })
      }
    }
  } finally {
    try { if (!page.isClosed()) await page.goto('about:blank') } finally { await server.close() }
  }
})
