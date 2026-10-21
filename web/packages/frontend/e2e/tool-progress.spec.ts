import { createServer, type ServerResponse } from 'node:http'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

test('MCP progress updates the running row, survives reload, and clears on completion', async ({ page }, testInfo) => {
  const sid = 'mcp-progress'
  const streamId = `${sid}-run`
  let stream = null as ServerResponse | null
  let progress: { percent: number | null; message: string | null } | null = null
  let seq = 0
  const send = (event: string, data: unknown) => { stream!.write(`${event === 'tool_progress' ? '' : `id: ${streamId}:${String(++seq)}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    stream = response
    send('tool', { id: 'index', name: 'mcp__index', kind: 'search', target: 'files', args: {}, progress: null })
    if (progress) send('tool_progress', { id: 'index', progress })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  const messages = [{ role: 'user', id: 1, content: 'Index the project files' }]
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: sid, title: 'Project index', messages, active_stream_id: streamId, is_streaming: true } } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: streamId, replay_available: true } }))
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${String(address.port)}${new URL(route.request().url()).search}` }))
  const shot = async (name: string) => { if (process.env.TAL1268_SHOTS) await page.screenshot({ path: `${process.env.TAL1268_SHOTS}/${name}-${testInfo.project.name}.png` }) }
  try {
    await page.goto(`/session/${sid}`)
    const row = page.locator('[data-tool-id="index"]')
    await expect(row).toBeVisible()
    await shot('before')
    progress = { percent: 42, message: 'indexing files' }
    send('tool_progress', { id: 'index', progress })
    await expect(row).toContainText('42% · indexing files')
    await shot('after')
    await page.reload()
    await expect(row).toContainText('42% · indexing files')
    await shot('reloaded')
    send('tool_complete', { id: 'index', name: 'mcp__index', progress: null, duration: 2 })
    await expect(row).toHaveAttribute('data-tool-done', '1')
    await expect(row.locator('.tool-card-progress')).toHaveCount(0)
    await shot('completed')
  } finally {
    stream?.end()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => { resolve() }))
  }
})
