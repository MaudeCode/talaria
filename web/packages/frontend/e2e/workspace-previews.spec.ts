import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** Half a second of a 440 Hz tone as 8 kHz mono 8-bit PCM. */
function wav(): Buffer {
  const samples = Buffer.from(Array.from({ length: 4000 }, (_, i) => 128 + Math.round(100 * Math.sin((2 * Math.PI * 440 * i) / 8000))))
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples.length, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(8000, 24); header.writeUInt32LE(8000, 28); header.writeUInt16LE(1, 32); header.writeUInt16LE(8, 34)
  header.write('data', 36); header.writeUInt32LE(samples.length, 40)
  return Buffer.concat([header, samples])
}

/** TAL-566: the Files page renders each server-named preview kind from a synthetic workspace. */
test('the Files page previews images, PDF, audio, video, HTML, CSV, Markdown and binary files', async ({ page, errors }, testInfo) => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'tal566-')))
  const put = (name: string, data: string | Buffer) => writeFileSync(join(workspace, name), data)
  put('pixel.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'))
  put('logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="teal"/></svg>')
  put('doc.pdf', '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
  put('tone.wav', wav())
  put('page.html', '<h1>Hello from HTML</h1><p id="js"></p><script>document.getElementById("js").textContent = "script ran"</script>')
  put('table.csv', 'name,note\n"Ada","said ""hi"", twice"\nGrace,compilers\n')
  put('notes.md', '# Notes heading\n')
  put('blob.bin', Buffer.from([0x68, 0, 0xff]))
  expect((await page.request.post('/api/workspaces/add', { data: { path: workspace } })).ok()).toBe(true)
  const created = (await (await page.request.post('/api/session/new', { data: { workspace } })).json()) as { session: { session_id: string } }
  const sid = created.session.session_id

  await page.goto(`/session/${sid}`)
  // A real VP8 clip, recorded from a canvas so the workspace stays synthetic.
  const webm = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 48
    const ctx = canvas.getContext('2d')
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm;codecs=vp8' })
    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => chunks.push(e.data)
    const stopped = new Promise((resolve) => { recorder.onstop = resolve })
    recorder.start()
    for (let i = 0; i < 10; i++) {
      if (ctx) { ctx.fillStyle = i % 2 ? 'teal' : 'orange'; ctx.fillRect(0, 0, 64, 48) }
      await new Promise((r) => setTimeout(r, 40))
    }
    recorder.stop()
    await stopped
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()))
  })
  put('clip.webm', Buffer.from(webm))

  if (testInfo.project.name === 'mobile') await page.locator('#btnTitlebarSidePanel').click()
  else await page.getByRole('button', { name: 'Show workspace panel' }).click()
  await page.getByRole('tablist', { name: 'Side panel' }).getByRole('tab', { name: 'Files' }).click()
  // Until the session record loads the panel shows the default workspace, then remounts on the session's own.
  await expect(page.locator('[data-files-toolbar] span')).toHaveAttribute('title', workspace)
  const tree = page.getByRole('tree', { name: 'Files' })
  const shot = async (name: string) => { if (process.env.TAL566_SHOTS) await page.screenshot({ path: `${process.env.TAL566_SHOTS}/${name}-${testInfo.project.name}.png` }) }
  const open = async (name: string) => {
    await tree.getByRole('treeitem', { name, exact: true }).click()
    await expect(page.getByRole('button', { name: 'Back' })).toBeVisible()
  }
  const back = () => page.getByRole('button', { name: 'Back' }).click()

  for (const name of ['pixel.png', 'logo.svg']) {
    await open(name)
    const img = page.getByRole('img', { name })
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(0)
    await shot(name)
    await back()
  }

  await open('doc.pdf')
  const pdf = page.locator('iframe[title="doc.pdf"]')
  await expect(pdf).toBeVisible()
  // The PDF frame loads the frameable inline response; the viewer itself is the browser's.
  const pdfRes = await page.request.get(new URL((await pdf.getAttribute('src')) ?? '', page.url()).href)
  expect(pdfRes.status()).toBe(200)
  expect(pdfRes.headers()['content-type']).toBe('application/pdf')
  expect(pdfRes.headers()['x-frame-options']).toBeUndefined()
  if (process.env.TAL566_SHOTS) { await page.waitForTimeout(1500); await shot('pdf') }
  await back()

  await open('tone.wav')
  const audio = page.getByLabel('tone.wav')
  await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.duration)).toBeGreaterThan(0.4)
  await shot('audio')
  await back()

  await open('clip.webm')
  const video = page.getByLabel('clip.webm')
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.videoWidth)).toBe(64)
  await shot('video')
  await back()

  await open('page.html')
  const frame = page.frameLocator('iframe[title="page.html"]')
  await expect(frame.getByRole('heading', { name: 'Hello from HTML' })).toBeVisible()
  await expect(frame.getByText('script ran')).toBeVisible()
  await shot('html')
  // Edit swaps the preview for the source text.
  await page.getByRole('button', { name: 'Edit' }).click()
  await expect(page.getByRole('textbox', { name: 'Preview' })).toHaveValue(/Hello from HTML/)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await back()

  await open('table.csv')
  const table = page.getByRole('table')
  await expect(table.getByRole('columnheader')).toHaveText(['name', 'note'])
  await expect(table.getByRole('row')).toHaveCount(3)
  await expect(table.getByRole('cell', { name: 'said "hi", twice' })).toBeVisible()
  await shot('csv')
  await back()

  await open('notes.md')
  await expect(page.getByRole('heading', { name: 'Notes heading' })).toBeVisible()
  await back()

  await open('blob.bin')
  await expect(page.getByText('Binary file (3 B)')).toBeVisible()
  await back()

  await page.request.post('/api/workspaces/remove', { data: { path: workspace } })
  rmSync(workspace, { recursive: true, force: true })
  // `serviceWorkers: 'block'` injects a script that reads `navigator.serviceWorker`, which throws in the opaque-origin HTML frame.
  errors.splice(0, errors.length, ...errors.filter((e) => !/serviceWorker.*context is sandboxed/.test(e)))
})
