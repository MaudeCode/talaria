import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, it, vi } from 'vitest'
import { SkillRevisionsSchema, type SkillReplayJob, type SkillReplayPlan } from '@maudecode/talaria-web-contracts'
import fixture from '../../../../../../contracts/fixtures/skill-revisions.json'
import planFixture from '../../../../../../contracts/fixtures/skill-replay-plan.json'
import jobFixture from '../../../../../../contracts/fixtures/skill-replay-job.json'

vi.mock('../../api/endpoints', () => ({ fetchSkills: vi.fn(), fetchSkillsUsage: vi.fn(), fetchSkillContent: vi.fn(), fetchSkillRevisions: vi.fn(), fetchSkillReplayPlan: vi.fn(), fetchSkillReplays: vi.fn(), startSkillReplay: vi.fn(), cancelSkillReplay: vi.fn(), saveSkill: vi.fn(), deleteSkill: vi.fn(), toggleSkill: vi.fn(), fetchPendingWrites: vi.fn(() => Promise.resolve({ kind: 'skills', visible: false, enabled: false, items: [] })) }))
vi.mock('../../shell/AppShell', () => ({ HubPage: ({ actions, children }: { actions: React.ReactNode; children: React.ReactNode }) => <div>{actions}{children}</div> }))
import * as api from '../../api/endpoints'
import { teardownAll } from '../../stream/connection'
import { SkillsPage } from './SkillsPage'

beforeEach(() => {
  vi.mocked(api.fetchSkills).mockReset().mockResolvedValue({ skills: [{ name: 'demo', description: 'Example skill', category: null, disabled: false }] })
  vi.mocked(api.fetchSkillsUsage).mockReset().mockResolvedValue({ usage: {} })
  vi.mocked(api.fetchSkillContent).mockReset().mockResolvedValue({ success: true, content: 'Current editable content', linked_files: {} })
  vi.mocked(api.fetchSkillRevisions).mockReset().mockResolvedValue(SkillRevisionsSchema.parse(fixture))
  vi.mocked(api.fetchSkillReplays).mockReset().mockResolvedValue({ jobs: [] })
  vi.mocked(api.fetchSkillReplayPlan).mockReset().mockResolvedValue(planFixture as SkillReplayPlan)
  vi.mocked(api.startSkillReplay).mockReset().mockResolvedValue(jobFixture as SkillReplayJob)
  vi.mocked(api.cancelSkillReplay).mockReset()
})

async function openHistory() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><SkillsPage /></QueryClientProvider>)
  await userEvent.click(await screen.findByRole('button', { name: /demo/ }))
  await screen.findByLabelText('Skill content')
  expect(api.fetchSkillRevisions).not.toHaveBeenCalled()
  await userEvent.click(screen.getByText('Saved revisions', { exact: true }))
}

it('renders server history and diff read-only while preserving the current editor', async () => {
  vi.mocked(api.fetchSkillRevisions).mockResolvedValue({ ...SkillRevisionsSchema.parse(fixture), replay_available: false })
  await openHistory()
  expect(await screen.findByLabelText('Saved revision content')).toHaveValue(fixture.selected.content)
  expect(screen.getByLabelText('Saved revision content')).toHaveAttribute('readonly')
  expect(screen.getByRole('region', { name: 'Saved revisions' }).querySelector('pre')?.textContent).toBe(fixture.comparison.diff)
  expect(screen.getByLabelText('Skill content')).toHaveValue('Current editable content')
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled()
  expect(screen.queryByRole('button', { name: /run|replay/i })).toBeNull()
})

it('shows explicit missing history without fabricating a revision from current content', async () => {
  vi.mocked(api.fetchSkillRevisions).mockResolvedValue({ state: 'missing', reason: 'history_unavailable', backend_revision: fixture.backend_revision, revisions: [], selected: null, comparison: null, replay_available: false })
  await openHistory()
  expect(await screen.findByText('No saved revisions are available for this skill.')).toBeInTheDocument()
  expect(screen.queryByLabelText('Saved revision content')).toBeNull()
})

it('discards history that finishes after the profile context changes', async () => {
  let finish!: (value: Awaited<ReturnType<typeof api.fetchSkillRevisions>>) => void
  vi.mocked(api.fetchSkillRevisions).mockReturnValue(new Promise((resolve) => { finish = resolve }))
  await openHistory()
  act(() => teardownAll())
  await act(async () => { finish(SkillRevisionsSchema.parse(fixture)); await Promise.resolve() })
  expect(screen.queryByLabelText('Saved revision content')).toBeNull()
  expect(screen.getByRole('region', { name: 'Saved revisions' }).querySelector('pre')).toBeNull()
})

const plan = planFixture as SkillReplayPlan
const job = jobFixture as SkillReplayJob

it('asks consent for the exact revisions, cases, provider and budget before admitting one bound replay', async () => {
  await openHistory()
  await userEvent.click(await screen.findByRole('button', { name: 'Replay saved checks' }))
  expect(api.fetchSkillReplayPlan).toHaveBeenCalledWith('demo', fixture.comparison.from_revision, fixture.comparison.to_revision)
  const dialog = await screen.findByRole('alertdialog')
  expect(dialog).toHaveTextContent(`Baseline ${plan.revisions[0]!.label} · Candidate ${plan.revisions[1]!.label}`)
  for (const row of plan.cases) expect(dialog).toHaveTextContent(row.title)
  expect(dialog).toHaveTextContent('Left out without a recorded turn: 1')
  expect(dialog).toHaveTextContent('Provider: openrouter · vendor/model-a')
  expect(dialog).toHaveTextContent('Up to $0.50 · 4 calls · 1500 output tokens per call')
  expect(api.startSkillReplay).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Replay' }))
  expect(api.startSkillReplay).toHaveBeenCalledTimes(1)
  const request = vi.mocked(api.startSkillReplay).mock.calls[0]![0]
  expect(request).toEqual({ request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown, name: 'demo', baseline: plan.revisions[0]!.id, candidate: plan.revisions[1]!.id, case_ids: plan.cases.map((row) => row.id), route: plan.route, max_cost_usd: 0.5 })
})

it('reuses the request id after an uncertain admission so a retry cannot start a second replay', async () => {
  vi.mocked(api.startSkillReplay).mockRejectedValueOnce(Object.assign(new Error('network lost'), { status: 503 }))
  await openHistory()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await userEvent.click(await screen.findByRole('button', { name: 'Replay saved checks' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Replay' }))
    await vi.waitFor(() => { expect(api.startSkillReplay).toHaveBeenCalledTimes(attempt + 1) })
    await vi.waitFor(() => { expect(screen.getByRole('button', { name: 'Replay saved checks' })).toBeEnabled() })
  }
  const [first, second] = vi.mocked(api.startSkillReplay).mock.calls.map(([input]) => input.request_id)
  expect(second).toBe(first)
})

it('explains an unverifiable route instead of offering consent', async () => {
  vi.mocked(api.fetchSkillReplayPlan).mockResolvedValue({ ...plan, state: 'unavailable', reason: 'route_unsupported', cases: [], budget: null })
  await openHistory()
  await userEvent.click(await screen.findByRole('button', { name: 'Replay saved checks' }))
  expect(await screen.findByText('Replays need an OpenRouter main model, which enforces the budget on every call.')).toBeInTheDocument()
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(api.startSkillReplay).not.toHaveBeenCalled()
})

it('shows retained server results and cancels an active replay at once', async () => {
  let finish!: (value: typeof job) => void
  vi.mocked(api.cancelSkillReplay).mockReturnValue(new Promise((resolve) => { finish = resolve }))
  vi.mocked(api.fetchSkillReplays).mockResolvedValue({ jobs: [{ ...job, state: 'running', active: true, can_cancel: true }] })
  await openHistory()
  const results = await screen.findByRole('region', { name: 'Replay results' })
  expect(results).toHaveTextContent('Running')
  expect(results).toHaveTextContent('Baseline: passed 0 · failed 1 · errors 0 · unknown 1 · refused 0 · skipped 0')
  expect(results).toHaveTextContent('Email the weekly summary')
  expect(results).toHaveTextContent('Unknown outcome')
  expect(results).toHaveTextContent('Provider answered HTTP 402')
  expect(screen.getByRole('button', { name: 'Replay saved checks' })).toBeDisabled()
  await userEvent.click(screen.getByRole('button', { name: 'Cancel replay' }))
  expect(api.cancelSkillReplay).toHaveBeenCalledWith(job.id)
  expect(await screen.findByText('Cancelling')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Cancel replay' })).toBeNull()
  await act(async () => { finish({ ...job, state: 'cancelling', active: true, can_cancel: false }); await Promise.resolve() })
})
