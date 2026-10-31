import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { expect, test } from './fixtures'
import { hydrateAnchorActivityScenes, withTurnIds } from '../../server/dist/sessions/anchor.js'
import { redactSessionData } from '../../server/dist/redact.js'

test.use({ serviceWorkers: 'block' })

test('Markdown renders diagrams and math after lazy loading', async ({ page }, testInfo) => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '../dist/client/.vite/manifest.json'), 'utf8')) as Record<string, { file: string }>
  const pluginFiles = Object.entries(manifest).filter(([key]) => /@streamdown\/(?:mermaid|math)\/dist\/index\.js|katex\/dist\/katex\.min\.css/.test(key)).map(([, chunk]) => chunk.file)
  expect(pluginFiles).toHaveLength(3)
  const requested: string[] = []
  let holdPlugins = false
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/assets/**', async (route) => {
    const file = new URL(route.request().url()).pathname.slice(1)
    if (pluginFiles.includes(file)) { requested.push(file); if (holdPlugins) await gate }
    await route.continue()
  })
  let content = 'Tickets cost $5 and meals cost $10.'
  await page.route('**/api/session?**', (route) => {
    const messages = [{ role: 'user', id: 1, content: 'Show a diagram and a formula' }, { role: 'assistant', id: 2, content }]
    return route.fulfill({ json: { session: {
      session_id: 'markdown-plugins', title: 'Diagram and formula', messages: redactSessionData({ messages: hydrateAnchorActivityScenes(withTurnIds(messages), {}) }, true).messages,
    } } })
  })
  await page.goto('/session/markdown-plugins')
  const answer = page.locator('[data-final-answer="1"]')
  await expect(answer).toContainText('Tickets cost $5 and meals cost $10.')
  await page.waitForLoadState('networkidle')
  expect(requested).toEqual([])
  holdPlugins = true
  content = '```mermaid\ngraph TD\n  A[Start] --> B[Finish]\n```\n\n$$\nx^2 + y^2 = z^2\n$$'
  try {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect.poll(() => requested.length).toBe(3)
    await expect(answer.locator('code').first()).toContainText('graph TD')
    await expect(answer.locator('.katex')).toHaveCount(0)
  } finally { release() }
  await expect(answer.locator('svg').filter({ hasText: 'Finish' })).toBeVisible()
  await expect(answer.locator('.katex')).toBeVisible()
  await expect(answer.locator('.katex')).toHaveCSS('font-family', /KaTeX_Main/)
  await page.screenshot({ path: testInfo.outputPath(`markdown-plugins-${testInfo.project.name}.png`), fullPage: true })
})

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

test('table and diagram fullscreen views are opaque and centre the table (TAL-1641)', async ({ page }, testInfo) => {
  const rows = Array.from({ length: 80 }, (_, i) => `| Row ${i + 1} | ${i + 1} |`).join('\n')
  const messages = [
    { role: 'user', id: 1, content: 'Show the tables' },
    { role: 'assistant', id: 2, content: `Small:\n\n| Fruit | Count |\n| --- | --- |\n| Apples | 3 |\n| Pears | 5 |\n\nLong:\n\n| Item | Value |\n| --- | --- |\n${rows}\n\n\`\`\`mermaid\ngraph TD\n  A[Start] --> B[Finish]\n\`\`\`` },
  ]
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: 'markdown-fullscreen', title: 'Show the tables', messages: redactSessionData({ messages: hydrateAnchorActivityScenes(withTurnIds(messages), {}) }, true).messages,
  } } }))
  await page.goto('/session/markdown-fullscreen')
  const answer = page.locator('[data-final-answer="1"]')
  const tables = answer.locator('[data-streamdown="table-wrapper"]')
  await expect(tables).toHaveCount(2)
  const overlay = page.locator('[data-streamdown="table-fullscreen"]')
  // The current theme's --bg, resolved to the same rgb() form as the overlay's computed background.
  const themeBg = () => page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement('div'))
    probe.style.background = 'var(--bg)'
    const color = getComputedStyle(probe).backgroundColor
    probe.remove()
    return color
  })
  const layout = () => overlay.evaluate((el) => {
    const table = el.querySelector('table')!
    const scroller = table.parentElement!
    // Centre against the scroller's content box: Streamdown pads it on three sides only.
    const [t, b, pad] = [table.getBoundingClientRect(), scroller.getBoundingClientRect(), getComputedStyle(scroller)]
    const s = { left: b.left + parseFloat(pad.paddingLeft), right: b.right - parseFloat(pad.paddingRight), top: b.top + parseFloat(pad.paddingTop), bottom: b.bottom - parseFloat(pad.paddingBottom) }
    return { dx: (t.left + t.right - s.left - s.right) / 2, dy: (t.top + t.bottom - s.top - s.bottom) / 2, top: t.top - s.top, width: t.width, scrollerWidth: s.right - s.left, overflow: scroller.scrollHeight - scroller.clientHeight }
  })

  await tables.nth(0).getByTitle('View fullscreen').click()
  await expect(overlay).toBeVisible()
  for (const [scheme, skin] of [['light', 'default'], ['dark', 'default'], ['dark', 'catppuccin']] as const) {
    await page.evaluate(([dark, name]) => { document.documentElement.classList.toggle('dark', dark); document.documentElement.dataset.skin = name }, [scheme === 'dark', skin] as const)
    await expect.soft(overlay, `${scheme} ${skin}`).toHaveCSS('background-color', await themeBg())
    await page.screenshot({ path: testInfo.outputPath(`table-fullscreen-${scheme}-${skin}-${testInfo.project.name}.png`) })
  }
  // An extension skin sets its tokens inline on <html>; the overlay follows them.
  await page.evaluate(() => { document.documentElement.style.setProperty('--bg', 'rgb(18, 52, 86)') })
  await expect(overlay).toHaveCSS('background-color', 'rgb(18, 52, 86)')
  await page.evaluate(() => { document.documentElement.style.removeProperty('--bg') })
  // A table smaller than the viewport sits in the middle of it, both ways.
  const small = await layout()
  expect(small.width).toBeLessThan(small.scrollerWidth)
  expect(Math.abs(small.dx)).toBeLessThan(2)
  expect(Math.abs(small.dy)).toBeLessThan(2)
  await page.keyboard.press('Escape')
  await expect(overlay).toHaveCount(0)

  // A taller table starts at the top of the scroller and scrolls to its last row.
  await tables.nth(1).getByTitle('View fullscreen').click()
  const long = await layout()
  expect(long.overflow).toBeGreaterThan(0)
  expect(long.top).toBeGreaterThanOrEqual(0)
  await overlay.getByText('Row 80', { exact: true }).scrollIntoViewIfNeeded()
  await expect(overlay.getByText('Row 80', { exact: true })).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath(`table-fullscreen-long-${testInfo.project.name}.png`) })
  await page.keyboard.press('Escape')
  await expect(overlay).toHaveCount(0)

  // The diagram's fullscreen view gets the same opaque background.
  const diagram = answer.locator('[data-streamdown="mermaid-block"]')
  // Streamdown renders the diagram once it scrolls into view.
  await diagram.scrollIntoViewIfNeeded()
  await expect(diagram.locator('svg').filter({ hasText: 'Finish' })).toBeVisible()
  await diagram.getByRole('button', { name: 'View fullscreen' }).click()
  const diagramOverlay = page.locator('[data-streamdown="mermaid-fullscreen"]')
  await expect(diagramOverlay.locator('svg').filter({ hasText: 'Finish' })).toBeVisible()
  await expect(diagramOverlay).toHaveCSS('background-color', await themeBg())
  // The diagram grows past its inline size and still fits inside the view.
  const box = (scope: typeof diagram) => scope.locator('svg').filter({ hasText: 'Finish' }).evaluate((svg) => svg.getBoundingClientRect().toJSON() as DOMRect)
  const [full, inline] = [await box(diagramOverlay), await box(diagram)]
  expect(full.width).toBeGreaterThan(inline.width)
  expect(full.top).toBeGreaterThanOrEqual(0)
  expect(full.bottom).toBeLessThanOrEqual(page.viewportSize()!.height)
  await page.screenshot({ path: testInfo.outputPath(`mermaid-fullscreen-${testInfo.project.name}.png`) })
  await page.keyboard.press('Escape')
  await expect(diagramOverlay).toHaveCount(0)
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
