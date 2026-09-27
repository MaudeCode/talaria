import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

interface NotificationRow {
  id: string
  kind: string
  target: 'webui' | 'agent' | null
  phase: string
  severity: 'info' | 'warning' | 'critical'
  persistent: boolean
  requires_acknowledgement: boolean
  actions: { id: string; label: string; style: 'default' | 'primary' | 'destructive'; acknowledges: boolean }[]
  destination: { key: string; label: string } | null
  title: string
  message: string
  created_at: string
  updated_at: string
  read_at: string | null
  acknowledged_at: string | null
  acknowledged_action_id: string | null
  verified_revision: string | null
  verified_version: string | null
  unread: boolean
  active: boolean
  requires_interaction: boolean
  can_dismiss: boolean
}

const row = (id: string, overrides: Partial<NotificationRow> = {}): NotificationRow => ({
  id, kind: 'system', target: null, phase: 'notice', severity: 'info', persistent: false,
  requires_acknowledgement: false, actions: [], destination: { key: 'settings.system', label: 'Open System settings' },
  title: 'Server notice', message: 'A notification arrived.', created_at: '2026-09-26T12:00:00Z', updated_at: '2026-09-26T12:00:00Z',
  read_at: null, acknowledged_at: null, acknowledged_action_id: null, verified_revision: null, verified_version: null,
  unread: true, active: false, requires_interaction: false, can_dismiss: true,
  ...overrides,
})

test('server notification interactions preserve canonical read, clear, action, scope, and lifecycle behavior', async ({ page }) => {
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
  const dismissedPopup = page.locator('.notification-toast').filter({ hasText: 'Dismiss me' })
  await expect(dismissedPopup).toBeVisible()
  await dismissedPopup.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(dismissedPopup).toBeHidden()
  await expect.poll(() => readIDs).toContain('00000000-0000-4000-8000-000000000001')
  expect(records[0]?.unread).toBe(false)

  records = [row('00000000-0000-4000-8000-000000000002', { title: 'Expire unread' })]
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
  const lifecyclePopup = page.locator('.notification-toast').filter({ hasText: 'Talaria Web update' })
  await expect(lifecyclePopup).toContainText('Installing.')
  records = [{ ...lifecycle, phase: 'succeeded', active: false, message: 'Talaria Web was updated successfully.', updated_at: '2026-09-26T12:02:00Z' }]
  await expect(lifecyclePopup).toContainText('updated successfully')
})
