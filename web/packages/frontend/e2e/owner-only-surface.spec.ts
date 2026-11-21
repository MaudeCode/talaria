import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootTestServer } from '../../server/dist/test/harness.js'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'
import { Session } from '../../server/dist/sessions/session.js'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const PROVIDERS = {
  providers: [
    { id: 'openrouter', display_name: 'OpenRouter', has_key: true, configured: true, is_active: true, key_source_kind: 'env', removable: true, setup: 'key' },
    { id: 'anthropic', display_name: 'Anthropic', has_key: false, configured: false, setup: 'key' },
  ],
  groups: [{ id: 'configured', provider_ids: ['openrouter'] }, { id: 'available', provider_ids: ['anthropic'] }],
}

/**
 * TAL-2201: a login bound to a profile chats in it and reads its providers and MCP servers, but the host terminal, provider
 * setup and MCP edits are owner-only, so Web offers none of them.
 */
test('a profile-bound session gets no terminal, provider setup or MCP edit controls', async ({ page }, testInfo) => {
  // OWNER_SHOTS names a folder for the PR's screenshots.
  const shot = async (name: string) => { if (process.env.OWNER_SHOTS) await page.screenshot({ path: `${process.env.OWNER_SHOTS}/${name}-${testInfo.project.name}.png` }) }
  const sidecar = new FakeSidecar()
  const config = { mcp_servers: { github: { command: 'gh-mcp' } } }
  sidecar.respond('config.get', () => ({ path: '<home>/config.yaml', exists: true, config, resolved: config }))
  const server = await bootTestServer({ sidecar, env: {
    TALARIA_WEB_SKIP_ONBOARDING: '1', TALARIA_WEB_TRUSTED_AUTH_HEADER: 'X-Remote-User', TALARIA_WEB_TRUSTED_GROUPS_HEADER: 'X-Remote-Groups', TALARIA_WEB_GROUP_PROFILE_MAP: '{"ops":"default"}',
  } })
  try {
    writeFileSync(join(server.state, 'config.yaml'), 'mcp_servers:\n  github:\n    command: gh-mcp\n')
    const sid = '20261119_120000_bound'
    const workspace = join(server.state, 'workspace')
    mkdirSync(workspace, { recursive: true })
    const now = Math.floor(Date.now() / 1000)
    await server.deps.sessionStore.save(new Session({ session_id: sid, title: 'Bound chat', profile: 'default', workspace, messages: [{ role: 'user', content: 'Hello', timestamp: now - 60 }, { role: 'assistant', content: 'Hi there.', timestamp: now - 50 }] }, { workspace, model: null }))
    await page.setExtraHTTPHeaders({ 'X-Remote-User': 'kim', 'X-Remote-Groups': 'ops' })
    await page.route((url) => url.pathname === '/api/providers', (route) => route.fulfill({ json: PROVIDERS }))

    await page.goto(`${server.base}/session/${sid}`)
    await settle(page)
    await expect(page.locator('.msg-body').filter({ hasText: 'Hi there.' })).toBeVisible()
    await shot('chat')
    await expect(page.locator('#btnTerminalInline')).toHaveCount(0)

    await page.goto(`${server.base}/settings/providers/openrouter`)
    await settle(page)
    await expect(page.getByRole('heading', { name: 'OpenRouter' })).toBeVisible()
    await shot('provider')
    await expect(page.getByRole('button', { name: /Replace key|Set key|Remove key/ })).toHaveCount(0)

    await page.goto(`${server.base}/settings/providers`)
    await settle(page)
    await expect(page.locator('[data-provider="openrouter"]')).toBeVisible()
    await shot('providers')
    await expect(page.locator('[data-section="providers-available"]')).toHaveCount(0)

    await page.goto(`${server.base}/settings/tools?tab=mcp`)
    await settle(page)
    const github = page.locator('[data-mcp-server="github"]')
    await expect(github).toBeVisible()
    await shot('mcp')
    await expect(github.getByRole('switch')).toHaveCount(0)
  } finally {
    // Leave the page first, so closing the server does not cut its live session-list stream.
    await page.goto('about:blank')
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await server.close()
  }
})
