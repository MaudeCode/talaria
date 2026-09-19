import { expect, settle, test } from './fixtures'
import { E2E_PASSWORD } from './global-setup'

const AUTH = () => process.env.HERMES_E2E_AUTH_BASE_URL!

test.describe('password auth', () => {
  test('protected routes redirect to login and back', async ({ page }) => {
    await page.goto(`${AUTH()}/settings/appearance`)
    await settle(page)
    await expect(page).toHaveURL(/\/login\?next=/)
    await page.locator('#pw').fill('wrong')
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    await page.locator('#pw').fill(E2E_PASSWORD)
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page).toHaveURL(/\/settings\/appearance$/)
    await settle(page)
  })

  test('the login page rejects an off-origin next target', async ({ page }) => {
    await page.goto(`${AUTH()}/login?next=https://evil.example/`)
    await settle(page)
    await page.locator('#pw').fill(E2E_PASSWORD)
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page).toHaveURL(new RegExp(`^${AUTH().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?$`))
  })

  test('API requests without a session are refused', async ({ request }) => {
    const res = await request.get(`${AUTH()}/api/settings`)
    expect(res.status()).toBe(401)
    const boot = await request.get(`${AUTH()}/api/bootstrap`)
    expect(boot.status()).toBe(200)
    const body = await boot.json() as { auth: { auth_enabled: boolean; logged_in: boolean } }
    expect(body.auth).toMatchObject({ auth_enabled: true, logged_in: false })
  })
})
