import { createServer, type ServerResponse } from 'node:http'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const goal = { text: 'Ship the release notes', status: 'active', turns_used: 3, max_turns: 20, reason: null, parked_until: null }

/** TAL-808: the standing goal sits in the composer's status tab; the server's `session_goal` event replaces it live. */
test('shows the standing goal and follows the server\'s live goal', async ({ page }, testInfo) => {
  const sid = 'goal-chip'
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Release notes', active_stream_id: 'goal-run', is_streaming: true, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true,
    transcript_seq: null, messages: [{ role: 'user', id: 1, content: 'Ship the release notes', _turn_id: 'goal-run' }],
    goal,
  } } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: 'goal-run', replay_available: false } }))
  const streams: ServerResponse[] = []
  let seq = 0
  const send = (event: string, data: unknown) => { seq += 1; for (const r of streams) r.write(`id: goal-run:${String(seq)}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    response.write(`id: goal-run:${String(++seq)}\nevent: token\ndata: ${JSON.stringify({ text: 'Drafting the notes.' })}\n\n`)
    streams.push(response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${String(address.port)}${new URL(route.request().url()).search}` }))
  const shot = async (name: string) => { if (process.env.TAL808_SHOTS) await page.screenshot({ path: `${process.env.TAL808_SHOTS}/${name}-${testInfo.project.name}.png` }) }
  try {
    await page.goto(`/session/${sid}`)
    const tab = page.locator('#composerWrap')
    await expect(tab.getByText('3/20 turns')).toBeVisible()
    await expect(tab.getByText('Ship the release notes')).toBeVisible()
    await shot('active')
    await expect.poll(() => streams.length).toBeGreaterThan(0)
    const until = Math.floor(Date.now() / 1000) + 3600
    send('session_goal', { session_id: sid, goal: { ...goal, turns_used: 4, status: 'parked', reason: 'CI running', parked_until: until } })
    await expect(tab.getByText('Goal parked')).toBeVisible()
    await expect(tab.getByText(/^4\/20 · until /)).toBeVisible()
    await expect(tab.getByText('CI running', { exact: false })).toBeVisible()
    await shot('parked')
    send('session_goal', { session_id: sid, goal: { ...goal, turns_used: 4, status: 'paused', reason: 'turn budget exhausted' } })
    await expect(tab.getByText('Goal paused')).toBeVisible()
    await expect(tab.getByText('turn budget exhausted', { exact: false })).toBeVisible()
    await expect(tab.getByText('4/20 turns')).toBeVisible()
    await shot('paused')
    send('session_goal', { session_id: sid, goal: null })
    await expect(tab.getByText('4/20 turns')).toHaveCount(0)
    await shot('cleared')
  } finally {
    for (const response of streams) response.end()
    await new Promise<void>((resolve) => server.close(() => { resolve() }))
  }
})
