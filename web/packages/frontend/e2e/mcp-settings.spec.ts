import { expect, settle, test } from './fixtures'
import { serverSummary } from '../../server/dist/tools/mcp.js'

// Service-worker requests bypass page routing; these fixtures own every response.
test.use({ serviceWorkers: 'block' })

const TOOLS = [
  { name: 'create_issue', server: 'github', description: 'Open an issue in a repository', status: 'active' },
  { name: 'list_pulls', server: 'github', description: 'List pull requests', status: 'active' },
  { name: 'search_notes', server: 'notes', description: 'Find notes by text', status: 'configured' },
]

for (const width of [1280, 390]) {
  test(`MCP servers toggle through PATCH and tool search filters at ${String(width)}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1400 })
    const config: Record<string, Record<string, unknown>> = { github: { command: 'gh-mcp', args: ['serve'] }, notes: { url: 'https://notes.example/mcp', enabled: false } }
    const patches: unknown[] = []
    const queries: string[] = []
    await page.route('**/api/mcp/servers', (route) => route.fulfill({ json: {
      toggle_supported: true, reload_required: true, health_pending: false,
      servers: Object.entries(config).map(([name, cfg]) => serverSummary(name, cfg, name === 'github' ? { connected: true, tools: 2, health: 'needs_auth', health_detail: 'HTTP 401' } : null)),
    } }))
    await page.route('**/api/mcp/servers/*', async (route) => {
      const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() ?? '')
      const body = route.request().postDataJSON() as { enabled: boolean }
      patches.push({ method: route.request().method(), name, body })
      config[name] = { ...config[name], enabled: body.enabled }
      await route.fulfill({ json: { ok: true, name, enabled: body.enabled } })
    })
    await page.route('**/api/mcp/tools*', (route) => {
      const q = new URL(route.request().url()).searchParams.get('q') ?? ''
      queries.push(q)
      return route.fulfill({ json: { tools: TOOLS.filter((t) => [t.name, t.server, t.description].some((v) => v.toLowerCase().includes(q.toLowerCase()))), total: TOOLS.length, source: 'mcp_runtime_status', unavailable_servers: [] } })
    })
    await page.goto('/settings/system')
    await settle(page)
    const github = page.locator('[data-mcp-server="github"]')
    const notes = page.locator('[data-mcp-server="notes"]')
    await expect(github).toContainText('Active')
    await expect(github).toContainText('Needs sign-in')
    await expect(notes).toContainText('Disabled')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole('heading', { name: 'MCP Servers' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath(`mcp-${String(width)}.png`) })

    await notes.getByRole('switch', { name: 'notes: Disabled' }).click()
    await expect(notes).toContainText('Configured')
    await expect(notes.getByRole('switch', { name: 'notes: Enabled' })).toBeChecked()
    await github.getByRole('switch', { name: 'github: Enabled' }).click()
    await expect(github).toContainText('Disabled')
    await expect(github).not.toContainText('Needs sign-in')
    expect(patches).toEqual([{ method: 'PATCH', name: 'notes', body: { enabled: true } }, { method: 'PATCH', name: 'github', body: { enabled: false } }])
    await page.screenshot({ path: testInfo.outputPath(`mcp-${String(width)}-toggled.png`) })

    const tools = page.getByRole('list', { name: 'MCP Tools' })
    await expect(tools.getByRole('listitem')).toHaveCount(3)
    await page.getByRole('searchbox', { name: 'Search MCP tools' }).fill('pull')
    await expect(tools.getByRole('listitem')).toHaveCount(1)
    await expect(tools).toContainText('list_pulls')
    expect(queries).toContain('pull')
    await tools.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath(`mcp-${String(width)}-search.png`) })
    await page.getByRole('searchbox').fill('zzz')
    await expect(page.getByText('No MCP tools match your search.')).toBeVisible()
  })
}
