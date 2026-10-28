import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SkillRevisionsSchema } from '@maudecode/talaria-web-contracts'
import type { z } from 'zod'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })
const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts/fixtures/skill-revisions.json'), 'utf8')) as z.infer<typeof SkillRevisionsSchema>

test('inspects actual saved revisions and a server comparison without executing or editing', async ({ page }, testInfo) => {
  const writes: string[] = []
  page.on('request', (request) => { if (request.method() !== 'GET' && request.url().includes('/api/skills')) writes.push(request.url()) })
  await page.route('**/api/skills', (route) => route.fulfill({ json: { skills: [{ name: 'demo', description: 'Recorded result instructions', category: null, disabled: false }] } }))
  await page.route('**/api/skills/usage', (route) => route.fulfill({ json: { usage: {} } }))
  await page.route('**/api/skills/content?**', (route) => route.fulfill({ json: { success: true, name: 'demo', content: fixture.selected!.content, linked_files: {} } }))
  const requests: URL[] = []
  let missing = false
  await page.route('**/api/skills/revisions?**', (route) => {
    const url = new URL(route.request().url())
    requests.push(url)
    expect(url.searchParams.get('name')).toBe('demo')
    if (missing) return route.fulfill({ json: { ...fixture, state: 'missing', reason: 'history_unavailable', revisions: [], selected: null, comparison: null } })
    if (url.searchParams.get('revision') === fixture.revisions[1]!.id) return route.fulfill({ json: { ...fixture, selected: { revision: fixture.revisions[1]!.id, content: 'Older saved text supplied by the server.' }, comparison: { ...fixture.comparison!, diff: '-Keep answers concise.\n' } } })
    return route.fulfill({ json: fixture })
  })
  await page.goto('/skills')
  await settle(page)
  await page.getByRole('button', { name: /demo/ }).click()
  await expect(page.getByLabel('Skill content')).toBeVisible()
  expect(requests).toHaveLength(0)
  await page.getByText('Saved revisions', { exact: true }).click()
  const region = page.getByRole('region', { name: 'Saved revisions' })
  await expect(region.getByLabel('Saved revision content')).toHaveValue(fixture.selected!.content)
  await expect(region.getByLabel('Saved revision content')).toHaveAttribute('readonly', '')
  await expect(region).toContainText(fixture.backend_revision!)
  await expect(region).toContainText('Current')
  await expect(region).toContainText('user')
  await expect(region.locator('pre')).toHaveText(fixture.comparison!.diff)
  await region.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('revision-after.png'), fullPage: true })
  await region.getByRole('combobox', { name: 'Revision', exact: true }).click()
  await page.getByRole('option', { name: fixture.revisions[1]!.label, exact: true }).click()
  await expect(region.getByLabel('Saved revision content')).toHaveValue('Older saved text supplied by the server.')
  expect(requests.at(-1)?.searchParams.get('revision')).toBe(fixture.revisions[1]!.id)
  await expect(region.getByRole('button', { name: /run|replay|approve|apply|cancel/i })).toHaveCount(0)
  expect(writes).toEqual([])
  // Existing skill editing is independent of the read-only history selection.
  await expect(page.getByLabel('Skill content')).not.toHaveAttribute('readonly')
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeVisible()
  missing = true
  await page.reload()
  await settle(page)
  await page.getByRole('button', { name: /demo/ }).click()
  await page.getByText('Saved revisions', { exact: true }).click()
  await expect(page.getByRole('region', { name: 'Saved revisions' })).toContainText('No saved revisions are available for this skill.')
  await expect(page.getByLabel('Saved revision content')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('revision-missing.png'), fullPage: true })
})
