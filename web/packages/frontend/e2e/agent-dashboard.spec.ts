import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, settle, test } from './fixtures'
import { openServerState } from './server'

// The ordinary browser suite uses replay fixtures; the native path is run explicitly on the cached Agent.
test('profile Agent dashboard uses the existing sandboxed extension frame and buffered API', async ({ page }, info) => {
  test.skip(!process.env.HERMES_WEBUI_AGENT_DIR, 'native Agent fixture run only')
  test.setTimeout(120_000)
  const state = openServerState()
  const config = join(state, 'config.yaml')
  const saved = existsSync(config) ? readFileSync(config, 'utf8') : null
  const plugin = join(state, 'plugins', 'factory-dashboard')
  mkdirSync(join(plugin, 'dashboard/dist'), { recursive: true })
  writeFileSync(join(plugin, 'plugin.yaml'), 'name: factory-dashboard\nversion: 0.0.1\ndescription: Synthetic dashboard\n')
  writeFileSync(join(plugin, '__init__.py'), 'raise AssertionError("must run only in Agent plugin host")\n')
  writeFileSync(join(plugin, 'dashboard/manifest.json'), JSON.stringify({ name: 'factory-dashboard', label: 'Factory dashboard', panel: 'dist/index.html', api: 'api.py' }))
  writeFileSync(join(plugin, 'dashboard/api.py'), 'from fastapi import APIRouter, Request\nfrom hermes_cli.web_deps import late\nrouter=APIRouter()\n@router.get("/identity")\nasync def identity(request: Request):\n    late("_require_token")(request)\n    return {"message":"Profile API connected"}\n')
  writeFileSync(join(plugin, 'dashboard/dist/index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Factory dashboard</title></head><body style="background:#151719;color:#f1f1f1;font:18px system-ui;padding:24px"><h1 style="font-size:24px">Profile dashboard</h1><p id="status">Connecting</p><script src="../../../static/dist/extension-sdk.js"></script><script src="app.js"></script></body></html>')
  writeFileSync(join(plugin, 'dashboard/dist/app.js'), 'Hermes.connect().then(async api=>{const r=await api.call("sidecar.fetch",{path:"identity"});document.getElementById("status").textContent=JSON.parse(r.body).message})')
  // Preserve the isolated server's existing config, with one explicit disabled synthetic plugin.
  writeFileSync(config, 'plugins:\n  enabled: []\n  disabled: [factory-dashboard]\n')
  try {
    await page.goto('/settings/extensions')
    await settle(page)
    const row = page.locator('[data-source="agent-plugin"]').filter({ hasText: 'Factory dashboard' })
    await expect(row).toBeVisible()
    await expect(row).not.toContainText(/agent-[a-f0-9]{40}/)
    await expect(page.getByText('web_extension_migration_required', { exact: true })).toHaveCount(0)
    await expect(row.getByRole('switch')).not.toBeChecked()
    if (process.env.TAL1326_SHOTS) await page.screenshot({ path: `${process.env.TAL1326_SHOTS}/before-${info.project.name}.png` })
    await row.getByRole('switch').click()
    await expect(row.getByRole('switch')).toBeChecked()
    await row.getByRole('link', { name: 'Open', exact: true }).click()
    await expect(page.frameLocator('iframe').getByText('Profile API connected')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.extension-panel')).toHaveAttribute('data-status', 'ready')
    await expect(page.getByText('Saved', { exact: true })).not.toBeVisible()
    if (process.env.TAL1326_SHOTS) await page.screenshot({ path: `${process.env.TAL1326_SHOTS}/after-${info.project.name}.png` })
  } finally {
    if (saved !== null) writeFileSync(config, saved)
    else rmSync(config, { force: true })
    rmSync(plugin, { recursive: true, force: true })
  }
})
