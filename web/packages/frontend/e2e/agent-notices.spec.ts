import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { GatewaySnapshot } from '@maudecode/talaria-web-contracts'
import { bootTestServer } from '../../server/dist/test/harness.js'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'
import type { StreamFrame } from '../../server/dist/sidecar/client.js'
import { createServer, type ServerResponse } from 'node:http'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const memory = { key: 'startup-warning.1a2b3c4d', level: 'warn', text: "⚠ Memory provider 'honcho' could not be loaded; memory is off for this session.", expires_at: null }
const pending = { key: 'mcp_discovery_pending', level: 'info', text: 'Some tools are still connecting. Using available tools for this turn.', expires_at: null }
const credits = { key: 'credits.usage_band', level: 'info', text: "You've used 90% of your Nous credits.", expires_at: null }

/** TAL-803: the session's Agent notices sit in the composer's status tab; the server's `notices` event replaces them live. */
test('shows the session\'s Agent notices and follows the server\'s live list', async ({ page }, testInfo) => {
  const sid = 'agent-notices'
  let notices = [memory]
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Plan the week', active_stream_id: 'notice-run', is_streaming: true, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true,
    transcript_seq: null, messages: [{ role: 'user', id: 1, content: 'Plan the week', _turn_id: 'notice-run' }],
    notices,
  } } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: 'notice-run', replay_available: false } }))
  const streams: ServerResponse[] = []
  let seq = 0
  const send = (event: string, data: { session_id: string; notices: typeof notices }) => {
    notices = data.notices
    seq += 1
    for (const r of streams) if (!r.destroyed && !r.writableEnded) r.write(`id: notice-run:${String(seq)}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    response.write(`id: notice-run:${String(++seq)}\nevent: token\ndata: ${JSON.stringify({ text: 'Looking at your calendar.' })}\n\n`)
    streams.push(response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${String(address.port)}${new URL(route.request().url()).search}` }))
  try {
    await page.goto(`/session/${sid}`)
    const tab = (text: string) => page.locator('#composerWrap').getByText(text)
    await expect(tab(memory.text)).toBeVisible()
    if (process.env.TAL803_SHOTS) await page.screenshot({ path: `${process.env.TAL803_SHOTS}/notice-${testInfo.project.name}.png` })
    await expect(page.locator('.live-turn .msg-body')).toContainText('Looking at your calendar.')
    send('notices', { session_id: sid, notices: [] })
    await expect(tab(memory.text)).toHaveCount(0)
    await page.reload()
    await expect(page.locator('#messages').getByText('Plan the week', { exact: true })).toBeVisible()
    await expect(tab(memory.text)).toHaveCount(0)
    await expect(page.locator('.live-turn .msg-body')).toContainText('Looking at your calendar.')
    if (process.env.TAL1227_SHOTS) await page.screenshot({ path: `${process.env.TAL1227_SHOTS}/before-${testInfo.project.name}.png` })
    send('notices', { session_id: sid, notices: [pending] })
    await expect(tab(pending.text)).toBeVisible()
    if (process.env.TAL1227_SHOTS) await page.screenshot({ path: `${process.env.TAL1227_SHOTS}/pending-${testInfo.project.name}.png` })
    send('notices', { session_id: sid, notices: [credits] })
    await expect(tab(pending.text)).toHaveCount(0)
    await expect(tab(credits.text)).toBeVisible()
    await expect(tab(memory.text)).toHaveCount(0)
    send('notices', { session_id: sid, notices: [] })
    await expect(tab(credits.text)).toHaveCount(0)
  } finally {
    for (const response of streams) response.end()
    await new Promise<void>((resolve) => server.close(() => { resolve() }))
  }
})


test('idle native plugin notices refresh both viewers through one observation', async ({ page, context }, testInfo) => {
  const fixture = JSON.parse(readFileSync(new URL('../../server/src/test/fixtures/canonical-ownership.json', import.meta.url), 'utf8')) as { sessions: { cli: string }; schema: string[]; inserts: string[] }
  const notices = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/web-native-notices.json', import.meta.url), 'utf8')) as { events: Record<string, unknown>[]; info: Record<string, unknown> }
  const sid = fixture.sessions.cli
  const sidecar = new FakeSidecar()
  const server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' } })
  const db = new DatabaseSync(join(server.state, 'state.db'))
  let emit: ((frame: Omit<StreamFrame, 'seq'>) => void) | undefined
  let aborted = false
  const snap: GatewaySnapshot = { session_id: sid, stored_session_id: sid, messages: [{ role: 'user', content: 'Check the project' }, { role: 'assistant', content: 'The project is ready.' }],
    message_count: 2, running: false, authority_epoch: 1, replay_epoch: 'owner-epoch', last_sequence: 0, subscription_id: 'viewer', revision: 1, execution_generation: 1,
    pending: [], prompts: [], info: { title: 'Project status', ...notices.info } }
  const attached = () => ({ state: 'attached' as const, reason: null, snapshot: snap, receipt: null })
  sidecar.respond('gateway.session', (params, send, opts) => {
    if (params.action !== 'watch') return attached()
    emit = send
    send({ event: 'snapshot', data: attached() })
    return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { aborted = true; resolve(attached()) }, { once: true }) })
  })
  const second = await context.newPage()
  const shot = async (name: string) => {
    await page.screenshot({ path: process.env.TAL1329_SHOTS ? `${process.env.TAL1329_SHOTS}/${name}-${testInfo.project.name}.png` : testInfo.outputPath(`${name}-${testInfo.project.name}.png`) })
  }
  try {
    db.exec(fixture.schema.join('\n'))
    for (const sql of fixture.inserts) db.exec(sql)
    await server.deps.settings.save({ show_cli_sessions: true })
    await page.goto(`${server.base}/session/${sid}`)
    await expect(page.locator('#composerWrap').getByText('Project plugins were skipped')).toBeVisible()
    await expect.poll(() => Boolean(emit)).toBe(true)
    await shot('idle-before')
    await second.goto(`${server.base}/session/${sid}`)
    await expect.poll(() => server.deps.channels.subscriberCount(sid)).toBe(2)
    for (const event of notices.events) emit!({ event: 'event', data: event })
    for (const viewer of [page, second]) {
      await expect(viewer.locator('#composerWrap').getByText('Plugin finished', { exact: true })).toHaveCount(1)
      await expect(viewer.locator('#composerWrap').getByText('Plugin started', { exact: true })).toHaveCount(0)
    }
    expect(server.deps.registry.activeRunStreamForSession(sid)).toBeNull()
    expect(sidecar.calls.filter((call) => call.method === 'gateway.session' && (call.params as { action: string }).action === 'watch')).toHaveLength(1)
    await shot('idle-after')
    await page.reload()
    await expect(page.locator('#composerWrap').getByText('Plugin finished', { exact: true })).toHaveCount(1)
    await shot('idle-reconnected')
    await page.goto('about:blank')
    expect(aborted).toBe(false)
    await second.close()
    await expect.poll(() => aborted).toBe(true)
    expect(sidecar.calls.some((call) => call.method === 'chat.start')).toBe(false)
  } finally {
    await second.close()
    await page.goto('about:blank')
    db.close()
    await server.close()
  }
})
