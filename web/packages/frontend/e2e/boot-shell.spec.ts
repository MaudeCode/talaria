import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** TAL-1712: the bootstrap carries the shell's settings, profiles, workspaces and projects, so a cold load never reads them. */
test('a cold load reads the shell data from the bootstrap and still snapshots it', async ({ page }) => {
  // Chromium keeps 250 resource entries by default; a full buffer would drop the reads this test looks for.
  await page.addInitScript(() => { performance.setResourceTimingBufferSize(10_000) })
  await page.goto('/')
  await page.waitForLoadState('load')
  const paths = () => page.evaluate(() => performance.getEntriesByType('resource').map(({ name }) => new URL(name).pathname))
  await expect.poll(async () => (await paths()).filter((path) => path.endsWith('/api/bootstrap'))).toHaveLength(1)
  await page.waitForTimeout(3_000)
  expect((await paths()).filter((path) => /\/api\/(settings|profiles|workspaces|projects)$/.test(path))).toEqual([])
  const snapshot = await page.evaluate(() => JSON.parse(localStorage.getItem('hermes-boot:queries') ?? '{"queries":[]}') as { queries: { queryKey: unknown[] }[] })
  expect(snapshot.queries.map((q) => q.queryKey[0])).toEqual(expect.arrayContaining(['settings', 'profiles', 'workspaces', 'projects']))
})
