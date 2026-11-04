import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { bootTestServer } from '../../server/dist/test/harness.js'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'
import { groupFixture } from '../../server/dist/test/group-fixture.js'

test.use({ serviceWorkers: 'block' })

const BAR = { x: 0, y: 0, width: 390, height: 120 }
const PROFILES = {
  'two profiles': [{ name: 'default', is_default: true }, { name: 'helper' }],
  'one profile': [{ name: 'default', is_default: true }],
}

async function phoneServer(profiles: { name: string; is_default?: boolean }[]) {
  const sidecar = new FakeSidecar()
  groupFixture(sidecar)
  return bootTestServer({ sidecar, env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' }, deps: (deps) => { deps.profiles.list = () => Promise.resolve(profiles) } })
}

async function expectNoOverlap(page: Page, where: string) {
  const boxes = await Promise.all(['.app-titlebar-left', '.app-titlebar-notifications', '.app-titlebar-icon', '#appTitlebarTitle'].map(async (selector) => {
    const box = await page.locator(selector).boundingBox()
    if (!box) throw new Error(`${selector} is not rendered on ${where}`)
    return { selector, ...box }
  }))
  for (const [i, a] of boxes.entries()) {
    for (const b of boxes.slice(i + 1)) {
      const intersects = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
      expect(intersects, `${a.selector} [${a.x}, ${a.x + a.width}] and ${b.selector} [${b.x}, ${b.x + b.width}] on ${where}`).toBe(false)
    }
  }
}

/** The title's whole text fits its box. A Range measures the text past the ellipsis; `scrollWidth` rounds a sub-pixel cut away. */
async function expectTitleUncut(page: Page) {
  const { box, text } = await page.locator('#appTitlebarTitle').evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    return { box: element.getBoundingClientRect().width, text: range.getBoundingClientRect().width }
  })
  expect(box, 'the title is not cut').toBeGreaterThanOrEqual(text)
}

test.describe('phone titlebar', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) > 640, 'the titlebar only shows at phone width')

  for (const [name, profiles] of Object.entries(PROFILES)) {
    test(`keeps its controls clear of the brand and title with ${name}`, async ({ page }, info) => {
      const server = await phoneServer(profiles)
      try {
        for (const path of ['/groups', '/', '/tasks']) {
          await page.goto(`${server.base}${path}`)
          await expect(page.locator('#appTitlebarTitle')).toBeVisible()
          await expect(page.locator('.app-titlebar-left .composer-chip')).toHaveCount(profiles.length > 1 ? 1 : 0)
          await page.screenshot({ path: info.outputPath(`${name}${path.replace('/', '-')}.png`), clip: BAR })
          await expectNoOverlap(page, path)
        }
      } finally { await page.goto('about:blank').catch(() => undefined); await server.close() }
    })
  }

  test('truncates a title too long for the bar and keeps the right-hand buttons on screen', async ({ page }, info) => {
    const server = await phoneServer(PROFILES['two profiles'])
    try {
      await page.goto(`${server.base}/groups`)
      const title = page.locator('#appTitlebarTitle')
      await expect(title).toBeVisible()
      // Every nav label fits today, so the label a longer locale could ship is written into the element.
      await title.evaluate((element) => { element.textContent = 'A page title much too long for the space a phone titlebar leaves it' })
      await page.screenshot({ path: info.outputPath('long-title.png'), clip: BAR })
      await expectNoOverlap(page, 'the long title')
      expect(await title.evaluate((element) => element.scrollWidth > element.clientWidth && getComputedStyle(element).textOverflow === 'ellipsis')).toBe(true)
      await expect(page.locator('#btnTitlebarNewChat')).toBeInViewport({ ratio: 1 })
      await expect(page.locator('#btnReload')).toBeInViewport({ ratio: 1 })
    } finally { await page.goto('about:blank').catch(() => undefined); await server.close() }
  })

  test('a long profile name truncates in its chip instead of pushing the bar off screen', async ({ page }, info) => {
    const server = await phoneServer(PROFILES['two profiles'])
    const longName = 'a-profile-name-at-the-limit-of-what-the-agent-allows-for-a-name'
    try {
      await page.route('**/api/profiles', (route) => route.fulfill({ json: { active: longName, profiles: [{ name: longName, is_default: true }, { name: 'helper' }] } }))
      await page.goto(`${server.base}/groups`)
      await expect(page.locator('.app-titlebar-left .composer-chip')).toContainText(longName)
      await page.screenshot({ path: info.outputPath('long-profile.png'), clip: BAR })
      expect((await page.locator('.app-titlebar-left .composer-chip svg').first().boundingBox())?.width).toBe(13)
      await expectNoOverlap(page, 'the long profile name')
      await expectTitleUncut(page)
      await expect(page.locator('#btnTitlebarNewChat')).toBeInViewport({ ratio: 1 })
      await expect(page.locator('#btnReload')).toBeInViewport({ ratio: 1 })
    } finally { await page.goto('about:blank').catch(() => undefined); await server.close() }
  })

  test('a long extension name truncates beside the title instead of running under the bell', async ({ page }, info) => {
    const server = await phoneServer(PROFILES['two profiles'])
    try {
      await page.goto(`${server.base}/ext/an-extension-with-a-name-too-long-for-a-phone-titlebar`)
      const subtitle = page.locator('#appTitlebarSub')
      await expect(subtitle).toBeVisible()
      await expect(page.locator('.app-titlebar-left .composer-chip')).toHaveCount(1)
      await page.screenshot({ path: info.outputPath('long-subtitle.png'), clip: BAR })
      const [subtitleBox, bellBox] = await Promise.all([subtitle.boundingBox(), page.locator('.app-titlebar-notifications').boundingBox()])
      expect(subtitleBox!.x + subtitleBox!.width).toBeLessThanOrEqual(bellBox!.x)
      await expectTitleUncut(page)
      await expect(page.locator('#btnReload')).toBeInViewport({ ratio: 1 })
    } finally { await page.goto('about:blank').catch(() => undefined); await server.close() }
  })
})
