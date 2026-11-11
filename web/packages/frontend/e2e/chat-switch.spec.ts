import { mkdirSync } from 'node:fs'
import { expect, expectNoOverflow, test } from './fixtures'
import { bootDemoServer, DEMO_SESSION_ID } from './demo-server'

test.use({ serviceWorkers: 'block', reducedMotion: 'no-preference', video: 'on' })

// Component tests own motion calls and lifecycle. This checks actual painted geometry and interactive navigation.
test('chat switches keep title slots stable and retarget the painted selection without blocking navigation', async ({ page }, info) => {
  const { server } = await bootDemoServer()
  const second = '20261101_090000_demo', third = '20261102_090000_demo'
  try {
    await page.goto(`${server.base}/session/${DEMO_SESSION_ID}`)
    await expect(page.locator('#messages')).toContainText('Filed two tickets')
    const title = page.locator(info.project.name === 'mobile' ? '#appTitlebarTitle' : '#topbarTitle')
    const width = (await title.boundingBox())!.width
    const finishMotion = () => page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))))
    const open = async (id: string) => {
      const link = page.locator(`#sessionList [data-sid="${id}"]`)
      await expect(link).toBeAttached()
      if (info.project.name === 'mobile') await page.locator('#btnHamburger').click()
      await link.click()
      await expect(page).toHaveURL(new RegExp(`/session/${id}$`))
    }
    await open(second)
    await expect(page.locator('#messages')).toContainText('Done: plan the release.')
    expect((await title.boundingBox())!.width).toBeCloseTo(width, 0)
    expect(await page.locator('[data-list-selection]').count()).toBe(1)
    const before = await page.locator('[data-list-selection]').evaluate((el) => {
      const animation = el.getAnimations()[0]
      if (animation) { animation.pause(); animation.currentTime = 160 }
      return { top: el.getBoundingClientRect().top, moving: !!animation }
    })
    // On a phone the drawer closes immediately, so its hidden highlight settles when reopened.
    if (info.project.name === 'desktop') expect(before.moving).toBe(true)
    await open(third)
    await expect(page.locator('#messages')).toContainText('Done: fix the flaky upload test.')
    await expect(page.locator('#messages')).not.toContainText('Done: plan the release.')
    expect((await title.boundingBox())!.width).toBeCloseTo(width, 0)
    if (info.project.name === 'desktop') {
      const move = await page.locator('[data-list-selection]').evaluate((el) => {
        const animation = el.getAnimations()[0]
        const target = document.querySelector('#sessionList [aria-current="page"]')!.getBoundingClientRect()
        const frame = (animation?.effect as KeyframeEffect | null)?.getKeyframes()[0]
        return { delta: frame?.transform ? new DOMMatrix(String(frame.transform)).m42 : null, top: target.top }
      })
      expect(move.delta).not.toBeNull()
      expect(move.delta!).toBeCloseTo(before.top - move.top, 0)
    }
    await expect(page.locator('#msg')).toBeEditable()
    await page.locator('#msg').fill('A draft can be typed immediately after switching')
    await expect(page.locator('#msg')).toHaveValue('A draft can be typed immediately after switching')
    await expect.poll(() => page.locator('#messages').evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2)
    await finishMotion()
    await info.attach('chat-switch-final', { body: await page.screenshot(), contentType: 'image/png' })
    const shots = process.env.TOUR_SHOTS
    if (shots) {
      mkdirSync(shots, { recursive: true })
      const save = async (name: string) => {
        await finishMotion()
        await page.screenshot({ path: `${shots}/${name}.png` })
      }
      await save(`switch-${info.project.name}`)
      if (info.project.name === 'desktop') await expectNoOverflow(page, 'switch', save)
    }
  } finally { await page.goto('about:blank').catch(() => undefined); await server.close() }
})
