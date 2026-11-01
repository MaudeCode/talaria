import type { CDPSession, Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** Transcript image lightbox zoom and pan (TAL-1530), on synthetic SVG attachments of known size. */

const SIZES: Record<string, [number, number, string]> = {
  'large.svg': [2400, 1600, '#2563eb'],
  'tall.svg': [900, 3000, '#16a34a'],
  'small.svg': [120, 80, '#dc2626'],
}
const svg = ([w, h, fill]: [number, number, string]) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${fill}"/>` +
  `<path d="M0 0L${w} ${h}M${w} 0L0 ${h}" stroke="#fff" stroke-width="${Math.max(2, w / 200)}"/></svg>`)

/**
 * One session whose user message carries `files` as image attachments. Each entry is `<image>` or `<image>#<n>` (the same
 * path, so a repeated source URL); an image in `broken` answers 404 until removed.
 */
async function gallery(page: Page, files: string[], broken = new Set<string>()) {
  const attachments = files.map((file) => ({ name: file, path: `/tmp/${file.split('#')[0]}`, is_image: true }))
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'zoom', title: 'Zoom', messages: [{ role: 'user', content: 'shots', attachments }] } } }))
  await page.route('**/api/file/raw**', (route) => {
    const name = (new URL(route.request().url()).searchParams.get('path') ?? '').replace('/tmp/', '')
    const size = SIZES[name]
    if (!size || broken.has(name)) return route.fulfill({ status: 404, body: 'missing' })
    return route.fulfill({ contentType: 'image/svg+xml', body: svg(size) })
  })
  await page.goto('/session/zoom')
  await expect(page.locator('.msg-row .attachment-chip button')).toHaveCount(files.length)
}

async function open(page: Page, index: number) {
  await page.locator('.msg-row .attachment-chip button').nth(index).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

/** A box after the last input's render and layout (two frames). */
async function box(locator: Locator) {
  await locator.page().evaluate(() => new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(resolve)) }))
  const b = await locator.boundingBox()
  if (!b) throw new Error('no box')
  return b
}
const stage = (page: Page) => page.locator('[data-lightbox-stage]')
const shown = (page: Page) => page.locator('[data-lightbox-stage] img')
/** Rendered width over natural width. */
const scaleOf = async (page: Page, name: string) => (await box(shown(page))).width / SIZES[name]![0]

/** Fitted: the whole image inside the stage, touching it on one axis unless it is smaller than the stage. */
async function expectFit(page: Page, name: string) {
  await expect.poll(async () => {
    const [img, room] = [await box(shown(page)), await box(stage(page))]
    const [w, h] = SIZES[name]!
    const fit = Math.min(1, room.width / w, room.height / h)
    return Math.abs(img.width - w * fit) < 1 && Math.abs(img.height - h * fit) < 1 &&
      img.x >= room.x - 0.5 && img.y >= room.y - 0.5 && img.x + img.width <= room.x + room.width + 0.5 && img.y + img.height <= room.y + room.height + 0.5
  }, { message: `${name} fitted` }).toBe(true)
}

/** Zoomed in, the stage stays covered on each overflowing axis. */
async function expectCovers(page: Page) {
  const [img, room] = [await box(shown(page)), await box(stage(page))]
  if (img.width > room.width) { expect(img.x).toBeLessThanOrEqual(room.x + 0.5); expect(img.x + img.width).toBeGreaterThanOrEqual(room.x + room.width - 0.5) }
  if (img.height > room.height) { expect(img.y).toBeLessThanOrEqual(room.y + 0.5); expect(img.y + img.height).toBeGreaterThanOrEqual(room.y + room.height - 0.5) }
}

const centre = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })

test('wheel over a large attachment zooms the image in place', async ({ page }) => {
  await gallery(page, ['large.svg'])
  const dialog = await open(page, 0)
  const img = dialog.getByRole('img', { name: 'large.svg' })
  await expect(img).toBeVisible()
  const before = await box(img)
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
  await page.mouse.wheel(0, -300)
  await expect.poll(async () => (await box(img)).width).toBeGreaterThan(before.width * 1.3)
})

test('the wheel zooms at the cursor and converts line and page deltas', async ({ page }) => {
  await gallery(page, ['large.svg'])
  await open(page, 0)
  await expectFit(page, 'large.svg')
  const before = await box(shown(page))
  const at = { x: before.x + before.width * 0.3, y: before.y + before.height * 0.5 }
  await page.mouse.move(at.x, at.y)
  await page.mouse.wheel(0, -100)
  await expect.poll(() => scaleOf(page, 'large.svg')).toBeGreaterThan(before.width / 2400 * 1.1)
  const after = await box(shown(page))
  // The image point under the cursor stays under it.
  expect(Math.abs((at.x - after.x) / after.width - 0.3)).toBeLessThan(0.01)
  // Line and page delta modes zoom too (a trusted wheel only sends pixels).
  for (const deltaMode of [1, 2]) {
    const scale = await scaleOf(page, 'large.svg')
    await stage(page).evaluate((el, mode) => el.dispatchEvent(new WheelEvent('wheel', { deltaY: -3, deltaMode: mode, clientX: 400, clientY: 300, bubbles: true, cancelable: true })), deltaMode)
    await expect.poll(() => scaleOf(page, 'large.svg')).toBeGreaterThan(scale * 1.1)
  }
  await expectCovers(page)
})

test('zoom buttons and keys step the zoom, Fit restores the whole image, and controls are 44 px with names', async ({ page }) => {
  await gallery(page, ['large.svg'])
  const dialog = await open(page, 0)
  await expectFit(page, 'large.svg')
  const fit = await scaleOf(page, 'large.svg')
  for (const name of ['Zoom out', 'Fit image', 'Zoom in', 'Close']) {
    const b = await box(dialog.getByRole('button', { name, exact: true }))
    expect(Math.min(b.width, b.height), name).toBeGreaterThanOrEqual(44)
  }
  await dialog.getByRole('button', { name: 'Zoom in' }).click()
  await expect.poll(() => scaleOf(page, 'large.svg')).toBeCloseTo(fit * 1.25, 3)
  await page.keyboard.press('+')
  await expect.poll(() => scaleOf(page, 'large.svg')).toBeCloseTo(fit * 1.25 * 1.25, 3)
  await page.keyboard.press('=')
  await page.keyboard.press('-')
  await expect.poll(() => scaleOf(page, 'large.svg')).toBeCloseTo(fit * 1.25 * 1.25, 3)
  await expectCovers(page)
  await page.keyboard.press('f')
  await expectFit(page, 'large.svg')
  await dialog.getByRole('button', { name: 'Zoom in' }).click()
  await dialog.getByRole('button', { name: 'Fit image' }).click()
  await expectFit(page, 'large.svg')
  // Zoom-out bottoms out at a quarter scale or the fit, whichever is smaller.
  for (let i = 0; i < 12; i++) await page.keyboard.press('_')
  await expect.poll(() => scaleOf(page, 'large.svg')).toBeCloseTo(Math.min(0.25, fit), 3)
  // Visible keyboard focus on the controls.
  await dialog.getByRole('button', { name: 'Zoom in' }).focus()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'Zoom in' })).toBeFocused()
  expect(await dialog.getByRole('button', { name: 'Zoom in' }).evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none')
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toHaveCount(0)
})

test('a drag pans the zoomed image within bounds and reverses at once from the edge', async ({ page }) => {
  await gallery(page, ['large.svg'])
  const dialog = await open(page, 0)
  await expectFit(page, 'large.svg')
  // Far enough that both axes overflow at desktop and phone widths.
  for (let i = 0; i < 7; i++) await dialog.getByRole('button', { name: 'Zoom in' }).click()
  const start = centre(await box(stage(page)))
  const before = await box(shown(page))
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x - 40, start.y - 30, { steps: 4 })
  await expect.poll(async () => (await box(shown(page))).x).toBeCloseTo(before.x - 40, 0)
  expect((await box(shown(page))).y).toBeCloseTo(before.y - 30, 0)
  // Far past the edge: the image stops at the stage edge…
  await page.mouse.move(start.x + 3000, start.y, { steps: 6 })
  await expectCovers(page)
  const pinned = await box(shown(page))
  expect(pinned.x).toBeCloseTo((await box(stage(page))).x, 0)
  // …and moving back moves it straight away, with no dead zone to unwind.
  await page.mouse.move(start.x + 3000 - 25, start.y, { steps: 2 })
  await expect.poll(async () => (await box(shown(page))).x).toBeCloseTo(pinned.x - 25, 0)
  // Released over the backdrop, the drag does not dismiss the dialog.
  await page.mouse.move(2, 2, { steps: 4 })
  await page.mouse.up()
  await expect(dialog).toBeVisible()
  // An image tap does not dismiss either; a clean backdrop click and Escape do.
  await shown(page).click()
  await expect(dialog).toBeVisible()
  await page.mouse.click(2, 2)
  await expect(dialog).toHaveCount(0)
  await open(page, 0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // Focus returns to the opener.
  await expect(page.locator('.msg-row .attachment-chip button').first()).toBeFocused()
})

test('navigation wraps, a fitted view fits each image, a zoom carries over recentred, and small images are not upscaled', async ({ page }) => {
  await gallery(page, ['large.svg', 'tall.svg', 'small.svg'])
  const dialog = await open(page, 0)
  await expectFit(page, 'large.svg')
  await page.keyboard.press('ArrowRight')
  await expect(dialog.getByRole('img', { name: 'tall.svg' })).toBeVisible()
  await expectFit(page, 'tall.svg')
  await page.keyboard.press('ArrowRight')
  await expectFit(page, 'small.svg')
  expect(await scaleOf(page, 'small.svg')).toBeCloseTo(1, 3)
  await page.keyboard.press('ArrowRight')
  await expect(dialog.getByRole('img', { name: 'large.svg' })).toBeVisible()
  await expectFit(page, 'large.svg')
  // A deliberate zoom, panned off-centre, survives the step and recentres on the next image.
  for (let i = 0; i < 4; i++) await page.keyboard.press('+')
  const zoomed = await scaleOf(page, 'large.svg')
  const at = centre(await box(stage(page)))
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x + 60, at.y + 40, { steps: 3 })
  await page.mouse.up()
  await dialog.getByRole('button', { name: 'Next image' }).click()
  await expect(dialog.getByRole('img', { name: 'tall.svg' })).toBeVisible()
  await expect.poll(() => scaleOf(page, 'tall.svg')).toBeCloseTo(zoomed, 3)
  const [img, room] = [await box(shown(page)), await box(stage(page))]
  expect(centre(img).x).toBeCloseTo(centre(room).x, 0)
  expect(centre(img).y).toBeCloseTo(centre(room).y, 0)
  await dialog.getByRole('button', { name: 'Previous image' }).click()
  await dialog.getByRole('button', { name: 'Previous image' }).click()
  await expect(dialog.getByRole('img', { name: 'small.svg' })).toBeVisible()
  await expect.poll(() => scaleOf(page, 'small.svg')).toBeCloseTo(zoomed, 3)
})

test('a repeated source URL, a failed load and its recovery, and a resize each keep the view consistent', async ({ page, errors }) => {
  const broken = new Set(['tall.svg'])
  await gallery(page, ['large.svg', 'large.svg#2', 'tall.svg'], broken)
  const dialog = await open(page, 0)
  await expectFit(page, 'large.svg')
  // The same source twice: the second view of the cached image still fits.
  await page.keyboard.press('ArrowRight')
  await expect(dialog.getByRole('img', { name: 'large.svg#2' })).toBeAttached()
  await expectFit(page, 'large.svg')
  // A failed image says so; its zoom controls are inert and the image after it loads normally.
  await page.keyboard.press('ArrowRight')
  await expect(dialog.getByRole('alert')).toHaveText('Could not load image')
  await page.keyboard.press('+')
  broken.delete('tall.svg')
  await page.keyboard.press('ArrowRight')
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await expectFit(page, 'large.svg')
  // Back on the once-broken image, it now loads and fits.
  await page.keyboard.press('ArrowLeft')
  await expect(dialog.getByRole('img', { name: 'tall.svg' })).toBeVisible()
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await expectFit(page, 'tall.svg')
  // A resize refits a fitted view and keeps a zoomed one in bounds.
  const viewport = page.viewportSize()!
  await page.setViewportSize({ width: Math.round(viewport.width * 0.8), height: Math.round(viewport.height * 0.8) })
  await expectFit(page, 'tall.svg')
  for (let i = 0; i < 3; i++) await page.keyboard.press('+')
  const room = await box(stage(page))
  await page.mouse.move(room.x + room.width / 2, room.y + room.height / 2)
  await page.mouse.down()
  await page.mouse.move(room.x + room.width / 2 + 2000, room.y + room.height / 2 + 2000, { steps: 4 })
  await page.mouse.up()
  await page.setViewportSize(viewport)
  await expect.poll(async () => { try { await expectCovers(page); return true } catch { return false } }).toBe(true)
  errors.splice(0, errors.length, ...errors.filter((e) => !/404 GET .*\/api\/file\/raw/.test(e)))
})

test('image input stays in the lightbox: no shell listeners, native context menu, page zoom and pointer ownership', async ({ page }) => {
  await gallery(page, ['large.svg'])
  await open(page, 0)
  await expectFit(page, 'large.svg')
  await page.evaluate(() => {
    const seen = window as unknown as { seen: string[]; events: Event[] }
    seen.seen = []
    seen.events = []
    for (const type of ['wheel', 'pointerdown', 'touchmove']) document.addEventListener(type, () => seen.seen.push(type))
    for (const type of ['contextmenu', 'keydown']) window.addEventListener(type, (e) => seen.events.push(e), true)
  })
  const at = centre(await box(shown(page)))
  await page.mouse.move(at.x, at.y)
  await page.mouse.wheel(0, -100)
  await page.mouse.down()
  await page.mouse.move(at.x - 20, at.y, { steps: 2 })
  await page.mouse.up()
  expect(await page.evaluate(() => (window as unknown as { seen: string[] }).seen)).toEqual([])
  // Right-click leaves the browser's own image menu alone.
  await shown(page).click({ button: 'right' })
  // Modified shortcuts (page zoom) pass through untouched and do not zoom the image.
  const scale = await scaleOf(page, 'large.svg')
  await page.keyboard.press('Control+=')
  expect(await scaleOf(page, 'large.svg')).toBeCloseTo(scale, 3)
  const prevented = await page.evaluate(() => (window as unknown as { events: Event[] }).events.map((e) => `${e.type}:${e.defaultPrevented}`))
  expect(prevented).toContain('contextmenu:false')
  expect(prevented.filter((e) => e.startsWith('keydown')).every((e) => e === 'keydown:false')).toBe(true)
  await page.keyboard.press('Escape')
  // A pointer that started outside the image does not drive it.
  await open(page, 0)
  await expectFit(page, 'large.svg')
  const before = await box(shown(page))
  await page.mouse.move(2, 2)
  await page.mouse.down()
  await page.mouse.move(before.x + 100, before.y + 100, { steps: 4 })
  expect((await box(shown(page))).x).toBeCloseTo(before.x, 0)
  await page.mouse.up()
})

/** Trusted multi-touch through the DevTools protocol; `touchEnd` lifts the listed points, or every point when empty. */
const touch = (cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', points: { x: number; y: number; id: number }[]) =>
  cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(({ x, y, id }) => ({ x, y, id })) })

test('a pinch zooms at its midpoint, the remaining finger pans, and lifting over the backdrop keeps the dialog', async ({ page }, info) => {
  test.skip(!info.project.use.hasTouch, 'touch input runs on the mobile project')
  await gallery(page, ['large.svg'])
  const dialog = await open(page, 0)
  await expectFit(page, 'large.svg')
  const cdp = await page.context().newCDPSession(page)
  const c = centre(await box(stage(page)))
  const fit = await scaleOf(page, 'large.svg')
  await touch(cdp, 'touchStart', [{ x: c.x - 40, y: c.y, id: 1 }, { x: c.x + 40, y: c.y, id: 2 }])
  for (let d = 50; d <= 120; d += 10) await touch(cdp, 'touchMove', [{ x: c.x - d, y: c.y, id: 1 }, { x: c.x + d, y: c.y, id: 2 }])
  await expect.poll(() => scaleOf(page, 'large.svg')).toBeCloseTo(fit * 3, 1)
  // The midpoint stays over the same image point (the centre).
  expect(centre(await box(shown(page))).x).toBeCloseTo(c.x, 0)
  // Lift one finger; the other pans.
  await touch(cdp, 'touchEnd', [{ x: c.x - 120, y: c.y, id: 1 }])
  const lifted = await box(shown(page))
  for (let dx = 10; dx <= 40; dx += 10) await touch(cdp, 'touchMove', [{ x: c.x + 120 + dx, y: c.y, id: 2 }])
  await expect.poll(async () => (await box(shown(page))).x).toBeCloseTo(lifted.x + 40, 0)
  await touch(cdp, 'touchEnd', [])
  // A cancelled touch leaves no gesture behind: the next finger pans on its own instead of pinching against it.
  await touch(cdp, 'touchStart', [{ x: c.x, y: c.y, id: 3 }])
  await touch(cdp, 'touchCancel', [])
  const scale = await scaleOf(page, 'large.svg')
  const settled = await box(shown(page))
  await touch(cdp, 'touchStart', [{ x: c.x, y: c.y, id: 4 }])
  for (let dx = 10; dx <= 30; dx += 10) await touch(cdp, 'touchMove', [{ x: c.x - dx, y: c.y, id: 4 }])
  await expect.poll(async () => (await box(shown(page))).x).toBeCloseTo(settled.x - 30, 0)
  expect(await scaleOf(page, 'large.svg')).toBeCloseTo(scale, 3)
  await touch(cdp, 'touchEnd', [])
  await expect(dialog).toBeVisible()
  // A second finger that lands on the backdrop and lifts there last does not dismiss.
  await touch(cdp, 'touchStart', [{ x: c.x, y: c.y, id: 5 }])
  await touch(cdp, 'touchStart', [{ x: c.x, y: c.y, id: 5 }, { x: 4, y: 4, id: 6 }])
  await touch(cdp, 'touchEnd', [{ x: c.x, y: c.y, id: 5 }])
  await touch(cdp, 'touchEnd', [{ x: 4, y: 4, id: 6 }])
  await expect(dialog).toBeVisible()
  // A clean backdrop tap still does.
  await page.touchscreen.tap(4, 4)
  await expect(dialog).toHaveCount(0)
})
