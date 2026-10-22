import { mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })
const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/native-cron-refusal.json', import.meta.url), 'utf8')) as { event: { event: string; data: { message: string } } }

test('a scheduled-chat refusal shows its recovery instruction without Retry or resend', async ({ page }, testInfo) => {
  const sid = 'scheduled-refusal', stream = 'scheduled-turn'
  const before = process.env.TALARIA_EVIDENCE_BEFORE === '1'
  const error = before ? { type: 'owner_turn_failed', message: 'The owning Agent could not complete this turn', terminal_state: 'error' } : fixture.event.data
  let attached = false
  let finished = false
  let refuse: () => void = () => undefined
  const session = () => ({ session_id: sid, title: 'Scheduled chat', messages: [{ role: 'user', id: 1, content: 'Summarize this report', _turn_id: stream }], active_stream_id: finished ? null : stream })
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: session() } }))
  await page.route('**/api/health/agent', (route) => route.fulfill({ json: { alive: true, chat: { available: true, condition: null } } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: !finished, stream_id: stream, replay_available: true } }))
  const starts: string[] = []
  await page.route('**/api/chat/start', (route) => { starts.push(route.request().url()); return route.fulfill({ status: 500, json: { error: 'Unexpected resend' } }) })
  const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  const peer = createServer((_request, response) => {
    attached = true
    response.writeHead(200, { 'content-type': 'text/event-stream', 'access-control-allow-origin': new URL(process.env.HERMES_E2E_BASE_URL!).origin, 'access-control-allow-credentials': 'true' })
    response.write(': attached\n\n')
    refuse = () => { finished = true; response.end(event('apperror', { ...error, session: session() })) }
  })
  await new Promise<void>((resolve) => { peer.listen(0, '127.0.0.1', resolve) })
  const address = peer.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture stream address')
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${address.port}/stream` }))
  try {
    await page.goto(`/session/${sid}`)
    await expect.poll(() => attached).toBe(true)
    refuse()
    await expect(page.locator('[role="alert"]').filter({ hasText: error.message })).toBeVisible()
    const notice = page.locator('[data-notice="runtime:thread_error"]')
    await expect(notice).toBeVisible()
    await expect(notice.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(before ? 1 : 0)
    const evidence = process.env.TALARIA_EVIDENCE_DIR
    if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: `${evidence}/${before ? 'before' : 'after'}-${testInfo.project.name}.png`, fullPage: true }) }
    await notice.getByRole('button').first().click()
    await expect(page.getByRole('dialog')).toContainText(error.message)
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
    if (evidence) await page.screenshot({ path: `${evidence}/${before ? 'before' : 'after'}-detail-${testInfo.project.name}.png`, fullPage: true })
    expect(starts).toEqual([])
  } finally { peer.closeAllConnections(); await new Promise<void>((resolve) => { peer.close(() => resolve()) }) }
})
