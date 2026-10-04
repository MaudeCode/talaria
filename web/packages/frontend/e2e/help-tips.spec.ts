import { expect, settle, test } from './fixtures'

// Page explanations open from a "?" beside the hub title instead of sitting under it.
const PAGES = [
  { path: '/workspaces', name: 'About Spaces', text: 'Add and switch workspaces for your sessions.' },
  { path: '/profiles', name: 'About Profiles', text: 'Use profiles for how the agent works' },
]

for (const width of [1280, 760, 390]) {
  for (const { path, name, text } of PAGES) {
    test(`${path} keeps its explanation behind the title help at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(path)
      await settle(page)
      await expect(page.getByText(text, { exact: false })).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`${path.slice(1)}-${width}.png`) })
      await page.getByRole('button', { name, exact: true }).click()
      await expect(page.getByText(text, { exact: false })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`${path.slice(1)}-${width}-help.png`) })
    })
  }
}

test('the hub title help button keeps a 44px touch target', async ({ page }) => {
  await page.goto('/workspaces')
  await settle(page)
  const help = page.getByRole('button', { name: 'About Spaces', exact: true })
  const box = await help.boundingBox()
  if (!box) throw new Error('help button not rendered')
  // Points 10px beyond each visible edge still land on the button.
  const hits = await page.evaluate(({ x, y, w, h }) => [[x - 10, y + h / 2], [x + w + 10, y + h / 2], [x + w / 2, y - 10], [x + w / 2, y + h + 10]]
    .map(([px, py]) => document.elementFromPoint(px!, py!)?.closest('button')?.getAttribute('aria-label') ?? null), { x: box.x, y: box.y, w: box.width, h: box.height })
  expect(hits).toEqual(Array(4).fill('About Spaces'))
})
