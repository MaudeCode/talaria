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
  const pick = async () => { await composer.fill('/model muse-spark-1.2-contributor'); await page.getByRole('button', { name: 'Send message', exact: true }).click() }
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
