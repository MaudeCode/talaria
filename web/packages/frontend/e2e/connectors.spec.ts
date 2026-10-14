import { readFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import type { ConnectorOperationView, ConnectorsPage, ConnectorToolsView } from '@maudecode/talaria-web-contracts'
import { expect, settle, test } from './fixtures'

// Service-worker requests bypass page routing; these fixtures own every response.
test.use({ serviceWorkers: 'block' })

/** The views the server suite composes (contracts/fixtures/connectors.json). */
const shared = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts/fixtures/connectors.json'), 'utf8')) as { page: ConnectorsPage; tools: ConnectorToolsView; connect_card: ConnectorOperationView }
const waiting: ConnectorOperationView = { op_id: 'op-page', settled: false, can_continue: false, tool_call_id: null, targets: [
  { name: 'gmail', title: 'Gmail', kind: 'connector', state: 'initiated', detail: '', connect_url: 'https://vendor.example.test/authorize/conn-1', actions: ['skip'], env_fields: [] },
] }

{
  test('Connectors page: apps, rules, tools and a connect (TAL-818)', async ({ page }, testInfo) => {
    const shot = testInfo.project.name
    let connected = false
    const rules: unknown[] = []
    await page.route('**/api/connectors/available', (route) => route.fulfill({ json: { available: true } }))
    await page.route('**/api/connectors', (route) => route.fulfill({ json: connected
      ? { ...shared.page, connectors: shared.page.connectors.map((c) => c.slug === 'gmail' ? { ...c, connected: true, accounts: [{ connection_id: 'conn-1', name: 'me@example.test', problem: null, status_reason: null, active: true, created_at: '2026-10-14T00:00:00Z' }] } : c) }
      : shared.page }))
    await page.route('**/api/connectors/notion/tools', (route) => route.fulfill({ json: { ...shared.tools, tools: shared.tools.tools.map((t) => ({ ...t, editable: !t.locked })) } }))
    await page.route('**/api/connectors/*/policy', async (route) => { rules.push(route.request().postDataJSON()); await route.fulfill({ json: { ok: true, revision: 'rev-8' } }) })
    await page.route('**/api/connectors/gmail/connect', (route) => route.fulfill({ json: waiting }))
    await page.route('**/api/connectors/operations/op-page', (route) => route.fulfill({ json: connected
      ? { ...waiting, settled: true, targets: [{ ...waiting.targets[0]!, state: 'connected', connect_url: null, actions: [] }] }
      : waiting }))

    await page.goto('/settings/connectors')
    await settle(page)
    const gmail = page.locator('[data-connector="gmail"]')
    const notion = page.locator('[data-connector="notion"]')
    await expect(gmail).toContainText('Off by organization rule')
    await expect(notion.getByRole('list', { name: 'Notion accounts' })).toContainText('work')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`connectors-${shot}.png`) })

    await notion.getByRole('button', { name: /Tools/ }).click()
    await expect(notion.getByRole('list', { name: 'Tools' }).getByRole('listitem')).toHaveCount(4)
    await notion.getByRole('switch', { name: 'Send available to Hermes' }).click()
    await expect.poll(() => rules).toEqual([{ revision: 'rev-7', tool: 'notion_send', tool_enabled: true }])
    await page.screenshot({ path: testInfo.outputPath(`connectors-${shot}-tools.png`) })

    await gmail.getByRole('button', { name: 'Connect' }).click()
    const authorize = gmail.getByRole('link', { name: 'Authorize' })
    await expect(authorize).toHaveAttribute('href', 'https://vendor.example.test/authorize/conn-1')
    await expect(gmail).toContainText('Waiting for authorization')
    await page.screenshot({ path: testInfo.outputPath(`connectors-${shot}-connecting.png`) })
    connected = true
    await expect(gmail.getByRole('list', { name: 'Gmail accounts' })).toContainText('me@example.test', { timeout: 10_000 })
    await expect(authorize).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`connectors-${shot}-connected.png`) })
  })
}

test('the Connectors entry follows the server flag (TAL-818)', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'the settings menu is the desktop sidebar')
  let available = false
  await page.route('**/api/connectors/available', (route) => route.fulfill({ json: { available } }))
  await page.goto('/settings/appearance')
  await settle(page)
  const menu = page.locator('#settingsMenu')
  await expect(menu.getByRole('link', { name: 'Providers' })).toBeVisible()
  await expect(menu.getByRole('link', { name: 'Connectors' })).toHaveCount(0)
  available = true
  await page.reload()
  await settle(page)
  await expect(menu.getByRole('link', { name: 'Connectors' })).toBeVisible()
})

{
  test('a chat connect card shows the apps and continues (TAL-818)', async ({ page }, testInfo) => {
    const shot = testInfo.project.name
    const sid = 'connect-card'
    await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
      session_id: sid, title: 'Connect Gmail', active_stream_id: 'connect-run', is_streaming: true, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true,
      transcript_seq: null, messages: [{ role: 'user', id: 1, content: 'Read my latest Gmail', _turn_id: 'connect-run' }],
    } } }))
    await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: 'connect-run', replay_available: false } }))
    let settled = false
    const moves: unknown[] = []
    await page.route('**/api/connectors/operations/op-chat', async (route) => {
      if (route.request().method() === 'POST') { moves.push(route.request().postDataJSON()); settled = true }
      await route.fulfill({ json: { ...shared.connect_card, settled } })
    })
    const streams: ServerResponse[] = []
    let seq = 0
    const send = (event: string, data: unknown) => { seq += 1; for (const r of streams) r.write(`id: connect-run:${String(seq)}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
      response.write(`id: connect-run:${String(++seq)}\nevent: token\ndata: ${JSON.stringify({ text: 'Gmail needs a connection first.' })}\n\n`)
      streams.push(response)
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${String(address.port)}${new URL(route.request().url()).search}` }))
    try {
      await page.goto(`/session/${sid}`)
      await expect.poll(() => streams.length).toBeGreaterThan(0)
      const pageWidth = () => page.evaluate(() => document.documentElement.scrollWidth)
      const before = await pageWidth()
      send('connect_card', shared.connect_card)
      const card = page.getByRole('region', { name: 'Connect apps' })
      await expect(card.getByRole('link', { name: 'Authorize' })).toHaveAttribute('href', 'https://vendor.example.test/authorize/conn-2')
      await expect(card.locator('[data-connect-target="linear"]')).toContainText('Starting')
      // The card widens nothing (the chat page's own right-panel handle may already overhang by a few pixels).
      expect(await pageWidth()).toBe(before)
      await page.screenshot({ path: testInfo.outputPath(`connect-card-${shot}.png`) })
      await card.getByRole('button', { name: 'Continue' }).click()
      await expect(card).toHaveCount(0)
      await expect.poll(() => moves).toEqual([{ action: 'continue' }])
    } finally {
      for (const response of streams) response.end()
      await new Promise<void>((done) => server.close(() => { done() }))
    }
  })
}
