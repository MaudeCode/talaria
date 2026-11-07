import type { Locator } from '@playwright/test'
import { expect, settle, test } from './fixtures'

const look = (control: Locator) => control.evaluate((el) => {
  const { opacity, cursor } = getComputedStyle(el)
  return { opacity, cursor }
})

/** TAL-1882: Base UI's switch root is a span, so only `data-disabled` can style its disabled state. */
test('a disabled switch dims with a not-allowed cursor while an enabled one stays full strength', async ({ page }) => {
  await page.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch()
    const boot = await response.json() as { auth: object }
    await route.fulfill({ response, json: { ...boot, auth: { ...boot.auth, can_manage_server: false } } })
  })
  await page.goto('/settings/preferences')
  await settle(page)

  const disabled = page.getByRole('switch', { name: 'Redact sensitive data in API responses' })
  await expect(disabled).toHaveAttribute('aria-disabled', 'true')
  expect(await look(disabled)).toEqual({ opacity: '0.5', cursor: 'not-allowed' })

  const enabled = page.getByRole('switch', { name: 'Show non-WebUI sessions' })
  await expect(enabled).toBeEnabled()
  expect(await look(enabled)).toEqual({ opacity: '1', cursor: 'pointer' })
})
