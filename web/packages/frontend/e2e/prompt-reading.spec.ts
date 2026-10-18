import { createServer, type ServerResponse } from 'node:http'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block', reducedMotion: 'no-preference', video: 'on' })

/** TAL-1058: real built composer and stream reducer, with only the provider and HTTP state replaced. */
test('prompt-reading progress uses the existing status and survives a cold attach until Stop', async ({ page }, testInfo) => {
  const sid = 'prompt-reading'
  const streamId = `${sid}-run`
  let stream = null as ServerResponse | null
  let status: unknown = { phase: 'working' }
  let snapshotStatus: unknown
  let seq = 0
  const send = (value: unknown) => {
    status = value
    stream!.write(`id: ${streamId}:${String(++seq)}\nevent: run_status\ndata: ${JSON.stringify({ session_id: sid, status })}\n\n`)
  }
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    stream = response
    response.write('event: hello\ndata: {}\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  await page.route('**/api/session?**', (route) => {
    const requestedSid = new URL(route.request().url()).searchParams.get('session_id') ?? sid
    return route.fulfill({ json: { session: { session_id: requestedSid, title: 'Local model', messages: [{ role: 'user', id: 1, content: 'Summarize the release notes' }], active_stream_id: stopped || requestedSid !== sid ? null : streamId, is_streaming: !stopped && requestedSid === sid, run_status: snapshotStatus ?? status } } })
  })
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: !stopped, blocking_stream_id: null, stream_id: streamId, replay_available: false } }))
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${String(address.port)}${new URL(route.request().url()).search}` }))
  let stopped = false
  await page.route('**/api/chat/cancel?**', async (route) => {
    stopped = true
    send(null)
    stream!.write('event: cancel\ndata: {}\n\n')
    await route.fulfill({ json: { ok: true } })
  })
  const shot = async (name: string) => {
    const tab = page.locator('.composer-tab')
    if (await tab.count()) await tab.evaluate(async (el) => {
      await Promise.all(el.getAnimations({ subtree: true }).filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined)))
    })
    if (process.env.TAL1058_SHOTS) await page.screenshot({ path: `${process.env.TAL1058_SHOTS}/${name}-${testInfo.project.name}.png` })
  }
  try {
    await page.goto(`/session/${sid}`)
    const pill = page.locator('.composer-tab .live-run-status')
    await expect(pill).toContainText('Working')
    await expect.poll(() => stream !== null).toBe(true)
    await shot('before')
    for (const progress_percent of [0, 42, 100, null]) {
      send({ phase: 'prompt_reading', progress_percent })
      await expect(pill).toHaveText(progress_percent === null ? 'Reading prompt' : `Reading prompt · ${String(progress_percent)}%`)
      await expect(pill.locator('.live-laurel')).toHaveCount(1)
      await expect(page.locator('#btnStop')).toBeVisible()
      if (progress_percent === 42) await shot('after')
    }
    send({ phase: 'prompt_reading', progress_percent: 42 })
    await expect(pill).toHaveText('Reading prompt · 42%')
    // Returning with a retained SSE cursor must preserve progress newer than the cached HTTP snapshot.
    snapshotStatus = { phase: 'prompt_reading', progress_percent: 0 }
    const previousStream = stream
    for (const next of ['prompt-idle', sid]) {
      await page.evaluate((path) => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')) }, `/session/${next}`)
      await expect(page).toHaveURL(new RegExp(`/session/${next}$`))
      if (next !== sid) await expect(pill).toHaveCount(0)
    }
    await expect(pill).toHaveText('Reading prompt · 42%')
    await expect.poll(() => stream !== previousStream).toBe(true)
    await shot('retained')
    snapshotStatus = undefined
    send({ phase: 'compressing' })
    await expect(pill).toHaveText('Compressing context')
    send({ phase: 'prompt_reading', progress_percent: 42 })
    stream?.end()
    stream = null
    await page.reload()
    await expect(pill).toHaveText('Reading prompt · 42%')
    await expect.poll(() => stream !== null).toBe(true)
    await shot('reconnect')
    await page.locator('#btnStop').click()
    await expect.poll(() => stopped).toBe(true)
    await expect(pill).toHaveCount(0)
    await expect(page.locator('#btnStop')).toBeHidden()
    await shot('stopped')
  } finally {
    stream?.end()
    await new Promise<void>((resolve) => server.close(() => { resolve() }))
  }
})
