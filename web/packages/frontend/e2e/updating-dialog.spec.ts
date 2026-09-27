import type { Page } from '@playwright/test'
import { expect, settle, test } from './fixtures'

// Service-worker requests bypass page routing; these fixtures own every update response and never install anything.
test.use({ serviceWorkers: 'block' })

type Phase = 'applying' | 'awaiting_confirmation' | 'restarting' | 'succeeded' | 'blocked' | 'failed' | 'unknown'
const MESSAGES: Record<Phase, string> = {
  applying: 'Installing the selected Talaria Web update.',
  awaiting_confirmation: 'This Hermes Agent revision needs confirmation before it can be installed.',
  restarting: 'The update is installed. Talaria Web is restarting.',
  succeeded: 'Talaria Web was updated successfully.',
  blocked: 'The update is waiting for active work to finish.',
  failed: 'The update could not be completed. Open System settings for details.',
  unknown: 'The connection closed before completion could be verified. Check the installed version before trying again.',
}

/** A synthetic server record for one update operation; `message` stands in for the server's wording. */
const record = (id: string, phase: Phase, target: 'webui' | 'agent' = 'webui') => ({
  id, kind: 'update', target, phase, severity: phase === 'failed' || phase === 'unknown' ? 'critical' : 'info',
  persistent: false, requires_acknowledgement: false, actions: [], destination: { key: 'settings.system', label: 'Open System settings' },
  title: target === 'webui' ? 'Talaria Web update' : 'Hermes Agent update',
  message: target === 'webui' ? MESSAGES[phase] : MESSAGES[phase].replace('Talaria Web', 'Hermes Agent'),
  created_at: '2026-09-27T12:00:00Z', updated_at: `2026-09-27T12:0${Object.keys(MESSAGES).indexOf(phase)}:00Z`,
  read_at: null, acknowledged_at: null, acknowledged_action_id: null, verified_revision: null, verified_version: null,
  unread: true, active: phase === 'applying' || phase === 'restarting', requires_interaction: false, can_dismiss: true,
})
type Row = ReturnType<typeof record>

/** The notification read endpoint, reachable or not, answering this tab's `tab_update` from test-owned state. */
async function serveNotifications(page: Page) {
  const state = { up: true, scope: 'owner-a', tabUpdate: null as Row | null, reads: 0 }
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
      unread_count: state.tabUpdate ? 1 : 0, clearable_count: state.tabUpdate ? 1 : 0, can_clear: state.tabUpdate !== null,
    } })
  })
  return state
}

async function serveUpdatesCheck(page: Page, updates: { web: number; agent: number }) {
  await page.route('**/api/updates/check', (route) => route.fulfill({ json: { cached: true, webui: { behind: updates.web }, agent: { behind: updates.agent } } }))
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
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused()
  expect(applies).toEqual([expect.objectContaining({ target: 'webui', tab_id: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/) })])
  // Reduced motion (the Playwright default here) stops the spinner after one near-instant iteration.
  expect(await dialog.locator('.animate-spin').evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).animationIterationCount))).toEqual(['1'])

  server.tabUpdate = record(WEB_ID, 'applying')
  await expect(dialog).toContainText(MESSAGES.applying)
  server.tabUpdate = record(WEB_ID, 'restarting')
  await expect(dialog).toContainText(MESSAGES.restarting)

  server.up = false
  dropApply()
  await expect(dialog.getByRole('status')).toContainText('Reconnecting')
  await expect(dialog).toContainText(MESSAGES.restarting)
  await page.screenshot({ path: testInfo.outputPath('updating-reconnecting.png') })
  const box = await dialog.boundingBox()
  const viewport = page.viewportSize()!
  expect(box && box.x >= 0 && box.x + box.width <= viewport.width && box.y >= 0 && box.y + box.height <= viewport.height).toBe(true)

  // Browser offline, then online: the server's record answers at once, and the dialog never guessed success meanwhile.
  await context.setOffline(true)
  server.up = true
  server.tabUpdate = record(WEB_ID, 'succeeded')
  await expect(dialog.getByRole('status')).toContainText('Reconnecting')
  await expect(dialog).not.toContainText(MESSAGES.succeeded)
  await context.setOffline(false)
  await expect(dialog).toContainText(MESSAGES.succeeded, { timeout: 1_900 })
  await expect(dialog.getByRole('status')).not.toContainText('Reconnecting')
  await page.screenshot({ path: testInfo.outputPath('updating-succeeded.png') })

  expect(applies).toHaveLength(1)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await page.reload()
  await settle(page)
  await expect(dialog).toBeHidden()
  dropExpectedFailures(errors)
})

test('an unverifiable outcome says so and checks again without starting another update', async ({ page, errors }) => {
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
  expect(server.reads).toBeGreaterThan(reads)
  expect(applies).toBe(1)
  dropExpectedFailures(errors)
})

test('closing before the server record arrives keeps that operation closed across a reload', async ({ page }) => {
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
  await expect(dialog).toBeHidden()
  const reads = server.reads
  await expect.poll(() => server.reads).toBeGreaterThan(reads + 1)
  await expect(dialog).toBeHidden()
  await page.reload()
  await settle(page)
  const after = server.reads
  await expect.poll(() => server.reads).toBeGreaterThan(after + 1)
  await expect(dialog).toBeHidden()
})

test('the dialog follows the server operation across route change and reload, and clears for another owner', async ({ page }) => {
  const server = await serveNotifications(page)
  await serveUpdatesCheck(page, { web: 1, agent: 0 })
  server.tabUpdate = record(WEB_ID, 'applying')
  await page.goto('/settings/system')
  await settle(page)
  const dialog = page.getByRole('dialog', { name: 'Updating Talaria Web' })
  await expect(dialog).toContainText(MESSAGES.applying)

  await page.evaluate(() => { history.pushState({}, '', '/'); dispatchEvent(new PopStateEvent('popstate')) })
  await expect(page).toHaveURL(/\/$/)
  await expect(dialog).toContainText(MESSAGES.applying)
  await page.reload()
  await settle(page)
  await expect(dialog).toContainText(MESSAGES.applying)

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
      server.tabUpdate = record(id, 'awaiting_confirmation', 'agent')
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
  await expect(updating).toContainText(MESSAGES.applying.replace('Talaria Web', 'Hermes Agent'))
  expect(bodies.at(-1)).toMatchObject({ target: 'agent', confirmed_agent_revision: 'b'.repeat(40) })
  releaseSecond()
  await expect(updating).toContainText('Hermes Agent was updated successfully.')
  expect(bodies).toHaveLength(3)
  await updating.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(updating).toBeHidden()
})
