import { createServer, type ServerResponse } from 'node:http'
import type { Page } from '@playwright/test'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** TAL-568: Settings > Speech turns on read-aloud and auto-read; speech runs through a recording stand-in for speechSynthesis. */

async function recordSpeech(page: Page) {
  await page.addInitScript(() => {
    const spoken: string[] = []
    Object.assign(window, { spoken })
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      speak: (u: SpeechSynthesisUtterance) => { spoken.push(u.text) },
      cancel: () => undefined,
      getVoices: () => [],
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } })
  })
  return () => page.evaluate(() => (window as unknown as { spoken: string[] }).spoken)
}

test('enabling speech shows Read aloud, and auto-read speaks a new reply', async ({ page }, testInfo) => {
  const spoken = await recordSpeech(page)
  const sid = 'speech'
  const answer = 'All three services are healthy.'
  const question = { role: 'user', id: 1, content: 'Check the services', _turn_id: 'speech-run' }
  const reply = { role: 'assistant', id: 2, content: answer, _turn_id: 'speech-run' }
  let finished = false
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: sid, title: 'Speech', messages: finished ? [question, reply] : [question], active_stream_id: finished ? null : 'speech-run' } } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: 'speech-run', replay_available: true } }))
  let stream: ServerResponse | undefined
  let seq = 0
  const send = (event: string, data: Record<string, unknown>) => stream?.write(`id: speech-run:${++seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  const server = createServer((_request, response) => {
    stream = response
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    send('server_turn_started', { session_id: sid, stream_id: 'speech-run', user_message_id: 1 })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${address.port}/stream` }))
  try {
    await page.goto('/settings/speech')
    await settle(page)
    const readAloud = page.getByRole('switch', { name: 'Text-to-Speech for responses', exact: true })
    const autoRead = page.getByRole('switch', { name: 'Auto-read responses aloud', exact: true })
    await expect(readAloud).not.toBeChecked()
    await readAloud.click()
    await expect(readAloud).toBeChecked()
    await autoRead.click()
    await expect(autoRead).toBeChecked()
    await expect(page.getByLabel('Speech rate')).toHaveValue('1')
    await page.screenshot({ path: testInfo.outputPath('speech-settings.png'), fullPage: true })

    await page.goto(`/session/${sid}`)
    await expect(page.locator('.live-run-status')).toBeVisible()
    send('token', { text: answer })
    finished = true
    send('done', { session: { session_id: sid, title: 'Speech', messages: [question, reply] } })
    await expect(page.locator('.live-turn')).toHaveCount(0)
    await expect.poll(spoken).toEqual([answer])
    await page.getByRole('button', { name: 'Read aloud' }).click()
    await expect.poll(spoken).toEqual([answer, answer])
    await page.screenshot({ path: testInfo.outputPath('speech-read-aloud.png'), fullPage: true })
  } finally {
    server.close()
    await page.request.post('/api/settings', { data: { tts_enabled: false, tts_auto_read: false } })
  }
})
