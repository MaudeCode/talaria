import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SkillRevisionsSchema, type SkillReplayJob, type SkillReplayPlan } from '@maudecode/talaria-web-contracts'
import fixture from '../../../../../../contracts/fixtures/skill-revisions.json'
import planFixture from '../../../../../../contracts/fixtures/skill-replay-plan.json'
import jobFixture from '../../../../../../contracts/fixtures/skill-replay-job.json'

vi.mock('../../api/endpoints', () => ({ fetchSkills: vi.fn(), fetchSkillsUsage: vi.fn(), fetchSkillContent: vi.fn(), fetchSkillRevisions: vi.fn(), fetchSkillReplayPlan: vi.fn(), fetchSkillReplays: vi.fn(), startSkillReplay: vi.fn(), cancelSkillReplay: vi.fn(), saveSkill: vi.fn(), deleteSkill: vi.fn(), toggleSkill: vi.fn(), lockSkill: vi.fn(), fetchPendingWrites: vi.fn(() => Promise.resolve({ kind: 'skills', visible: false, enabled: false, items: [] })) }))
vi.mock('../../shell/AppShell', () => ({ HubPage: ({ actions, toolbar, children }: { actions: React.ReactNode; toolbar: React.ReactNode; children: React.ReactNode }) => <div>{actions}{toolbar}{children}</div> }))
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { ApiError } from '../../contracts/common'
import { teardownAll } from '../../stream/connection'
import { SkillsPage } from './SkillsPage'
import { showToast } from '../toast/toast'
import { loadBootstrap } from '../../app/bootstrap'

vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
vi.mock('../../app/bootstrap', async (original) => ({ ...await original<typeof import('../../app/bootstrap')>(), loadBootstrap: vi.fn(() => Promise.resolve()) }))

beforeEach(() => {
  vi.mocked(api.fetchSkills).mockReset().mockResolvedValue({ skills: [{ name: 'demo', description: 'Example skill', category: null, disabled: false }], total: 1, categories: [], profile: 'default' })
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
  return client
}

const lockRow = (locked: boolean | null) => vi.mocked(api.fetchSkills).mockResolvedValue({ skills: [{ name: 'demo', description: '', category: null, disabled: false, locked }], total: 1, categories: [], profile: 'default' })

it('shows the lock at once, then rolls it back and reports a refusal', async () => {
  lockRow(false)
  let refuse!: (error: unknown) => void
  vi.mocked(api.lockSkill).mockReturnValue(new Promise((_, reject) => { refuse = reject }) as never)
  renderSkills()
  const lock = await screen.findByRole('button', { name: 'Lock demo' })
  expect(lock).toHaveAttribute('aria-pressed', 'false')
  await userEvent.click(lock)
  expect(lock).toHaveAttribute('aria-pressed', 'true')
  expect(api.lockSkill).toHaveBeenCalledWith('demo', true, 'default')
  await act(async () => { refuse(new ApiError({ kind: 'http', status: 409, path: '/api/skills/lock', message: 'skills/.usage.json could not be written' })); await Promise.resolve() })
  await vi.waitFor(() => expect(lock).toHaveAttribute('aria-pressed', 'false'))
  expect(showToast).toHaveBeenCalledWith('skills/.usage.json could not be written', 4000, 'error')
})

// TAL-2717: another tab switched the shared profile; the toggle lands nowhere and the page reloads onto the active profile.
it('rolls a toggle refused with profile_changed back, shows the server error and reloads the list', async () => {
  const refused = 'The active profile changed to beta in another tab. Nothing was saved.'
  vi.mocked(api.toggleSkill).mockRejectedValue(new ApiError({ kind: 'http', status: 409, path: '/api/skills/toggle', message: refused, body: { error: refused, condition: 'profile_changed' } }))
  renderSkills()
  const toggle = await screen.findByRole('switch', { name: 'demo' })
  expect(toggle).toBeChecked()
  const reads = vi.mocked(api.fetchSkills).mock.calls.length
  await userEvent.click(toggle)
  expect(api.toggleSkill).toHaveBeenCalledWith('demo', false, 'default')
  await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith(refused, 4000, 'error'))
  await vi.waitFor(() => expect(vi.mocked(api.fetchSkills).mock.calls.length).toBeGreaterThan(reads))
  expect(await screen.findByRole('switch', { name: 'demo' })).toBeChecked()
  // The shell's profile and every other cached read reload, as an in-tab switch does.
  expect(loadBootstrap).toHaveBeenCalledTimes(1)
})

it('keeps a skill edit refused with profile_changed, and reloads the profile once the editor is left', async () => {
  const refused = 'The active profile changed to beta in another tab. Nothing was saved.'
  vi.mocked(api.saveSkill).mockRejectedValue(new ApiError({ kind: 'http', status: 409, path: '/api/skills/save', message: refused, body: { error: refused, condition: 'profile_changed' } }))
  renderSkills()
  await userEvent.click(await screen.findByRole('button', { name: /^demo/ }))
  const editor = await screen.findByRole('textbox')
  await userEvent.type(editor, '!')
  await userEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.saveSkill).toHaveBeenCalledWith('demo', 'Current editable content!', 'default')
  await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith(refused, 4000, 'error'))
  expect(editor).toHaveValue('Current editable content!')
  expect(loadBootstrap).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(loadBootstrap).toHaveBeenCalledTimes(1)
})

it('saves a skill edit naming the profile it started on after the list refetches another', async () => {
  vi.mocked(api.saveSkill).mockResolvedValue({ ok: true, name: 'demo', path: '/h/skills/demo/SKILL.md' })
  const client = renderSkills()
  await userEvent.click(await screen.findByRole('button', { name: /^demo/ }))
  await userEvent.type(await screen.findByRole('textbox'), '!')
  // Another tab switched to `beta`; a focus refetch brings the list under that profile while the editor stays open.
  vi.mocked(api.fetchSkills).mockResolvedValue({ skills: [{ name: 'demo', description: '', category: null, disabled: false }], total: 1, categories: [], profile: 'beta' })
  await act(() => client.refetchQueries())
  await vi.waitFor(() => expect(client.getQueryData<{ profile: string }>([...keys.skills.list, { q: '', category: '' }])?.profile).toBe('beta'))
  await userEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.saveSkill).toHaveBeenCalledWith('demo', 'Current editable content!', 'default')
})

it('unlocks a locked skill from its row menu, the same action as the row control', async () => {
  lockRow(true)
  vi.mocked(api.lockSkill).mockResolvedValue({ ok: true, name: 'demo', locked: false })
  renderSkills()
  expect(await screen.findByRole('button', { name: 'Lock demo' })).toHaveAttribute('aria-pressed', 'true')
  fireEvent.contextMenu(screen.getByRole('button', { name: /^demo/ }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Unlock' }))
  expect(api.lockSkill).toHaveBeenCalledWith('demo', false, 'default')
})

it.each([[null], [undefined]])('offers no lock while the server reports it unavailable (%s)', async (locked) => {
  vi.mocked(api.fetchSkills).mockResolvedValue({ skills: [{ name: 'demo', description: '', category: null, disabled: false, ...(locked === null ? { locked } : {}) }], total: 1, categories: [], profile: 'default' })
  renderSkills()
  await screen.findByRole('switch', { name: 'demo' })
  expect(screen.queryByRole('button', { name: 'Lock demo' })).toBeNull()
})

// TAL-2480: the server filters and names the categories; the page sends the filter and shows the answer.
it('sends the search and category to the server and renders its answer', async () => {
  vi.mocked(api.fetchSkills).mockImplementation(({ q = '', category = '' } = {}) => Promise.resolve({ total: 3, categories: ['docs', 'tools'], profile: 'default',
    skills: q || category ? [{ name: `${category}:${q}`, description: '', category: null, disabled: false }] : [{ name: 'demo', description: '', category: null, disabled: false }] }))
  renderSkills()
  await screen.findByRole('switch', { name: 'demo' })
  await userEvent.type(screen.getByRole('searchbox'), ' pdf ')
  expect(await screen.findByRole('switch', { name: ':pdf' })).toBeInTheDocument()
  expect(api.fetchSkills).toHaveBeenLastCalledWith({ q: 'pdf', category: '' })
  await userEvent.click(screen.getByRole('combobox', { name: 'All categories' }))
  expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['All categories', 'docs', 'tools'])
  await userEvent.click(screen.getByRole('option', { name: 'tools' }))
  expect(await screen.findByRole('switch', { name: 'tools:pdf' })).toBeInTheDocument()
  expect(screen.queryByRole('switch', { name: ':pdf' })).toBeNull()
  expect(api.fetchSkills).toHaveBeenLastCalledWith({ q: 'pdf', category: 'tools' })
})

it('opens the skill a tool row links to (TAL-2326)', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><SkillsPage initialSkill="demo" /></QueryClientProvider>)
  expect(await screen.findByLabelText('Skill content')).toHaveValue('Current editable content')
  expect(api.fetchSkillContent).toHaveBeenCalledWith('demo')
})

async function openHistory() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><SkillsPage /></QueryClientProvider>)
  await userEvent.click(await screen.findByRole('button', { name: /demo/ }))
  await screen.findByLabelText('Skill content')
  expect(api.fetchSkillRevisions).not.toHaveBeenCalled()
  await userEvent.click(screen.getByText('Saved revisions', { exact: true }))
}

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
