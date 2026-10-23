import { createServer, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { bootTestServer } from '../../server/dist/test/harness.js'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block', video: 'on' })

test('a healthy sidebar skips polling and resyncs on reconnect', async ({ page }, testInfo) => {
  let stream: ServerResponse | undefined
  let connections = 0
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    response.write('retry: 100\n\nevent: initial\ndata: {"stream":"sessions"}\n\n')
    stream = response
    connections++
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  let title = 'Before reconnect'
  let listReads = 0
  const now = Math.floor(Date.now() / 1000)
  await page.route('**/api/sessions/events*', (route) => route.continue({ url: `http://127.0.0.1:${String(address.port)}/` }))
  await page.route(/\/api\/sessions(\?|$)/, (route) => {
    listReads++
    return route.fulfill({ json: { sessions: [{
      session_id: 'reconnect-sidebar', title, updated_at: now, sort_ts: now, last_message_at: now,
      pinned: false, archived: false, project_id: null, is_streaming: false, attention: null,
      is_cli_session: false, source_kind: 'webui', is_messaging_session: false, read_only: false,
      can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true,
    }] } })
  })
  try {
    await page.goto('/')
    await settle(page)
    const hamburger = page.locator('#btnHamburger')
    if (await hamburger.isVisible()) await hamburger.click()
    const row = page.locator('.session-item[data-sid="reconnect-sidebar"] .session-title')
    await expect(row).toHaveText('Before reconnect')
    await expect.poll(() => connections).toBe(1)
    await page.screenshot({ path: testInfo.outputPath('before-reconnect.png') })
    await page.clock.install()
    const before = listReads
    await page.clock.runFor(300_000)
    expect(listReads).toBe(before)
    title = 'Caught up after reconnect'
    stream!.end()
    await expect.poll(() => connections).toBe(2)
    await expect(row).toHaveText('Caught up after reconnect')
    expect(listReads).toBe(before + 1)
    await page.screenshot({ path: testInfo.outputPath('after-reconnect.png') })
  } finally {
    await page.close()
    stream?.end()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('external Agent session updates reach the sidebar without polling', async ({ page }, testInfo) => {
  const fixture = JSON.parse(readFileSync(new URL('../../server/src/test/fixtures/canonical-ownership.json', import.meta.url), 'utf8')) as { sessions: { cli: string }; schema: string[]; inserts: string[] }
  const server = await bootTestServer({ sidecar: new FakeSidecar(), env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' }, gatewayPollMs: 100 })
  const db = new DatabaseSync(join(server.state, 'state.db'))
  const sid = fixture.sessions.cli
  let listReads = 0
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/sessions') listReads++ })
  try {
    db.exec(fixture.schema.join('\n'))
    for (const sql of fixture.inserts) db.exec(sql)
    db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('Before Agent update', sid)
    await server.deps.settings.save({ show_cli_sessions: true })
    server.deps.gatewayWatchers.get('default')
    await page.goto(server.base)
    await settle(page)
    const hamburger = page.locator('#btnHamburger')
    if (await hamburger.isVisible()) await hamburger.click()
    await page.getByRole('button', { name: /^CLI sessions/ }).click()
    const row = page.locator(`.session-item[data-sid="${sid}"] .session-title`)
    await expect(row).toHaveText('Before Agent update')
    await page.screenshot({ path: testInfo.outputPath('before-agent-update.png') })
    const before = listReads
    db.prepare('UPDATE sessions SET title = ?, message_count = message_count + 1 WHERE id = ?').run('Updated by the Agent', sid)
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(sid, 'user', 'An external update', Date.now() / 1000)
    await expect(row).toHaveText('Updated by the Agent', { timeout: 5000 })
    expect(listReads).toBeGreaterThan(before)
    await page.screenshot({ path: testInfo.outputPath('after-agent-update.png') })
  } finally {
    await page.goto('about:blank')
    db.close()
    await server.close()
  }
})
