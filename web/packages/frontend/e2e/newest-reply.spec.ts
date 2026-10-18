import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const answer = (letter: string) => `## Report ${letter}\n\n${(`Paragraph ${letter} with a [reference](https://example.test/report).\n\n`).repeat(70)}\n\`\`\`ts\nconst answer = 42\n\`\`\`\n\n| Key | Value |\n| --- | --- |\n| State | Complete |`
const scene = (text: string, excerpt?: string) => ({ version: 'activity_scene_v1', activity_rows: [], final_answer: text, ...(excerpt ? { final_answer_excerpt: excerpt } : {}) })
const distance = (page: Page) => page.locator('#messages').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)

for (const follows of [false, true]) test(`newest reply transfers its excerpt at settlement and preserves ${follows ? 'bottom follow' : 'the reader'} (TAL-1114)`, async ({ page }, testInfo) => {
  const a = answer('A'), b = answer('B'), sid = 'excerpt-lifecycle'
  const excerptA = a.slice(0, a.lastIndexOf('\n\n', 3000)).trimEnd()
  let settled = false
  let finish: () => void = () => undefined
  const rows = () => [
    { role: 'user', id: 1, content: 'Question A', _turn_id: 'A' },
    { role: 'assistant', id: 2, content: a, _turn_id: 'A', _anchor_activity_scene: scene(a, settled ? excerptA : undefined), ...(settled ? { _display_truncated: true, _display_excerpt: excerptA } : {}) },
    { role: 'user', id: 3, content: 'Question B', _turn_id: 'B' },
    ...(settled ? [{ role: 'assistant', id: 4, content: b, _turn_id: 'B', _anchor_activity_scene: scene(b) }] : []),
  ]
  const session = () => ({ session_id: sid, title: 'Excerpt lifecycle', messages: rows(), active_stream_id: settled ? null : 'B' })
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: session() } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: !settled, stream_id: 'B', replay_available: true } }))
  const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  // A disposable HTTP stream gives the browser real token and terminal chunks under explicit test control.
  const streamServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'access-control-allow-origin': new URL(process.env.HERMES_E2E_BASE_URL!).origin, 'access-control-allow-credentials': 'true' })
    response.write(event('server_turn_started', { session_id: sid, stream_id: 'B', user_message_id: 3 }) + event('token', { text: b }))
    finish = () => { response.end(event('done', { session: session() }) + event('stream_end', {})) }
  })
  await new Promise<void>((resolve) => { streamServer.listen(0, '127.0.0.1', resolve) })
  const address = streamServer.address()
  if (!address || typeof address === 'string') throw new Error('Missing synthetic stream address')
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${address.port}/stream` }))
  try {
  await page.goto(`/session/${sid}`)
  const old = page.locator('[data-message-key="2"]'), prompt = page.locator('[data-message-key="3"]')
  await expect(old).toContainText('Report A')
  await expect(page.locator('#messages')).toContainText('Report B')
  await expect(old.locator('.msg-collapse-toggle')).toHaveCount(0)
  const height = await old.evaluate((el) => el.getBoundingClientRect().height)
  // A detail refresh/reconnect while B runs keeps the full A layout.
  await expect.poll(() => old.evaluate((el) => el.getBoundingClientRect().height)).toBe(height)
  if (follows) await expect.poll(() => distance(page)).toBeLessThan(3)
  else {
    await prompt.evaluate((el) => { const pane = document.querySelector('#messages')!; pane.scrollTop += el.getBoundingClientRect().top - pane.getBoundingClientRect().top - 100 })
    await expect.poll(() => distance(page)).toBeGreaterThan(200)
    await expect(page.locator('.scroll-to-bottom-btn')).toBeVisible()
  }
  const before = await prompt.evaluate((el) => el.getBoundingClientRect().top)
  mkdirSync('/tmp/tal1114-evidence', { recursive: true })
  await page.screenshot({ path: `/tmp/tal1114-evidence/before-${testInfo.project.name}-${follows ? 'follow' : 'reader'}.png` })
  settled = true; finish()
  await expect(old.locator('.msg-collapse-toggle')).toBeVisible()
  await expect(page.locator('[data-message-key="4"] .msg-collapse-toggle')).toHaveCount(0)
  if (follows) await expect.poll(() => distance(page)).toBeLessThan(3)
  else await expect.poll(async () => Math.abs(await prompt.evaluate((el) => el.getBoundingClientRect().top) - before)).toBeLessThan(3)
  await page.screenshot({ path: `/tmp/tal1114-evidence/after-${testInfo.project.name}-${follows ? 'follow' : 'reader'}.png` })
  await old.locator('.msg-collapse-toggle').click()
  await expect(old.locator('.msg-collapse-toggle')).toHaveText('Show less')
  await old.locator('.msg-collapse-toggle').click()
  await expect(old.locator('.msg-collapse-toggle')).toHaveText('Show full message')
  await page.reload()
  await expect(old.locator('.msg-collapse-toggle')).toHaveText('Show full message')
  await expect(page.locator('[data-message-key="4"]')).toContainText('Report B')
  await expect(page.locator('[data-message-key="4"] .msg-collapse-toggle')).toHaveCount(0)
  } finally {
    streamServer.closeAllConnections()
    await new Promise<void>((resolve, reject) => { streamServer.close((error) => { if (error) reject(error); else resolve() }) })
  }
})
