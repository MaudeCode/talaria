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
    for (const name of files) dt.items.add(new File([bytes], name, { type: 'image/png' }))
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
