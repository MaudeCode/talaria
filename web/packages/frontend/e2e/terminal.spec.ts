import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block', video: 'on' })

test('terminal assets load only on opening and its loading chrome can close', async ({ page }, testInfo) => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '../dist/client/.vite/manifest.json'), 'utf8')) as Record<string, { file: string; css?: string[] }>
  const chunk = manifest['src/features/terminal/TerminalPanel.tsx']!
  expect(chunk).toBeDefined()
  expect(chunk.css?.length).toBeGreaterThan(0)
  const assets = [chunk.file, ...chunk.css!]
  const requested: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let starts = 0
  await page.route('**/assets/**', async (route) => {
    const file = new URL(route.request().url()).pathname.slice(1)
    if (assets.includes(file)) { requested.push(file); await gate }
    await route.continue()
  })
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'terminal-lazy', title: 'Terminal', workspace: '/tmp/term', messages: [] } } }))
  await page.route('**/api/terminal/start', (route) => { starts++; return route.fulfill({ json: { ok: true, running: true } }) })
  await page.route('**/api/terminal/output?**', (route) => route.fulfill({ headers: { 'content-type': 'text/event-stream' }, body: 'retry: 60000\n\n' }))
  const panel = page.locator('#composerTerminalPanel')
  const toggle = async () => { await page.locator('#msg').fill('/terminal'); await page.locator('#btnSend').click() }
  try {
    await page.goto('/session/terminal-lazy')
    await page.waitForLoadState('networkidle')
    expect(requested).toEqual([])
    await toggle()
    await expect(panel).toHaveAttribute('data-status', 'loading')
    await expect(panel.locator('#terminalWorkspaceLabel')).toHaveText('/tmp/term')
    await expect(panel.locator('.xterm')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('terminal-loading.png') })
    await panel.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(panel).toHaveCount(0)
    expect(starts).toBe(0)
  } finally { release() }
  await page.waitForLoadState('networkidle')
  expect(starts).toBe(0)
  await toggle()
  await expect(panel).toHaveAttribute('data-status', 'running')
  await expect(panel.locator('.xterm-screen')).toHaveCSS('position', 'relative')
  expect(new Set(requested)).toEqual(new Set(assets))
  expect(starts).toBe(1)
})

test('terminal opens, accepts input, resizes, and closes', async ({ page }, testInfo) => {
  const sid = 'terminal-interaction'
  const inputs: string[] = []
  const sizes: { cols: number; rows: number }[] = []
  let closes = 0
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: sid, title: 'Terminal', model: 'm1', workspace: '/tmp/term', messages: [] } } }))
  await page.route('**/api/terminal/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/output')) {
      await route.fulfill({ headers: { 'content-type': 'text/event-stream' }, body: 'retry: 60000\n\nevent: output\ndata: {"text":"Ready\\r\\n$ "}\n\n' })
      return
    }
    if (path.endsWith('/input')) inputs.push((route.request().postDataJSON() as { data: string }).data)
    if (path.endsWith('/resize')) sizes.push(route.request().postDataJSON() as { cols: number; rows: number })
    if (path.endsWith('/close')) closes++
    await route.fulfill({ json: { ok: true, running: true } })
  })
  await page.goto(`/session/${sid}`)
  await page.locator('#msg').fill('/terminal')
  await page.locator('#btnSend').click()
  const panel = page.locator('#composerTerminalPanel')
  await expect(panel).toHaveAttribute('data-status', 'running')
  await panel.locator('.xterm-helper-textarea').focus()
  await page.keyboard.type('echo hello')
  await page.keyboard.press('Enter')
  await expect.poll(() => inputs.join('')).toBe('echo hello\r')
  await page.screenshot({ path: testInfo.outputPath('terminal-open.png') })
  const handle = await panel.getByRole('separator', { name: 'Resize terminal' }).boundingBox()
  const surface = panel.getByRole('application', { name: 'Workspace terminal' })
  const initial = await surface.boundingBox()
  expect(handle).not.toBeNull()
  expect(initial).not.toBeNull()
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2 + 60, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => (await surface.boundingBox())!.height).toBeLessThan(initial!.height)
  await expect.poll(() => sizes.length).toBeGreaterThan(0)
  expect(sizes.at(-1)!.cols).toBeGreaterThan(0)
  expect(sizes.at(-1)!.rows).toBeGreaterThan(0)
  await page.screenshot({ path: testInfo.outputPath('terminal-resized.png') })
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(panel).toHaveCount(0)
  await expect.poll(() => closes).toBe(1)
  await page.screenshot({ path: testInfo.outputPath('terminal-closed.png') })
})

/** TAL-555: closing the terminal while its start request is pending must not open an output stream afterwards. */

test('closing the terminal during start opens no output stream', async ({ page }) => {
  const sid = 'term-close'
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  let starts = 0
  const outputs: string[] = []
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: sid, title: 'Terminal', model: 'm1', workspace: '/tmp/term', messages: [] } } }))
  await page.route('**/api/terminal/**', async (route) => {
    const url = route.request().url()
    if (url.includes('/api/terminal/output')) {
      outputs.push(url)
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'event: terminal_closed\ndata: {}\n\n' })
    } else if (url.endsWith('/api/terminal/start')) {
      if (++starts === 1) await firstGate
      await route.fulfill({ json: { ok: true, running: true } })
    } else {
      await route.fulfill({ json: { ok: true } })
    }
  })
  await page.goto(`/session/${sid}`)
  // The /terminal command toggles the panel on every viewport; the inline button is desktop-only.
  const toggleTerminal = async () => { await page.locator('#msg').fill('/terminal'); await page.locator('#btnSend').click() }
  await toggleTerminal()
  await expect(page.locator('#composerTerminalPanel')).toHaveAttribute('data-status', 'starting')
  await toggleTerminal()
  await expect(page.locator('#composerTerminalPanel')).toHaveCount(0)
  const firstDone = page.waitForResponse((res) => res.url().endsWith('/api/terminal/start'))
  releaseFirst()
  await firstDone
  // Reopening proves the stream path still works; only the reopened panel may open a stream.
  await toggleTerminal()
  await expect.poll(() => outputs.length).toBe(1)
  await expect(page.locator('#composerTerminalPanel')).toHaveAttribute('data-status', 'closed')
  expect(outputs).toHaveLength(1)
})
