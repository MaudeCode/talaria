import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SkillReplayJob, SkillReplayPlan, SkillRevisionsSchema } from '@maudecode/talaria-web-contracts'
import type { z } from 'zod'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })
const read = (name: string): unknown => JSON.parse(readFileSync(resolve(import.meta.dirname, `../../../../contracts/fixtures/${name}.json`), 'utf8'))
const revisions = read('skill-revisions') as z.infer<typeof SkillRevisionsSchema>
const plan = read('skill-replay-plan') as SkillReplayPlan
const finished = read('skill-replay-job') as SkillReplayJob

test('consents to one exact bounded replay, cancels it, and keeps its results', async ({ page }, testInfo) => {
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}-${testInfo.project.name}.png`), fullPage: true })
  await page.route('**/api/skills', (route) => route.fulfill({ json: { skills: [{ name: 'demo', description: 'Recorded result instructions', category: null, disabled: false }] } }))
  await page.route('**/api/skills/usage', (route) => route.fulfill({ json: { usage: {} } }))
  await page.route('**/api/skills/content?**', (route) => route.fulfill({ json: { success: true, name: 'demo', content: revisions.selected!.content, linked_files: {} } }))
  await page.route('**/api/skills/revisions?**', (route) => route.fulfill({ json: revisions }))
  await page.route('**/api/skills/replays/plan?**', (route) => route.fulfill({ json: plan }))
  const running: SkillReplayJob = { ...finished, state: 'running', active: true, can_cancel: true, reported_cost_usd: 0.0003, unreported_calls: 0,
    cases: finished.cases.map((row, i) => i === 0 ? { ...row, candidate: { status: 'dispatched', detail: null, result: null } } : { ...row, baseline: { status: 'pending', detail: null, result: null }, candidate: { status: 'pending', detail: null, result: null } }),
    summary: [{ ...finished.summary[0]!, unknown: 0, pending: 1 }, { ...finished.summary[1]!, passed: 0, error: 0, pending: 2 }] }
  const cancelled: SkillReplayJob = { ...running, state: 'cancelled', active: false, can_cancel: false,
    cases: running.cases.map((row, i) => i === 0 ? { ...row, candidate: finished.cases[0]!.candidate } : { ...row, baseline: { status: 'skipped', detail: 'Cancelled before this call was sent', result: null }, candidate: { status: 'skipped', detail: 'Cancelled before this call was sent', result: null } }),
    summary: [{ ...finished.summary[0]!, unknown: 0, skipped: 1 }, { ...finished.summary[1]!, error: 0, skipped: 1 }] }
  let jobs: SkillReplayJob[] = []
  const starts: unknown[] = []
  const cancels: unknown[] = []
  await page.route('**/api/skills/replays/cancel', async (route) => { cancels.push(route.request().postDataJSON()); await route.fulfill({ json: { ...running, state: 'cancelling', can_cancel: false } }) })
  await page.route('**/api/skills/replays?**', (route) => route.fulfill({ json: { jobs } }))
  await page.route('**/api/skills/replays', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    starts.push(route.request().postDataJSON())
    jobs = [running]
    return route.fulfill({ json: running })
  })
  await page.goto('/skills')
  await settle(page)
  await page.getByRole('button', { name: /demo/ }).click()
  await page.getByText('Saved revisions', { exact: true }).click()
  const region = page.getByRole('region', { name: 'Saved revisions' })
  await region.getByRole('button', { name: 'Replay saved checks' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText(`Baseline ${plan.revisions[0]!.label} · Candidate ${plan.revisions[1]!.label}`)
  for (const row of plan.cases) await expect(dialog).toContainText(row.title)
  await expect(dialog).toContainText('Provider: openrouter · vendor/model-a')
  await expect(dialog).toContainText('Up to $0.50 · 4 calls · 1500 output tokens per call')
  expect(starts).toEqual([])
  await shot('replay-consent')
  await dialog.getByRole('button', { name: 'Replay', exact: true }).click()
  await expect(region.getByRole('region', { name: 'Replay results' })).toContainText('Running')
  expect(starts).toEqual([{ request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown, name: 'demo', baseline: plan.revisions[0]!.id, candidate: plan.revisions[1]!.id, case_ids: plan.cases.map((row) => row.id), route: plan.route, max_cost_usd: 0.5 }])
  await expect(region.getByRole('button', { name: 'Replay saved checks' })).toBeDisabled()
  await region.getByRole('region', { name: 'Replay results' }).scrollIntoViewIfNeeded()
  await shot('replay-running')
  jobs = [{ ...running, state: 'cancelling', can_cancel: false }]
  await region.getByRole('button', { name: 'Cancel replay' }).click()
  await expect(region.getByRole('region', { name: 'Replay results' })).toContainText('Cancelling')
  expect(cancels).toEqual([{ id: finished.id }])
  jobs = [cancelled]
  await expect(region.getByRole('region', { name: 'Replay results' })).toContainText('Cancelled', { timeout: 15_000 })
  await expect(region.getByRole('region', { name: 'Replay results' })).toContainText('Skipped')
  await shot('replay-cancelled')
  // Retained results survive a reload: the server keeps every per-case actual result.
  jobs = [finished, cancelled]
  await page.reload()
  await settle(page)
  await page.getByRole('button', { name: /demo/ }).click()
  await page.getByText('Saved revisions', { exact: true }).click()
  const results = page.getByRole('region', { name: 'Replay results' })
  await expect(results.locator('article').first()).toContainText('Completed')
  await expect(results.locator('article').first()).toContainText('Candidate: passed 1 · failed 0 · errors 1 · unknown 0 · refused 0 · skipped 0')
  await expect(results.locator('article').first()).toContainText('Unknown outcome')
  await expect(results.locator('article').first()).toContainText('send_email')
  await results.scrollIntoViewIfNeeded()
  await shot('replay-results')
})
