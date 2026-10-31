import { readFileSync } from 'node:fs'
import type { UpdateNotification } from '../src/contracts'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** These records model automatic updates and notices: none presents an Updating dialog (TAL-1138). */
type NotificationRow = Omit<UpdateNotification, 'kind' | 'phase'> & { kind: string; phase: string }

const row = (id: string, overrides: Partial<NotificationRow> = {}): NotificationRow => ({
  id, kind: 'system', target: null, phase: 'notice', severity: 'info', persistent: false,
  requires_acknowledgement: false, actions: [], destination: { key: 'settings.system', label: 'Open System settings' },
  title: 'Server notice', message: 'A notification arrived.', created_at: '2026-09-26T12:00:00Z', updated_at: '2026-09-26T12:00:00Z',
  read_at: null, acknowledged_at: null, acknowledged_action_id: null, verified_revision: null, verified_version: null, detail: null,
  unread: true, active: false, requires_interaction: false, can_dismiss: true,
  steps: [], presents_dialog: false, dialog_close: 'close',
  ...overrides,
})

test('Agent startup warning appears in the notification center and can be dismissed (TAL-1018)', async ({ page }, testInfo) => {
  const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/update-notifications.json', import.meta.url), 'utf8')) as { notifications: NotificationRow[] }
  const warning = fixture.notifications.find((item) => item.kind === 'agent_warning')!
  let records: NotificationRow[] = []
  const envelope = () => ({ scope_id: 'startup-warning-scope', notifications: records, unread_count: records.filter((item) => item.unread).length, clearable_count: records.length, can_clear: records.length > 0 })
  await page.route('**/api/update-notifications**', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: envelope() })
    if (new URL(route.request().url()).pathname.endsWith('/dismiss')) {
      records = []
      return route.fulfill({ json: { ok: true } })
    }
    return route.fulfill({ json: records[0] ?? warning })
  })
  await page.goto('/')
  await settle(page)
  await page.getByRole('button', { name: 'Notifications', exact: true }).click()
  const center = page.getByRole('dialog')
  await expect(center).not.toContainText(warning.title)
  await page.screenshot({ path: testInfo.outputPath('startup-warning-before.png'), fullPage: true })
  records = [warning]
  await expect(center).toContainText(warning.title)
  await expect(center).toContainText(warning.message)
  await page.screenshot({ path: testInfo.outputPath('startup-warning-after.png'), fullPage: true })
  await center.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(center).not.toContainText(warning.title)
  expect(records).toEqual([])
})

test('Agent recovery preserves failed update history in the shared notification center', async ({ page }, testInfo) => {
  const failed = row('00000000-0000-4000-8000-000000000081', { kind: 'update', target: 'agent', phase: 'failed', title: 'Hermes Agent update', message: 'The update could not be completed.', destination: null, detail: 'Gateway resume remained unverified.' })
  let records = [failed]
  await page.route('**/api/update-notifications**', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { scope_id: 'recovery-scope', notifications: records, tab_update: null, tab_joined_at: null, unread_count: records.length, clearable_count: records.length, can_clear: true } })
    return route.fulfill({ json: records.find((item) => route.request().url().includes(item.id)) ?? failed })
  })
  await page.goto('/')
  await settle(page)
  await page.getByRole('button', { name: 'Notifications', exact: true }).click()
  const center = page.getByRole('dialog')
  await expect(center).toContainText('The update could not be completed.')
  await page.screenshot({ path: testInfo.outputPath('agent-recovery-before.png'), fullPage: true })
  const recovery = row('00000000-0000-4000-8000-000000000082', { kind: 'agent_recovery', target: 'agent', phase: 'blocked', title: 'Hermes Agent recovery', message: 'Hermes Agent recovery will retry automatically.', destination: null, detail: 'The recorded gateway identity is temporarily unavailable.' })
  records = [recovery, failed]
  await expect(center).toContainText(recovery.message)
  await page.screenshot({ path: testInfo.outputPath('agent-recovery-waiting.png'), fullPage: true })
  records = [{ ...recovery, phase: 'unknown', severity: 'warning', message: 'Agent recovery was interrupted. Current readiness has not been verified.', detail: null, updated_at: '2026-09-26T12:01:00Z' }, failed]
  await expect(center).toContainText('Current readiness has not been verified.')
  await page.screenshot({ path: testInfo.outputPath('agent-recovery-interrupted.png'), fullPage: true })
  records = [{ ...recovery, phase: 'succeeded', message: 'Hermes Agent is usable again. The original update result is unchanged.', detail: null, updated_at: '2026-09-26T12:02:00Z' }, failed]
  await expect(center).toContainText('Hermes Agent is usable again.')
  await expect(center).toContainText('The update could not be completed.')
  await expect(center).not.toContainText('was updated successfully')
  await page.screenshot({ path: testInfo.outputPath('agent-recovery-after.png'), fullPage: true })
})

test('server notification interactions preserve canonical read, clear, action, scope, and lifecycle behavior', async ({ page }, testInfo) => {
  await page.clock.install()
  let scopeID = 'scope-a'
  let records: NotificationRow[] = []
  const readIDs: string[] = []
  const envelope = () => ({
    scope_id: scopeID,
    notifications: records,
    unread_count: records.filter((item) => item.unread).length,
    clearable_count: records.filter((item) => item.can_dismiss).length,
    can_clear: records.some((item) => item.can_dismiss),
  })

  await page.route('**/api/update-notifications**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === 'GET') return route.fulfill({ json: envelope() })
    if (path.endsWith('/clear')) {
      records = records.filter((item) => !item.can_dismiss)
      return route.fulfill({ json: envelope() })
    }
    const id = path.split('/')[3] ?? ''
    const index = records.findIndex((item) => item.id === id)
    if (index < 0) return route.fulfill({ status: 404, json: { error: 'missing' } })
    if (path.endsWith('/read')) {
      readIDs.push(id)
      records[index] = { ...records[index]!, unread: false, read_at: '2026-09-26T12:01:00Z' }
      return route.fulfill({ json: records[index] })
    }
    if (path.includes('/actions/')) {
      readIDs.push(id)
      records[index] = { ...records[index]!, unread: false, read_at: '2026-09-26T12:01:00Z', acknowledged_at: '2026-09-26T12:01:00Z', acknowledged_action_id: 'acknowledge', requires_interaction: false, can_dismiss: true }
      return route.fulfill({ json: records[index] })
    }
    if (path.endsWith('/dismiss')) {
      records = records.filter((item) => item.id !== id)
      return route.fulfill({ json: { ok: true } })
    }
    return route.fulfill({ status: 400, json: { error: 'unexpected' } })
  })

  await page.goto('/')
  await settle(page)

  records = [row('00000000-0000-4000-8000-000000000001', { title: 'Dismiss me' })]
  await page.clock.runFor(30_000)
  const dismissedPopup = page.locator('.notification-toast').filter({ hasText: 'Dismiss me' })
  await expect(dismissedPopup).toBeVisible()
  await dismissedPopup.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(dismissedPopup).toBeHidden()
  await expect.poll(() => readIDs).toContain('00000000-0000-4000-8000-000000000001')
  expect(records[0]?.unread).toBe(false)

  records = [row('00000000-0000-4000-8000-000000000002', { title: 'Expire unread' })]
  await page.clock.runFor(30_000)
  const expiredPopup = page.locator('.notification-toast').filter({ hasText: 'Expire unread' })
  await expect(expiredPopup).toBeVisible()
  await expect(expiredPopup).toBeHidden({ timeout: 8_000 })
  expect(records[0]?.unread).toBe(true)

  const urgent = row('00000000-0000-4000-8000-000000000003', {
    title: 'Action required', message: 'Acknowledge this alert.', severity: 'critical', persistent: true,
    requires_acknowledgement: true, actions: [{ id: 'acknowledge', label: 'Acknowledge', style: 'primary', acknowledges: true }],
    requires_interaction: true, can_dismiss: false,
  })
  records = [urgent]
  await page.clock.runFor(30_000)
  const urgentPopup = page.locator('.notification-toast').filter({ hasText: 'Action required' })
  await expect(urgentPopup).toBeVisible()
  await urgentPopup.getByRole('button', { name: 'Open System settings', exact: true }).click()
  await expect(page).toHaveURL(/\/settings\/system$/)
  await expect(urgentPopup).toBeVisible()
  await expect.poll(() => records[0]?.unread).toBe(false)
  await urgentPopup.getByRole('button', { name: 'Acknowledge', exact: true }).click()
  await expect(urgentPopup).toBeHidden()
  expect(records[0]).toMatchObject({ unread: false, requires_interaction: false, can_dismiss: true })

  const required = row('00000000-0000-4000-8000-000000000004', {
    title: 'Keep me', severity: 'critical', persistent: true, requires_acknowledgement: true,
    actions: [{ id: 'acknowledge', label: 'Acknowledge', style: 'primary', acknowledges: true }], requires_interaction: true, can_dismiss: false,
  })
  records = [required, row('00000000-0000-4000-8000-000000000005', { title: 'Clear me' })]
  await page.goto('/')
  const requiredPopup = page.locator('.notification-toast').filter({ hasText: 'Keep me' })
  await expect(requiredPopup).toBeVisible()
  await page.getByRole('button', { name: 'Notifications', exact: true }).click()
  const center = page.getByRole('dialog')
  await expect(center.getByText('Keep me')).toBeVisible()
  await expect.poll(() => readIDs.filter((id) => id === required.id || id === '00000000-0000-4000-8000-000000000005').length).toBe(2)
  await center.getByRole('button', { name: 'Clear all', exact: true }).click()
  await expect(center.getByText('Clear me')).toBeHidden()
  await expect(center.getByText('Keep me')).toBeVisible()
  await expect(center.getByRole('button', { name: 'Clear all', exact: true })).toBeDisabled()
  expect(records.map((item) => item.id)).toEqual([required.id])

  scopeID = 'scope-b'
  records = []
  await expect(requiredPopup).toBeHidden()
  await center.getByRole('button', { name: 'Close', exact: true }).click()

  const lifecycle = row('00000000-0000-4000-8000-000000000006', { kind: 'update', target: 'webui', phase: 'applying', active: true, title: 'Talaria Web update', message: 'Installing.' })
  records = [lifecycle]
  await page.clock.runFor(30_000)
  const lifecyclePopup = page.locator('.notification-toast').filter({ hasText: 'Talaria Web update' })
  await expect(lifecyclePopup).toContainText('Installing.')
  records = [{ ...lifecycle, phase: 'succeeded', active: false, message: 'Talaria Web was updated successfully.', updated_at: '2026-09-26T12:02:00Z' }]
  await expect(lifecyclePopup).toContainText('updated successfully')

  for (const target of ['webui', 'agent'] as const) {
    const title = target === 'webui' ? 'Talaria Web update' : 'Hermes Agent update'
    records = [{ ...lifecycle, id: target === 'webui' ? lifecycle.id : '00000000-0000-4000-8000-000000000007', target, title, phase: 'failed', active: false, severity: 'critical', destination: null,
      message: 'The update could not be completed.', detail: 'Build failed.\nTry again.', updated_at: '2026-09-26T12:03:00Z' }]
    await page.clock.runFor(30_000)
    const popup = page.locator('.notification-toast').filter({ hasText: title })
    await expect(popup).toContainText('The update could not be completed.')
    await expect(popup.getByRole('button', { name: 'Open System settings', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Notifications', exact: true }).click()
    await expect(center).toContainText('The update could not be completed.')
    const detail = center.getByText('Build failed.\nTry again.')
    await expect(detail).toBeVisible()
    expect(await detail.evaluate((node) => getComputedStyle(node).whiteSpace)).toBe('pre-line')
    await expect(center.getByRole('button', { name: 'Open System settings', exact: true })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`failed-${target}.png`) })
    await center.getByRole('button', { name: 'Close', exact: true }).click()
  }
})

test('rail captions fit under their icons; the bell keeps its full accessible name (TAL-1643)', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'The rail is desktop-only')
  await page.route('**/api/update-notifications**', (route) => route.fulfill({ json: { scope_id: 'rail-scope', notifications: [], unread_count: 0, clearable_count: 0, can_clear: false } }))
  await page.goto('/')
  await settle(page)
  const bell = page.locator('.rail').getByRole('button', { name: 'Notifications', exact: true })
  await expect(bell).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  const captions = await page.locator('.rail .rail-btn.has-tooltip').evaluateAll((nodes) => {
    const ctx = document.createElement('canvas').getContext('2d')!
    return nodes.map((node) => {
      const s = getComputedStyle(node, '::after')
      const text = s.content.startsWith('attr(') ? node.getAttribute('data-tooltip') ?? '' : JSON.parse(s.content) as string
      ctx.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`
      ctx.letterSpacing = s.letterSpacing
      const room = parseFloat(s.maxWidth) - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight)
      return { text, fits: ctx.measureText(text).width <= room }
    })
  })
  await page.locator('.rail').screenshot({ path: testInfo.outputPath('rail-captions.png') })
  expect(captions.filter((caption) => !caption.fits)).toEqual([])
})
