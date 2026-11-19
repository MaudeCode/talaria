import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, settle, test } from './fixtures'

// Service-worker requests bypass page routing; these fixtures own every response.
test.use({ serviceWorkers: 'block' })

const fixture = (JSON.parse(readFileSync(join(import.meta.dirname, '../../../../contracts/fixtures/web-session.json'), 'utf8')) as { tool_app_views: { session: { messages: unknown[] } } }).tool_app_views

test('MCP and connector calls read as their app and action, under a connector\'s logo or the MCP and connector icons (TAL-2330)', async ({ page }, testInfo) => {
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}-${testInfo.project.name}.png`), fullPage: true })
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'app-session', title: 'File the bug and tell the team', messages: fixture.session.messages } } }))

  await page.goto('/session/app-session')
  await settle(page)
  // A settled turn folds its calls under Worked, then under their kinds' summary.
  await page.getByRole('button', { name: 'Worked' }).click()
  await page.getByRole('button', { name: /MCP/ }).click()
  const mcp = page.locator('[data-tool-id="call-mcp"]')
  await expect(mcp).toHaveAttribute('data-tool-kind', 'mcp')
  await expect(mcp.locator('.tool-card-icon svg.lucide-server')).toHaveCount(1)
  await expect(mcp.locator('.tool-card-name')).toHaveText('GitHub · Create issue')
  const mail = page.locator('[data-tool-id="call-mail"]')
  await expect(mail).toHaveAttribute('data-tool-kind', 'connector')
  await expect(mail.locator('.tool-card-name')).toHaveText('Gmail · Send email (work)')
  // TAL-2199: the server ships the logo inline, so it loads under an img-src with no remote host.
  await expect.poll(() => mail.locator('.tool-card-icon img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
  const notion = page.locator('[data-tool-id="call-notion"]')
  await expect(notion.locator('.tool-card-name')).toHaveText('Notion · Create page')
  await expect(notion.locator('.tool-card-icon svg.lucide-cable')).toHaveCount(1)
  await shot('app-tool-calls')
})
