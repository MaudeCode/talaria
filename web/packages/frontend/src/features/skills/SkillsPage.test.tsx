import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SkillRevisionsSchema, type SkillReplayJob, type SkillReplayPlan } from '@maudecode/talaria-web-contracts'
import fixture from '../../../../../../contracts/fixtures/skill-revisions.json'
import planFixture from '../../../../../../contracts/fixtures/skill-replay-plan.json'
import jobFixture from '../../../../../../contracts/fixtures/skill-replay-job.json'

vi.mock('../../api/endpoints', () => ({ fetchSkills: vi.fn(), fetchSkillsUsage: vi.fn(), fetchSkillContent: vi.fn(), fetchSkillRevisions: vi.fn(), fetchSkillReplayPlan: vi.fn(), fetchSkillReplays: vi.fn(), startSkillReplay: vi.fn(), cancelSkillReplay: vi.fn(), saveSkill: vi.fn(), deleteSkill: vi.fn(), toggleSkill: vi.fn(), lockSkill: vi.fn(), fetchPendingWrites: vi.fn(() => Promise.resolve({ kind: 'skills', visible: false, enabled: false, items: [] })) }))
vi.mock('../../shell/AppShell', () => ({ HubPage: ({ actions, children }: { actions: React.ReactNode; children: React.ReactNode }) => <div>{actions}{children}</div> }))
import * as api from '../../api/endpoints'
import { ApiError } from '../../contracts/common'
import { teardownAll } from '../../stream/connection'
import { SkillsPage } from './SkillsPage'
import { showToast } from '../toast/toast'

vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))

beforeEach(() => {
  vi.mocked(api.fetchSkills).mockReset().mockResolvedValue({ skills: [{ name: 'demo', description: 'Example skill', category: null, disabled: false }] })
  vi.mocked(api.fetchSkillsUsage).mockReset().mockResolvedValue({ usage: {} })
  vi.mocked(api.fetchSkillContent).mockReset().mockResolvedValue({ success: true, content: 'Current editable content', linked_files: {} })
  vi.mocked(api.fetchSkillRevisions).mockReset().mockResolvedValue(SkillRevisionsSchema.parse(fixture))
  vi.mocked(api.fetchSkillReplays).mockReset().mockResolvedValue({ jobs: [] })
  vi.mocked(api.fetchSkillReplayPlan).mockReset().mockResolvedValue(planFixture as unknown as SkillReplayPlan)
  vi.mocked(api.startSkillReplay).mockReset().mockResolvedValue(jobFixture as unknown as SkillReplayJob)
  vi.mocked(api.cancelSkillReplay).mockReset()
})

afterEach(() => { vi.unstubAllGlobals() })

function renderSkills() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><SkillsPage /></QueryClientProvider>)
}

const lockRow = (locked: boolean | null) => vi.mocked(api.fetchSkills).mockResolvedValue({ skills: [{ name: 'demo', description: '', category: null, disabled: false, locked }] })

it('shows the lock at once, then rolls it back and reports a refusal', async () => {
  lockRow(false)
  let refuse!: (error: unknown) => void
  vi.mocked(api.lockSkill).mockReturnValue(new Promise((_, reject) => { refuse = reject }) as never)
  renderSkills()
  const lock = await screen.findByRole('button', { name: 'Lock demo' })
  expect(lock).toHaveAttribute('aria-pressed', 'false')
  await userEvent.click(lock)
  expect(lock).toHaveAttribute('aria-pressed', 'true')
  expect(api.lockSkill).toHaveBeenCalledWith('demo', true)
  await act(async () => { refuse(new ApiError({ kind: 'http', status: 409, path: '/api/skills/lock', message: 'This Agent version cannot lock skills' })); await Promise.resolve() })
  await vi.waitFor(() => expect(lock).toHaveAttribute('aria-pressed', 'false'))
  expect(showToast).toHaveBeenCalledWith('This Agent version cannot lock skills', 4000, 'error')
})

it('unlocks a locked skill from its row menu, the same action as the row control', async () => {
  lockRow(true)
  vi.mocked(api.lockSkill).mockResolvedValue({ ok: true, name: 'demo', locked: false })
  renderSkills()
  expect(await screen.findByRole('button', { name: 'Lock demo' })).toHaveAttribute('aria-pressed', 'true')
  fireEvent.contextMenu(screen.getByRole('button', { name: /^demo/ }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Unlock' }))
  expect(api.lockSkill).toHaveBeenCalledWith('demo', false)
})

it.each([[null], [undefined]])('offers no lock while the server reports it unavailable (%s)', async (locked) => {
  vi.mocked(api.fetchSkills).mockResolvedValue({ skills: [{ name: 'demo', description: '', category: null, disabled: false, ...(locked === null ? { locked } : {}) }] })
  renderSkills()
  await screen.findByRole('switch', { name: 'demo' })
  expect(screen.queryByRole('button', { name: 'Lock demo' })).toBeNull()
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

const plan = planFixture as unknown as SkillReplayPlan
const job = jobFixture as unknown as SkillReplayJob

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

it('opens a skill and admits a replay on a plain-HTTP origin, where crypto.randomUUID does not exist', async () => {
  const secure = globalThis.crypto
  vi.stubGlobal('crypto', { getRandomValues: secure.getRandomValues.bind(secure) })
  await openHistory()
  await userEvent.click(await screen.findByRole('button', { name: 'Replay saved checks' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Replay' }))
  expect(vi.mocked(api.startSkillReplay).mock.calls[0]![0].request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
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
