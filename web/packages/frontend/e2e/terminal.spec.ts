import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

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
