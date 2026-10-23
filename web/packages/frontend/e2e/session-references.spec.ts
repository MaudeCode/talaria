import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { serverState } from './server'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

test('selects earlier conversations and retains accepted references on lazy creation', async ({ page, request }, info) => {
  const title = `Parser decisions ${info.project.name}`
  const imported = await request.post('/api/session/import', { data: { title, messages: [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }] } })
  expect(imported.ok()).toBe(true)
  const { session: source } = await imported.json() as { session: { session_id: string } }
  // The replay sidecar never writes Agent state.db. Own this synthetic retained source explicitly.
  const db = new DatabaseSync(join(serverState('open'), 'state.db'))
  db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, title TEXT, started_at REAL, parent_session_id TEXT, ended_at REAL, end_reason TEXT); CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL)')
  db.prepare('INSERT INTO sessions (id, source, title, started_at) VALUES (?, ?, ?, ?)').run(source.session_id, 'webui', title, Date.now() / 1000)
  db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(source.session_id, 'assistant', 'Earlier answer', Date.now() / 1000)
  db.close()
  await page.route('**/api/session/execution-modes', (route) => route.fulfill({ json: { modes: [
    { mode: 'normal', available: true, reason: null, can_attach: true, can_reference: true },
    { mode: 'safe', available: true, reason: null, can_attach: false, can_reference: false },
  ] } }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Earlier conversations', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('searchbox').fill(title)
  await dialog.getByRole('checkbox', { name: new RegExp(title) }).click()
  await expect(dialog.getByText('1 of 5 selected')).toBeVisible()
  const evidence = (name: string) => process.env.TAL1359_EVIDENCE ? `${process.env.TAL1359_EVIDENCE}/${name}-${info.project.name}.png` : info.outputPath(`${name}.png`)
  await page.screenshot({ path: evidence('picker') })
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.getByRole('button', { name: `Remove ${title}` })).toBeVisible()
  await page.locator('#msg').fill('Keep this draft')
  await page.locator('.composer-execution-mode-chip').click()
  await page.getByRole('menuitemradio', { name: 'Safe mode', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Earlier conversations', exact: true })).not.toBeAttached()
  await expect(page.getByRole('button', { name: `Remove ${title}` })).not.toBeAttached()
  await expect(page.locator('#msg')).toHaveValue('Keep this draft')
  await page.screenshot({ path: evidence('diagnostic') })
  await page.locator('.composer-execution-mode-chip').click()
  await page.getByRole('menuitemradio', { name: 'Normal', exact: true }).click()
  await page.getByRole('button', { name: 'Earlier conversations', exact: true }).click()
  await expect(dialog.getByText('0 of 5 selected')).toBeVisible()
  await dialog.getByRole('checkbox', { name: new RegExp(title) }).click()
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  // File attachment uses the real lazy creation path, with no model call.
  const created = page.waitForResponse((res) => res.url().endsWith('/api/session/new') && res.request().method() === 'POST')
  await page.locator('#fileInput').setInputFiles({ name: 'reference.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic attachment') })
  const response = await created
  expect(response.ok()).toBe(true)
  const body = response.request().postDataJSON() as { source_references: unknown[]; request_id: string; worktree: boolean }
  expect(body.source_references).toEqual([{ session_id: source.session_id, tip_session_id: source.session_id, profile: 'default' }])
  expect(body.request_id).toBeTruthy()
  expect(body.worktree).toBe(false)
  await expect(page.getByTestId('session-references').getByRole('link', { name: title })).toBeVisible()
  await expect(page.locator('#msg')).toBeVisible()
  await page.screenshot({ path: evidence('accepted') })
  if (info.project.name === 'desktop') {
    await page.setViewportSize({ width: 768, height: 900 })
    await expect(page.getByTestId('session-references').getByRole('link', { name: title })).toBeVisible()
    await page.screenshot({ path: process.env.TAL1359_EVIDENCE ? `${process.env.TAL1359_EVIDENCE}/accepted-narrow.png` : info.outputPath('accepted-narrow.png') })
  }
})
