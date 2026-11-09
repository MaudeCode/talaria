import { readFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import type { ConnectorOperationView, ConnectorsPage, ConnectorToolsView } from '@maudecode/talaria-web-contracts'
import { expect, expectPromptReachable, settle, test } from './fixtures'

// Service-worker requests bypass page routing; these fixtures own every response.
test.use({ serviceWorkers: 'block' })

/** The views the server suite composes (contracts/fixtures/connectors.json). */
const shared = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts/fixtures/connectors.json'), 'utf8')) as { page: ConnectorsPage; tools: ConnectorToolsView; connect_card: ConnectorOperationView; native_connection: { view: ConnectorOperationView } }
const waiting: ConnectorOperationView = { op_id: 'op-page', settled: false, outcome: null, can_continue: false, tool_call_id: null, targets: [
  { name: 'gmail', title: 'Gmail', kind: 'connector', state: 'initiated', detail: '', connect_url: 'https://vendor.example.test/authorize/conn-1', launch: null, actions: ['skip'], env_fields: [] },
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
    await page.route('**/api/connectors/notion/tools', (route) => route.fulfill({ json: shared.tools }))
    await page.route('**/api/connectors/*/policy', async (route) => { rules.push(route.request().postDataJSON()); await route.fulfill({ json: { ok: true, revision: 'rev-8' } }) })
    await page.route('**/api/connectors/gmail/connect', (route) => route.fulfill({ json: waiting }))
    await page.route('**/api/connectors/operations/op-page', (route) => route.fulfill({ json: connected
      ? { ...waiting, settled: true, outcome: 'connected', targets: [{ ...waiting.targets[0]!, state: 'connected', connect_url: null, actions: [] }] }
      : waiting }))

    await page.goto('/settings/agent?tab=connectors')
    await settle(page)
    const gmail = page.locator('[data-connector="gmail"]')
    const notion = page.locator('[data-connector="notion"]')
    await expect(gmail).toContainText('Off by organization rule')
    await expect(notion.getByRole('list', { name: 'Notion accounts' })).toContainText('work')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`connectors-${shot}.png`) })

    await notion.getByRole('button', { name: /Tools/ }).click()
    await expect(notion.getByRole('list', { name: 'Tools' }).getByRole('listitem')).toHaveCount(5)
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

test('an unsigned Connectors page offers sign-in and adopts an external account on refresh (TAL-1504)', async ({ page }, testInfo) => {
  let signedIn = false
  let publicCatalog = true
  await page.route('**/api/connectors/available', (route) => route.fulfill({ json: { available: true } }))
  await page.route('**/api/connectors', (route) => route.fulfill({ json: signedIn ? shared.page : {
    ...shared.page, sign_in_required: true, policy_revision: null, rules_error: 'Sign in to Nous Portal to use connectors.',
    connectors: publicCatalog ? shared.page.connectors.map((c) => ({ ...c, connected: false, accounts: [], enabled: false, org_locked: false, rules_editable: false, tools_off: 0 })) : [],
  } }))
  const writes: string[] = []
  page.on('request', (request) => { if (request.method() !== 'GET') writes.push(request.url()) })
  await page.goto('/settings/agent?tab=connectors')
  await settle(page)
  await expect(page.getByRole('button', { name: 'Sign in with Nous Portal' })).toBeVisible()
  const gmail = page.locator('[data-connector="gmail"]')
  await expect(gmail.getByRole('button', { name: 'Connect' })).toBeEnabled()
  await expect(gmail.getByRole('switch')).toHaveAttribute('aria-disabled', 'true')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath(`unsigned-${testInfo.project.name}.png`) })
  // Supported older Agents offer sign-in without inventing a catalog.
  publicCatalog = false
  await page.reload()
  await settle(page)
  await expect(page.getByRole('button', { name: 'Sign in with Nous Portal' })).toBeVisible()
  await expect(page.locator('[data-connector]')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath(`sign-in-only-${testInfo.project.name}.png`) })
  publicCatalog = true
  await page.reload()
  await settle(page)
  await expect(page.getByRole('button', { name: 'Sign in with Nous Portal' })).toBeVisible()
  await page.goto('/settings/appearance')
  await page.goto('/settings/agent?tab=connectors')
  await settle(page)
  await expect(page.getByRole('button', { name: 'Sign in with Nous Portal' })).toBeVisible()
  expect(writes.filter((url) => /connectors|oauth/.test(url))).toEqual([])
  // A sign-in performed in the Agent becomes the real account on the next page read.
  signedIn = true
  await page.reload()
  await settle(page)
  await expect(page.getByRole('button', { name: 'Sign in with Nous Portal' })).toHaveCount(0)
  await expect(page.getByRole('list', { name: 'Notion accounts' })).toContainText('work')
  await page.screenshot({ path: testInfo.outputPath(`adopted-${testInfo.project.name}.png`) })
})

test('the Connectors tab follows the server flag (TAL-818)', async ({ page }) => {
  let available = false
  await page.route('**/api/connectors/available', (route) => route.fulfill({ json: { available } }))
  await page.goto('/settings/agent?tab=connectors')
  await settle(page)
  const tabs = page.getByRole('tablist', { name: 'Agent' })
  await expect(tabs.getByRole('tab', { name: 'Plugins' })).toHaveAttribute('aria-selected', 'true')
  await expect(tabs.getByRole('tab', { name: 'Connectors' })).toHaveCount(0)
  available = true
  await page.reload()
  await settle(page)
  await expect(tabs.getByRole('tab', { name: 'Connectors' })).toHaveAttribute('aria-selected', 'true')
})

{
  test('a chat connect card shows the apps and continues (TAL-818)', async ({ page }, testInfo) => {
    const shot = testInfo.project.name
    const sid = 'connect-card'
    await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
      session_id: sid, title: 'Connect Gmail', active_stream_id: 'connect-run', is_streaming: true, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true,
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
      await page.setViewportSize({ width: 594, height: 368 })
      await expectPromptReachable(page, card, [card.getByText('Connect apps'), card.getByRole('link', { name: 'Authorize' }), card.getByRole('button', { name: 'Continue' })])
      await page.screenshot({ path: testInfo.outputPath(`connect-card-short-${shot}.png`) })
      await card.getByRole('button', { name: 'Continue' }).click()
      await expect(card).toHaveCount(0)
      await expect.poll(() => moves).toEqual([{ action: 'continue' }])
    } finally {
      for (const response of streams) response.end()
      await new Promise<void>((done) => server.close(() => { done() }))
    }
  })
}

test('scheduled guest offer reuses OAuth, preserves the result, and dismisses without signing in (TAL-1507)', async ({ page }, testInfo) => {
  let visible = false
  let signedIn = false
  let approved = false
  let starts = 0
  let dismisses = 0
  let offerAvailable = true
  const offer = () => ({ available: offerAvailable, due: offerAvailable && visible, visible: visible && !signedIn, offer_id: visible && !signedIn ? 'offer-1' : null,
    actions: visible && !signedIn ? offerAvailable ? ['sign_in', 'dismiss'] : ['dismiss'] : [], refresh_after: 1 })
  await page.route('**/api/connectors/available', (route) => route.fulfill({ json: { available: true } }))
  await page.route('**/api/connectors', (route) => route.fulfill({ json: { ...shared.page, sign_in_offer: offer() } }))
  await page.route('**/api/connectors/sign-in-offer/dismiss', async (route) => {
    dismisses += 1
    expect(route.request().postDataJSON()).toEqual({ offer_id: 'offer-1' })
    visible = false
    await route.fulfill({ json: offer() })
  })
  await page.route('**/api/onboarding/oauth/start', async (route) => {
    starts += 1
    expect(route.request().postDataJSON()).toEqual({ provider: 'nous' })
    await route.fulfill({ json: { ok: true, status: 'pending', flow_id: 'offer-flow', provider: 'nous', user_code: 'TEST-1507', verification_url: 'https://auth.example.test/device', interval: 1 } })
  })
  await page.route('**/api/onboarding/oauth/cancel', (route) => route.fulfill({ json: { ok: true, status: 'cancelled', flow_id: 'offer-flow' } }))
  await page.route('**/api/onboarding/oauth/poll?**', (route) => route.fulfill({ json: approved ? {
    ok: true, status: 'approved', flow_id: 'offer-flow', nous_account: { account_id: 'account-1', email: 'u***@example.test', state: 'retrying', lines: ['Moving connected apps.'], moved: [], dropped: [], reconnect: [], poll_after: null },
  } : { ok: true, status: 'pending', flow_id: 'offer-flow' } }))
  await page.goto('/settings/agent?tab=connectors')
  await settle(page)
  await page.screenshot({ path: testInfo.outputPath(`offer-before-${testInfo.project.name}.png`) })
  visible = true
  const signIn = page.getByRole('button', { name: 'Sign in with Nous Portal' })
  const later = page.getByRole('button', { name: 'Not now' })
  await expect(later).toBeVisible()
  expect(starts).toBe(0)
  if (testInfo.project.name === 'mobile') {
    expect((await signIn.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    expect((await later.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath(`offer-after-${testInfo.project.name}.png`) })
  if (testInfo.project.name === 'desktop') {
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.screenshot({ path: testInfo.outputPath('offer-after-laptop.png') })
  }
  offerAvailable = false
  await expect(signIn).toBeDisabled()
  await expect(later).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath(`offer-unavailable-${testInfo.project.name}.png`) })
  offerAvailable = true
  await expect(signIn).toBeEnabled()
  await later.focus()
  await page.keyboard.press('Enter')
  await expect(later).toHaveCount(0)
  await expect.poll(() => dismisses).toBe(1)
  expect(starts).toBe(0)
  await page.reload()
  await settle(page)
  await expect(later).toHaveCount(0)
  visible = true  // a later native due offer
  await expect(signIn).toBeVisible()
  await signIn.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByText('TEST-1507')).toBeVisible()
  expect(starts).toBe(1)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('cancelled')
  await signIn.click()
  approved = true
  signedIn = true  // account refresh may withdraw the offer before the OAuth result is acknowledged
  await expect(page.getByText('u***@example.test', { exact: false })).toBeVisible()
  await expect(page.getByText('Moving connected apps.')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath(`offer-result-${testInfo.project.name}.png`) })
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(later).toHaveCount(0)
  await expect(page.getByText('Moving connected apps.')).toHaveCount(0)
  expect(starts).toBe(2)
})

test('an MCP row keeps a long command in a bounded box with every argument reachable (TAL-1907)', async ({ page }, testInfo) => {
  const native = shared.native_connection.view
  const sid = native.owner!.session_id
  const target = ['npx -y mcp-linear', ...Array.from({ length: 120 }, (_, index) => `--include=/workspace/project/${String(index)}`), `'two  spaces'`, '--last-argument'].join(' ')
  const view: ConnectorOperationView = { ...native, targets: native.targets.map((row) => row.name === 'linear' ? { ...row, launch: { ...row.launch!, target } } : row) }
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: sid, title: 'Native owner chat', workspace: '/workspace/native', read_only: true, read_only_reason: 'canonical_session', messages: [{ role: 'user', content: 'Connect my apps' }], owner_attachment: { state: 'attached', reason: null, can_submit: true, can_interrupt: false, can_attach: false, restarting: false, revision: 1, execution_generation: 1, admissions: [], queued_input_count: 0, connection: view } } } }))
  await page.route('**/api/connectors/operations/op-native**', (route) => route.fulfill({ json: view }))
  await page.goto(`/session/${sid}`)
  await settle(page)
  const card = page.getByRole('region', { name: 'Connect apps' })
  const row = card.locator('[data-connect-target="linear"]')
  const box = row.locator('[data-connect-launch]')
  await expect(box).toBeVisible()
  expect(await box.evaluate((el) => el.firstElementChild!.textContent)).toBe(`Runs: ${target}`)
  const size = await box.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }))
  expect(size.clientHeight).toBeLessThanOrEqual(120)
  expect(size.scrollHeight).toBeGreaterThan(size.clientHeight)
  expect(size.scrollWidth).toBeLessThanOrEqual(size.clientWidth)
  expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= innerWidth)).toBe(true)
  await expect(row.getByRole('button', { name: 'Approve' })).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath(`launch-line-${testInfo.project.name}.png`) })
  await box.focus()
  await page.keyboard.press('End')
  await expect.poll(() => box.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath(`launch-line-${testInfo.project.name}-end.png`) })
  await row.locator('input').fill('lin-key')
  await expect(row.getByRole('button', { name: 'Approve' })).toBeEnabled()
})

test('a canonical owner\'s connection card restores on attach and answers through that owner (TAL-1317)', async ({ page }, testInfo) => {
  const native = shared.native_connection.view
  const sid = native.owner!.session_id
  let current = native
  const moves: unknown[] = []
  const reads: string[] = []
  let answer: () => void = () => undefined
  const ownerAnswers = new Promise<void>((resolve) => { answer = resolve })
  const owner_attachment = () => ({ state: 'attached', reason: null, can_submit: true, can_interrupt: false, can_attach: false, restarting: false, revision: 1, execution_generation: 1, admissions: [], queued_input_count: 0, connection: current })
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: sid, title: 'Native owner chat', workspace: '/workspace/native', read_only: true, read_only_reason: 'canonical_session', messages: [{ role: 'user', content: 'Connect my apps' }], owner_attachment: owner_attachment() } } }))
  await page.route('**/api/connectors/operations/op-native**', async (route) => {
    const request = route.request()
    if (request.method() === 'GET') {
      reads.push(new URL(request.url()).search)
      return route.fulfill({ json: current })
    }
    const body = request.postDataJSON() as { action: string; target?: string }
    moves.push(body)
    // The owner has not answered yet: the page must already show the choice.
    if (body.action === 'skip') await ownerAnswers
    if (body.action === 'skip') current = { ...current, targets: current.targets.map((t) => t.name === body.target ? { ...t, state: 'skipped', connect_url: null, launch: null, actions: [], env_fields: [] } : t) }
    if (body.action === 'continue') current = { ...current, settled: true, outcome: 'not_connected', can_continue: false, can_wake: false, targets: current.targets.map((t) => ({ ...t, connect_url: null, launch: null, actions: [], env_fields: [] })) }
    return route.fulfill({ json: current })
  })
  await page.goto(`/session/${sid}`)
  await settle(page)
  const card = page.getByRole('region', { name: 'Connect apps' })
  await expect(card).toBeVisible()
  await expect(card.getByRole('link', { name: 'Authorize' })).toHaveAttribute('href', native.targets[0]!.connect_url!)
  await expect(card.locator('[data-connect-target="notion"]')).toContainText('The link expired')
  await expect(card.locator('[data-connect-target="linear"] input')).toHaveAttribute('type', 'password')
  expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath(`native-card-${testInfo.project.name}.png`) })
  await card.locator('[data-connect-target="gmail"]').getByRole('button', { name: 'Skip' }).click()
  await expect(card.locator('[data-connect-target="gmail"]')).toContainText('Skipped')
  await expect(card.getByRole('button', { name: 'Continue' })).toBeEnabled()
  answer()
  await expect.poll(() => reads.length, { timeout: 5000 }).toBeGreaterThan(0)
  expect(reads.every((search) => search.includes(`session_id=${sid}`) && search.includes('authority_epoch=1'))).toBe(true)
  await page.screenshot({ path: testInfo.outputPath(`native-card-${testInfo.project.name}-moved.png`) })
  await card.getByRole('button', { name: 'Continue' }).click()
  await expect(card).toHaveCount(0)
  expect(moves).toEqual([
    { session_id: sid, authority_epoch: 1, action: 'skip', target: 'gmail' },
    { session_id: sid, authority_epoch: 1, action: 'continue' },
  ])
})
