import type { BrowserContext } from '@playwright/test'
import { expect, settle, test } from './fixtures'

// Service-worker requests bypass page routing; these tests own every API answer.
test.use({ serviceWorkers: 'block' })

/** Every API request in the context fails without an HTTP answer while `down` is set; otherwise the real server answers. */
async function serveApi(context: BrowserContext) {
  const api = { down: false }
  await context.route('**/api/**', (route) => (api.down ? route.abort('connectionrefused') : route.fallback()))
  return api
}

/** The refused requests are these tests' subject; their console noise is expected. */
const dropRefused = (errors: string[]) => errors.splice(0, errors.length, ...errors.filter((e) => !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(e)))

test('an unreachable server covers every open tab and clears in all of them on recovery', async ({ page, context, errors }, testInfo) => {
  const api = await serveApi(context)
  const other = await context.newPage()
  await page.goto('/settings/system')
  await other.goto('/')
  await Promise.all([settle(page), settle(other)])
  const overlay = page.getByRole('alertdialog', { name: 'Server stopped' })
  const otherOverlay = other.getByRole('alertdialog', { name: 'Server stopped' })
  await expect(overlay).toHaveCount(0)

  api.down = true
  await expect(overlay).toBeVisible({ timeout: 25_000 })
  await expect(otherOverlay).toBeVisible({ timeout: 25_000 })
  await expect(overlay.getByRole('button', { name: 'Retry' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('server-stopped.png') })

  // One tab's successful retry tells the other at once, well before its own backed-off probe.
  api.down = false
  await overlay.getByRole('button', { name: 'Retry' }).click()
  await expect(overlay).toHaveCount(0, { timeout: 1_500 })
  await expect(otherOverlay).toHaveCount(0, { timeout: 1_500 })
  dropRefused(errors)
})

test('stopping the server from Settings shows the overlay in every open tab at once', async ({ page, context, errors }) => {
  const api = await serveApi(context)
  await context.route('**/api/shutdown', (route) => { api.down = true; return route.fulfill({ json: { status: 'shutting_down' } }) })
  const other = await context.newPage()
  await page.goto('/settings/system')
  await other.goto('/')
  await Promise.all([settle(page), settle(other)])

  await page.getByRole('button', { name: 'Stop server', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Stop server', exact: true }).click()
  // Faster than either tab's own 10 s health cadence could notice.
  await expect(page.getByRole('alertdialog', { name: 'Server stopped' })).toBeVisible({ timeout: 2_000 })
  await expect(other.getByRole('alertdialog', { name: 'Server stopped' })).toBeVisible({ timeout: 2_000 })
  dropRefused(errors)
})
