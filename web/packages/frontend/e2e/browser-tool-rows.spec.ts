import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, settle, test } from './fixtures'

// Service-worker requests bypass page routing; these fixtures own every response.
test.use({ serviceWorkers: 'block' })

const fixture = (JSON.parse(readFileSync(join(import.meta.dirname, '../../../../contracts/fixtures/web-session.json'), 'utf8')) as { tool_browser_views: { session: { messages: unknown[] } } }).tool_browser_views

test('browser and computer-use calls show their verbs, code, screenshots and rows, never JSON (TAL-2328)', async ({ page }, testInfo) => {
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}-${testInfo.project.name}.png`), fullPage: true })
  // The screenshots the calls saved: a rendered page stands in for each.
  const source = await page.context().newPage()
  await source.setViewportSize({ width: 640, height: 400 })
  await source.setContent('<body style="margin:0;font:24px system-ui;background:#f4f4f5;color:#18181b"><header style="padding:16px 24px;background:#4338ca;color:#fff">Example — Pricing</header><main style="padding:24px"><h1 style="margin:0 0 12px">Pricing</h1><p>Starter $10/month</p><button style="font:inherit;padding:8px 20px">Buy</button></main></body>')
  const png = await source.screenshot()
  await source.close()
  const media: string[] = []
  await page.route('**/api/media?**', (route) => { media.push(new URL(route.request().url()).searchParams.get('path') ?? ''); return route.fulfill({ body: png, contentType: 'image/png' }) })
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'browser-session', title: 'Check the pricing page', messages: fixture.session.messages } } }))

  await page.goto('/session/browser-session')
  await settle(page)
  // The worklog opens on its own (its calls carry media); its browser and computer calls fold under their kinds' summary.
  await page.getByRole('button', { name: 'Used the browser, used the computer' }).click()
  const exec = page.locator('[data-tool-id="call-exec"]')
  await expect(exec).toHaveAttribute('data-tool-kind', 'browser')
  await expect(exec.locator('svg.lucide-app-window')).toHaveCount(1)
  await expect(exec.locator('.tool-card-name')).toHaveText('Ran Open the pricing page')
  await expect(page.locator('[data-tool-id="call-cdp"] .tool-card-name')).toHaveText('Sent Page.captureScreenshot')
  await expect(page.locator('[data-tool-id="call-fill"] .tool-card-name')).toHaveText('Filled a login')
  // The screenshot shows without opening the call.
  await exec.locator('.tool-card-media img').scrollIntoViewIfNeeded()
  await expect.poll(() => exec.locator('.tool-card-media img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
  await exec.locator('.tool-card-header').click()
  await expect(exec.locator('.tool-file-excerpt')).toContainText('goto("https://example.com/pricing")')
  await expect(exec.locator('.tool-card-result')).toContainText('Pricing: $10/month')
  // The code sits above its output, and an excerpt with no file offers no Open.
  await expect(exec.locator('.tool-file-excerpt + pre')).toHaveText('Pricing: $10/month')
  await expect(exec.locator('.tool-file-excerpt button')).toHaveCount(0)
  const fill = page.locator('[data-tool-id="call-fill"]')
  await fill.locator('.tool-card-header').click()
  await expect(fill.locator('.tool-card-result')).toContainText('Filled 2 fields on https://example.com')
  await expect(fill.locator('.tool-card-result')).not.toContainText('"filled_fields"')
  await shot('browser-tool-rows')

  const capture = page.locator('[data-tool-id="call-capture"]')
  await expect(capture).toHaveAttribute('data-tool-kind', 'computer')
  await expect(capture.locator('svg.lucide-monitor')).toHaveCount(1)
  await expect(capture.locator('.tool-card-name')).toHaveText('Captured the screen')
  await capture.locator('.tool-card-media img').scrollIntoViewIfNeeded()
  await expect.poll(() => capture.locator('.tool-card-media img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
  await capture.locator('.tool-card-header').click()
  await expect(capture.locator('.tool-card-result')).toContainText('Pricing · 2 elements')
  await expect(capture.locator('.tool-card-result')).not.toContainText('capture mode=som')
  await expect(page.locator('[data-tool-id="call-click"] .tool-card-name')).toHaveText('Clicked on the screen')
  await shot('computer-tool-rows')
  expect(new Set(media)).toEqual(new Set(['/srv/hermes/cache/browser-use/workspace/default/pricing.png', '/srv/hermes/cache/computer_use/cap_1.png']))
})
