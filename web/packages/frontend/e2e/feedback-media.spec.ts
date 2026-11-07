import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Page, Request } from '@playwright/test'
import type * as Mediabunny from 'mediabunny'
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny'
import { expect, settle, test } from './fixtures'

/** The script-tag build, which exposes a global `Mediabunny`; the package's exports do not name it, so it is found beside the Node bundle. */
const MEDIABUNNY_BROWSER_BUNDLE = join(dirname(createRequire(import.meta.url).resolve('mediabunny')), 'mediabunny.min.cjs')

/**
 * TAL-1596: Send feedback compresses in the real browser before it uploads. Synthetic media is generated in a browser page;
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

/**
 * A WebM clip encoded from a fixed count of seeded noise frames at 1920×1080 plus an Opus tone, so its size and validity
 * do not depend on machine speed. The noise is low-contrast: it fills 12 Mbps here but quantizes away at the re-encode's
 * bitrate, where full-contrast noise cannot fit maxVideoBytes. Built in its own context: some tests hide VideoEncoder from
 * the page under test, and the app's service worker would answer a navigation in that context. localhost keeps WebCodecs'
 * secure context.
 */
async function syntheticClip(page: Page, seconds: number): Promise<Buffer> {
  const context = await page.context().browser()!.newContext()
  try {
    const maker = await context.newPage()
    await maker.route('http://localhost/synthetic-clip', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }))
    await maker.goto('http://localhost/synthetic-clip')
    await maker.addScriptTag({ path: MEDIABUNNY_BROWSER_BUNDLE })
    return Buffer.from(await maker.evaluate(async (duration) => {
      const { AudioBufferSource, BufferTarget, CanvasSource, Output, Quality, WebMOutputFormat } = (globalThis as unknown as { Mediabunny: typeof Mediabunny }).Mediabunny
      const fps = 10
      const canvas = document.createElement('canvas')
      canvas.width = 1920
      canvas.height = 1080
      const ctx = canvas.getContext('2d')!
      const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() })
      const video = new CanvasSource(canvas, { codec: 'vp8', quality: new Quality({ bitrate: 12_000_000 }) })
      const audio = new AudioBufferSource({ codec: 'opus', quality: new Quality({ bitrate: 64_000 }) })
      output.addVideoTrack(video, { frameRate: fps })
      output.addAudioTrack(audio)
      await output.start()

      const addFrames = async () => {
        const image = ctx.createImageData(canvas.width, canvas.height)
        const pixels = new Uint32Array(image.data.buffer)
        let seed = 0x1934
        for (let frame = 0; frame < duration * fps; frame++) {
          for (let i = 0; i < pixels.length; i++) {
            seed ^= seed << 13
            seed ^= seed >>> 17
            seed ^= seed << 5
            pixels[i] = 0xff000000 | ((120 + (seed & 15)) * 0x010101)
          }
          ctx.putImageData(image, 0, 0)
          await video.add(frame / fps, 1 / fps)
        }
        video.close()
      }
      const addTone = async () => {
        const tone = new AudioBuffer({ length: duration * 48_000, sampleRate: 48_000 })
        tone.getChannelData(0).forEach((_, i, samples) => { samples[i] = Math.sin(i / 20) / 4 })
        await audio.add(tone)
        audio.close()
      }
      await Promise.all([addFrames(), addTone()])
      await output.finalize()
      return Array.from(new Uint8Array(output.target.buffer!))
    }, seconds))
  } finally {
    await context.close()
  }
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
  // The clip's size depends on how many frames the runner draws, so the budget comes from the recording.
  await page.route('**/blank', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }))
  await page.goto('/blank')
  const clip = await syntheticClip(page, 3)
  expect(await tracks(clip)).toEqual({ audio: 1, width: 1920 })
  const maxVideoBytes = Math.floor(clip.length / 2)
  expect(clip.length).toBeGreaterThan(maxVideoBytes)
  const { uploads } = await openDialog(page, { maxVideoBytes })

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
