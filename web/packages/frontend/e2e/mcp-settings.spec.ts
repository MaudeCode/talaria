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
    const config: Record<string, Record<string, unknown>> = { github: { command: 'gh-mcp', args: ['serve'] }, notes: { url: 'https://notes.example/mcp', enabled: false }, broken: { timeout: 5 } }
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
    const broken = page.locator('[data-mcp-server="broken"]')
    await expect(broken).toContainText('Invalid config')
    await expect(broken.getByRole('switch')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole('heading', { name: 'MCP Servers' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath(`mcp-${String(width)}.png`) })

    await notes.getByRole('switch', { name: 'notes' }).click()
    await expect(notes).toContainText('Configured')
    await expect(notes.getByRole('switch', { name: 'notes' })).toBeChecked()
    await github.getByRole('switch', { name: 'github' }).click()
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

for (const width of [1280, 768, 390]) {
  test(`MCP declared policy saves and unsets through the service at ${String(width)}px`, async ({ page }, testInfo) => {
    const { McpService } = await import('../../server/dist/tools/mcp.js')
    const config: Record<string, unknown> = { mcp_servers: { paid: { command: 'synthetic-mcp', trust: 'full', enabled: false, spend_limit: 5, tool_costs: { search: { credits: [1, 3], note: 'Declared upper-range estimate' } }, future: 'keep' } } }
    const service = new McpService({
      config: {
        read: () => Promise.resolve(structuredClone(config)),
        update: async (_home: string, mutate: (config: Record<string, unknown>) => unknown) => { const next = structuredClone(config); await mutate(next); Object.assign(config, next); return next },
      } as unknown as ConstructorParameters<typeof McpService>[0]['config'],
      sidecar: () => ({ call: (method: string, params: { servers: Record<string, Record<string, unknown>> }) => {
        if (method === 'mcp.status') return Promise.resolve({ servers: [] })
        if (method !== 'mcp.cost_policies') throw new Error(method)
        const native = params.servers.paid!
        return Promise.resolve({ supported: true, policies: [{ name: 'paid', source: 'native', valid: true, can_edit: true, error: null, package_revision: 'none', overrides: { tool_costs: native.tool_costs, spend_limit: native.spend_limit ?? null, cost_unit: null }, tool_costs: [{ name: 'search', low: 1, high: 3, note: 'Declared upper-range estimate' }], spend_limit: native.spend_limit ?? 0, cost_unit: 'credits', budget_enabled: (native.spend_limit as number ?? 0) > 0, field_sources: { tool_costs: 'native', spend_limit: 'spend_limit' in native ? 'native' : 'default', cost_unit: 'default' } }] })
      } } as unknown as NonNullable<ReturnType<ConstructorParameters<typeof McpService>[0]['sidecar']>>),
    })
    await page.setViewportSize({ width, height: 1100 })
    const home = '/synthetic/profile'
    let expose = false
    await page.route('**/api/mcp/servers', async (route) => {
      const data = await service.servers(home)
      if (!expose) for (const row of data.servers as Record<string, unknown>[]) delete row.cost_policy
      await route.fulfill({ json: data })
    })
    const writes: unknown[] = []
    let release: (() => void) | undefined
    await page.route('**/api/mcp/servers/paid', async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>
      writes.push(body)
      await new Promise<void>((resolve) => { release = resolve })
      await route.fulfill({ json: await service.update(home, 'paid', body) })
    })
    await page.route('**/api/mcp/tools*', (route) => route.fulfill({ json: { tools: [], total: 0, source: 'none', unavailable_servers: [] } }))
    await page.goto('/settings/system')
    await settle(page)
    const row = page.locator('[data-mcp-server="paid"]')
    await row.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath(`policy-before-${String(width)}.png`) })
    expose = true
    await page.reload()
    await settle(page)
    await row.getByText('Cost policy', { exact: true }).click()
    await expect(row.getByText('Declared estimate', { exact: true })).toBeVisible()
    await expect(row).toContainText('5 credits')
    await expect(row).toContainText('Runtime policy is unconfirmed')
    const limit = row.getByRole('textbox', { name: 'Per-chat limit', exact: true })
    await limit.fill('0')
    await row.getByRole('button', { name: 'Save policy', exact: true }).click()
    await expect(limit).toHaveValue('0')
    await expect.poll(() => writes.length).toBe(1)
    release!()
    await expect(row).toContainText('0 credits')
    await expect(limit).toHaveValue('0')
    expect((config.mcp_servers as Record<string, unknown>).paid).toMatchObject({ spend_limit: 0, trust: 'full', enabled: false, future: 'keep' })
    await row.scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`policy-after-${String(width)}.png`) })
    await row.getByRole('button', { name: 'Use inherited/default', exact: true }).click()
    await expect.poll(() => writes.length).toBe(2)
    release!()
    await expect(limit).toHaveValue('')
    await expect.poll(() => Object.hasOwn((config.mcp_servers as Record<string, object>).paid!, 'spend_limit')).toBe(false)
    expect(writes).toMatchObject([{ cost_policy: { spend_limit: 0 } }, { cost_policy: { spend_limit: null } }])
  })
}
