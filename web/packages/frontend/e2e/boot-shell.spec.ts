import { expect, painted, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** TAL-1712: the bootstrap carries the shell's settings, profiles, workspaces and projects, so a cold load never reads them. */
test('a cold load reads the shell data from the bootstrap and still snapshots it', async ({ page }) => {
  // Each request counts when the page sends it, not when it finishes.
  const paths: string[] = []
  page.on('request', (request) => { paths.push(new URL(request.url()).pathname) })
  // The page's clock runs the 3 s after boot on demand, so every timer due in it (refetches, idle snapshot writes) fires.
  await page.clock.install()
  await page.goto('/')
  await page.waitForLoadState('load')
  await expect.poll(() => paths.filter((path) => path.endsWith('/api/bootstrap'))).toHaveLength(1)
  const snapshot = () => page.evaluate(() => (JSON.parse(localStorage.getItem('hermes-boot:queries') ?? '{"queries":[]}') as { queries: { queryKey: unknown[] }[] }).queries.map((q) => q.queryKey[0]))
  await expect.poll(snapshot).toEqual(expect.arrayContaining(['settings', 'profiles', 'workspaces', 'projects']))
  await page.clock.runFor(3_000)
  await painted(page)
  expect(paths.filter((path) => /\/api\/(settings|profiles|workspaces|projects)$/.test(path))).toEqual([])
})
