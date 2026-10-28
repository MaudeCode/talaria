import { expect, settle, test } from './fixtures'

test('profile import previews, cancels, confirms and reconciles using keyboard and responsive controls', async ({ page }, testInfo) => {
  const calls: unknown[] = []
  const base = { status: 'available', sources: [{ agent: 'cursor', label: 'Cursor' }], items: [], stripped_secrets: [], receipt: null, can_apply: false, message: null }
  const preview = { ...base, status: 'preview', items: [{ kind: 'rules', status: 'imported', label: 'Cursor rules' }, { kind: 'mcp-servers', status: 'conflict', label: 'MCP servers' }, { kind: 'skills', status: 'skipped', label: 'Skills' }], stripped_secrets: ['mcp_servers.example.env.API_TOKEN'], receipt: 'bound-fixture', can_apply: true }
  await page.route('**/api/profile/import', (route) => route.fulfill({ json: base }))
  await page.route('**/api/profile/import/preview', (route) => {
    calls.push(route.request().postDataJSON())
    return route.fulfill({ json: preview })
  })
  await page.route('**/api/profile/import/apply', (route) => {
    calls.push(route.request().postDataJSON())
    return route.fulfill({ json: { ...preview, status: 'applied', receipt: null, can_apply: false } })
  })
  await page.goto('/profiles')
  await settle(page)
  if (process.env.TALARIA_IMPORT_BEFORE === '1') {
    await page.screenshot({ path: `/tmp/TAL-1493-evidence/before-${testInfo.project.name}.png` })
    return
  }
  await page.getByRole('button', { name: 'Import agent setup' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox', { name: 'Source' }).click()
  await page.getByRole('option', { name: 'Cursor', exact: true }).click()
  await dialog.getByRole('button', { name: 'Preview', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(dialog.getByText('Importable', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Conflict', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: `/tmp/TAL-1493-evidence/after-${testInfo.project.name}.png` })
  await dialog.getByRole('button', { name: 'Import', exact: true }).click()
  const confirmation = page.getByRole('alertdialog')
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(calls).toEqual([{ agent: 'cursor' }])
  await dialog.getByRole('button', { name: 'Import', exact: true }).click()
  await confirmation.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(dialog.getByText('Import complete', { exact: true })).toBeVisible()
  expect(calls).toEqual([{ agent: 'cursor' }, { receipt: 'bound-fixture' }])
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
})

test('unknown import outcomes offer readback without replaying the write', async ({ page }, testInfo) => {
  if (process.env.TALARIA_IMPORT_BEFORE === '1') return
  let applies = 0
  let reads = 0
  const base = { status: 'available', sources: [{ agent: 'codex', label: 'Codex CLI' }], items: [], stripped_secrets: [], receipt: null, can_apply: false, message: null }
  await page.route('**/api/profile/import', (route) => route.fulfill({ json: base }))
  await page.route('**/api/profile/import/preview', (route) => route.fulfill({ json: { ...base, status: 'preview', receipt: 'unknown-fixture', can_apply: true } }))
  await page.route('**/api/profile/import/apply', (route) => { applies++; return route.fulfill({ json: { ...base, status: 'unknown', message: 'Import outcome is unknown. Check the profile before starting a new preview.' } }) })
  await page.route('**/api/profile/import/result?*', (route) => { reads++; return route.fulfill({ json: { ...base, status: 'applied' } }) })
  await page.goto('/profiles')
  await settle(page)
  await page.getByRole('button', { name: 'Import agent setup' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox', { name: 'Source' }).click()
  await page.getByRole('option', { name: 'Codex CLI', exact: true }).click()
  await dialog.getByRole('button', { name: 'Preview', exact: true }).click()
  await dialog.getByRole('button', { name: 'Import', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Import', exact: true }).click()
  await expect(dialog.getByText('Import outcome is unknown.', { exact: false })).toBeVisible()
  await page.screenshot({ path: `/tmp/TAL-1493-evidence/unknown-${testInfo.project.name}.png` })
  await dialog.getByRole('button', { name: 'Check result', exact: true }).click()
  await expect(dialog.getByText('Import complete', { exact: true })).toBeVisible()
  expect(applies).toBe(1)
  expect(reads).toBe(1)
})

test('configuration refusals keep the profile unchanged and offer no unrelated install action', async ({ page }, testInfo) => {
  await page.route('**/api/profile/import', (route) => route.fulfill({ json: { status: 'unavailable', sources: [], items: [], stripped_secrets: [], receipt: null, can_apply: false, catalog_required: false, message: 'Profile configuration is managed or its write policy cannot be verified. Import is unavailable.' } }))
  await page.goto('/profiles')
  await settle(page)
  await page.getByRole('button', { name: 'Import agent setup' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Profile configuration is managed', { exact: false })).toBeVisible()
  await expect(dialog.getByRole('link', { name: 'Open plugin catalog' })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Preview', exact: true })).toHaveCount(0)
  await page.screenshot({ path: `/tmp/TAL-1493-evidence/config-refusal-${testInfo.project.name}.png` })
})
