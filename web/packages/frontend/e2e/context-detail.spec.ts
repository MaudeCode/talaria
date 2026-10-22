import { readFileSync } from 'node:fs'
import { expect, test } from './fixtures'
import { ContextDetailSchema } from '@maudecode/talaria-web-contracts'

const fixture = JSON.parse(readFileSync(new URL('../../contracts/fixtures/sidecar/context-detail.json', import.meta.url), 'utf8')) as Record<string, { result: unknown }[]>
const detail = ContextDetailSchema.parse(fixture['chat.context_detail']![0]!.result)

test('the existing context inspector renders allocation and safe file metadata on desktop and mobile', async ({ page }, info) => {
  let reads = 0
  let currentDetail = detail
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: 'context-detail', title: 'Context inspection', model: 'fixture-model', context_detail_key: 'synthetic-owner-context',
    messages: [{ role: 'user', content: 'Inspect the context allocation.' }, { role: 'assistant', content: 'Context metadata is available from the conversation control.' }],
    context_used_tokens: 3790, context_window_tokens: 256000, context_usage_percent: 1, can_compress: true,
  } } }))
  await page.route('**/api/session/context-detail?**', (route) => { expect(new URL(route.request().url()).searchParams.get('context_detail_key')).toBe('synthetic-owner-context'); reads += 1; return route.fulfill({ json: currentDetail }) })
  await page.goto('/session/context-detail')
  await expect(page.locator('#msg')).toBeVisible()
  expect(reads).toBe(0)
  const phone = info.project.name === 'mobile'
  if (phone) { await page.locator('#msg').focus(); await expect(page.locator('#composerMobileConfigBtn')).toBeVisible(); expect(reads).toBe(0); await page.locator('#composerMobileConfigBtn').click() }
  else await page.locator('#ctxIndicator').click()
  const inspector = page.locator(phone ? '#composerMobileContextAction' : '#ctxPopup')
  await expect(inspector).toContainText('Occupancy from local estimate')
  await expect(inspector).toContainText('Estimated tokens by category')
  await expect(inspector).toContainText('AGENTS.md')
  await expect(inspector).toContainText('4,000 characters · ~1,000 tokens')
  await expect(inspector.getByRole('button', { name: 'Compress now' })).toBeVisible()
  await expect.poll(() => reads).toBe(1)
  await page.screenshot({ path: info.outputPath('context-detail-after.png') })
  expect(await inspector.innerText()).not.toContain('/private')
  const bounds = await inspector.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(info.project.use.viewport!.width)
  // Closing releases the query; a maximal manifest still keeps every control reachable.
  if (phone) await page.locator('#composerMobileConfigBtn').click()
  else await page.keyboard.press('Escape')
  currentDetail = { ...detail, files: Array.from({ length: 64 }, () => detail.files[0]!) }
  if (phone) await page.locator('#composerMobileConfigBtn').click()
  else await page.locator('#ctxIndicator').click()
  await expect(inspector.getByText('AGENTS.md', { exact: true })).toHaveCount(64)
  await inspector.getByRole('button', { name: 'Compress now' }).scrollIntoViewIfNeeded()
  await expect(inspector.getByRole('button', { name: 'Compress now' })).toBeVisible()
  const scrollContainer = page.locator(phone ? '#composerMobileConfigPanel' : '#ctxPopup')
  expect((await scrollContainer.boundingBox())!.y).toBeGreaterThanOrEqual(0)
  expect((await scrollContainer.boundingBox())!.height).toBeLessThan(info.project.use.viewport!.height)
})
