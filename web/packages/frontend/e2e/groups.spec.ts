import { mkdirSync } from 'node:fs'
import { expect, test } from './fixtures'
import { bootTestServer } from '../../server/dist/test/harness.js'
import type { Page } from '@playwright/test'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'
import { groupFixture } from '../../server/dist/test/group-fixture.js'
import { SpaShell } from '../../server/dist/spa.js'

test.use({ serviceWorkers: 'block', video: process.env.TALARIA_GROUP_ROUTING_EVIDENCE || process.env.TALARIA_GROUP_REPLY_EVIDENCE ? 'on' : 'off' })

test('live discussion activity shows tools, elapsed time, stalled members and the owning round', async ({ page }, info) => {
  const { fixture, server } = await discussionServer()
  const now = 1_800_000_000
  server.deps.nowSeconds = () => now
  fixture.state.driver_status.working = true
  fixture.state.context = { purpose: '', notes: '', routing: 'lead', lead_member_id: 'two' }
  fixture.state.driver_status.max_rounds = 3
  fixture.state.driver_status.member_activity = [{ member_id: 'one', status: 'running', tool: 'terminal', started_at: now - 80, progress_at: now, thread_id: 'thread', round_index: 1 }]
  const event = fixture.append('message.user', 'Review this proposal')
  Object.assign(event.payload, { thread_id: 'thread' })
  await page.clock.setFixedTime(new Date(now * 1000))
  const evidence = process.env.TALARIA_GROUP_ACTIVITY_EVIDENCE
  if (evidence) mkdirSync(evidence, { recursive: true })
  const shot = async (name: string) => { if (evidence) await page.screenshot({ path: `${evidence}/${name}-${info.project.name}.png` }) }
  try {
    await page.goto(`${server.base}/groups?room=discussion`)
    const members = page.getByRole('list', { name: 'Members', exact: true })
    await expect(members).toBeVisible()
    await shot('initial')
    await expect(members.getByRole('listitem').first()).toHaveText('Writer · terminal · 1m 20s')
    await expect(members.getByRole('listitem').nth(1)).toHaveText('Reviewer · Lead · Idle')
    await expect(page.getByText('Round 2 of 3', { exact: true })).toBeVisible()
    expect(await members.getByRole('listitem').first().evaluate((el) => el.getBoundingClientRect().height <= parseFloat(getComputedStyle(el).lineHeight) + 1)).toBe(true)
    await shot('running')
    // Real observer polls, even with no new transcript events, replace the tool and stalled state.
    fixture.state.driver_status.member_activity[0]!.progress_at = now - 121
    await expect(members.getByRole('status').first()).toContainText('Stalled')
    await shot('stalled')
    if (info.project.name === 'desktop') {
      for (const [name, width, height] of [['outer-portrait', 382, 580], ['outer-landscape', 594, 368], ['inner-split', 385, 571], ['inner-portrait', 669, 867], ['inner-landscape', 951, 585]] as const) {
        await page.setViewportSize({ width, height })
        await expect(members).toBeInViewport()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        const row = members.getByRole('listitem').first()
        expect(await row.evaluate((el) => el.getBoundingClientRect().height <= parseFloat(getComputedStyle(el).lineHeight) + 1)).toBe(true)
        await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toBeInViewport()
        await shot(name)
      }
    }
    fixture.state.driver_status.member_activity = [{ member_id: 'one', status: 'running' }]
    fixture.state.driver_status.max_rounds = undefined
    await expect(members.getByRole('listitem').first()).toHaveText('Writer · Answering')
    await expect(page.getByText('Round 2 of 3', { exact: true })).toHaveCount(0)
    await expect(members.locator('.live-run-elapsed')).toHaveCount(0)
    await shot('legacy')
  } finally { await page.goto('about:blank'); await server.close() }
})

async function discussionServer() {
  const sidecar = new FakeSidecar(), fixture = groupFixture(sidecar)
  const server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' }, deps: (deps) => {
    deps.profiles.list = () => Promise.resolve([{ name: 'default', is_default: true, display_name: 'Writer' }, { name: 'helper', display_name: 'Reviewer' }])
  } })
  return { sidecar, fixture, server }
}

test('replies in a chosen thread, retaining a refused draft and clearing a confirmed reply', async ({ page }, info) => {
  const { sidecar, fixture, server } = await discussionServer()
  fixture.append('message.user', 'Legacy message')
  fixture.discussion('Review this proposal', 'proposal-thread')
  const answer = fixture.append('message.member', 'Use the shared boundary', fixture.members[1])
  Object.assign(answer.payload, { thread_id: 'proposal-thread' })
  const native = sidecar.responderFor('gateway.groups')!
  let refuse = true
  let unknown = false, commit: (() => unknown) | undefined
  sidecar.respond('gateway.groups', (params, emit, options) => {
    if (params.operation.action !== 'send') return native(params, emit, options)
    if (refuse) return { state: 'refused', reason: 'refused', value: null }
    if (unknown) { commit = () => native(params, emit, options); return { state: 'unknown', reason: 'unknown', value: null } }
    return native(params, emit, options)
  })
  const evidence = process.env.TALARIA_GROUP_REPLY_EVIDENCE
  if (evidence) mkdirSync(evidence, { recursive: true })
  const shot = async (name: string) => { if (evidence) await page.screenshot({ path: `${evidence}/${name}-${info.project.name}.png` }) }
  try {
    await page.goto(`${server.base}/groups?room=discussion`)
    const legacy = page.locator('.msg-row').filter({ hasText: 'Legacy message' })
    const source = page.locator('.msg-row').filter({ hasText: 'Review this proposal' })
    const member = page.locator('.msg-row').filter({ hasText: 'Use the shared boundary' })
    const chip = page.locator('[data-notice="group-reply"]')
    await expect(member).toBeVisible()
    await shot('before')
    await expect(legacy.getByRole('button', { name: 'Reply in thread', exact: true })).toHaveCount(0)
    await expect(source.getByRole('button', { name: 'Reply in thread', exact: true })).toBeVisible()
    await member.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Reply in thread', exact: true }).click()
    await expect(chip).toContainText('Replying in thread')
    await page.locator('#msg').fill('Keep the same context')
    await shot('reply')
    if (info.project.name === 'desktop') {
      for (const [name, width, height] of [['outer-portrait', 382, 580], ['outer-landscape', 594, 368], ['inner-split', 385, 571], ['inner-portrait', 669, 867], ['inner-landscape', 951, 585]] as const) {
        await page.setViewportSize({ width, height })
        await expect(chip).toBeInViewport()
        await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeInViewport()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await shot(name)
      }
      await page.setViewportSize({ width: 1280, height: 800 })
    }
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(page.getByText('The Agent refused this discussion action.', { exact: true })).toBeVisible()
    await expect(page.locator('#msg')).toHaveValue('Keep the same context')
    await expect(chip).toContainText('Replying in thread')
    await shot('refused')
    refuse = false
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(chip).toHaveCount(0)
    await expect(page.locator('#msg')).toHaveValue('')
    await expect(page.getByText('Keep the same context', { exact: true })).toBeVisible()
    const sends = sidecar.calls.flatMap((call) => call.method === 'gateway.groups' && (call.params as { operation: { action: string } }).operation.action === 'send' ? [call.params] : [])
    expect(sends).toHaveLength(2)
    for (const send of sends) expect(send).toMatchObject({ operation: { payload: { thread_id: 'proposal-thread' } } })
    await shot('confirmed')
    await member.getByRole('button', { name: 'Reply in thread', exact: true }).click()
    await chip.getByRole('button', { name: 'Dismiss', exact: true }).click()
    await expect(chip).toHaveCount(0)
    unknown = true
    // A held pointer press must survive the empty phone composer's focus change.
    await source.getByRole('button', { name: 'Reply in thread', exact: true }).click({ delay: 75 })
    await expect(chip).toContainText('Replying in thread')
    await page.locator('#msg').fill('Wait for confirmation')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(page.getByText('Execution could not be confirmed. Refresh to reconcile.', { exact: true })).toBeVisible()
    await expect(chip).toContainText('Replying in thread')
    await commit!()
    await expect(chip).toHaveCount(0)
    fixture.state.driver_status.running = false
    await expect(source.getByRole('button', { name: 'Reply in thread', exact: true })).toHaveCount(0)
  } finally { await page.goto('about:blank'); await server.close() }
})

test('receipt refresh clears its submitted reply before the view or stream confirms it', async ({ page }, info) => {
  const { sidecar, fixture, server } = await discussionServer()
  fixture.discussion('Review this proposal', 'proposal-thread')
  const native = sidecar.responderFor('gateway.groups')!
  const viewRequested = Promise.withResolvers<undefined>(), releaseView = Promise.withResolvers<undefined>()
  let commit: (() => unknown) | undefined
  sidecar.respond('gateway.groups', (params, emit, options) => {
    if (params.operation.action !== 'send') return native(params, emit, options)
    commit = () => native(params, emit, options)
    return { state: 'unknown', reason: 'unknown', value: null }
  })
  await page.route('**/api/groups/stream?**', (route) => route.fulfill({ headers: { 'content-type': 'text/event-stream' }, body: 'retry: 1000\n\n' }))
  try {
    await page.goto(`${server.base}/groups?room=discussion`)
    await page.getByRole('button', { name: 'Reply in thread', exact: true }).click()
    const chip = page.locator('[data-notice="group-reply"]'), unknown = page.locator('[data-notice="unknown"]')
    await expect(chip).toContainText('Replying in thread')
    await page.locator('#msg').fill('Receipt-confirmed reply')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(unknown).toBeVisible()
    await page.screenshot({ path: info.outputPath('receipt-unknown.png') })
    await commit!()
    await page.route('**/api/groups/view?**', async (route) => {
      const response = await route.fetch()
      viewRequested.resolve(undefined)
      await releaseView.promise
      await route.fulfill({ response })
    })
    await unknown.getByRole('button', { name: 'Refresh', exact: true }).click()
    await viewRequested.promise
    await expect(unknown).toHaveCount(0)
    await expect(chip).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('receipt-confirmed.png') })
  } finally {
    releaseView.resolve(undefined)
    await page.unrouteAll({ behavior: 'wait' })
    await page.goto('about:blank')
    await server.close()
  }
})

test('the discussion list is the page, a primary nav entry, and a room opens with a way back', async ({ page }, info) => {
  const { fixture, server } = await discussionServer()
  const desktop = info.project.name === 'desktop'
  const offsets: string[] = []
  await page.route('**/api/groups?**', async (route) => {
    const offset = new URL(route.request().url()).searchParams.get('offset') ?? '0'
    offsets.push(offset)
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...await response.json() as object, next_offset: offset === '0' ? 5 : null } })
  })
  try {
    await page.goto(`${server.base}/groups`)
    const room = page.locator('#main [data-group-room="discussion"]').getByRole('link', { name: 'Design review', exact: true })
    await expect(room).toBeVisible()
    await expect(page.locator('#main').getByRole('heading', { level: 1, name: 'Discussions', exact: true })).toBeVisible()
    await expect(page.locator('#main .main-view-actions').getByRole('button', { name: 'New discussion', exact: true })).toBeEnabled()
    if (!desktop) await expect(page.locator('.sidebar.mobile-open')).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('list.png') })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.locator('#main').getByRole('button', { name: 'Next page', exact: true }).click()
    await expect.poll(() => offsets).toContain('5')
    await page.locator('#main').getByRole('button', { name: 'First page', exact: true }).click()
    await room.click()
    await expect(page).toHaveURL(/\/groups\?room=discussion$/)
    await expect(page.locator('#msg')).toBeVisible()
    await page.screenshot({ path: info.outputPath('discussion.png') })
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(page).toHaveURL(/\/groups$/)
    await expect(room).toBeVisible()
    await room.click()
    await expect(page.locator('#msg')).toBeVisible()
    await page.goBack()
    await expect(room).toBeVisible()
    if (desktop) {
      const rail = page.locator('aside.sidebar [data-panel="groups"]')
      await expect(rail).toHaveAttribute('aria-current', 'page')
      await room.click()
      await rail.click()
      await expect(page).toHaveURL(/\/groups$/)
      await page.goto(`${server.base}/`)
      await expect(page.locator('#panelChat')).toBeVisible()
      await expect(page.locator('#panelChat').getByRole('button', { name: 'Discussions', exact: true })).toHaveCount(0)
      await page.locator('aside.sidebar').getByRole('button', { name: 'More', exact: true }).click()
      await rail.click()
      await expect(page).toHaveURL(/\/groups$/)
      await page.goto(`${server.base}/settings/preferences`)
      await page.locator('#settingsHiddenTabs label', { hasText: 'Discussions' }).getByRole('switch').click()
      await expect(rail).toHaveCount(0)
    } else {
      await page.locator('.tabbar [data-tab="more"]').click()
      await page.locator('.tabbar-sheet').getByRole('menuitem', { name: 'Discussions', exact: true }).click()
      await expect(page).toHaveURL(/\/groups$/)
      await expect(page.locator('.tabbar [data-tab="more"]')).toHaveClass(/active/)
    }
    await page.goto(`${server.base}/groups`)
    await expect(room).toBeVisible()
    fixture.state.driver = false
    await page.reload()
    await expect(page.locator('#main').getByRole('status').filter({ hasText: 'Discussions are unavailable from the current Agent gateway.' })).toBeVisible()
  } finally { await page.goto('about:blank').catch(() => undefined); await server.close() }
})

test('creates a discussion, sends once, shows member replies and reconnects after reload', async ({ page }, info) => {
  const { sidecar, fixture, server } = await discussionServer()
  const evidence = process.env.TALARIA_GROUP_EVIDENCE
  try {
    if (evidence && process.env.TALARIA_GROUP_BASELINE_DIST) {
      const current = server.deps.spa
      server.deps.spa = new SpaShell(process.env.TALARIA_GROUP_BASELINE_DIST)
      await page.goto(`${server.base}/`)
      await expect(page.locator('#msg')).toBeVisible()
      mkdirSync(evidence, { recursive: true })
      await page.screenshot({ path: `${evidence}/before-${info.project.name}.png` })
      server.deps.spa = current
    }
    await page.goto(`${server.base}/groups`)
    const create = page.getByRole('button', { name: 'New discussion', exact: true })
    await expect(create).toBeEnabled()
    await create.click()
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Architecture discussion')
    await page.getByRole('checkbox', { name: 'Writer', exact: true }).check()
    await page.getByRole('checkbox', { name: 'Reviewer', exact: true }).check()
    await page.getByRole('dialog').getByRole('button', { name: 'New discussion', exact: true }).click()
    await expect(page.locator('#msg')).toBeVisible()
    await page.locator('#fileInput').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('note') })
    await expect(page.locator('.attach-tray [data-status=done]')).toHaveCount(1)
    await page.locator('#msg').fill('Review this proposal')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(page.locator('.msg-row[data-role=user]')).toHaveCount(1)
    await expect(page.locator('.msg-row[data-role=assistant]')).toHaveCount(2)
    await expect(page.locator('.msg-row[data-role=user]')).toHaveCount(1)
    await expect(page.getByRole('link', { name: 'note.txt', exact: true })).toBeVisible()
    await expect(page.getByText('First member reply', { exact: true })).toBeVisible()
    await expect(page.getByText('Second member reply', { exact: true })).toBeVisible()
    await expect(page.locator('.msg-role-name')).toHaveText(['Writer', 'Reviewer'])
    await expect(page.locator('.msg-role-name').first()).toBeVisible()
    if (info.project.name === 'mobile') {
      await expect(page.locator('.app-titlebar')).toBeInViewport()
      await expect(page.locator('.tabbar')).toBeInViewport()
    }
    for (const title of ['A long discussion name that must leave its actions reachable on a narrow screen', 'Architecture discussion']) {
      await page.getByRole('button', { name: 'Rename', exact: true }).click()
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill(title)
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect.poll(() => fixture.state.room.name).toBe(title)
      await expect(page.getByRole('button', { name: 'Disband', exact: true })).toBeInViewport()
    }
    await page.reload()
    await expect(page.getByText('First member reply', { exact: true })).toBeVisible()
    if (evidence) await page.screenshot({ path: `${evidence}/after-${info.project.name}.png` })
    const sends = sidecar.calls.filter((c) => c.method === 'gateway.groups' && (c.params as { operation: { action: string } }).operation.action === 'send')
    expect(sends).toHaveLength(1)
    const native = sidecar.responderFor('gateway.groups')
    if (!native) throw new Error('Native group fixture missing')
    sidecar.respond('gateway.groups', (params, emit, options) => params.operation.action === 'send' ? { state: 'unknown', reason: 'unknown', value: null } : native(params, emit, options))
    await page.locator('#msg').fill('Unknown admission')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(page.getByText('Execution could not be confirmed. Refresh to reconcile.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
    expect(sidecar.calls.filter((c) => c.method === 'gateway.groups' && (c.params as { operation: { action: string } }).operation.action === 'send')).toHaveLength(2)
    fixture.state.room.authority_epoch++
    await expect(page.getByText('Unknown admission', { exact: true })).toHaveCount(0)
    await expect(page.locator('#msg')).toHaveValue('')
    await page.locator('#msg').fill('Draft for the replacement owner')
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
    fixture.state.driver = false
    await expect(page.getByText('Discussions are unavailable from the current Agent gateway.', { exact: true }).last()).toBeVisible()
    expect(server.deps.registry.activeRuns.size).toBe(0)
  } finally { await page.goto('about:blank').catch(() => undefined); await server.close() }
})

test('labels a scheduled job\'s post by its job and leaves the person\'s own message unlabelled', async ({ page }, info) => {
  const { fixture, server } = await discussionServer()
  try {
    fixture.append('message.user', 'Typed by me')
    fixture.scheduled({ kind: 'user', id: 'cron:job42', display_name: 'Nightly' }, 'Report ready')
    await page.goto(`${server.base}/groups?room=discussion`)
    const post = page.locator('.msg-row[data-role=assistant]').filter({ hasText: 'Report ready' })
    await expect(post.locator('.msg-role-name')).toHaveText('Nightly')
    await expect(post.locator('.msg-role')).toContainText('Scheduled')
    const own = page.locator('.msg-row[data-role=user]').filter({ hasText: 'Typed by me' })
    await expect(own).toBeVisible()
    await expect(own).not.toContainText('Nightly')
    await expect(own).not.toContainText('Scheduled')
    if (process.env.TALARIA_GROUP_EVIDENCE) { mkdirSync(process.env.TALARIA_GROUP_EVIDENCE, { recursive: true }); await page.screenshot({ path: `${process.env.TALARIA_GROUP_EVIDENCE}/scheduled-${info.project.name}.png` }) }
  } finally { await page.goto('about:blank').catch(() => undefined); await server.close() }
})

test('shows a stalled room\'s wake failure and retries it optimistically, restoring Retry on refusal', async ({ page }, info) => {
  const { sidecar, fixture, server } = await discussionServer()
  const native = sidecar.responderFor('gateway.groups')!
  let hold: PromiseWithResolvers<undefined> | null = null
  sidecar.respond('gateway.groups', async (params, emit, options) => {
    if (params.operation.action === 'retry' && hold) await hold.promise
    return native(params, emit, options)
  })
  try {
    fixture.append('message.user', 'Review this')
    fixture.stall('Members could not be woken: profile helper not found')
    await page.goto(`${server.base}/groups?room=discussion`)
    await expect(page.locator('.msg-row[data-role=notice]')).toHaveText('Members could not be woken: profile helper not found')
    const retry = page.getByRole('button', { name: 'Retry', exact: true })
    await expect(retry).toBeVisible()
    if (process.env.TALARIA_GROUP_EVIDENCE) { mkdirSync(process.env.TALARIA_GROUP_EVIDENCE, { recursive: true }); await page.screenshot({ path: `${process.env.TALARIA_GROUP_EVIDENCE}/stalled-${info.project.name}.png` }) }
    fixture.state.refuseRetry = true
    const refused = hold = Promise.withResolvers<undefined>()
    await retry.click()
    await expect(retry).toHaveCount(0)
    refused.resolve(undefined)
    await expect(page.getByText('The Agent refused this discussion action.', { exact: true })).toBeVisible()
    await expect(retry).toBeVisible()
    fixture.state.refuseRetry = false; hold = null
    await retry.click()
    await expect(retry).toHaveCount(0)
    await expect.poll(() => fixture.state.driver_status.pending_actions).toEqual([])
    await expect(retry).toHaveCount(0)
  } finally { hold?.resolve(undefined); await page.goto('about:blank').catch(() => undefined); await server.close() }
})

const settingsWrites = (sidecar: FakeSidecar) => sidecar.calls.flatMap((c) => { const operation = (c.params as { operation?: { action: string; event_id?: string } }).operation; return c.method === 'gateway.groups' && operation?.action === 'context' ? [operation.event_id] : [] })
const fillSettings = async (page: Page, purpose: string, routing: string) => {
  await page.getByRole('button', { name: 'Discussion settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Discussion settings' })
  await dialog.getByRole('textbox', { name: 'Purpose', exact: true }).fill(purpose)
  await dialog.getByRole('radio', { name: routing, exact: true }).check()
  return dialog
}

test('saves a room\'s settings before the Agent answers and shows who its lead assigned', async ({ page }, info) => {
  const { sidecar, fixture, server } = await discussionServer()
  const native = sidecar.responderFor('gateway.groups')!
  let hold: PromiseWithResolvers<undefined> | null = null
  sidecar.respond('gateway.groups', async (params, emit, options) => {
    if (params.operation.action === 'context' && hold) await hold.promise
    return native(params, emit, options)
  })
  const shot = async (name: string) => { if (process.env.TALARIA_GROUP_EVIDENCE) { mkdirSync(process.env.TALARIA_GROUP_EVIDENCE, { recursive: true }); await page.screenshot({ path: `${process.env.TALARIA_GROUP_EVIDENCE}/${name}-${info.project.name}.png` }) } }
  try {
    fixture.append('message.user', 'Who should take this?')
    fixture.state.context = { purpose: '', notes: '', routing: 'lead', lead_member_id: 'one' }
    fixture.assignment('one', ['two'])
    fixture.assignment('one', ['one'], true)
    await page.goto(`${server.base}/groups?room=discussion`)
    const notices = page.locator('.msg-row[data-role=notice]')
    await expect(notices).toHaveText(['Writer gave this to Reviewer', 'Writer took this'])
    await expect(notices.locator('.text-warning')).toHaveCount(0)
    const strip = page.getByRole('list', { name: 'Members' })
    await expect(strip.getByRole('listitem').first()).toContainText('Writer · Lead')
    await shot('lead-assigned')

    const save = hold = Promise.withResolvers<undefined>()
    const dialog = await fillSettings(page, 'Ship the design review', 'Reviewer assigns each message')
    await dialog.getByRole('textbox', { name: 'Shared notes', exact: true }).fill('é'.repeat(2049))
    await expect(dialog.getByRole('alert')).toHaveText('Shared notes must fit in 4096 bytes.')
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await dialog.getByRole('textbox', { name: 'Shared notes', exact: true }).fill('Decisions live in the shared doc.')
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await shot('settings')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(strip.getByRole('listitem').last()).toContainText('Reviewer · Lead')
    await expect(strip.getByRole('listitem').first()).not.toContainText('Lead')
    save.resolve(undefined); hold = null
    await expect.poll(() => fixture.state.context).toEqual({ purpose: 'Ship the design review', notes: 'Decisions live in the shared doc.', routing: 'lead', lead_member_id: 'two' })
    await page.reload()
    await expect(strip.getByRole('listitem').last()).toContainText('Reviewer · Lead')
    await page.getByRole('button', { name: 'Discussion settings', exact: true }).click()
    await expect(dialog.getByRole('textbox', { name: 'Purpose', exact: true })).toHaveValue('Ship the design review')
    await expect(dialog.getByRole('radio', { name: 'Reviewer assigns each message', exact: true })).toBeChecked()
    await page.keyboard.press('Escape')

    fixture.state.contextOffered = false
    await page.reload()
    await expect(page.getByText('Who should take this?', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Discussion settings', exact: true })).toHaveCount(0)
    await expect(strip).not.toContainText('Lead')
  } finally { hold?.resolve(undefined); await page.goto('about:blank').catch(() => undefined); await server.close() }
})

test.describe('automatic routing', () => {
  test('renders advertised choices and picks, saving optimistically and rolling back a refusal', async ({ page }, info) => {
    const { sidecar, fixture, server } = await discussionServer()
    const native = sidecar.responderFor('gateway.groups')!
    let hold: PromiseWithResolvers<undefined> | null = null
    sidecar.respond('gateway.groups', async (params, emit, options) => {
      if (params.operation.action === 'context' && hold) await hold.promise
      return native(params, emit, options)
    })
    const evidence = process.env.TALARIA_GROUP_ROUTING_EVIDENCE
    const shot = async (name: string) => { if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: `${evidence}/${name}-${info.project.name}.png` }) } }
    const settings = page.getByRole('button', { name: 'Discussion settings', exact: true })
    const dialog = page.getByRole('dialog', { name: 'Discussion settings' })
    const automatic = dialog.getByRole('radio', { name: 'Automatic', exact: true })
    try {
      fixture.append('message.user', 'Review this proposal')
      await page.goto(`${server.base}/groups?room=discussion`)
      await settings.click()
      await expect(automatic).toHaveCount(0)
      await shot('before-settings')
      await page.keyboard.press('Escape')
      fixture.state.driver_status.routing_modes = ['everyone', 'lead', 'auto']
      fixture.gateway('room.routed', { member_ids: ['two'], everyone: false, fallback: false })
      fixture.gateway('room.routed', { member_ids: [], everyone: true, fallback: true })
      await page.reload()
      const notices = page.locator('.msg-row[data-role=notice]')
      await expect(notices).toHaveText(['Picked Reviewer'])
      await expect(notices.locator('.text-warning')).toHaveCount(0)
      await shot('picked')
      const save = hold = Promise.withResolvers<undefined>()
      await settings.click()
      await automatic.check()
      await shot('automatic-settings')
      await dialog.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      // Read the optimistic choice while the native response is still held.
      await settings.click()
      await expect(automatic).toBeChecked()
      await shot('optimistic')
      await page.keyboard.press('Escape')
      save.resolve(undefined); hold = null
      await expect.poll(() => fixture.state.context.routing).toBe('auto')
      await page.reload()
      await settings.click()
      await expect(automatic).toBeChecked()
      fixture.state.refuseContext = true
      await dialog.getByRole('radio', { name: 'Everyone', exact: true }).check()
      await dialog.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.getByText('The Agent refused this discussion action.', { exact: true })).toBeVisible()
      await expect(dialog.getByRole('radio', { name: 'Everyone', exact: true })).toBeChecked()
      await shot('refused-draft')
      await page.keyboard.press('Escape')
      await settings.click()
      await expect(automatic).toBeChecked()
      await shot('rollback')
      await page.keyboard.press('Escape')
      if (info.project.name === 'desktop') {
        await expect(page.getByText('The Agent refused this discussion action.', { exact: true })).toHaveCount(0)
        for (const [name, width, height] of [['outer-portrait', 382, 580], ['outer-landscape', 594, 368], ['inner-split', 385, 571], ['inner-portrait', 669, 867], ['inner-landscape', 951, 585]] as const) {
          await page.setViewportSize({ width, height })
          await page.mouse.move(0, 0)
          await page.keyboard.press('Tab')
          await expect(page.getByRole('tooltip')).toHaveCount(0)
          await expect(notices).toBeInViewport()
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          await shot(`room-${name}`)
          await settings.click()
          await automatic.scrollIntoViewIfNeeded()
          await expect(automatic).toBeInViewport()
          await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeInViewport()
          await shot(`settings-${name}`)
          await page.keyboard.press('Escape')
        }
      }
      fixture.state.driver_status.routing_modes = undefined
      await page.reload()
      await settings.click()
      await expect(automatic).toBeChecked()
      await expect(automatic).toBeDisabled()
      await shot('desktop-auto-without-modes')
    } finally { hold?.resolve(undefined); await page.goto('about:blank').catch(() => undefined); await server.close() }
  })
})

test('rolls a refused settings save back to its draft and retries a lost one with its event id', async ({ page }, info) => {
  const { sidecar, fixture, server } = await discussionServer()
  try {
    await page.goto(`${server.base}/groups?room=discussion`)
    // The open dialog hides the page from role queries, and the rollback is asserted behind it.
    const strip = page.locator('[aria-label="Members"]')
    await expect(strip).toContainText('Writer')
    await expect(strip).not.toContainText('Lead')

    fixture.state.refuseContext = true
    const dialog = await fillSettings(page, 'Refused purpose', 'Writer assigns each message')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('The Agent refused this discussion action.', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('textbox', { name: 'Purpose', exact: true })).toHaveValue('Refused purpose')
    await expect(dialog.getByRole('radio', { name: 'Writer assigns each message', exact: true })).toBeChecked()
    await expect(strip).not.toContainText('Lead')
    expect(fixture.state.context.purpose).toBe('')
    fixture.state.refuseContext = false

    fixture.state.lostContext = 'before'
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    const unknown = page.locator('[data-notice=context-unknown]')
    await expect(unknown).toContainText('This save could not be confirmed.')
    await expect(dialog).toHaveCount(0)
    await expect(strip).toContainText('Writer · Lead')
    if (process.env.TALARIA_GROUP_EVIDENCE) { mkdirSync(process.env.TALARIA_GROUP_EVIDENCE, { recursive: true }); await page.screenshot({ path: `${process.env.TALARIA_GROUP_EVIDENCE}/unknown-${info.project.name}.png` }) }
    fixture.state.lostContext = null
    await unknown.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(unknown).toHaveCount(0)
    await expect.poll(() => fixture.state.context.purpose).toBe('Refused purpose')
    expect(fixture.state.events.filter((e) => e.kind === 'room.context_set')).toHaveLength(1)
    const [refused, lost, retried] = settingsWrites(sidecar)
    expect(settingsWrites(sidecar)).toHaveLength(3)
    expect(retried).toBe(lost)
    expect(refused).not.toBe(lost)

    fixture.state.lostContext = 'before'
    await (await fillSettings(page, 'Lost then committed', 'Everyone')).getByRole('button', { name: 'Save', exact: true }).click()
    await expect(unknown).toBeVisible()
    await expect(strip).not.toContainText('Lead')
    fixture.state.lostContext = null
    fixture.state.context = { purpose: 'Lost then committed', notes: '', routing: 'everyone', lead_member_id: '' }
    await expect(unknown).toHaveCount(0)
  } finally { await page.goto('about:blank').catch(() => undefined); await server.close() }
})

test('shows a discussion paused at its cap and continues it optimistically, restoring Continue on refusal', async ({ page, errors }, info) => {
  const { sidecar, fixture, server } = await discussionServer()
  const native = sidecar.responderFor('gateway.groups')!
  let hold: PromiseWithResolvers<undefined> | null = null
  sidecar.respond('gateway.groups', async (params, emit, options) => {
    if (params.operation.action === 'continue' && hold) await hold.promise
    return native(params, emit, options)
  })
  const shot = async (name: string) => { if (process.env.TALARIA_GROUP_EVIDENCE) { mkdirSync(process.env.TALARIA_GROUP_EVIDENCE, { recursive: true }); await page.screenshot({ path: `${process.env.TALARIA_GROUP_EVIDENCE}/${name}-${info.project.name}.png` }) } }
  const grants = () => fixture.state.events.filter((event) => event.kind === 'room.continued').length
  try {
    const ask = fixture.discussion('Review this', 'thread')
    fixture.append('message.member', 'First take')
    fixture.activity(ask, 'thread')
    await page.goto(`${server.base}/groups?room=discussion`)
    const notice = page.locator('.msg-row[data-role=notice]')
    await expect(notice).toHaveText('Paused at the round limit')
    await expect(page.locator('.composer-notice')).toContainText('Paused at the round limit · 5 left')
    const resume = page.getByRole('button', { name: 'Continue', exact: true })
    await expect(resume).toBeEnabled()
    await shot('paused')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

    fixture.state.driver_status.member_activity = [{ member_id: 'one', status: 'stopping' }]
    await expect(resume).toBeDisabled()
    await shot('stop-pending')
    fixture.state.driver_status.member_activity = []
    await expect(resume).toBeEnabled()

    fixture.state.refuseContinue = true
    const refused = hold = Promise.withResolvers<undefined>()
    await resume.click()
    await expect(resume).toHaveCount(0)
    await expect(notice).toHaveCount(0)
    await shot('continued')
    refused.resolve(undefined)
    await expect(page.getByText('The Agent refused this discussion action.', { exact: true })).toBeVisible()
    await expect(resume).toBeVisible()
    await expect(notice).toBeVisible()
    fixture.state.refuseContinue = false; hold = null

    // The gateway never took it: the log still reads paused, so Continue comes back and nothing was granted.
    fixture.state.lostContinue = 'dropped'
    await resume.click()
    await expect(page.getByText('Execution could not be confirmed. Refresh to reconcile.', { exact: true })).toBeVisible()
    await expect(resume).toBeVisible()
    expect(grants()).toBe(0)
    fixture.state.lostContinue = null

    // The response is lost after the grant landed: the log reads continued, so Continue stays gone with one grant.
    await page.route('**/api/groups/action', async (route) => { await route.fetch(); await route.abort() })
    await resume.click()
    await expect.poll(grants).toBe(1)
    await expect(notice).toHaveCount(0)
    await expect(page.locator('.composer-notice')).toHaveCount(0)
    await page.unroute('**/api/groups/action')
    expect(grants()).toBe(1)
    errors.splice(0, errors.length, ...errors.filter((error) => !error.includes('net::ERR_FAILED')))

    fixture.activity(ask, 'thread', 'max_messages')
    await expect(notice).toHaveText('Paused at the reply limit')
    await expect(page.locator('.composer-notice')).toContainText('Paused at the reply limit · 4 left')
    fixture.state.continueMethod = false
    // The room observer keeps capabilities for 30 seconds.
    const nowSeconds = server.deps.nowSeconds
    server.deps.nowSeconds = () => nowSeconds() + 30
    await expect(resume).toHaveCount(0)
    await expect(notice).toBeVisible()
  } finally { hold?.resolve(undefined); await page.goto('about:blank').catch(() => undefined); await server.close() }
})

for (const refusal of ['receipt', 'http'] as const) test(`restores a ${refusal}-refused send when reconciliation reads fail`, async ({ page, errors }) => {
  const { server } = await discussionServer()
  let reads = 0
  try {
    await page.goto(`${server.base}/groups?room=discussion`)
    await expect(page.locator('#msg')).toBeVisible()
    await page.locator('#fileInput').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('note') })
    await expect(page.locator('.attach-tray [data-status=done]')).toHaveCount(1)
    await page.route('**/api/groups/view?**', (route) => { reads++; return route.fulfill({ status: 503, json: { error: 'Synthetic read failure' } }) })
    await page.route('**/api/groups/receipt?**', (route) => { reads++; return route.fulfill({ status: 503, json: { error: 'Synthetic read failure' } }) })
    await page.route('**/api/groups/action', (route) => route.fulfill(refusal === 'http' ? { status: 403, json: { error: 'Synthetic write refusal' } } : { json: { outcome: 'refused', reason: 'refused', room_id: 'discussion', event_id: null, attachment: null } }))
    await page.locator('#msg').fill('Refused with a file')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(page.locator('#msg')).toHaveValue('Refused with a file')
    await expect(page.locator('.attach-tray [data-status=done]')).toHaveCount(1)
    await expect(page.locator('.msg-row[data-role=user]')).toHaveCount(0)
    expect(reads).toBe(0)
    if (refusal === 'http') errors.splice(0, errors.length, ...errors.filter((error) => error !== `403 POST ${server.base}/api/groups/action`))
  } finally { await page.goto('about:blank').catch(() => undefined); await server.close() }
})

for (const timing of ['response delayed', 'unknown then committed'] as const) test(`converges one submitted occurrence from the stream: ${timing}`, async ({ page }) => {
  const { sidecar, fixture, server } = await discussionServer()
  const release = Promise.withResolvers<undefined>(), submitted = Promise.withResolvers<undefined>()
  const native = sidecar.responderFor('gateway.groups')!
  let commit: (() => unknown) | undefined
  if (timing === 'unknown then committed') sidecar.respond('gateway.groups', (params, emit, options) => {
    if (params.operation.action !== 'send') return native(params, emit, options)
    commit = () => native(params, emit, options)
    return { state: 'unknown', reason: 'unknown', value: null }
  })
  try {
    // A previous equal-text occurrence must never confirm this submission.
    fixture.append('message.user', 'Same text')
    await page.goto(`${server.base}/groups?room=discussion`)
    await expect(page.locator('#msg')).toBeVisible()
    if (timing === 'response delayed') await page.route('**/api/groups/action', async (route) => {
      const response = await route.fetch()
      submitted.resolve(undefined)
      await release.promise
      await route.fulfill({ response })
    })
    await page.locator('#msg').fill('Same text')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    if (timing === 'unknown then committed') {
      await expect(page.getByText('Execution could not be confirmed. Refresh to reconcile.', { exact: true })).toBeVisible()
      await expect(page.locator('.msg-row[data-role=user]')).toHaveCount(2)
      await commit!()
    } else await submitted.promise
    await expect(page.locator('.msg-row[data-role=assistant]')).toHaveCount(2)
    await expect(page.locator('.msg-row[data-role=user]')).toHaveCount(2)
    await expect(page.getByText('Execution could not be confirmed. Refresh to reconcile.', { exact: true })).toHaveCount(0)
    await page.locator('#msg').fill('Next occurrence')
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
    expect(sidecar.calls.filter((c) => c.method === 'gateway.groups' && (c.params as { operation: { action: string } }).operation.action === 'send')).toHaveLength(1)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(() => sidecar.calls.filter((c) => c.method === 'gateway.groups' && (c.params as { operation: { action: string } }).operation.action === 'send').length).toBe(2)
  } finally { release.resolve(undefined); await page.goto('about:blank').catch(() => undefined); await server.close() }
})

for (const observed of ['Submitted title', 'Superseding title']) test(`retires an unknown rename after authoritative revision: ${observed}`, async ({ page }) => {
  const { sidecar, fixture, server } = await discussionServer()
  const native = sidecar.responderFor('gateway.groups')!
  sidecar.respond('gateway.groups', (params, emit, options) => params.operation.action === 'rename' ? { state: 'unknown', reason: 'unknown', value: null } : native(params, emit, options))
  try {
    await page.goto(`${server.base}/groups?room=discussion`)
    await page.getByRole('button', { name: 'Rename', exact: true }).click()
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Submitted title')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.locator('[data-notice=rename-unknown]')).toBeVisible()
    fixture.state.room.name = observed
    fixture.state.room.revision++
    await expect(page.locator('[data-notice=rename-unknown]')).toHaveCount(0)
    fixture.state.room.name = 'Renamed from another browser'
    fixture.state.room.revision++
    await expect(page.getByText('Renamed from another browser', { exact: true })).toBeVisible()
  } finally { await page.goto('about:blank').catch(() => undefined); await server.close() }
})

test('keeps draft files and uploads across unavailable snapshots but resets a replaced owner', async ({ page }) => {
  const { sidecar, fixture, server } = await discussionServer()
  const native = sidecar.responderFor('gateway.groups')!
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  sidecar.respond('gateway.groups', async (params, emit, options) => {
    if (params.operation.action === 'attachment.upload' && params.operation.name === 'uploading.txt') {
      entered.resolve(undefined)
      await release.promise
    }
    return native(params, emit, options)
  })
  try {
    await page.goto(`${server.base}/groups?room=discussion`)
    await expect(page.locator('#msg')).toBeVisible()
    await page.locator('#fileInput').setInputFiles({ name: 'done.txt', mimeType: 'text/plain', buffer: Buffer.from('done') })
    await expect(page.locator('.attach-tray [data-status=done]')).toHaveCount(1)
    await page.locator('#fileInput').setInputFiles({ name: 'uploading.txt', mimeType: 'text/plain', buffer: Buffer.from('uploading') })
    await entered.promise
    await expect(page.locator('.attach-tray [data-status=uploading]')).toHaveCount(1)
    await page.locator('#msg').fill('Draft with two files')
    fixture.state.available = false
    await expect(page.getByText('Discussions are unavailable from the current Agent gateway.', { exact: true }).last()).toBeVisible()
    await expect(page.locator('#msg')).toHaveValue('Draft with two files')
    await expect(page.locator('.attach-tray [data-status=done]')).toHaveCount(1)
    await expect(page.locator('.attach-tray [data-status=uploading]')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
    fixture.state.available = true
    release.resolve(undefined)
    await expect(page.getByText('Discussions are unavailable from the current Agent gateway.', { exact: true })).toHaveCount(0)
    await expect(page.locator('.attach-tray [data-status=done]')).toHaveCount(2)
    await expect(page.locator('#msg')).toHaveValue('Draft with two files')
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
    fixture.state.room.authority_epoch++
    await expect(page.locator('.attach-tray [data-status=done]')).toHaveCount(0)
    await expect(page.locator('#msg')).toHaveValue('')
  } finally { fixture.state.available = true; release.resolve(undefined); await page.goto('about:blank').catch(() => undefined); await server.close() }
})
