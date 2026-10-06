import { expect, settle, test } from './fixtures'
import { updatesCheckView } from '../../server/dist/tools/updates.js'

// Service-worker requests bypass page routing; these fixtures own every response.
test.use({ serviceWorkers: 'block' })

test('failed checks keep both update paths aligned', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.route('**/api/updates/check', (route) => route.fulfill({ json: updatesCheckView({
    cached: false,
    webui: { behind: null, manual_update: true, error: 'GitHub answered 404', current_version: 'web-v1.0.0-46-g8c2d4c2-dirty' },
    agent: { behind: null, error: 'fetch failed: git fetch origin --tags --force timed out after 15s', current_version: '0.21.3' },
  }) }))
  await page.goto('/settings/system')
  await settle(page)
  const web = page.getByRole('switch', { name: 'Automatically apply Web updates', exact: true })
  const agent = page.getByRole('switch', { name: 'Ignore Agent updates', exact: true })
  await expect(web).toBeVisible()
  const [a, b] = await Promise.all([web.boundingBox(), agent.boundingBox()])
  expect(Math.abs((a?.y ?? 0) - (b?.y ?? 1))).toBeLessThan(1)
  await page.screenshot({ path: testInfo.outputPath('system-failed-aligned.png') })
})

for (const width of [1280, 760, 390]) {
  test(`System page keeps Web and Agent update paths separate at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1500 })
    await page.route('**/api/settings', (route) => route.fulfill({ json: {
      update_channel: 'stable', agent_update_channel: 'experimental', check_for_updates: true, auto_apply_updates: false,
      webui_version: 'web-v1.2.3', agent_version: 'v2026.9.21',
    } }))
    await page.route('**/api/updates/check', (route) => route.fulfill({ json: updatesCheckView({
      cached: false,
      webui: { behind: 1, release_based: true, current_version: 'web-v1.2.3', latest_version: 'web-v1.3.0', install_kind: 'npm', no_git: true, manual_update: false },
      agent: { behind: 14, release_based: false, current_version: 'v2026.9.21', latest_version: 'main' },
    }) }))
    await page.goto('/settings/system')
    await settle(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`system-${width}.png`) })
    await page.getByRole('button', { name: 'About Automatically apply Web updates', exact: true }).click()
    await expect(page.getByText('Hermes Agent is never updated automatically', { exact: false })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`system-${width}-help.png`) })
  })
}

test('help buttons keep a 44px touch target around the small icon', async ({ page }) => {
  await page.goto('/settings/system')
  await settle(page)
  const help = page.getByRole('button', { name: 'About Automatically apply Web updates', exact: true })
  const box = await help.boundingBox()
  if (!box) throw new Error('help button not rendered')
  // Points 10px beyond each visible edge still land on the button.
  const hits = await page.evaluate(({ x, y, w, h }) => [[x - 10, y + h / 2], [x + w + 10, y + h / 2], [x + w / 2, y - 10], [x + w / 2, y + h + 10]]
    .map(([px, py]) => document.elementFromPoint(px!, py!)?.closest('button')?.getAttribute('aria-label') ?? null), { x: box.x, y: box.y, w: box.width, h: box.height })
  expect(hits).toEqual(Array(4).fill('About Automatically apply Web updates'))
})
