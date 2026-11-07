import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, deflateSync, gzipSync } from 'node:zlib'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { hydrateAnchorActivityScenes, withTurnIds } from '../../server/dist/sessions/anchor.js'
import { redactSessionData } from '../../server/dist/redact.js'

test.use({ serviceWorkers: 'block', video: 'on' })
const DIAGRAM_SVG = '[role="img"] > svg'
const MATH_DIAGRAM = 'flowchart LR\n  A[Start] --> B["$$x^2$$"]'

async function mockMarkdown(page: Page, sessionId: string, content: () => string) {
  await page.route('**/api/session?**', (route) => {
    const messages = [{ role: 'user', id: 1, content: 'Show the diagrams' }, { role: 'assistant', id: 2, content: content() }]
    return route.fulfill({ json: { session: { session_id: sessionId, title: 'Diagrams', messages: redactSessionData({ messages: hydrateAnchorActivityScenes(withTurnIds(messages), {}) }, true).messages } } })
  })
}

test('diagram cost for 15 test-owned diagrams', async ({ page }, testInfo) => {
  const requested = new Set<string>()
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname.slice(1)
    if (path.startsWith('assets/')) requested.add(path)
  })
  let content = 'Diagram benchmark'
  await mockMarkdown(page, 'diagram-cost', () => content)
  await page.goto('/session/diagram-cost')
  await expect(page.locator('[data-final-answer="1"]')).toContainText(content)
  await page.waitForLoadState('networkidle')
  const initialFiles = new Set(requested)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const taskDuration = async () => (await cdp.send('Performance.getMetrics')).metrics.find(({ name }) => name === 'TaskDuration')!.value
  const before = await taskDuration()
  content = Array.from({ length: 15 }, (_, i) => `\`\`\`mermaid\n${i % 2 ? `sequenceDiagram\n  Alice->>Bob: Diagram ${i}` : `flowchart LR\n  A[Start ${i}] --> B[Finish ${i}]`}\n\`\`\``).join('\n\n')
  await page.reload()
  const diagrams = page.locator('[data-streamdown="mermaid-block"]')
  await expect(diagrams).toHaveCount(15)
  for (const diagram of await diagrams.all()) {
    await diagram.scrollIntoViewIfNeeded()
    await expect(diagram.locator(DIAGRAM_SVG)).toBeVisible()
  }
  const mainThreadMs = ((await taskDuration()) - before) * 1000
  const files = [...requested].filter((file) => !initialFiles.has(file)).sort()
  const gzipBytes = files.reduce((sum, file) => sum + gzipSync(readFileSync(join(import.meta.dirname, '../dist/client', file))).byteLength, 0)
  const costPath = testInfo.outputPath('diagram-cost.json')
  writeFileSync(costPath, JSON.stringify({ diagrams: 15, mainThreadMs, gzipBytes, files }, null, 2))
  await testInfo.attach('diagram-cost.json', { path: costPath, contentType: 'application/json' })
  expect(gzipBytes).toBeGreaterThan(0)
  // TAL-1852: at most half the 238,811-byte baseline measured at 314092ff0.
  expect(gzipBytes).toBeLessThanOrEqual(238_811 / 2)
  await diagrams.first().scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath(`diagram-cost-${testInfo.project.name}.png`) })
  for (const [pose, width, height] of [
    ['outer-portrait', 382, 580], ['outer-landscape', 594, 368], ['inner-split', 385, 571],
    ['inner-portrait', 669, 867], ['inner-landscape', 951, 585],
  ] as const) {
    await page.setViewportSize({ width, height })
    await diagrams.first().evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await expect(diagrams.first().locator(DIAGRAM_SVG)).toBeVisible()
    await expect(diagrams.first().getByRole('button', { name: 'Reset zoom and pan' })).toBeInViewport({ ratio: 1 })
    await diagrams.first().getByRole('button', { name: 'Reset zoom and pan' }).click({ trial: true })
    await page.screenshot({ path: testInfo.outputPath(`diagrams-${pose}.png`) })
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), pose).toBe(false)
  }
})

test('diagrams keep math, theme colors, safe SVG and readable invalid source', async ({ page }, testInfo) => {
  const content = [
    MATH_DIAGRAM,
    'sequenceDiagram\n  Alice->>Bob: Hello',
    'flowchart LR\n  X["<script>alert(1)</script>"] --> Y[Safe]\n  click Y "https://example.com/hostile"',
    'this is not a diagram',
    'flowchart LR\n  subgraph Group\n    C[Group start] --> D[Group finish]\n  end',
  ].map((source) => `\`\`\`mermaid\n${source}\n\`\`\``).join('\n\n')
  await mockMarkdown(page, 'diagram-contract', () => content)
  await page.goto('/session/diagram-contract')
  const diagrams = page.locator('[data-streamdown="mermaid-block"]')
  await expect(diagrams).toHaveCount(5)
  const flow = diagrams.nth(0)
  await flow.scrollIntoViewIfNeeded()
  await expect(flow.locator(DIAGRAM_SVG)).toBeVisible()
  await expect(flow.locator('math msup')).toHaveCount(1)
  for (const [dark, color] of [[false, 'rgb(30, 70, 110)'], [true, 'rgb(210, 230, 250)']] as const) {
    await page.evaluate(({ dark, color }) => {
      document.documentElement.classList.toggle('dark', dark)
      document.documentElement.style.setProperty('--text', color)
    }, { dark, color })
    await expect.poll(() => flow.locator(DIAGRAM_SVG).evaluate((svg) => {
      const label = [...svg.querySelectorAll('text, .nodeLabel')].find((el) => el.textContent === 'Start')!
      return label instanceof SVGElement ? getComputedStyle(label).fill : getComputedStyle(label).color
    })).toBe(color)
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await page.screenshot({ path: testInfo.outputPath(`diagram-${dark ? 'dark' : 'light'}-${testInfo.project.name}.png`), animations: 'disabled' })
  }
  const inlineSvg = flow.locator(DIAGRAM_SVG)
  const original = await inlineSvg.boundingBox()
  await flow.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await expect.poll(async () => (await inlineSvg.boundingBox())!.width).toBeGreaterThan(original!.width)
  await flow.getByRole('button', { name: 'Reset zoom and pan' }).click()
  await expect.poll(async () => Math.abs((await inlineSvg.boundingBox())!.width - original!.width)).toBeLessThan(1)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await flow.getByRole('button', { name: 'Copy Code', exact: true }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('A[Start] --> B["$$x^2$$"]')
  await flow.getByRole('button', { name: 'View fullscreen' }).click()
  await expect(page.locator('[data-streamdown="mermaid-fullscreen"] math msup')).toHaveCount(1)
  await page.keyboard.press('Escape')
  for (const index of [1, 2]) {
    await diagrams.nth(index).scrollIntoViewIfNeeded()
    await expect(diagrams.nth(index).locator(DIAGRAM_SVG)).toBeVisible()
  }
  const hostile = diagrams.nth(2).locator(DIAGRAM_SVG)
  await expect(hostile.locator('script, a[href], a[*|href], image')).toHaveCount(0)
  await expect(hostile).toContainText('Safe')
  await diagrams.nth(3).scrollIntoViewIfNeeded()
  await diagrams.nth(3).getByText('Show Code', { exact: true }).click()
  await expect(diagrams.nth(3).locator('pre')).toContainText('this is not a diagram')
  await page.evaluate(() => document.documentElement.style.setProperty('--hover-bg', 'rgb(12, 34, 56)'))
  await diagrams.nth(4).scrollIntoViewIfNeeded()
  await expect(diagrams.nth(4).locator('.pele-cluster > rect')).toHaveCSS('fill', 'rgb(12, 34, 56)')
})

test('diagram exports keep SVG, PNG and source usable', async ({ page }, testInfo) => {
  await mockMarkdown(page, 'diagram-exports', () => `\`\`\`mermaid\n${MATH_DIAGRAM}\n\`\`\``)
  await page.goto('/session/diagram-exports')
  const flow = page.locator('[data-streamdown="mermaid-block"]')
  await expect(flow.locator(DIAGRAM_SVG)).toBeVisible()
  for (const format of ['SVG', 'PNG', 'MMD']) {
    await flow.getByRole('button', { name: 'Download diagram', exact: true }).click()
    const formatButton = flow.getByRole('button', { name: `Download diagram as ${format}`, exact: true })
    expect((await formatButton.boundingBox())!.width).toBeGreaterThanOrEqual(100)
    if (format === 'SVG') await page.screenshot({ path: testInfo.outputPath(`diagram-download-menu-${testInfo.project.name}.png`) })
    const downloading = page.waitForEvent('download')
    await formatButton.click()
    const download = await downloading
    expect(download.suggestedFilename()).toMatch(new RegExp(`\\.${format.toLowerCase()}$`))
    await download.saveAs(testInfo.outputPath(`diagram.${format.toLowerCase()}`))
  }
})

test('Markdown renders diagrams and math after lazy loading', async ({ page }, testInfo) => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '../dist/client/.vite/manifest.json'), 'utf8')) as Record<string, { file: string }>
  const pluginFiles = Object.entries(manifest).filter(([key]) => /@streamdown\/math\/dist\/index\.js|src\/features\/chat\/render\/diagramPlugin\.ts|katex\/dist\/katex\.min\.css/.test(key)).map(([, chunk]) => chunk.file)
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
  await mockMarkdown(page, 'markdown-plugins', () => content)
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
