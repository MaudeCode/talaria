import { mkdir } from 'node:fs/promises'
import { test, expect } from './fixtures'

test.use({ serviceWorkers: 'block' })
const baseline = process.env.TALARIA_AUDIO_BASELINE === '1'

test('completion sound settings stay local and preview uses browser audio', async ({ page }, info) => {
  await page.addInitScript(() => {
    const attempts: string[] = []
    Object.assign(window, { audioAttempts: attempts })
    HTMLMediaElement.prototype.play = function () { attempts.push(this.src); return Promise.resolve() }
  })
  await page.goto('/settings/preferences')
  const sound = page.getByRole('switch', { name: 'Notification sound', exact: true })
  await sound.scrollIntoViewIfNeeded()
  if (!baseline) {
    if (await sound.getAttribute('aria-checked') !== 'true') await sound.click()
    const choice = page.getByRole('combobox', { name: 'Completion sound', exact: true })
    await choice.click()
    await page.getByRole('option', { name: 'Bell', exact: true }).click()
    await page.getByRole('button', { name: 'Preview sound', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as unknown as { audioAttempts: string[] }).audioAttempts.length)).toBe(1)
    await expect(choice).toContainText('Bell')
    await page.getByRole('switch', { name: 'Quiet period', exact: true }).click()
    await page.getByLabel('Quiet period starts').fill('22:00')
    await page.getByLabel('Quiet period ends').fill('07:00')
    // Exercise the real browser decoder with a generated WAV, without an audio output device.
    const wav = await page.evaluate(() => (window as unknown as { audioAttempts: string[] }).audioAttempts[0]!)
    await choice.click()
    await page.getByRole('option', { name: 'Local audio', exact: true }).click()
    await page.getByLabel('Local audio file', { exact: true }).setInputFiles({ name: 'local.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav.split(',')[1]!, 'base64') })
    await expect(page.getByRole('button', { name: 'Remove audio', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Preview sound', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as unknown as { audioAttempts: string[] }).audioAttempts.length)).toBe(2)
    await page.getByLabel('Local audio file', { exact: true }).setInputFiles({ name: 'corrupt.wav', mimeType: 'audio/wav', buffer: Buffer.from('invalid audio bytes') })
    await expect(page.getByRole('alert').filter({ hasText: 'Choose a supported audio file' })).toBeVisible()
    await page.getByRole('button', { name: 'Remove audio', exact: true }).click()
    await choice.click()
    await page.getByRole('option', { name: 'Bell', exact: true }).click()
  }
  await sound.evaluate((el) => el.scrollIntoView({ block: 'start' }))
  if (process.env.TALARIA_AUDIO_EVIDENCE) {
    await mkdir(process.env.TALARIA_AUDIO_EVIDENCE, { recursive: true })
    await page.screenshot({ path: `${process.env.TALARIA_AUDIO_EVIDENCE}/${baseline ? 'before' : 'after'}-${info.project.name}.png` })
  }
})

test('live completions play once across tabs, while history and replay stay quiet', async ({ context, page, request }) => {
  const settings = { ...await (await request.get('/api/settings')).json(), sound_enabled: true }
  await context.route('**/api/settings', (route) => route.fulfill({ json: settings }))
  await context.addInitScript(() => {
    const feeds: EventSource[] = []
    const attempts: string[] = []
    const Native = window.EventSource
    window.EventSource = class extends Native {
      constructor(url: string | URL, config?: EventSourceInit) { super(url, config); if (String(url).includes('/api/sessions/events')) feeds.push(this) }
    }
    Object.assign(window, { audioAttempts: attempts, emitAudioFrame: (event: string, data: unknown) => feeds.filter((feed) => feed.readyState !== 2).forEach((feed) => feed.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(data) }))) })
    HTMLMediaElement.prototype.play = function () { attempts.push(this.src); return Promise.resolve() }
  })
  const peer = await context.newPage()
  const emit = async (event: string, data: unknown) => {
    for (const tab of [page, peer]) await tab.evaluate(({ event, data }) => (window as unknown as { emitAudioFrame: (event: string, data: unknown) => void }).emitAudioFrame(event, data), { event, data })
  }
  const count = async () => (await Promise.all([page, peer].map((tab) => tab.evaluate(() => (window as unknown as { audioAttempts: string[] }).audioAttempts.length)))).reduce((a, b) => a + b, 0)
  await Promise.all([page.goto('/settings/preferences'), peer.goto('/settings/preferences')])
  for (const tab of [page, peer]) await expect(tab.getByRole('combobox', { name: 'Completion sound', exact: true })).toBeVisible()
  const completion = { identity: 'browser-run', scope: 'server-profile-a', profile: 'default', eligible: true, expires_at: Date.now() + 60_000 }
  await emit('initial', { web_audio: [completion] })
  await emit('sessions_changed', { reason: 'history', session_id: 'synthetic' })
  expect(await count()).toBe(0)
  await emit('sessions_changed', { web_audio: [completion] })
  await expect.poll(count).toBe(1)
  await emit('sessions_changed', { web_audio: [completion] })
  // Await a later unique claim to prove both replay callbacks have drained.
  await emit('sessions_changed', { web_audio: [{ ...completion, scope: 'server-profile-b' }] })
  await expect.poll(count).toBe(2)
  for (const tab of [page, peer]) {
    await tab.reload()
    await expect(tab.getByRole('combobox', { name: 'Completion sound', exact: true })).toBeVisible()
  }
  await emit('sessions_changed', { web_audio: [completion] })
  await emit('sessions_changed', { web_audio: [{ ...completion, identity: 'second-live-run' }] })
  await expect.poll(count).toBe(1)

  for (let start = 0; start < 1025; start += 32) {
    await emit('sessions_changed', { web_audio: Array.from({ length: Math.min(32, 1025 - start) }, (_, i) => ({ ...completion, expires_at: Date.now() + 60_000, identity: `retention-${start + i}` })) })
  }
  await expect.poll(count).toBe(1026)
  const retained = await page.evaluate(() => new Promise<number>((resolve, reject) => {
    const request = indexedDB.open('talaria-auto-read', 1)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
    request.onsuccess = () => {
      const db = request.result
      const count = db.transaction('claims').objectStore('claims').count()
      count.onsuccess = () => { db.close(); resolve(count.result) }
      count.onerror = () => { db.close(); reject(count.error ?? new Error('IndexedDB count failed')) }
    }
  }))
  expect(retained).toBe(1024)
  await peer.close()
})
