import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, settle, test } from './fixtures'
import { REPO_ROOT } from './server'

/** TAL-568: an extension's TTS engine stays registered with its panel closed, so Settings > Speech can pick it and replies use it. */
const voiceBox = {
  id: 'voicebox', name: 'Voice Box', source: 'manifest', enabled: true, panel: 'extensions/voicebox/index.html', nav: null,
  capabilities: ['tts'], settings_schema: [], theme: null, tts: { id: 'voicebox', label: 'Voice Box' }, sidecar: null, legacy_injection: false, can_toggle: true, warnings: [],
}
// The panel records what it synthesizes and answers with a one-sample WAV.
// The SDK is inlined: a sandboxed (opaque-origin) frame may not fetch from a loopback server.
const voiceBoxPanel = () => `<!doctype html><script>${readFileSync(join(REPO_ROOT, 'static', 'dist', 'extension-sdk.js'), 'utf8')}</script><script>
window.synthesized = []
Hermes.connect().then((hermes) => hermes.registerTts({ id: 'voicebox', label: 'Voice Box' }, async (text) => {
  window.synthesized.push(text)
  const b = new DataView(new ArrayBuffer(46)), s = (o, t) => [...t].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)))
  s(0, 'RIFF'); b.setUint32(4, 38, true); s(8, 'WAVEfmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true)
  b.setUint32(24, 8000, true); b.setUint32(28, 16000, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); s(36, 'data'); b.setUint32(40, 2, true)
  return b.buffer
}))
</script>`

test('an extension TTS engine is picked in Settings > Speech and reads replies with its panel closed', async ({ page }) => {
  await page.addInitScript(() => { HTMLMediaElement.prototype.play = () => Promise.resolve() })
  await page.route('**/api/extensions/manifests', (route) => route.fulfill({ json: { protocol_version: 1, manifests: [voiceBox] } }))
  await page.route('**/extensions/voicebox/index.html', (route) => route.fulfill({ contentType: 'text/html', body: voiceBoxPanel() }))
  const answer = 'The backup finished.'
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'voicebox-chat', title: 'Voice Box', messages: [
    { role: 'user', id: 1, content: 'Is the backup done?', _turn_id: 't1' }, { role: 'assistant', id: 2, content: answer, _turn_id: 't1' },
  ] } } }))
  expect((await page.request.post('/api/settings', { data: { tts_enabled: true } })).ok()).toBe(true)
  try {
    await page.goto('/settings/speech')
    await settle(page)
    await page.locator('#settingsTtsEngine').click()
    const option = page.getByRole('option', { name: 'Voice Box' })
    await expect(option).toBeVisible()
    await option.click()
    await expect(page.locator('#settingsTtsEngine')).toHaveText(/Voice Box/)
    expect(await page.evaluate(() => localStorage.getItem('hermes-tts-engine'))).toBe('voicebox')

    await page.goto('/session/voicebox-chat')
    await page.getByRole('button', { name: 'Read aloud' }).click()
    const panel = () => page.frames().find((f) => f.url().endsWith('/extensions/voicebox/index.html'))
    await expect.poll(async () => panel()?.evaluate(() => (window as unknown as { synthesized: string[] }).synthesized)).toEqual([answer])
  } finally {
    await page.request.post('/api/settings', { data: { tts_enabled: false } })
  }
})
