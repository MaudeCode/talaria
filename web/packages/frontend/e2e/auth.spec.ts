import { createServer, request as forward } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, settle, test } from './fixtures'
import { E2E_PASSWORD } from './global-setup'

const AUTH = () => process.env.HERMES_E2E_AUTH_BASE_URL!
/** Anchored at the auth origin: the login URL itself (`/login?next=/settings/appearance`) must not match. */
const authUrl = (path: string) => new RegExp(`^${AUTH().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${path}$`)

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
    await expect(page).toHaveURL(authUrl('/settings/appearance'))
    await settle(page)
  })

  test('the login page rejects an off-origin next target', async ({ page }) => {
    await page.goto(`${AUTH()}/login?next=https://evil.example/`)
    await settle(page)
    await page.locator('#pw').fill(E2E_PASSWORD)
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page).toHaveURL(authUrl('/?'))
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

/** TAL-1075: serve the auth server under `/mount/` through a proxy that strips the prefix, as subpath installs do. */
async function mountProxy(target: string): Promise<{ url: string; close: () => Promise<void> }> {
  const upstream = new URL(target)
  const server = createServer((req, res) => {
    const path = req.url ?? '/'
    if (path !== '/mount' && !path.startsWith('/mount/')) { res.writeHead(404).end(); return }
    const proxied = forward({ host: upstream.hostname, port: upstream.port, method: req.method, path: path.slice('/mount'.length) || '/', headers: req.headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    })
    proxied.on('error', () => { res.writeHead(502).end() })
    req.pipe(proxied)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${String(port)}/mount`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) }) }
}

test.describe('password auth under a subpath mount', () => {
  let proxy: Awaited<ReturnType<typeof mountProxy>>
  test.beforeAll(async () => { proxy = await mountProxy(AUTH()) })
  test.afterAll(async () => { await proxy.close() })

  test('a server-issued stripped target lands under the mount once', async ({ page }) => {
    await page.goto(`${proxy.url}/settings/appearance`)
    await settle(page)
    await expect(page).toHaveURL(/\/mount\/login\?next=%2Fsettings%2Fappearance$/)
    await page.locator('#pw').fill(E2E_PASSWORD)
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page).toHaveURL(`${proxy.url}/settings/appearance`)
    await settle(page)
  })

  test('a page-issued prefixed target lands under the mount once', async ({ page }) => {
    await page.goto(`${proxy.url}/login?next=${encodeURIComponent('/mount/settings/appearance?tab=1')}`)
    await settle(page)
    await page.locator('#pw').fill(E2E_PASSWORD)
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page).toHaveURL(`${proxy.url}/settings/appearance?tab=1`)
    await settle(page)
  })
})
