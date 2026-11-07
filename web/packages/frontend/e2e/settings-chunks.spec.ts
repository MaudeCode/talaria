import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { expect, settle, test } from './fixtures'

/** TAL-1702: a settings page downloads its own section's chunk and leaves the other sections' chunks alone. */
const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../dist/client/.vite/manifest.json'), 'utf8')) as Record<string, { file: string } | undefined>
const chunk = (source: string) => basename(manifest[source]?.file ?? `no chunk for ${source}`)

test('opening Appearance downloads its section chunk and not the Providers chunk', async ({ page }) => {
  await page.goto('/settings/appearance')
  await settle(page)
  await expect(page.locator('.settings-section-title')).toHaveText('Appearance')
  const requested = await page.evaluate(() => performance.getEntriesByType('resource').map(({ name }) => name))
  expect(requested.filter((url) => url.includes(chunk('src/features/settings/AppearanceSection.tsx')))).not.toEqual([])
  expect(requested.filter((url) => url.includes(chunk('src/features/settings/ProvidersSection.tsx')))).toEqual([])
})
