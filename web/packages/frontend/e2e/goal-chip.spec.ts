import { createServer, type ServerResponse } from 'node:http'
import { SessionGoalSchema, type SessionGoal } from '@maudecode/talaria-web-contracts'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const goal: SessionGoal = { text: 'Ship the release notes', status: 'active', turns_used: 3, max_turns: 20, reason: null, parked_until: null }

/** TAL-808: the standing goal sits in the composer's status tab; the server's `session_goal` event replaces it live. */
test('shows the standing goal and follows the server\'s live goal', async ({ page }, testInfo) => {
  const sid = 'goal-chip'
  let currentGoal: SessionGoal | null = goal
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Release notes', active_stream_id: 'goal-run', is_streaming: true, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true,
    transcript_seq: null, messages: [{ role: 'user', id: 1, content: 'Ship the release notes', _turn_id: 'goal-run' }],
    goal: currentGoal,
  } } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: 'goal-run', replay_available: false } }))
  const streams: ServerResponse[] = []
  const sessionLists: ServerResponse[] = []
  let seq = 0
  const send = (event: string, data: { session_id: string; goal: SessionGoal | null }) => {
    currentGoal = data.goal
    seq += 1
    for (const r of streams) r.write(`id: goal-run:${String(seq)}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    if (new URL(request.url ?? '/', 'http://fixture.invalid').searchParams.has('gateway')) {
      sessionLists.push(response)
      return
    }
    response.write(`id: goal-run:${String(++seq)}\nevent: token\ndata: ${JSON.stringify({ text: 'Drafting the notes.' })}\n\n`)
    streams.push(response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  await page.route(/\/api\/(?:chat\/stream|sessions\/events)\?/, (route) => route.continue({ url: `http://127.0.0.1:${String(address.port)}${new URL(route.request().url()).search}` }))
  const shot = async (name: string) => { if (process.env.TAL808_SHOTS) await page.screenshot({ path: `${process.env.TAL808_SHOTS}/${name}-${testInfo.project.name}.png` }) }
  try {
    await page.goto(`/session/${sid}`)
    const tab = page.locator('#composerWrap')
    await expect(tab.getByText('3/20 turns')).toBeVisible()
    await expect(tab.getByText('Ship the release notes')).toBeVisible()
    await shot('active')
    await expect.poll(() => streams.length).toBeGreaterThan(0)
    await expect.poll(() => sessionLists.length).toBeGreaterThan(0)
    const until = Math.floor(Date.now() / 1000) + 3600
    send('session_goal', { session_id: sid, goal: { ...goal, turns_used: 4, status: 'parked', reason: 'CI running', parked_until: until } })
    await expect(tab.getByText('Goal parked')).toBeVisible()
    // A late session-feed snapshot refetches the persisted session after the live update.
    const refresh = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/session')
    for (const response of sessionLists) response.write('event: initial\ndata: {"stream":"sessions"}\n\nevent: sessions_changed\ndata: {"type":"sessions_changed","sessions":[],"stream":"gateway"}\n\n')
    const refreshed = await refresh
    await refreshed.finished()
    await expect(tab.getByText('Goal parked')).toBeVisible()
    const snapshot = await refreshed.json() as { session: { goal: unknown } }
    expect(SessionGoalSchema.parse(snapshot.session.goal).status).toBe('parked')
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
    for (const response of [...streams, ...sessionLists]) response.end()
    await new Promise<void>((resolve) => server.close(() => { resolve() }))
  }
})
