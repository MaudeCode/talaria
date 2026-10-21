import { test, expect } from '@playwright/test'
import { settle } from './fixtures'

test.use({ serviceWorkers: 'block', video: 'on' })

test('guarded model switch preserves the selection until confirmation', async ({ page, request }, info) => {
  await expect.poll(async () => {
    const health = await request.get('/health')
    return (await health.json() as { agent: { status: string } }).agent.status
  }).toBe('ready')
  const created = await request.post('/api/session/new', { data: { model: 'old-model', model_provider: 'custom' } })
  expect(created.ok()).toBe(true)
  const { session } = await created.json() as { session: { session_id: string } }
  const model = async () => {
    const res = await request.get(`/api/session?session_id=${session.session_id}`)
    return (await res.json() as { session: { model: string } }).session.model
  }
  await page.goto(`/session/${session.session_id}`)
  await settle(page)
  await expect(page.locator('#composerModelChip')).toContainText('old-model')
  const composer = page.locator('#msg')
  await expect(composer).toBeVisible()
  await composer.click()
  await page.screenshot({ path: info.outputPath('before.png') })
  const pick = async () => {
    const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/session/update' && r.request().method() === 'POST')
    await composer.fill('/model muse-spark-1.2-contributor')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const refused = await response
    expect(refused.status(), await refused.text()).toBe(409)
  }
  await pick()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('LARGE CONTEXT MODEL SWITCH')
  expect(await model()).toBe('old-model')
  await page.screenshot({ path: info.outputPath('after.png') })
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(await model()).toBe('old-model')
  await pick()
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(model).toBe('muse-spark-1.2-contributor')
  await page.screenshot({ path: info.outputPath('confirmed.png') })
})

test('native model outcomes keep the committed selection and require the owner confirmation', async ({ page, request }, info) => {
  const created = await request.post('/api/session/new', { data: { model: 'old-model', model_provider: 'custom' } })
  expect(created.ok()).toBe(true)
  const { session } = await created.json() as { session: { session_id: string } }
  await page.addInitScript(() => localStorage.removeItem('hermes-boot:queries'))
  let change: Record<string, unknown> | undefined
  let committed = 'old-model'
  const owner = () => ({ state: 'attached', reason: null, can_submit: true, can_interrupt: false, can_attach: false,
    revision: 8, execution_generation: 3, admissions: [], ...(change ? { model_change: change } : {}) })
  await page.route('**/api/session?*', async (route) => {
    const response = await route.fetch()
    const body = await response.json() as { session: Record<string, unknown> }
    await route.fulfill({ response, json: { ...body, session: { ...body.session, model: committed, read_only: true, owner_attachment: owner() } } })
  })
  const actions: Record<string, unknown>[] = []
  await page.route('**/api/chat/owner-action', async (route) => {
    const body = route.request().postDataJSON() as { payload: Record<string, unknown> }
    actions.push(body)
    if (body.payload.confirm === 'native-token') { committed = 'picked'; change = { state: 'applied' } }
    else change = { state: 'confirmation_required', message: 'This model may train on your conversation.', confirm: 'native-token', model: 'picked', provider: 'custom' }
    const response = await request.get(`/api/session?session_id=${session.session_id}`)
    const current = await response.json() as { session: Record<string, unknown> }
    await route.fulfill({ json: { ok: true, model_change: change, session: { ...current.session, model: committed, read_only: true, owner_attachment: owner() } } })
  })
  await page.goto(`/session/${session.session_id}`)
  await settle(page)
  const composer = page.locator('#msg')
  await expect(composer).toBeVisible()
  await page.screenshot({ path: info.outputPath('native-before.png') })
  await composer.fill('/model picked')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(() => actions.length).toBe(1)
  await page.screenshot({ path: info.outputPath('native-guard.png') })
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('This model may train on your conversation.')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.locator('#composerModelChip')).toContainText('old-model')
  await expect(dialog).toHaveCount(0)
  change = { state: 'deferred', model: 'picked' }
  await page.reload(); await settle(page)
  await expect(page.locator('[data-notice="model-change"] .composer-notice-content')).toBeVisible()
  await page.screenshot({ path: info.outputPath('native-deferred.png') })
  change = { state: 'confirmation_required', message: 'This model may train on your conversation.', confirm: 'native-token', model: 'picked', provider: 'custom' }
  await page.reload(); await settle(page)
  await expect(dialog).toBeVisible()
  await page.screenshot({ path: info.outputPath('native-confirmation.png') })
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('#composerModelChip')).toContainText('picked')
  expect((actions.at(-1) as { payload: Record<string, unknown> }).payload).toMatchObject({ model: 'picked', provider: 'custom', confirm: 'native-token' })
  await page.screenshot({ path: info.outputPath('native-applied.png') })
  change = { state: 'refused', message: 'model_resolution_failed' }
  await page.reload(); await settle(page)
  await expect(page.getByText('model_resolution_failed', { exact: true }).first()).toBeVisible()
  await page.screenshot({ path: info.outputPath('native-refused.png') })
})
