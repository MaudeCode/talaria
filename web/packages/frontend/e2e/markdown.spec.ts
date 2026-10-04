import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { expect, test } from './fixtures'
import { hydrateAnchorActivityScenes, withTurnIds } from '../../server/dist/sessions/anchor.js'
import { redactSessionData } from '../../server/dist/redact.js'

test.use({ serviceWorkers: 'block' })

test('Markdown lists keep their numbers and bullets', async ({ page }, testInfo) => {
  const messages = [
    { role: 'user', id: 1, content: 'List the steps' },
    { role: 'assistant', id: 2, content: 'Steps:\n\n1. First step\n2. Second step\n\nNotes:\n\n- One note' },
  ]
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: 'markdown-lists', title: 'List the steps', messages: redactSessionData({ messages: hydrateAnchorActivityScenes(withTurnIds(messages), {}) }, true).messages,
  } } }))
  await page.goto('/session/markdown-lists')
  const ol = page.locator('.msg-body ol').first()
  await expect(ol.getByText('Second step')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('markdown-lists.png'), fullPage: true })
  await expect(ol).toHaveCSS('list-style-type', 'decimal')
  await expect(page.locator('.msg-body ul').first()).toHaveCSS('list-style-type', 'disc')
})

/** A visible synthetic chart: a 240×140 RGB PNG with a diagonal gradient. */
function chartPng(): Buffer {
  const [width, height] = [240, 140]
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rows.set([40 + Math.round((x * 200) / width), 90 + Math.round((y * 150) / height), 200], y * (width * 3 + 1) + 1 + x * 3)
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), 8 + data.length)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

test('server media references render inline, inside the Markdown around them (TAL-186)', async ({ page }, testInfo) => {
  const fixture = (JSON.parse(readFileSync(join(import.meta.dirname, '../../../../contracts/fixtures/web-session.json'), 'utf8')) as { media_session: { session_id: string; messages: unknown[] } }).media_session
  const requested: string[] = []
  await page.route('**/api/media?**', (route) => {
    const url = new URL(route.request().url())
    requested.push(url.pathname + url.search)
    return url.searchParams.get('path')?.endsWith('.png') ? route.fulfill({ body: chartPng(), contentType: 'image/png' }) : route.fulfill({ body: Buffer.alloc(0), contentType: 'audio/mpeg' })
  })
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: fixture.session_id, title: 'Plot the run', messages: fixture.messages } } }))
  await page.goto(`/session/${fixture.session_id}`)
  const answer = page.locator('[data-final-answer="1"]')
  // The image inside bold text keeps the bold run around it, and the list keeps all three items.
  await expect(answer.locator('[data-streamdown="strong"]').getByRole('img', { name: 'Chart' })).toBeVisible()
  await expect(answer.locator('[data-streamdown="list-item"]')).toHaveCount(3)
  await expect(answer.getByRole('img', { name: 'chart.png' })).toBeVisible()
  await expect(answer).not.toContainText('**')
  await expect(answer.locator('pre, code').first()).toContainText('MEDIA:/talaria-contract/out/secret.png')
  await expect(answer.getByLabel('narration.mp3')).toBeAttached()
  expect(requested).toContain(`/api/media?path=%2Ftalaria-contract%2Fout%2Fchart.png&session_id=${fixture.session_id}`)
  await answer.screenshot({ path: testInfo.outputPath(`media-inline-${testInfo.project.name}.png`) })
})
