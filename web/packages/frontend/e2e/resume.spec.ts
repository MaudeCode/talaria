import { createServer, type ServerResponse } from 'node:http'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** A reload mid-run resumes from the server's transcript cursor and renders each segment of the running turn once (TAL-316). */
test('reloading a running session renders its turn once from the transcript cursor', async ({ page }) => {
  const sid = 'resume-fixture'
  // The server leaves the running turn's output to the journal replay: the transcript ends at the turn's prompt.
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Read the file', active_stream_id: 'resume-run', transcript_seq: { stream_id: 'resume-run', seq: 0 },
    messages: [{ role: 'user', id: 1, content: 'Read the file', _turn_id: 'resume-run' }],
  } } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: 'resume-run', replay_available: true } }))
  const journal: [string, Record<string, unknown>][] = [
    ['token', { text: 'Reading the file.' }],
    ['tool', { id: 't1', name: 'read_file', args: { path: 'a.txt' } }],
    ['tool_complete', { id: 't1', name: 'read_file', result_view: { text: 'A' } }],
    ['token', { text: 'Checked once.' }],
  ]
  const requests: string[] = []
  const open: ServerResponse[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? '')
    open.push(response)
    const afterSeq = Number(new URL(request.url ?? '', 'http://x').searchParams.get('after_seq') ?? journal.length)
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    response.write(journal.map(([event, data], i) => (i + 1 > afterSeq ? `id: resume-run:${i + 1}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n` : '')).join(''))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${address.port}${new URL(route.request().url()).search}` }))
  const once = async (): Promise<void> => {
    const turn = page.locator('.live-turn')
    await expect(turn).toContainText('Checked once.')
    const text = await turn.innerText()
    expect(text.split('Reading the file.').length - 1).toBe(1)
    expect(text.split('Checked once.').length - 1).toBe(1)
    await expect(page.locator('[data-tool-id="t1"]')).toHaveCount(1)
  }
  try {
    await page.goto(`/session/${sid}`)
    await once()
    await page.reload()
    await once()
    expect(requests.map((url) => new URL(url, 'http://x').searchParams.get('after_seq'))).toEqual(['0', '0'])
  } finally {
    for (const response of open) response.end()
    await new Promise<void>((resolve) => server.close(() => { resolve() }))
  }
})

/** A run whose journal cannot replay it keeps its persisted rows: the live turn attached without replay does not hide them. */
test('a running session without a transcript cursor keeps its persisted output visible', async ({ page }) => {
  const sid = 'resume-degraded'
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Read the file', active_stream_id: 'degraded-run', transcript_seq: null,
    messages: [
      { role: 'user', id: 1, content: 'Read the file', _turn_id: 'degraded-run' },
      { role: 'assistant', id: 2, content: 'Persisted before the journal failed.', _turn_id: 'degraded-run' },
    ],
  } } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: 'degraded-run', replay_available: false } }))
  const requests: string[] = []
  const open: ServerResponse[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? '')
    open.push(response)
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    response.write(': connected\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${address.port}${new URL(route.request().url()).search}` }))
  try {
    await page.goto(`/session/${sid}`)
    await expect.poll(() => requests.length).toBeGreaterThan(0)
    expect(new URL(requests[0]!, 'http://x').searchParams.get('after_seq')).toBeNull()
    await expect(page.getByText('Persisted before the journal failed.')).toBeVisible()
  } finally {
    for (const response of open) response.end()
    await new Promise<void>((resolve) => server.close(() => { resolve() }))
  }
})

/** The server's detail carries a running turn's deferred prompt as its user row, so reopening keeps it before the activity (TAL-368). */
test('reopening a running session keeps its pending prompt before the activity, once', async ({ page }) => {
  const sid = 'pending-prompt-fixture'
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Pending prompt', active_stream_id: 'pending-run', transcript_seq: { stream_id: 'pending-run', seq: 0 },
    pending_user_message: 'Unique pending follow-up', pending_started_at: 1000, message_count: 3,
    messages: [
      { role: 'user', content: 'Earlier question', timestamp: 900, _turn_id: 'earlier-run' },
      { role: 'assistant', content: 'Earlier answer', timestamp: 901, _turn_id: 'earlier-run' },
      { role: 'user', content: 'Unique pending follow-up', timestamp: 1000, _turn_id: 'pending-run', _active_turn_user: true },
    ],
  } } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: 'pending-run', replay_available: true } }))
  const open: ServerResponse[] = []
  const server = createServer((_request, response) => {
    open.push(response)
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    response.write(`id: pending-run:1\nevent: token\ndata: ${JSON.stringify({ text: 'Agent is still working.' })}\n\n`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${address.port}${new URL(route.request().url()).search}` }))
  const promptOnceBeforeActivity = async (): Promise<void> => {
    await expect(page.locator('.live-turn')).toContainText('Agent is still working.')
    await expect(page.getByText('Unique pending follow-up')).toBeVisible()
    await expect(page.locator('[data-role="user"]', { hasText: 'Unique pending follow-up' })).toHaveCount(1)
    const [prompt, activity] = await Promise.all([page.getByText('Unique pending follow-up').boundingBox(), page.locator('.live-turn').boundingBox()])
    expect(prompt!.y).toBeLessThan(activity!.y)
  }
  try {
    await page.goto(`/session/${sid}`)
    await promptOnceBeforeActivity()
    await page.reload()
    await promptOnceBeforeActivity()
  } finally {
    for (const response of open) response.end()
    await new Promise<void>((resolve) => server.close(() => { resolve() }))
  }
})

/** Real hook/router/HTTP SSE regression for passive navigation, including first paint before both delayed replies. */
test('navigation keeps a live scene and requests only its unseen suffix (TAL-1050)', async ({ page }, testInfo) => {
  const sid = 'navigation-fixture-a'
  const run = 'navigation-run-a'
  let detailReads = 0
  let statusReads = 0
  let releaseDetail!: () => void
  let releaseStatus!: () => void
  const detailGate = new Promise<void>((resolve) => { releaseDetail = resolve })
  const statusGate = new Promise<void>((resolve) => { releaseStatus = resolve })
  await page.route('**/api/session?**', async (route) => {
    const id = new URL(route.request().url()).searchParams.get('session_id')!
    if (id === sid && ++detailReads > 1) await detailGate
    await route.fulfill({ json: { session: {
      session_id: id, title: id === sid ? 'Navigation proof' : 'Other chat',
      ...(id === sid ? { active_stream_id: run, transcript_seq: { stream_id: run, seq: 0 } } : {}),
      messages: [{ role: 'user', id: 1, content: id === sid ? 'Read the file' : 'Other question', _turn_id: id === sid ? run : 'other' }],
    } } })
  })
  await page.route('**/api/chat/stream/status?**', async (route) => {
    if (++statusReads > 1) await statusGate
    await route.fulfill({ json: { active: true, stream_id: run, replay_available: true } })
  })
  const journal: [string, Record<string, unknown>][] = [
    ['token', { text: 'Reading the file.' }],
    ['reasoning', { text: 'Checking the contents.' }],
    ['tool', { id: 'navigation-tool', name: 'read_file', kind: 'read', target: 'fixture.txt' }],
    ['tool_complete', { id: 'navigation-tool', name: 'read_file', result_view: { text: 'Fixture contents' } }],
  ]
  const requests: URL[] = []
  const connections: ServerResponse[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture')
    requests.push(url)
    connections.push(response)
    const seq = Number(url.searchParams.get('after_seq') ?? journal.length)
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    // Include the cursor boundary to prove identity-based overlap handling as well as suffix resume.
    response.write(': connected\n\n' + journal.map(([event, data], index) => index + 1 >= Math.max(1, seq) ? `id: ${run}:${index + 1}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n` : '').join(''))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${address.port}${new URL(route.request().url()).search}` }))
  const enter = async (id: string) => {
    await page.evaluate((path) => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')) }, `/session/${id}`)
    await expect(page).toHaveURL(new RegExp(`/session/${id}$`))
  }
  try {
    await page.goto(`/session/${sid}`)
    await expect(page.locator('.live-turn')).toContainText('Reading the file.')
    await expect(page.locator('[data-tool-id="navigation-tool"]')).toHaveCount(1)
    await enter('navigation-fixture-b')
    await expect(page.getByText('Other question')).toBeVisible()
    await expect(page.getByText('Reading the file.')).toHaveCount(0)
    journal.push(['token', { text: ' Unseen suffix.' }])
    // Detail is stale on return, so the first paint must survive its outstanding refresh too.
    await page.waitForTimeout(5100)
    await enter(sid)
    await expect.poll(() => detailReads).toBeGreaterThan(1)
    await expect.poll(() => statusReads).toBe(2)
    await page.screenshot({ path: testInfo.outputPath('return-held.png') })
    await expect(page.locator('.live-turn')).toContainText('Reading the file.')
    expect(requests).toHaveLength(1)
    // Navigate again with status still pending. Its late reply must not reconnect a hidden chat.
    await enter('navigation-fixture-b')
    await expect(page.getByText('Other question')).toBeVisible()
    releaseStatus()
    releaseDetail()
    await page.waitForTimeout(150)
    expect(requests).toHaveLength(1)
    await enter(sid)
    await expect(page.locator('.live-turn')).toContainText('Unseen suffix.')
    expect(requests).toHaveLength(2)
    expect(requests[1]!.searchParams.get('after_seq')).toBe('4')
    expect(requests[1]!.searchParams.get('after_event_id')).toBe(`${run}:4`)
    await expect(page.locator('[data-tool-id="navigation-tool"]')).toHaveCount(1)
    expect((await page.locator('.live-turn').innerText()).split('Reading the file.')).toHaveLength(2)
    await page.screenshot({ path: testInfo.outputPath('resumed.png') })
    await enter('navigation-fixture-b')
    await expect(page.getByText('Other question')).toBeVisible()
    await enter(sid)
    await expect.poll(() => requests.length).toBe(3)
    expect(requests[2]!.searchParams.get('after_seq')).toBe('5')
    expect((await page.locator('.live-turn').innerText()).split('Unseen suffix.')).toHaveLength(2)
  } finally {
    releaseDetail()
    releaseStatus()
    await page.goto('about:blank')
    for (const response of connections) response.end()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => { resolve() }))
  }
})
