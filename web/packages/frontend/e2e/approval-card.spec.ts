import { createServer, type ServerResponse } from 'node:http'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** A dismissed approval card no longer answers Enter, and the next approval in the turn shows again (TAL-503). */
test('dismissing an approval stops Enter from approving it; the next approval in the turn is visible', async ({ page }) => {
  const sid = 'approval-dismiss'
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Clean the build', active_stream_id: 'approval-run', is_streaming: true, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true,
    transcript_seq: null, messages: [{ role: 'user', id: 1, content: 'Clean the build', _turn_id: 'approval-run' }],
  } } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: 'approval-run', replay_available: false } }))
  const responses: unknown[] = []
  await page.route('**/api/approval/respond', async (route) => {
    responses.push(route.request().postDataJSON())
    await route.fulfill({ json: { ok: true } })
  })
  const streams: ServerResponse[] = []
  let seq = 0
  const send = (event: string, data: unknown) => { seq += 1; for (const r of streams) r.write(`id: approval-run:${String(seq)}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    response.write(`id: approval-run:${String(++seq)}\nevent: token\ndata: ${JSON.stringify({ text: 'Cleaning up.' })}\n\n`)
    streams.push(response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${String(address.port)}${new URL(route.request().url()).search}` }))
  try {
    await page.goto(`/session/${sid}`)
    await expect.poll(() => streams.length).toBeGreaterThan(0)
    const card = page.getByRole('alertdialog')
    send('approval', { approval_id: 'a1', command: 'rm -rf build' })
    await expect(card).toContainText('rm -rf build')
    await card.getByRole('button', { name: 'Dismiss approval' }).click()
    await expect(card).toHaveCount(0)
    await page.locator('body').press('Enter')
    send('approval', { approval_id: 'a2', command: 'rm -rf dist' })
    await expect(card).toContainText('rm -rf dist')
    expect(responses).toEqual([])
  } finally {
    for (const response of streams) response.end()
    await new Promise<void>((resolve) => server.close(() => { resolve() }))
  }
})
