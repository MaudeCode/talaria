import type { Page, Request } from '@playwright/test'
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny'
import { expect, settle, test } from './fixtures'

/**
 * TAL-1596: Send feedback compresses in the real browser before it uploads. Synthetic media is generated in the page;
 * the stubbed server receives the multipart upload and the test inspects the exact bytes that would leave the browser.
 */
const OPTIONS = { enabled: true, videoAllowed: true, maxCount: 5, maxVideoCount: 1, maxImageBytes: 10_000_000, maxVideoBytes: 20_000_000, maxVideoSeconds: 120, acceptedTypes: ['image/png', 'image/jpeg', 'image/heic', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm'] }
type Limits = typeof OPTIONS

test.skip(({ isMobile }) => isMobile, 'Compression does not depend on the viewport; desktop Chromium covers it.')

/** The `file` part of a multipart body. */
function uploadedFile(request: Request): { contentType: string; data: Buffer } {
  const body = request.postDataBuffer()!
  const boundary = /boundary=(.+)$/.exec(request.headers()['content-type'] ?? '')![1]!
  const parts: { headers: string; data: Buffer }[] = []
  let at = body.indexOf(`--${boundary}`)
  while (at >= 0) {
    const next = body.indexOf(`--${boundary}`, at + boundary.length + 2)
    if (next < 0) break
    const part = body.subarray(at + boundary.length + 4, next - 2)
    const split = part.indexOf('\r\n\r\n')
    parts.push({ headers: part.subarray(0, split).toString('latin1'), data: part.subarray(split + 4) })
    at = next
  }
  const field = parts.find((p) => p.headers.includes('name="contentType"'))!
  const file = parts.find((p) => p.headers.includes('name="file"'))!
  return { contentType: field.data.toString('utf8'), data: file.data }
}

async function openDialog(page: Page, limits: Partial<Limits>): Promise<{ uploads: Request[] }> {
  const uploads: Request[] = []
  await page.route('**/api/feedback/options', (route) => route.fulfill({ json: { attachments: { ...OPTIONS, ...limits } } }))
  await page.route('**/api/feedback/attachments', (route) => {
    uploads.push(route.request())
    const { contentType, data } = uploadedFile(route.request())
    return route.fulfill({ json: { attachmentId: '3b241101-e2bb-4255-8caf-4136c566a962', contentType, bytes: data.length } })
  })
  await page.goto('/settings/help')
  await settle(page)
  await page.getByRole('button', { name: 'Send feedback' }).click()
  await expect(page.getByRole('dialog', { name: 'Send feedback' }).getByRole('button', { name: 'Attach' })).toBeVisible()
  return { uploads }
}

const picker = (page: Page) => page.locator('input[data-feedback-picker]')

/** JPEG markers up to the scan: the APP1 (EXIF) count and the frame size. */
function jpegMarkers(data: Buffer): { app1: number; width: number; height: number } {
  expect(data.readUInt16BE(0)).toBe(0xffd8)
  let app1 = 0
  let width = 0
  let height = 0
  for (let at = 2; at < data.length && data[at] === 0xff;) {
    const marker = data[at + 1]!
    if (marker === 0xda) break
    if (marker === 0xe1) app1++
    if (marker >= 0xc0 && marker <= 0xc3) { height = data.readUInt16BE(at + 5); width = data.readUInt16BE(at + 7) }
    at += 2 + data.readUInt16BE(at + 2)
  }
  return { app1, width, height }
}

test('image re-encoding drops EXIF and caps the long edge at 2560 px', async ({ page }) => {
  const { uploads } = await openDialog(page, {})
  const canvasJpeg = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 4000
    canvas.height = 3000
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#3366cc'
    ctx.fillRect(0, 0, 4000, 3000)
    ctx.fillStyle = '#ffcc00'
    ctx.fillRect(500, 500, 2000, 1000)
    const blob = await new Promise<Blob>((resolve) => { canvas.toBlob((b) => { resolve(b!) }, 'image/jpeg', 0.9) })
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  }))
  // A synthetic EXIF block (big-endian TIFF, one empty IFD) carrying a marker string, inserted after SOI.
  const tiff = Buffer.concat([Buffer.from('MM\0*\0\0\0\x08', 'latin1'), Buffer.from([0, 0, 0, 0, 0, 0]), Buffer.from('TAL1596-SYNTHETIC-GPS', 'latin1')])
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([(exif.length + 2) >> 8, (exif.length + 2) & 0xff]), exif])
  const input = Buffer.concat([canvasJpeg.subarray(0, 2), app1, canvasJpeg.subarray(2)])
  expect(jpegMarkers(input)).toEqual({ app1: 1, width: 4000, height: 3000 })

  await picker(page).setInputFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: input })
  await expect.poll(() => uploads.length).toBe(1)
  const { contentType, data } = uploadedFile(uploads[0]!)
  expect(contentType).toBe('image/jpeg')
  expect(jpegMarkers(data)).toEqual({ app1: 0, width: 2560, height: 1920 })
  expect(data.includes('TAL1596-SYNTHETIC-GPS')).toBe(false)
  await expect(page.getByRole('button', { name: 'Enlarge photo.jpg' })).toBeVisible()
})

/** A WebM clip recorded in the page from an animated 1920×1080 canvas plus an oscillator, so it has video and audio. */
async function syntheticClip(page: Page, seconds: number): Promise<Buffer> {
  return Buffer.from(await page.evaluate(async (duration) => {
    const canvas = document.createElement('canvas')
    canvas.width = 1920
    canvas.height = 1080
    const ctx = canvas.getContext('2d')!
    const audio = new AudioContext()
    const tone = audio.createOscillator()
    const sink = audio.createMediaStreamDestination()
    tone.connect(sink)
    tone.start()
    const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...sink.stream.getAudioTracks()])
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus', videoBitsPerSecond: 12_000_000 })
    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => { chunks.push(e.data) }
    let frame = 0
    const draw = () => {
      frame++
      for (let i = 0; i < 60; i++) {
        ctx.fillStyle = `hsl(${String((frame * 7 + i * 37) % 360)} 80% ${String(30 + ((i * 13 + frame) % 40))}%)`
        ctx.fillRect((i * 211 + frame * 17) % 1920, (i * 97 + frame * 11) % 1080, 160 + (i % 7) * 40, 120 + (i % 5) * 30)
      }
    }
    const timer = setInterval(draw, 1000 / 30)
    const stopped = new Promise((resolve) => { recorder.onstop = resolve })
    recorder.start(250)
    await new Promise((resolve) => setTimeout(resolve, duration * 1000))
    recorder.stop()
    await stopped
    clearInterval(timer)
    tone.stop()
    await audio.close()
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()))
  }, seconds))
}

async function tracks(data: Buffer): Promise<{ audio: number; width: number }> {
  const input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS })
  try {
    const video = await input.getPrimaryVideoTrack()
    return { audio: (await input.getAudioTracks()).length, width: video ? await video.getDisplayWidth() : 0 }
  } finally {
    input.dispose()
  }
}

test('video is re-encoded smaller, without audio, at most 1280 px wide and within maxVideoBytes', async ({ page }) => {
  test.setTimeout(120_000)
  const maxVideoBytes = 1_500_000
  const { uploads } = await openDialog(page, { maxVideoBytes })
  const clip = await syntheticClip(page, 3)
  expect(await tracks(clip)).toEqual({ audio: 1, width: 1920 })
  expect(clip.length).toBeGreaterThan(maxVideoBytes)

  await picker(page).setInputFiles({ name: 'screen.webm', mimeType: 'video/webm', buffer: clip })
  await expect.poll(() => uploads.length, { timeout: 60_000 }).toBe(1)
  const { contentType, data } = uploadedFile(uploads[0]!)
  expect(['video/mp4', 'video/webm']).toContain(contentType)
  expect(data.length).toBeLessThan(clip.length)
  expect(data.length).toBeLessThanOrEqual(maxVideoBytes)
  const out = await tracks(data)
  expect(out.audio).toBe(0)
  expect(out.width).toBeLessThanOrEqual(1280)
  expect(out.width).toBeGreaterThan(0)
  await expect(page.getByRole('dialog').getByRole('listitem').filter({ hasText: /^screen\.(mp4|webm)/ })).toHaveAttribute('data-status', 'done')
})

test('a clip longer than maxVideoSeconds is refused before encoding', async ({ page }) => {
  const { uploads } = await openDialog(page, { maxVideoSeconds: 1 })
  const clip = await syntheticClip(page, 2)
  await picker(page).setInputFiles({ name: 'long.webm', mimeType: 'video/webm', buffer: clip })
  await expect(page.getByRole('alert')).toHaveText('long.webm is longer than 1s.')
  await expect(page.getByRole('dialog').getByRole('list', { name: 'Attachments' })).toHaveCount(0)
  expect(uploads).toHaveLength(0)
})

test.describe('without a video encoder', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => { Reflect.deleteProperty(globalThis, 'VideoEncoder') })
  })

  test('an over-limit original shows the inline error and nothing uploads', async ({ page }) => {
    const { uploads } = await openDialog(page, { maxVideoBytes: 100_000 })
    const clip = await syntheticClip(page, 1)
    expect(clip.length).toBeGreaterThan(100_000)
    await picker(page).setInputFiles({ name: 'big.webm', mimeType: 'video/webm', buffer: clip })
    await expect(page.getByRole('alert')).toHaveText('big.webm is larger than 0.1 MB')
    expect(uploads).toHaveLength(0)
  })

  test('an in-limit original uploads unchanged', async ({ page }) => {
    const { uploads } = await openDialog(page, {})
    const clip = await syntheticClip(page, 1)
    await picker(page).setInputFiles({ name: 'small.webm', mimeType: 'video/webm', buffer: clip })
    await expect.poll(() => uploads.length).toBe(1)
    const { contentType, data } = uploadedFile(uploads[0]!)
    expect(contentType).toBe('video/webm')
    expect(data.equals(clip)).toBe(true)
  })
})
