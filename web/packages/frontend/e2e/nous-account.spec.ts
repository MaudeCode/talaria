import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { NousAccount } from '@maudecode/talaria-web-contracts'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })
const fixtures = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts/fixtures/nous-account.json'), 'utf8')) as Record<'moved' | 'no_apps' | 'retrying', NousAccount>

test('Nous result remains readable, survives reload, and reconnect is an explicit keyboard action', async ({ page }, testInfo) => {
  let result: NousAccount | null = null
  const writes: unknown[] = []
  await page.route('**/api/providers', (route) => route.fulfill({ json: { providers: [{ id: 'nous', display_name: 'Nous Portal', is_oauth: true, has_key: true, configured: true, models: [], nous_account: result }], active_provider: 'nous' } }))
  await page.route('**/api/connectors/gmail/connect', async (route) => {
    writes.push(route.request().postDataJSON())
    await route.fulfill({ json: { op_id: 'reconnect-1', settled: false, outcome: null, can_continue: false, tool_call_id: null, targets: [
      { name: 'gmail', title: 'Gmail', kind: 'connector', state: 'initiated', detail: '', connect_url: 'https://vendor.example.test/authorize/gmail', actions: ['skip'], env_fields: [] },
    ] } })
  })
  await page.route('**/api/connectors/operations/reconnect-1', (route) => route.fulfill({ json: { op_id: 'reconnect-1', settled: false, outcome: null, can_continue: false, tool_call_id: null, targets: [
    { name: 'gmail', title: 'Gmail', kind: 'connector', state: 'initiated', detail: '', connect_url: 'https://vendor.example.test/authorize/gmail', actions: ['skip'], env_fields: [] },
  ] } }))
  await page.goto('/settings/providers')
  await settle(page)
  const row = page.locator('[data-provider="nous"]')
  await expect(row).not.toContainText('u***@example.test')
  await page.screenshot({ path: testInfo.outputPath(`nous-without-result-${testInfo.project.name}.png`) })
  result = fixtures.moved
  await page.reload()
  await settle(page)
  await expect(row).toContainText('Signed in as u***@example.test.')
  await expect(row).toContainText('calendar')
  expect(writes).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath(`nous-result-${testInfo.project.name}.png`) })
  const reconnect = row.getByRole('button', { name: 'Reconnect gmail' })
  await reconnect.focus()
  await expect(reconnect).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(() => writes).toEqual([{ nous_account_id: fixtures.moved.account_id }])
  await expect(row.getByRole('link', { name: 'Authorize' })).toHaveAttribute('href', 'https://vendor.example.test/authorize/gmail')
  await page.screenshot({ path: testInfo.outputPath(`nous-reconnect-${testInfo.project.name}.png`) })
})

test('Nous approval keeps the transfer result on screen until Continue', async ({ page }, testInfo) => {
  let approved = false
  let account = fixtures.retrying
  await page.route('**/api/connectors/available', (route) => route.fulfill({ json: { available: true } }))
  await page.route('**/api/connectors', (route) => route.fulfill({ json: { available: true, sign_in_required: !approved, connectors: [], policy_revision: null, rules_error: null } }))
  await page.route('**/api/onboarding/oauth/start', (route) => route.fulfill({ json: { ok: true, status: 'pending', flow_id: 'native-flow', provider: 'nous', user_code: 'NOUS-42', verification_url: 'https://portal.example.test/device', expires_in: 600, interval: 1 } }))
  await page.route('**/api/onboarding/oauth/poll?*', (route) => {
    approved = true
    return route.fulfill({ json: { ok: true, status: 'approved', flow_id: 'native-flow', provider: 'nous', error: null, nous_account: { ...account, poll_after: 1 } } })
  })
  await page.goto('/settings/connectors')
  await settle(page)
  await page.getByRole('button', { name: 'Sign in with Nous Portal' }).click()
  await expect(page.getByText('NOUS-42')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath(`nous-code-${testInfo.project.name}.png`) })
  const result = page.locator('[data-handoff-state]')
  await expect(result).toContainText('u***@example.test')
  await expect(result).toHaveAttribute('data-handoff-state', 'retrying')
  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath(`nous-approved-retrying-${testInfo.project.name}.png`) })
  account = fixtures.moved
  await expect(result).toHaveAttribute('data-handoff-state', 'claimed')
  await expect(result).toContainText('calendar')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath(`nous-approved-moved-${testInfo.project.name}.png`) })
  await page.getByRole('button', { name: 'Continue' }).focus()
  await page.keyboard.press('Enter')
  await expect(result).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Sign in with Nous Portal' })).toHaveCount(0)
})
