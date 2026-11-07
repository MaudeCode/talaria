import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { expect, settle, test } from './fixtures'

/** TAL-1702: a settings page downloads its own section's chunk and leaves the other sections' chunks alone. */
const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../dist/client/.vite/manifest.json'), 'utf8')) as Record<string, { file: string } | undefined>
const chunk = (source: string) => basename(manifest[source]?.file ?? `no chunk for ${source}`)

test('opening Appearance downloads its section chunk and not the Providers chunk', async ({ page }) => {
  await page.goto('/settings/appearance')
  await settle(page)
  const requested = () => page.evaluate(() => performance.getEntriesByType('resource').map(({ name }) => name))
  // The heading renders before the section's chunk arrives, and an entry appears only once its request finishes.
  await expect.poll(async () => (await requested()).filter((url) => url.includes(chunk('src/features/settings/AppearanceSection.tsx')))).not.toEqual([])
  await page.waitForLoadState('networkidle')
  expect((await requested()).filter((url) => url.includes(chunk('src/features/settings/ProvidersSection.tsx')))).toEqual([])
})
