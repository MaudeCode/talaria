import { expect, test } from './fixtures'

// TAL-1709: Inter ships as per-script subsets. A cold Latin-script load fetches only the preloaded latin file; Cyrillic
// text fetches the cyrillic subset on demand.
test.use({ locale: 'en-US', serviceWorkers: 'block' })

test('a cold load downloads one small Inter subset and Cyrillic text adds the cyrillic one', async ({ page }) => {
  const fonts = () => page.evaluate(() => performance.getEntriesByType('resource')
    .filter(({ name }) => name.endsWith('.woff2'))
    .map((entry) => ({ file: entry.name.slice(entry.name.lastIndexOf('/') + 1), bytes: (entry as PerformanceResourceTiming).encodedBodySize })))
  await page.goto('/')
  await page.evaluate(() => document.fonts.ready)
  const cold = await fonts()
  expect(cold).toHaveLength(1)
  expect(cold[0]?.bytes).toBeGreaterThan(0)
  expect(cold[0]?.bytes).toBeLessThan(120_000)

  await page.evaluate(() => {
    const text = document.createElement('p')
    text.textContent = 'Привет'
    document.body.append(text)
  })
  await expect.poll(async () => (await fonts()).map(({ file }) => file.replace(/-[\w-]{8}\.woff2$/, ''))).toEqual(['InterVariable-latin', 'InterVariable-cyrillic'])
})
