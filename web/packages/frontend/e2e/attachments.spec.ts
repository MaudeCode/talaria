import type { Page, Request } from '@playwright/test'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** Composer attachments (TAL-276): picker and paste show chips, uploads keep their session, image-only sends. */

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const image = (name: string) => ({ name, mimeType: 'image/png', buffer: PNG })
const chips = (page: Page) => page.locator('.attach-tray li')

/** One synthetic session, its draft autosave, and an upload endpoint that records which session each file went to. */
async function mockSession(page: Page, sid: string, uploads: string[] = []) {
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: sid, title: 'Attach', messages: [] } } }))
  await page.route('**/api/session/draft', (route) => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/upload**', async (route) => {
    const target = new URL(route.request().url()).searchParams.get('session_id') ?? ''
    uploads.push(target)
    await route.fulfill({ json: { filename: `f${uploads.length}.png`, path: `/tmp/${target}/f${uploads.length}.png`, size: PNG.length, mime: 'image/png', is_image: true } })
  })
  return uploads
}

/** A paste carrying the given files and plain text; resolves to whether the composer kept the browser's own paste. */
function paste(page: Page, files: string[], text: string) {
  return page.locator('#msg').evaluate((el, { files, text, png }) => {
    const dt = new DataTransfer()
    const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0))
    for (const name of files) dt.items.add(new File([bytes], name, { type: 'image/png', lastModified: 1 }))
    if (text) dt.setData('text/plain', text)
    const event = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    el.dispatchEvent(event)
    return !event.defaultPrevented
  }, { files, text, png: PNG.toString('base64') })
}

test('picked images show as chips in an existing chat and send without text', async ({ page }) => {
  await mockSession(page, 'picked')
  let body: Record<string, unknown> | null = null
  await page.route('**/api/chat/start', async (route) => { body = route.request().postDataJSON() as Record<string, unknown>; await route.fulfill({ json: { status: 'suppressed' } }) })
  await page.goto('/session/picked')
  await page.locator('#fileInput').setInputFiles([image('one.png'), image('two.png')])
  await expect(chips(page)).toHaveCount(2)
  await expect(chips(page).first()).toBeVisible()
  await expect(chips(page).and(page.locator('[data-status="done"]'))).toHaveCount(2)
  await expect(page.locator('#btnSend')).toBeEnabled()
  await page.locator('#btnSend').click()
  await expect.poll(() => body).not.toBeNull()
  expect(body!.message).toBe('')
  expect((body!.attachments as { filename: string }[]).map((a) => a.filename)).toEqual(['f1.png', 'f2.png'])
  await expect(chips(page)).toHaveCount(0)
})

test('a pasted image shows as a chip, and its accompanying text pastes as text', async ({ page }) => {
  await mockSession(page, 'pasted')
  await page.goto('/session/pasted')
  await expect(page.locator('#msg')).toBeVisible()
  // Image with text: the image attaches and the browser's paste of the text goes ahead.
  expect(await paste(page, ['shot.png'], 'see this')).toBe(true)
  await expect(chips(page)).toHaveCount(1)
  await expect(chips(page)).toBeVisible()
  // Image alone attaches without a text paste; plain text alone stays an ordinary paste.
  expect(await paste(page, ['other.png'], '')).toBe(false)
  await expect(chips(page)).toHaveCount(2)
  expect(await paste(page, [], 'just words')).toBe(true)
  await expect(chips(page)).toHaveCount(2)
})

test('attaching while a session transcript loads uploads to that session, never a new one', async ({ page }) => {
  let release!: () => void
  const loaded = new Promise<void>((resolve) => { release = resolve })
  const created: Request[] = []
  page.on('request', (req) => { if (req.url().includes('/api/session/new')) created.push(req) })
  const uploads: string[] = []
  await mockSession(page, 'loading', uploads)
  await page.route('**/api/session?**', async (route) => { await loaded; await route.fulfill({ json: { session: { session_id: 'loading', title: 'Attach', messages: [] } } }) })
  await page.goto('/session/loading')
  await expect(page.locator('#msg')).toBeVisible()
  await page.locator('#fileInput').setInputFiles([image('early.png')])
  await expect.poll(() => uploads).toEqual(['loading'])
  await expect(chips(page)).toBeVisible()
  release()
  await expect(chips(page).and(page.locator('[data-status="done"]'))).toHaveCount(1)
  await expect(page).toHaveURL(/\/session\/loading$/)
  expect(created).toHaveLength(0)
})

test('a new chat hands its draft and picked image to the session it creates', async ({ page }) => {
  const uploads = await mockSession(page, 'handoff')
  await page.route('**/api/session/new', (route) => route.fulfill({ json: { session: { session_id: 'handoff', title: '', messages: [] } } }))
  await page.goto('/')
  await page.locator('#msg').fill('Describe this')
  await page.locator('#fileInput').setInputFiles([image('new.png')])
  await expect(page).toHaveURL(/\/session\/handoff$/)
  await expect(page.locator('#msg')).toHaveValue('Describe this')
  await expect(chips(page).and(page.locator('[data-status="done"]'))).toHaveCount(1)
  expect(uploads).toEqual(['handoff'])
})

test('a new chat hands a pasted image to the session it creates', async ({ page }) => {
  const uploads = await mockSession(page, 'pasted-new')
  await page.route('**/api/session/new', (route) => route.fulfill({ json: { session: { session_id: 'pasted-new', title: '', messages: [] } } }))
  await page.goto('/')
  await expect(page.locator('#msg')).toBeVisible()
  expect(await paste(page, ['clip.png'], '')).toBe(false)
  await expect(page).toHaveURL(/\/session\/pasted-new$/)
  await expect(chips(page).and(page.locator('[data-status="done"]'))).toHaveCount(1)
  expect(uploads).toEqual(['pasted-new'])
})

test('removing a chip while it uploads rolls the late upload back', async ({ page }) => {
  await mockSession(page, 'inflight')
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/upload?**', async (route) => { await held; await route.fulfill({ json: { filename: 'late.png', path: '/tmp/late.png', size: PNG.length, mime: 'image/png', is_image: true, rollback_token: 'tok-late' } }) })
  const rolledBack: unknown[] = []
  await page.route('**/api/upload/rollback', async (route) => { rolledBack.push(route.request().postDataJSON()); await route.fulfill({ json: { ok: true, rolled_back: 1, failed: 0 } }) })
  await page.goto('/session/inflight')
  await page.locator('#fileInput').setInputFiles([image('late.png')])
  await expect(chips(page).and(page.locator('[data-status="uploading"]'))).toHaveCount(1)
  await page.getByRole('button', { name: 'Remove late.png' }).click()
  await expect(chips(page)).toHaveCount(0)
  release()
  await expect.poll(() => rolledBack).toEqual([{ session_id: 'inflight', rollback_tokens: ['tok-late'] }])
  await expect(chips(page)).toHaveCount(0)
})

test('a chip removed while the new chat is created stays removed', async ({ page }) => {
  const uploads = await mockSession(page, 'removed-new')
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/session/new', async (route) => { await held; await route.fulfill({ json: { session: { session_id: 'removed-new', title: '', messages: [] } } }) })
  await page.goto('/')
  await page.locator('#fileInput').setInputFiles([image('keep.png'), image('drop.png')])
  await expect(chips(page)).toHaveCount(2)
  await page.getByRole('button', { name: 'Remove drop.png' }).click()
  release()
  await expect(page).toHaveURL(/\/session\/removed-new$/)
  await expect(chips(page).and(page.locator('[data-status="done"]'))).toHaveText(/keep\.png/)
  await expect(chips(page)).toHaveCount(1)
  expect(uploads).toEqual(['removed-new'])
})

test('the same file pasted twice while the new chat is created attaches once', async ({ page }) => {
  const uploads = await mockSession(page, 'twice-new')
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/session/new', async (route) => { await held; await route.fulfill({ json: { session: { session_id: 'twice-new', title: '', messages: [] } } }) })
  await page.goto('/')
  await expect(page.locator('#msg')).toBeVisible()
  // Pasted twice, the same file (name, size and modified time) is one attachment.
  await paste(page, ['same.png'], '')
  await expect(chips(page)).toHaveCount(1)
  await paste(page, ['same.png'], '')
  release()
  await expect(page).toHaveURL(/\/session\/twice-new$/)
  await expect(chips(page).and(page.locator('[data-status="done"]'))).toHaveCount(1)
  await expect.poll(() => uploads).toEqual(['twice-new'])
  await page.waitForTimeout(300)
  expect(uploads).toEqual(['twice-new'])
})

test('opening another chat while a new chat is created leaves the hand-off to the new chat', async ({ page }) => {
  const uploads: string[] = []
  await page.route('**/api/session?**', (route) => {
    const sid = new URL(route.request().url()).searchParams.get('session_id') ?? ''
    return route.fulfill({ json: { session: { session_id: sid, title: sid, messages: [] } } })
  })
  await page.route('**/api/session/draft', (route) => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/upload**', async (route) => {
    uploads.push(new URL(route.request().url()).searchParams.get('session_id') ?? '')
    await route.fulfill({ json: { filename: 'h.png', path: '/tmp/h.png', size: PNG.length, mime: 'image/png', is_image: true } })
  })
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/session/new', async (route) => { await held; await route.fulfill({ json: { session: { session_id: 'bound-new', title: '', messages: [] } } }) })
  await page.goto('/')
  await page.locator('#msg').fill('For the new chat')
  await page.locator('#fileInput').setInputFiles([image('bound.png')])
  // Another chat opens in the same tab before the new one exists.
  await page.evaluate(() => { history.pushState({}, '', '/session/other-chat'); dispatchEvent(new PopStateEvent('popstate')) })
  await expect(page).toHaveURL(/\/session\/other-chat$/)
  await expect(page.locator('#msg')).toBeVisible()
  await page.waitForTimeout(300)
  await expect(chips(page)).toHaveCount(0)
  await expect(page.locator('#msg')).not.toHaveValue('For the new chat')
  release()
  await expect(page).toHaveURL(/\/session\/bound-new$/)
  await expect(page.locator('#msg')).toHaveValue('For the new chat')
  await expect(chips(page).and(page.locator('[data-status="done"]'))).toHaveCount(1)
  expect(uploads).toEqual(['bound-new'])
})

test('a failed upload stays as an error chip that can be retried or removed', async ({ page, errors }) => {
  await mockSession(page, 'retry')
  let fail = true
  await page.route('**/api/upload**', async (route) => {
    if (fail) { await route.fulfill({ status: 500, json: { error: 'synthetic upload failure' } }); return }
    await route.fulfill({ json: { filename: 'r.png', path: '/tmp/r.png', size: PNG.length, mime: 'image/png', is_image: true } })
  })
  await page.goto('/session/retry')
  await page.locator('#fileInput').setInputFiles([image('flaky.png'), image('gone.png')])
  await expect(chips(page).and(page.locator('[data-status="error"]'))).toHaveCount(2)
  fail = false
  await page.getByRole('button', { name: 'Retry flaky.png' }).click()
  await expect(chips(page).and(page.locator('[data-status="done"]'))).toHaveText(/flaky\.png/)
  await page.getByRole('button', { name: 'Remove gone.png' }).click()
  await expect(chips(page)).toHaveCount(1)
  // The synthetic 500s are the point of this test.
  errors.splice(0, errors.length, ...errors.filter((e) => !/api\/upload|status of 500/.test(e)))
})

test('clicking a sent image opens it enlarged, the arrow keys step through the message images, and Escape closes it (TAL-608)', async ({ page }) => {
  const shots = ['a.png', 'b.png', 'c.png']
  const attachments = [...shots.map((name) => ({ name, path: `/tmp/${name}`, is_image: true })), { name: 'notes.txt', path: '/tmp/notes.txt' }]
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'gallery', title: 'Gallery', messages: [{ role: 'user', content: 'three shots', attachments }] } } }))
  await page.route('**/api/session/draft', (route) => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/file/raw**', (route) => route.fulfill({ contentType: 'image/png', body: PNG }))
  await page.goto('/session/gallery')
  await page.locator('.msg-row img[alt="b.png"]').click()
  const dialog = page.getByRole('dialog', { name: 'b.png' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('img', { name: 'b.png' })).toBeVisible()
  await expect(dialog).toContainText('2 / 3')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('dialog', { name: 'c.png' })).toBeVisible()
  // Stepping wraps, and the on-screen arrows move the same way.
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('dialog', { name: 'a.png' })).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('dialog', { name: 'c.png' })).toBeVisible()
  await page.getByRole('button', { name: 'Previous image' }).click()
  await expect(page.getByRole('dialog', { name: 'b.png' })).toBeVisible()
  await page.getByRole('button', { name: 'Next image' }).click()
  await expect(page.getByRole('dialog', { name: 'c.png' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
