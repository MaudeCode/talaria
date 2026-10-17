import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, settle, test } from './fixtures'
import type { ConnectorsPage } from '@maudecode/talaria-web-contracts'

test.use({ serviceWorkers: 'block' })
const shared = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts/fixtures/connectors.json'), 'utf8')) as { page: ConnectorsPage }

for (const kind of ['skill', 'mcp', 'extension', 'connector'] as const) {
  test(`${kind} shows requested state while the write is held`, async ({ page }, testInfo) => {
    let release!: () => void
    let started!: () => void
    const held = new Promise<void>((done) => { release = done })
    const writing = new Promise<void>((done) => { started = done })
    let enabled = false
    const names = ['alpha', 'beta']
    await page.route('**/api/skills', (route) => route.fulfill({ json: { skills: names.map((name) => ({ name, description: 'Review changes', category: null, disabled: name === 'alpha' ? !enabled : true, tier: 0 })) } }))
    await page.route('**/api/skills/usage', (route) => route.fulfill({ json: { usage: {} } }))
    await page.route('**/api/mcp/servers', (route) => route.fulfill({ json: { toggle_supported: true, reload_required: true, servers: names.map((name) => ({ name, enabled: name === 'alpha' && enabled, can_toggle: true, transport: 'stdio', status: 'configured', health: 'unhealthy', tool_count: 0 })) } }))
    await page.route('**/api/mcp/tools*', (route) => route.fulfill({ json: { tools: [], total: 0 } }))
    await page.route('**/api/extensions/registry', (route) => route.fulfill({ json: { entries: [] } }))
    await page.route('**/api/extensions/manifests', (route) => route.fulfill({ json: { protocol_version: 1, manifests: names.map((id) => ({ id, name: id, enabled: id === 'alpha' && enabled, can_toggle: true, source: 'manifest', description: 'Review changes', panel: null, nav: null, capabilities: [], permissions: {}, settings_schema: [], theme: null, tts: null, sidecar: null, legacy_injection: false, warnings: [] })) } }))
    await page.route('**/api/connectors', (route) => route.fulfill({ json: { ...shared.page, connectors: names.map((slug) => ({ ...shared.page.connectors.find((c) => c.slug === 'notion')!, slug, name: slug, enabled: slug === 'alpha' && enabled, logo_url: null, accounts: [], connected: false, rules_editable: true })) } }))
    const endpoint = { skill: '**/api/skills/toggle', mcp: '**/api/mcp/servers/alpha', extension: '**/api/extensions/toggle', connector: '**/api/connectors/alpha/policy' }[kind]
    await page.route(endpoint, async (route) => {
      started()
      await held
      enabled = true
      await route.fulfill({ json: { ok: true, name: 'alpha', enabled: true, revision: 'rev-8' } })
    })
    await page.goto({ skill: '/skills', mcp: '/settings/system', extension: '/settings/extensions', connector: '/settings/connectors' }[kind])
    await settle(page)
    const toggle = page.getByRole('switch', { name: /^alpha[: ]/ })
    await toggle.scrollIntoViewIfNeeded()
    await toggle.click()
    await writing
    try {
      await expect(toggle).toBeChecked({ timeout: 1000 })
      await expect(toggle).toHaveAttribute('aria-busy', 'true')
      const peer = page.getByRole('switch', { name: /^beta[: ]/ })
      if (kind === 'connector') await expect(peer).toBeDisabled()
      else await expect(peer).toBeEnabled()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    } finally {
      await page.screenshot({ path: testInfo.outputPath(`${kind}-pending.png`), animations: 'disabled' })
      release()
    }
    await expect(toggle).not.toHaveAttribute('aria-busy', 'true')
    await expect(toggle).toBeChecked()
  })
}
