import { createServer, type ServerResponse } from 'node:http'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

for (const legacy of [true, false]) test(`${legacy ? 'legacy' : 'native'} model allowance and quota views`, async ({ page }, info) => {
  const models = [
    { id: 'included', label: 'Included model', provider_id: 'nous', bare_id: 'included', allowance: { state: 'included', usage_level: 'low', resets_at_ms: null } },
    { id: 'saved', label: 'Saved model', provider_id: 'nous', bare_id: 'saved', allowance: { state: 'unknown', usage_level: null, resets_at_ms: null } },
    { id: 'free', label: 'Free model', provider_id: 'nous', bare_id: 'free', allowance: { state: 'free', usage_level: 'free', resets_at_ms: null } },
    { id: 'large', label: 'Large model', provider_id: 'nous', bare_id: 'large', allowance: { state: 'blocked', usage_level: 'top_tier', resets_at_ms: null } },
  ]
  const plan = { kind: 'usage_window', plan: 'Pro', gauges: [{ label: 'week', title: 'Weekly', scope: 'all', left_fraction: 0, style: 'red', resets_at_ms: null }, { label: 'large', title: 'Large', scope: 'top_tier', left_fraction: 0.8, style: 'green', resets_at_ms: null }], top_tier_model_ids: ['large'], featured_model_ids: ['included'], paused_reason: null, credits_pay: false }
  const group = { provider: 'Nous', provider_id: 'nous', models: legacy ? models.map((m) => ({ id: m.id, label: m.label, provider_id: m.provider_id, bare_id: m.bare_id })) : models,
    ...(legacy ? {} : { plan_usage: plan, sections: [{ kind: 'recommended', model_ids: ['included'] }, { kind: 'other', model_ids: ['saved', 'free', 'large'] }] }),
  }
  await page.route('**/api/models', (route) => route.fulfill({ json: { default_model: 'saved', default_option_id: 'saved', groups: [group] } }))
  await page.route('**/api/model/auxiliary', (route) => route.fulfill({ json: { main: { model: 'saved', provider: 'nous' }, tasks: [] } }))
  await page.goto('/settings/preferences'); await settle(page)
  await page.getByRole('combobox', { name: 'Default Model', exact: true }).click()
  await expect(page.getByRole('option')).toHaveCount(4)
  if (!legacy) {
    await expect(page.getByText('Nous · Recommended', { exact: true })).toBeVisible()
    await expect(page.getByRole('option', { name: 'Large model · Large · Allowance exhausted', exact: true })).toBeVisible()
    await expect(page.getByRole('option', { name: 'Saved model · Allowance unknown', exact: true })).toBeVisible()
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ animations: 'disabled', path: info.outputPath(legacy ? 'before-models.png' : 'after-models.png') })
  await page.keyboard.press('Escape')
  await page.route('**/api/providers', (route) => route.fulfill({ json: { active_provider: 'nous', providers: [{ id: 'nous', display_name: 'Nous', configured: true, has_key: true }] } }))
  await page.route('**/api/provider/quotas*', (route) => route.fulfill({ json: { version: 1, computed_at: '2026-01-01T00:00:00Z', scope_id: 'test-scope', profile_id: 'default', active_provider: 'nous', requested_source_id: null, missing_source: false, sources: legacy ? [] : [{ source_id: 'test-nous', provider_id: 'nous', plan_usage: plan, windows: [] }] } }))
  await page.goto('/settings/providers'); await settle(page)
  if (!legacy) {
    await expect(page.getByTestId('provider-plan-usage')).toContainText('0% remaining')
    await expect(page.getByTestId('provider-plan-usage')).toContainText('80% remaining')
    await expect(page.getByText('Credits cover usage after allowance')).toHaveCount(0)
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ animations: 'disabled', path: info.outputPath(legacy ? 'before-quotas.png' : 'after-quotas.png') })
})

test('run allowance follows the current stream and clears on replacement', async ({ page }, info) => {
  const sid = 'allowance-run'
  const streamId = 'allowance-stream'
  let stream = null as ServerResponse | null
  let seq = 0
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    stream = response
    response.write('event: hello\ndata: {}\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  await page.route('**/api/session?**', (route) => {
    const requested = new URL(route.request().url()).searchParams.get('session_id')
    return route.fulfill({ json: { session: { session_id: requested, title: 'Plan usage', messages: [], active_stream_id: requested === sid ? streamId : null, is_streaming: requested === sid, run_status: { phase: 'working' } } } })
  })
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, blocking_stream_id: null, stream_id: streamId, replay_available: false } }))
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${String(address.port)}${new URL(route.request().url()).search}` }))
  await page.route('**/api/list?**', (route) => route.fulfill({ json: { path: '.', entries: [] } }))
  await page.route('**/api/git-info?**', (route) => route.fulfill({ json: { git: { is_git: false } } }))
  const meter = (plan_gauge: unknown) => stream!.write(`id: ${streamId}:${String(++seq)}\nevent: metering\ndata: ${JSON.stringify({ usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost: null, plan_gauge } })}\n\n`)
  try {
    await page.goto(`/session/${sid}`)
    const pill = page.locator('.composer-notices .live-run-status')
    await expect(pill).toContainText('Working')
    if (info.project.name === 'desktop') await page.getByRole('button', { name: 'Show workspace panel' }).click()
    await expect.poll(() => stream !== null).toBe(true)
    await page.screenshot({ animations: 'disabled', path: info.outputPath('before-run.png') })
    meter({ id: 'day', label: 'Today', used_bp: 8300, resets_at_ms: null })
    await expect(pill).toContainText('Today: 83% used')
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ animations: 'disabled', path: info.outputPath('after-run.png') })
    meter(null)
    await expect(pill).not.toContainText('Today: 83% used')
    await page.goto('/session/another-account')
    await expect(pill).toHaveCount(0)
    await expect(page.locator('[data-plan-gauge]')).toHaveCount(0)
  } finally {
    stream?.end()
    await new Promise<void>((resolve) => server.close(() => { resolve() }))
  }
})
