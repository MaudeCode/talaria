import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import type { UpdateNotification } from '../src/contracts'
import { expect, settle, test } from './fixtures'
import { updatesCheckView } from '../../server/dist/tools/updates.js'

// Service-worker requests bypass page routing; these fixtures own every update response and never install anything.
test.use({ serviceWorkers: 'block', video: 'on' })

type Phase = 'applying' | 'awaiting_confirmation' | 'restarting' | 'succeeded' | 'blocked' | 'failed' | 'unknown'
const MESSAGES: Record<Phase, string> = {
  applying: 'Installing the selected Talaria Web update.',
  awaiting_confirmation: 'This Hermes Agent revision needs confirmation before it can be installed.',
  restarting: 'The update is installed. Talaria Web is restarting.',
  succeeded: 'Talaria Web was updated successfully.',
  blocked: 'The update is waiting for active work to finish.',
  failed: 'The update could not be completed.',
  unknown: 'The connection closed before completion could be verified. Check the installed version before trying again.',
}

/** TAL-1138: the steps the server lists for each target, and the label its last step takes once the update succeeded. */
const STEPS = {
  webui: { ids: ['install', 'web_restart', 'ready'], labels: ['Installing', 'Restarting Talaria Web', 'Ready'], done: 'Talaria Web 1.2.3 is ready' },
  agent: { ids: ['install', 'web_restart', 'gateway_restart', 'agent_ready'], labels: ['Installing', 'Restarting Talaria Web', 'Restarting gateway', 'Agent responding'], done: 'Hermes Agent 0.22.1 is running' },
} as const
const AT: Record<Phase, number> = { applying: 0, awaiting_confirmation: 0, restarting: 1, succeeded: 9, blocked: 0, failed: 0, unknown: 1 }
type Row = UpdateNotification

/** A synthetic server record for one update operation; `message`, steps, and dialog fields stand in for the server's. */
const record = (id: string, phase: Phase, target: 'webui' | 'agent' = 'webui'): Row => {
  const plan = STEPS[target]
  const presents = phase === 'applying' || phase === 'restarting'
  const failed = phase === 'failed' || phase === 'blocked' || phase === 'unknown'
  return {
    id, kind: 'update', target, phase, severity: phase === 'failed' || phase === 'unknown' ? 'critical' : 'info',
    persistent: false, requires_acknowledgement: false, actions: [], destination: phase === 'failed' ? null : { key: 'settings.system', label: 'Open System settings' },
    title: target === 'webui' ? 'Talaria Web update' : 'Hermes Agent update',
    message: target === 'webui' ? MESSAGES[phase] : MESSAGES[phase].replace('Talaria Web', 'Hermes Agent'),
    created_at: '2026-09-27T12:00:00Z', updated_at: `2026-09-27T12:0${String(Object.keys(MESSAGES).indexOf(phase))}:00Z`,
    read_at: null, acknowledged_at: null, acknowledged_action_id: null, verified_revision: null, verified_version: null, detail: null,
    unread: true, active: presents, requires_interaction: false, can_dismiss: true,
    steps: plan.ids.map((stepId, index) => ({
      id: stepId, label: phase === 'succeeded' && index === plan.ids.length - 1 ? plan.done : plan.labels[index]!,
      state: index < AT[phase] ? 'done' : index > AT[phase] ? 'pending' : failed ? 'failed' : 'active',
    })),
    presents_dialog: presents, dialog_close: presents ? 'none' : phase === 'succeeded' ? 'auto' : 'close',
  }
}
/** The Web update this tab started has finished while the tab still runs the old build: Reload is the dialog's only way out. */
const ready = (id: string): Row => ({ ...record(id, 'succeeded'), presents_dialog: true, dialog_close: 'none', actions: [{ id: 'reload', label: 'Reload', style: 'primary', acknowledges: false }] })

/** The notification read endpoint, reachable or not, answering this tab's `tab_update` from test-owned state. */
async function serveNotifications(page: Page) {
  const state = { up: true, scope: 'owner-a', tabUpdate: null as Row | null, joinedAt: null as string | null, reads: 0 }
  await page.route('**/api/update-notifications**', (route) => {
    const request = route.request()
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/cancel')) {
      if (state.tabUpdate) state.tabUpdate = { ...state.tabUpdate, phase: 'blocked', message: 'The update was cancelled before installation.' }
      return route.fulfill({ json: state.tabUpdate })
    }
    if (request.method() !== 'GET') return route.fulfill({ json: state.tabUpdate })
    if (!state.up) return route.abort('connectionrefused')
    state.reads += 1
    return route.fulfill({ json: {
      scope_id: state.scope, frontend_build: { current_build: null, loaded_build: null, refresh_required: false, notification_id: null },
      notifications: state.tabUpdate ? [state.tabUpdate] : [], tab_update: state.tabUpdate,
      tab_joined_at: state.tabUpdate ? state.joinedAt ?? state.tabUpdate.created_at : null,
      unread_count: state.tabUpdate ? 1 : 0, clearable_count: state.tabUpdate ? 1 : 0, can_clear: state.tabUpdate !== null,
    } })
  })
  return state
}

async function serveUpdatesCheck(page: Page, updates: { web: number; agent: number }) {
  await page.route('**/api/updates/check', (route) => route.fulfill({ json: updatesCheckView({ cached: true, webui: { behind: updates.web }, agent: { behind: updates.agent } }) }))
}

/** Dropped connections are this test's subject; their console noise is expected. */
function dropExpectedFailures(errors: string[]) {
  errors.splice(0, errors.length, ...errors.filter((line) => !/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_INTERNET_DISCONNECTED/.test(line)))
}

const WEB_ID = '00000000-0000-4000-8000-000000000101'

test('a dropped Web update keeps the dialog reconnecting, then shows the server outcome without a second apply', async ({ page, context, errors }, testInfo) => {
  const server = await serveNotifications(page)
  await serveUpdatesCheck(page, { web: 1, agent: 1 })
  const applies: unknown[] = []
  let dropApply!: () => void
  const dropped = new Promise<void>((resolve) => { dropApply = resolve })
  await page.route('**/api/updates/apply', async (route) => {
    applies.push(route.request().postDataJSON())
    await dropped
    await route.abort('connectionreset')
  })
  await page.goto('/settings/system')
  await settle(page)

  await page.getByRole('button', { name: 'Update Web', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Updating Talaria Web' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('status')).toContainText('Starting the update')
  // TAL-1138: an update in progress cannot be closed.
  await expect(dialog.getByRole('button')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  // The dialog opens before the request is sent, so wait for the route to see it.
  await expect.poll(() => applies).toEqual([expect.objectContaining({ target: 'webui', tab_id: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/) })])
  // Reduced motion (the Playwright default here) stops the spinner after one near-instant iteration.
  expect(await dialog.locator('.animate-spin').evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).animationIterationCount))).toEqual(['1'])

  server.tabUpdate = record(WEB_ID, 'applying')
  await expect(dialog.locator('[aria-current="step"]')).toHaveText('Installing')
  server.tabUpdate = record(WEB_ID, 'restarting')
  await expect(dialog.locator('[aria-current="step"]')).toHaveText('Restarting Talaria Web')

  server.up = false
  dropApply()
  await expect(dialog.getByRole('status')).toContainText('Reconnecting')
  await expect(dialog.locator('[aria-current="step"]')).toHaveText('Restarting Talaria Web')
  await page.screenshot({ path: testInfo.outputPath('updating-reconnecting.png') })
  const box = await dialog.boundingBox()
  const viewport = page.viewportSize()!
  expect(box && box.x >= 0 && box.x + box.width <= viewport.width && box.y >= 0 && box.y + box.height <= viewport.height).toBe(true)

  // Browser offline, then online: the server's record answers at once, and the dialog never guessed success meanwhile.
  await context.setOffline(true)
  server.up = true
  server.tabUpdate = ready(WEB_ID)
  await expect(dialog.getByRole('status')).toContainText('Reconnecting')
  await expect(dialog).not.toContainText(STEPS.webui.done)
  await context.setOffline(false)
  await expect(dialog).toContainText(STEPS.webui.done, { timeout: 1_900 })
  await expect(dialog.getByRole('status')).not.toContainText('Reconnecting')
  await expect(dialog.getByRole('button')).toHaveText(['Reload'])
  await page.screenshot({ path: testInfo.outputPath('updating-succeeded.png') })

  expect(applies).toHaveLength(1)
  // Reload loads the new build; the server then no longer presents the finished update to this tab.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  server.tabUpdate = record(WEB_ID, 'succeeded')
  await dialog.getByRole('button', { name: 'Reload', exact: true }).click()
  await page.waitForLoadState('load')
  await settle(page)
  await expect(dialog).toBeHidden()
  dropExpectedFailures(errors)
})

test('an unverifiable outcome says so and checks again without starting another update', async ({ page, errors }, testInfo) => {
  await page.clock.install()
  const server = await serveNotifications(page)
  await serveUpdatesCheck(page, { web: 1, agent: 1 })
  let applies = 0
  await page.route('**/api/updates/apply', (route) => { applies += 1; return route.abort('connectionreset') })
  await page.goto('/settings/system')
  await settle(page)

  await page.getByRole('button', { name: 'Update Web', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Updating Talaria Web' })
  await expect(dialog.getByRole('status')).toContainText('The outcome could not be verified')
  await expect(dialog).not.toContainText(MESSAGES.succeeded)
  const reads = server.reads
  server.tabUpdate = record(WEB_ID, 'failed')
  await dialog.getByRole('button', { name: 'Check again', exact: true }).click()
  await expect(dialog).toContainText(MESSAGES.failed)
  await expect(dialog).not.toContainText('Open System settings')
  expect(server.reads).toBeGreaterThan(reads)
  // The server keeps the apply's own explanation on the record; the dialog shows it, line breaks included.
  server.tabUpdate = { ...record(WEB_ID, 'failed'), detail: 'npm run build failed.\nRun `npm ci` in web/ and press Update again.', updated_at: '2026-09-27T12:20:00Z' }
  await page.clock.runFor(30_000)
  await expect(dialog).toContainText('npm run build failed.')
  await expect(dialog.getByText(/Run `npm ci` in web\//)).toBeVisible()
  expect(await dialog.getByText(/Run `npm ci` in web\//).evaluate((node) => getComputedStyle(node).whiteSpace)).toBe('pre-line')
  await page.screenshot({ path: testInfo.outputPath('updating-failed.png') })
  expect(applies).toBe(1)
  dropExpectedFailures(errors)
})

test('an update in progress keeps its dialog open, across a reload, until the server stops presenting it', async ({ page }) => {
  await page.clock.install()
  const server = await serveNotifications(page)
  await serveUpdatesCheck(page, { web: 1, agent: 0 })
  await page.route('**/api/updates/apply', async (route) => {
    server.tabUpdate = record(WEB_ID, 'applying')
    await new Promise((resolve) => { setTimeout(resolve, 4_000) })
    await route.fulfill({ json: { ok: true, restart_scheduled: true, notification_id: WEB_ID } }).catch(() => undefined)
  })
  await page.goto('/settings/system')
  await settle(page)
  await page.getByRole('button', { name: 'Update Web', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Updating Talaria Web' })
  await expect(dialog.getByRole('status')).toContainText('Starting the update')
  await page.keyboard.press('Escape')
  await expect(dialog.locator('[aria-current="step"]')).toHaveText('Installing')
  await page.reload()
  await settle(page)
  await expect(dialog.locator('[aria-current="step"]')).toHaveText('Installing')
  server.tabUpdate = { ...record(WEB_ID, 'failed'), detail: 'npm run build failed.' }
  await page.clock.runFor(30_000)
  await expect(dialog).toContainText('npm run build failed.')
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toBeHidden()
  await page.reload()
  await settle(page)
  const after = server.reads
  await page.clock.runFor(60_000)
  await expect.poll(() => server.reads).toBeGreaterThan(after + 1)
  await expect(dialog).toBeHidden()
})

test('rejoining the gateway wait the tab already follows shows it even when the response is lost', async ({ page, errors }, testInfo) => {
  await page.clock.install()
  const server = await serveNotifications(page)
  await serveUpdatesCheck(page, { web: 0, agent: 1 })
  const WAIT_ID = '00000000-0000-4000-8000-000000000120'
  server.tabUpdate = {
    ...record(WAIT_ID, 'awaiting_confirmation', 'agent'), phase: 'waiting_for_idle', message: 'Waiting for 2 running gateway tasks to finish before restarting the gateway.', can_dismiss: false,
    actions: [{ id: 'restart_gateway_now', label: 'Restart now', style: 'destructive', acknowledges: false }], dialog_close: 'restart_later',
    steps: [
      { id: 'install', label: 'Installing', state: 'done' }, { id: 'web_restart', label: 'Restarting Talaria Web', state: 'done' },
      { id: 'gateway_wait', label: 'Waiting for 2 gateway tasks', state: 'active' }, { id: 'gateway_restart', label: 'Restarting gateway', state: 'pending' },
      { id: 'agent_ready', label: 'Agent responding', state: 'pending' },
    ],
  }
  server.joinedAt = '2026-09-27T12:00:00Z'
  let applies = 0
  await page.route('**/api/updates/apply', (route) => {
    applies += 1
    // The server rejoins the waiting record (only this tab's join time changes), then the response is lost.
    server.joinedAt = '2026-09-27T12:05:00Z'
    return route.abort('connectionreset')
  })
  await page.goto('/settings/system')
  await settle(page)
  const dialog = page.getByRole('dialog', { name: 'Updating Hermes Agent' })
  // A wait the tab left with Restart later does not reopen by itself.
  await expect(dialog).toBeHidden()

  await page.getByRole('button', { name: 'Update Agent', exact: true }).click()
  await expect(dialog.locator('[aria-current="step"]')).toHaveText('Waiting for 2 gateway tasks')
  const reads = server.reads
  await page.clock.runFor(60_000)
  await expect.poll(() => server.reads).toBeGreaterThan(reads + 1)
  await expect(dialog.getByRole('status')).not.toContainText('could not be verified')
  await expect(dialog.getByRole('button')).toHaveText(['Restart later', 'Restart now'])
  await page.screenshot({ path: testInfo.outputPath('updating-gateway-wait.png') })
  await dialog.getByRole('button', { name: 'Restart later', exact: true }).click()
  await expect(dialog).toBeHidden()
  expect(applies).toBe(1)
  dropExpectedFailures(errors)
})

test('the dialog follows the server operation across route change and reload, and clears for another owner', async ({ page }) => {
  const server = await serveNotifications(page)
  await serveUpdatesCheck(page, { web: 1, agent: 0 })
  server.tabUpdate = record(WEB_ID, 'applying')
  await page.goto('/settings/system')
  await settle(page)
  const dialog = page.getByRole('dialog', { name: 'Updating Talaria Web' })
  await expect(dialog.locator('[aria-current="step"]')).toHaveText('Installing')

  await page.evaluate(() => { history.pushState({}, '', '/'); dispatchEvent(new PopStateEvent('popstate')) })
  await expect(page).toHaveURL(/\/$/)
  await expect(dialog.locator('[aria-current="step"]')).toHaveText('Installing')
  await page.reload()
  await settle(page)
  await expect(dialog.locator('[aria-current="step"]')).toHaveText('Installing')

  server.scope = 'owner-b'
  server.tabUpdate = null
  await expect(dialog).toBeHidden()
})

test('the Agent confirmation can cancel or continue without claiming success, and Web stays independent', async ({ page }) => {
  const server = await serveNotifications(page)
  await serveUpdatesCheck(page, { web: 1, agent: 1 })
  const AGENT_ID = '00000000-0000-4000-8000-000000000200'
  const bodies: Record<string, unknown>[] = []
  let releaseSecond!: () => void
  const second = new Promise<void>((resolve) => { releaseSecond = resolve })
  await page.route('**/api/updates/apply', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    bodies.push(body)
    // A cancelled record is terminal, so the server creates a new one for the next attempt.
    const id = `${AGENT_ID.slice(0, -1)}${bodies.length}`
    if (!body.confirmed_agent_revision) {
      server.tabUpdate = { ...record(id, 'awaiting_confirmation', 'agent'), message: 'Active dashboard work may be interrupted by a graceful refresh.' }
      return route.fulfill({ json: { ok: false, confirmation_required: true, candidate_revision: 'b'.repeat(40), supported_revision: 'a'.repeat(40), supported_version: '0.21.3', agent_channel: 'stable', notification_id: id } })
    }
    const awaiting = server.tabUpdate!.id
    server.tabUpdate = { ...record(awaiting, 'applying', 'agent'), updated_at: '2026-09-27T12:10:00Z' }
    await second
    server.tabUpdate = { ...record(awaiting, 'succeeded', 'agent'), updated_at: '2026-09-27T12:11:00Z' }
    return route.fulfill({ json: { ok: true, notification_id: awaiting } })
  })
  await page.goto('/settings/system')
  await settle(page)
  const updating = page.getByRole('dialog', { name: 'Updating Hermes Agent' })
  const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog', { name: 'Unsupported Agent version' }))

  await page.getByRole('button', { name: 'Update Agent', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Update anyway', exact: true })).toBeVisible()
  await expect(updating).toBeHidden()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(confirm).toBeHidden()
  await expect(updating).toBeHidden()
  await page.waitForTimeout(2_500)
  await expect(updating).toBeHidden()
  await expect(page.getByRole('button', { name: 'Update Web', exact: true })).toBeEnabled()

  await page.getByRole('button', { name: 'Update Agent', exact: true }).click()
  await page.getByRole('button', { name: 'Update anyway', exact: true }).click()
  await expect(updating.locator('[aria-current="step"]')).toHaveText('Installing')
  expect(bodies.at(-1)).toMatchObject({ target: 'agent', confirmed_agent_revision: 'b'.repeat(40) })
  releaseSecond()
  // The outcome shows briefly, then the dialog closes by itself.
  await expect(updating).toContainText(STEPS.agent.done)
  expect(bodies).toHaveLength(3)
  await expect(updating).toBeHidden()
})

test('legacy dashboard confirmation supports cancel, retry and update continuation', async ({ page }, testInfo) => {
  const server = await serveNotifications(page)
  await serveUpdatesCheck(page, { web: 0, agent: 1 })
  const applies: Record<string, unknown>[] = []
  const id = '00000000-0000-4000-8000-000000000110'
  const revision = 'b'.repeat(40)
  const refreshToken = 'c'.repeat(32)
  await page.route('**/api/updates/apply', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    applies.push(body)
    if (applies.length === 1) {
      const message = 'synthetic.dashboard running backend lifecycle APIs are unsupported. Finish active work, then have the owner gracefully refresh this service through its original supervisor.'
      server.tabUpdate = { ...record(id, 'failed', 'agent'), detail: message }
      return route.fulfill({ json: { ok: false, message, notification_id: id } })
    }
    if (!body.agent_refresh_token) {
      server.tabUpdate = { ...record(id, 'awaiting_confirmation', 'agent'), message: 'Active dashboard work may be interrupted by a graceful refresh.' }
      return route.fulfill({ json: { ok: false, confirmation_required: true, candidate_revision: revision, agent_channel: 'stable', refresh_confirmation: { token: refreshToken, services: ['synthetic.dashboard'] }, notification_id: id } })
    }
    expect(body.agent_refresh_token).toBe(refreshToken)
    expect(body.confirmed_agent_revision).toBeUndefined()
    server.tabUpdate = record(id, 'succeeded', 'agent')
    return route.fulfill({ json: { ok: true, verified_revision: revision, notification_id: id } })
  })
  await page.goto('/settings/system')
  await settle(page)
  await page.getByRole('button', { name: 'Update Agent', exact: true }).click()
  const progress = page.getByRole('dialog', { name: 'Updating Hermes Agent' })
  await expect(progress).toContainText('original supervisor')
  await page.screenshot({ path: testInfo.outputPath('before-legacy-refusal.png') })
  await progress.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Update Agent', exact: true }).click()
  const confirmation = page.getByRole('alertdialog', { name: 'Refresh legacy dashboard?' })
  await expect(confirmation).toContainText('Active dashboard work may be interrupted')
  await expect(confirmation).toContainText('synthetic.dashboard')
  await page.screenshot({ path: testInfo.outputPath('after-legacy-confirmation.png') })
  const box = await confirmation.boundingBox()
  const viewport = page.viewportSize()!
  expect(box && box.x >= 0 && box.x + box.width <= viewport.width && box.y >= 0 && box.y + box.height <= viewport.height).toBe(true)
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(applies).toHaveLength(2)
  await page.getByRole('button', { name: 'Update Agent', exact: true }).click()
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button', { name: 'Refresh and update', exact: true }).click()
  await expect(progress).toContainText(STEPS.agent.done)
  expect(await page.locator('.notification-toast').filter({ hasText: 'Active dashboard work may be interrupted' }).count()).toBe(0)
  await page.screenshot({ path: testInfo.outputPath('after-legacy-completed.png') })
  expect(applies).toHaveLength(4)
})


test.describe('adaptive notification cadence', () => {
  test('idle discovery, open inbox and update progress keep the same visible outcomes (TAL-1246)', async ({ page }, testInfo) => {
    await page.clock.install()
    const server = await serveNotifications(page)
    await serveUpdatesCheck(page, { web: 1, agent: 0 })
    await page.route('**/api/updates/apply', (route) => {
      server.tabUpdate = record(WEB_ID, 'applying')
      return route.fulfill({ json: { ok: true, notification_id: WEB_ID } })
    })
    await page.goto('/settings/system')
    await settle(page)
    const idleReads = server.reads
    await page.clock.runFor(20_000)
    expect(server.reads).toBe(idleReads)
    server.tabUpdate = { ...record(WEB_ID, 'failed'), unread: false }
    await page.clock.runFor(10_000)
    await expect.poll(() => server.reads).toBe(idleReads + 1)
    const dialog = page.getByRole('dialog', { name: 'Updating Talaria Web' })
    await expect(dialog).toBeHidden()
    await page.getByRole('button', { name: 'Notifications', exact: true }).click()
    const inbox = page.getByRole('dialog', { name: 'Notifications', exact: true })
    await expect(inbox).toContainText(MESSAGES.failed)
    await page.clock.runFor(4_500)
    await page.screenshot({ path: testInfo.outputPath('polling-inbox.png') })
    const openReads = server.reads
    await page.clock.runFor(2_000)
    await expect.poll(() => server.reads).toBeGreaterThan(openReads)
    await inbox.getByRole('button', { name: 'Close', exact: true }).click()
    const closedReads = server.reads
    await page.clock.runFor(20_000)
    expect(server.reads).toBe(closedReads)

    await page.getByRole('button', { name: 'Update Web', exact: true }).click()
    await expect(dialog.locator('[aria-current="step"]')).toHaveText('Installing')
    await page.screenshot({ path: testInfo.outputPath('polling-active.png') })
    server.tabUpdate = record(WEB_ID, 'restarting')
    await page.clock.runFor(2_000)
    await expect(dialog.locator('[aria-current="step"]')).toHaveText('Restarting Talaria Web')
    server.tabUpdate = record(WEB_ID, 'failed')
    await page.clock.runFor(2_000)
    await expect(dialog).toContainText(MESSAGES.failed)
    await page.screenshot({ path: testInfo.outputPath('polling-terminal.png') })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    const finishedReads = server.reads
    await page.clock.runFor(20_000)
    expect(server.reads).toBe(finishedReads)
    await expect(dialog).toBeHidden()
  })
})


test('the original Agent modal stays open through automatic recovery and reconnect', async ({ page }, testInfo) => {
  await page.clock.install()
  const server = await serveNotifications(page)
  await serveUpdatesCheck(page, { web: 0, agent: 1 })
  const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/update-notifications.json', import.meta.url), 'utf8')) as { notifications: Row[] }
  const recovering = { ...fixture.notifications[0]!, id: WEB_ID }
  let applies = 0
  await page.route('**/api/updates/apply', (route) => {
    applies += 1
    server.tabUpdate = recovering
    return route.fulfill({ json: { ok: false, recovery_pending: true, notification_id: WEB_ID } })
  })
  await page.goto('/settings/system')
  await settle(page)
  await page.getByRole('button', { name: 'Update Agent', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Updating Hermes Agent' })
  await expect(dialog.locator('[aria-current="step"]')).toHaveText('Attempting recovery')
  await expect(dialog.getByRole('button')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('after-attempting-recovery.png') })
  await page.reload()
  await settle(page)
  await expect(dialog.locator('[aria-current="step"]')).toHaveText('Attempting recovery')
  await expect(dialog.getByRole('button')).toHaveCount(0)
  server.tabUpdate = { ...recovering, phase: 'failed', active: false, presents_dialog: false, dialog_close: 'close',
    message: 'The requested update failed. Automatic recovery rolled back to the previous revision, v1.0.0.',
    detail: 'The requested update failed. Automatic recovery rolled back to the previous revision, v1.0.0.\nSynthetic gateway resume failed.',
    steps: recovering.steps.map((step) => ({ ...step, label: step.id === 'agent_ready' ? 'Hermes Agent v1.0.0 is running' : step.label, state: step.id === 'gateway_restart' ? 'failed' : 'done' })),
    updated_at: '2026-10-23T12:00:00Z' }
  await page.clock.runFor(2_000)
  await expect(dialog).toContainText('rolled back to the previous revision, v1.0.0')
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('after-recovered-baseline.png') })
  expect(applies).toBe(1)
})
