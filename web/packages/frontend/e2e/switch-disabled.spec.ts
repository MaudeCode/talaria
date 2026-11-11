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
  await page.goto('/settings/access')
  await settle(page)

  const disabled = page.getByRole('switch', { name: 'Redact sensitive data in API responses' })
  await expect(disabled).toHaveAttribute('aria-disabled', 'true')
  expect(await look(disabled)).toEqual({ opacity: '0.5', cursor: 'not-allowed' })

  // TAL-2160: every Privacy switch is owner-only; Chat's are each user's own.
  await page.goto('/settings/chat')
  await settle(page)
  const enabled = page.getByRole('switch', { name: 'Format Markdown in my messages' })
  await expect(enabled).toBeEnabled()
  expect(await look(enabled)).toEqual({ opacity: '1', cursor: 'pointer' })
})

/** TAL-2160: at phone width the composer always sends with Ctrl/Cmd+Enter, so Send with shows that rule, disabled. */
test('Send with shows the rule phones always use at phone width and is editable on a desktop', async ({ page }, info) => {
  await page.goto('/settings/chat')
  await settle(page)
  const group = page.getByRole('radiogroup', { name: 'Send with' })
  const phone = info.project.name === 'mobile'
  if (phone) await expect(group.getByRole('radio', { checked: true })).toHaveText(/^(Ctrl|⌘) Enter$/)
  for (const radio of await group.getByRole('radio').all()) await (phone ? expect(radio).toBeDisabled() : expect(radio).toBeEnabled())
})
