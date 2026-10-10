import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, settle, test } from './fixtures'
import { openServerState } from './server'

/** TAL-704: a gallery-installed extension's real (unmocked) manifest row ships its panel, nav, source, and legacy flag. */
test('a gallery extension with a panel gets a rail entry, Open, and Uninstall; a scripts-only one shows the migration notice', async ({ page }, testInfo) => {
  const state = openServerState()
  const root = join(state, 'extensions')
  const seed = (id: string, manifest: object, files: Record<string, string>) => {
    mkdirSync(join(root, id), { recursive: true })
    writeFileSync(join(root, id, 'manifest.json'), JSON.stringify(manifest))
    for (const [name, body] of Object.entries(files)) writeFileSync(join(root, id, name), body)
  }
  seed('gal', { name: 'Gallery Panel', version: '1.0.0', panel: 'index.html', nav: { label: 'Gal' }, capabilities: ['theme'] }, { 'index.html': '<!doctype html><p>gallery panel body</p>' })
  seed('old', { name: 'Old Script', scripts: ['old.js'] }, { 'old.js': '' })
  const record = (files: string[]) => ({ version: '1.0.0', files, installed_at: '2026-01-01T00:00:00Z' })
  writeFileSync(join(state, 'extension-install-manifest.json'), JSON.stringify({ version: 1, installed: { gal: record(['manifest.json', 'index.html']), old: record(['manifest.json', 'old.js']) } }))
  try {
    await page.goto('/settings/extensions')
    await settle(page)
    const gal = page.locator('[data-extension-id="gal"]')
    await expect(gal).toHaveAttribute('data-source', 'gallery')
    await expect(gal.getByRole('button', { name: 'Uninstall' })).toBeVisible()
    await expect(gal.getByRole('link', { name: 'Open' })).toBeVisible()
    const old = page.locator('[data-extension-id="old"]')
    await expect(old.getByRole('status')).toBeVisible()
    await expect(old.getByRole('switch')).toHaveCount(0)
    await expect(old.getByRole('link', { name: 'Open' })).toHaveCount(0)

    // The rail is desktop chrome; phones reach the panel from Settings.
    if (testInfo.project.name === 'desktop') await expect(page.locator('nav.rail [data-extension="gal"]')).toHaveAttribute('aria-label', 'Gal')
    if (process.env.TAL704_SHOTS) await page.screenshot({ path: `${process.env.TAL704_SHOTS}/settings-${testInfo.project.name}.png` })
    await gal.getByRole('link', { name: 'Open' }).click()
    await expect(page.frameLocator('iframe').getByText('gallery panel body')).toBeVisible()
    if (process.env.TAL704_SHOTS) await page.screenshot({ path: `${process.env.TAL704_SHOTS}/panel-${testInfo.project.name}.png` })
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(join(state, 'extension-install-manifest.json'), { force: true })
  }
})
