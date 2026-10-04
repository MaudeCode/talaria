import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CronJob } from '../../contracts'

vi.mock(import('../../api/endpoints'), async (importOriginal) => ({
  ...(await importOriginal()),
  fetchCrons: vi.fn(), fetchCronStatus: vi.fn(), fetchCronHistory: vi.fn(), fetchCronRun: vi.fn(), cronAction: vi.fn(),
  fetchCronContextSources: vi.fn(), fetchCronDeliveryOptions: vi.fn(), fetchSkills: vi.fn(), fetchProfiles: vi.fn(), fetchModels: vi.fn(),
}))
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { useTasksWorkbench } from './TasksPage'

// Persisted shape: cron.jobs.create_job record plus _cron_job_for_api projections
// (profile, toast_notifications, monitor, continuity) with every field set.
const full: CronJob = {
  id: 'ab12cd34ef56', name: 'Digest', prompt: 'Summarise the inbox', skills: ['inbox', 'summary'], model: 'gpt-5.6-sol', provider: 'openai-codex',
  script: 'collect.sh', no_agent: false, monitor: 'https://example.com/status', continuity: true, context_from: ['self', 'feed0000feed'],
  schedule: { kind: 'cron', expr: '0 9 * * *', display: '0 9 * * *' }, schedule_display: '0 9 * * *', schedule_input: '0 9 * * *', repeat: { times: null, completed: 4 },
  enabled: true, state: 'scheduled', next_run_at: '2026-09-18T09:00:00+02:00', last_run_at: '2026-09-17T09:00:00+02:00', last_status: 'ok',
  last_error: null, last_delivery_error: null, deliver: 'telegram', workdir: '/srv/digest', reasoning_effort: 'high', profile: 'work', toast_notifications: false,
  derived_state: 'active', needs_attention: false, resumable: false,
}
const feed: CronJob = { ...full, id: 'feed0000feed', name: 'Feed', context_from: [], continuity: false, monitor: '', skills: [], reasoning_effort: null, model: null, provider: null, workdir: null }
const attention: CronJob = { ...feed, id: 'a77e0000a77e', name: 'Stuck', enabled: false, state: 'completed', next_run_at: null, last_error: "No module named 'croniter'", last_delivery_error: 'telegram: 401', derived_state: 'needs_attention', needs_attention: true, resumable: true }
const foreign: CronJob = { ...feed, id: 'f0e1f0e1f0e1', name: 'Other profile job', read_only: true, owner_profile: 'personal', profile: 'personal' }

/** The route without the app shell: selection is local state instead of `?job=`. */
function Workbench() {
  const [selected, setSelected] = useState<string | null>(null)
  const { sidebar, main } = useTasksWorkbench(selected, setSelected)
  // The shell's right-panel slot: the run panel portals into it.
  return <><aside data-testid="sidebar">{sidebar}</aside><main data-testid="main">{main}</main><div id="rightpanelSlot" /></>
}

let qc: QueryClient
function renderPage(jobs: CronJob[]) {
  vi.mocked(api.fetchCrons).mockResolvedValue({ jobs, active_profile: 'work', all_profiles: false, other_profile_count: 0 })
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><Workbench /></QueryClientProvider>)
}

async function openJob(name: string, jobs: CronJob[] = [full, feed]) {
  renderPage(jobs)
  return selectJob(name)
}

async function selectJob(name: string) {
  await userEvent.click(await within(screen.getByTestId('sidebar')).findByRole('button', { name: new RegExp(name) }))
  await screen.findByTestId('cron-detail')
  return within(screen.getByTestId('main'))
}

const runs = Array.from({ length: 50 }, (_, i) => ({ filename: `2026-09-${String(17 - (i % 17)).padStart(2, '0')}_09-00-${String(i).padStart(2, '0')}.md`, size: 1200 + i, modified: 1_789_600_000 - i * 3600, usage: { input_tokens: 1000 + i, output_tokens: 50 } }))

describe('TasksPage', () => {
  beforeEach(() => {
    // jsdom has no matchMedia; the empty state asks whether the sidebar is a drawer.
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }))
    vi.mocked(api.fetchCronContextSources).mockImplementation((input) => Promise.resolve({ profile: input.profile || 'work', sources: [{ job_id: feed.id!, label: 'Feed', selectable: true }] }))
    vi.mocked(api.fetchCronStatus).mockResolvedValue({ running: {} })
    vi.mocked(api.fetchCronHistory).mockResolvedValue({ job_id: 'x', runs, total: 73, offset: 0 })
    vi.mocked(api.fetchCronRun).mockReset().mockResolvedValue({ content: '# Not markdown\n| literal |', snippet: 'literal', usage: { input_tokens: 1000, output_tokens: 50 } })
    vi.mocked(api.cronAction).mockReset().mockResolvedValue({ ok: true, job: full })
    vi.mocked(api.fetchCronDeliveryOptions).mockResolvedValue({ platforms: [{ value: 'local', label: 'Local' }, { value: 'telegram', label: 'Telegram' }] })
    vi.mocked(api.fetchSkills).mockResolvedValue({ skills: [{ name: 'inbox' }] })
    vi.mocked(api.fetchProfiles).mockResolvedValue({ profiles: [{ name: 'work' }, { name: 'personal' }], active: 'work' })
    vi.mocked(api.fetchModels).mockResolvedValue({ groups: [{ provider: 'OpenAI Codex', provider_id: 'openai-codex', models: [{ id: '@openai-codex:gpt-5.6-sol' }, { id: '@openai-codex:gpt-6-astra' }] }] })
  })

  it('keeps the script path explanation behind the section help button', async () => {
    const scriptOnly: CronJob = { ...feed, id: 'script0only', name: 'Script only', no_agent: true, prompt: '' }
    const main = await openJob('Script only', [scriptOnly])
    expect(main.getAllByText('collect.sh', { selector: 'code' })).not.toHaveLength(0)
    expect(screen.queryByText(/Resolved under ~\/\.hermes\/scripts\//)).not.toBeInTheDocument()
    await userEvent.click(main.getByRole('button', { name: 'About Prompt' }))
    expect(await screen.findByText(/Resolved under ~\/\.hermes\/scripts\//)).toBeVisible()
  })

  it('renders only server-provided context choices for the execution store', async () => {
    const local: CronJob = { ...feed, id: 'local-source', name: 'Local source', profile: 'personal', read_only: false }
    const detail = await openJob('Digest', [full, feed, local])
    await userEvent.click(detail.getByRole('button', { name: /^edit/i }))
    const form = await screen.findByRole('form', { name: /edit job/i })
    expect(await within(form).findByRole('checkbox', { name: 'Feed' })).toBeVisible()
    expect(within(form).queryByRole('checkbox', { name: 'Local source' })).not.toBeInTheDocument()
  })

  it('lets an unavailable selected context source be removed without offering it again', async () => {
    vi.mocked(api.fetchCronContextSources).mockImplementation((input) => Promise.resolve({ profile: 'work', sources: (input.selected_refs ?? []).includes(feed.id!) ? [{ job_id: feed.id!, label: 'Feed', selectable: false }] : [] }))
    const detail = await openJob('Digest')
    await userEvent.click(detail.getByRole('button', { name: /^edit/i }))
    const form = await screen.findByRole('form', { name: /edit job/i })
    const choice = await within(form).findByRole('checkbox', { name: /Feed/ })
    expect(choice).toBeChecked()
    expect(choice).toBeEnabled()
    await userEvent.click(choice)
    await waitFor(() => expect(within(form).queryByRole('checkbox', { name: /Feed/ })).not.toBeInTheDocument())
  })

  it('shows the actions, including Edit, as soon as a writable task is selected', async () => {
    const detail = await openJob('Digest')
    expect(detail.getByRole('heading', { level: 1 })).toHaveTextContent('Digest')
    for (const name of [/run now/i, /^pause/i, /^edit/i, /duplicate/i, /delete/i]) expect(detail.getByRole('button', { name })).toBeVisible()
    await userEvent.click(detail.getByRole('button', { name: /^edit/i }))
    expect(await screen.findByRole('form', { name: /edit job/i })).toBeVisible()
  })

  it('round-trips every stored field when only the name changes', async () => {
    const detail = await openJob('Digest')
    await userEvent.click(detail.getByRole('button', { name: /^edit/i }))
    const dialog = await screen.findByRole('form', { name: /edit job/i })
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: /model override/i })).toHaveTextContent('@openai-codex:gpt-5.6-sol'))
    const name = within(dialog).getByLabelText(/^name$/i)
    await userEvent.clear(name)
    await userEvent.type(name, 'Digest v2')
    await userEvent.click(within(dialog).getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(api.cronAction).toHaveBeenCalledTimes(1))
    expect(api.cronAction).toHaveBeenCalledWith('update', {
      job_id: 'ab12cd34ef56', name: 'Digest v2', schedule: '0 9 * * *', prompt: 'Summarise the inbox', script: 'collect.sh', no_agent: false,
      deliver: 'telegram', profile: 'work', toast_notifications: false, monitor: 'https://example.com/status', continuity: true,
      context_from: ['feed0000feed'], reasoning_effort: 'high', model: 'gpt-5.6-sol', provider: 'openai-codex',
    })
  })

  it('shows the server schedule text and prefills the editor with the value the scheduler accepts back (TAL-298)', async () => {
    const runAt = '2026-10-05T09:00:00+02:00'
    const once: CronJob = { ...feed, id: '0nce0000once', name: 'Once', schedule: { kind: 'once', run_at: runAt }, schedule_display: `once at ${runAt}`, schedule_input: runAt, repeat: { times: 1, completed: 0 } }
    const detail = await openJob('Once', [once])
    expect(within(screen.getByTestId('sidebar')).getByText(`once at ${runAt}`)).toBeVisible()
    expect(detail.getByText(`once at ${runAt}`, { selector: 'code' })).toBeVisible()
    await userEvent.click(detail.getByRole('button', { name: /^edit/i }))
    const dialog = await screen.findByRole('form', { name: /edit job/i })
    expect(within(dialog).getByLabelText(/schedule/i, { selector: 'input' })).toHaveValue(runAt)
    await userEvent.click(within(dialog).getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(api.cronAction).toHaveBeenCalledTimes(1))
    expect(api.cronAction).toHaveBeenCalledWith('update', expect.objectContaining({ job_id: '0nce0000once', schedule: runAt }))
  })

  it('blocks a script-only save until the monitor is cleared, then sends the cleared name and monitor', async () => {
    const detail = await openJob('Digest')
    await userEvent.click(detail.getByRole('button', { name: /^edit/i }))
    const dialog = await screen.findByRole('form', { name: /edit job/i })
    await userEvent.clear(within(dialog).getByLabelText(/^name$/i))
    // Base UI puts the id on its hidden input, so the switch has no accessible name: it is the first switch in the form.
    await userEvent.click(within(dialog).getAllByRole('switch')[0]!)
    await userEvent.click(within(dialog).getByRole('button', { name: /^save$/i }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/monitor cannot be combined/i)
    expect(api.cronAction).not.toHaveBeenCalled()
    const monitor = within(dialog).getByRole('textbox', { name: /monitor/i })
    expect(monitor).toBeEnabled()
    await userEvent.clear(monitor)
    await userEvent.click(within(dialog).getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(api.cronAction).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.cronAction).mock.calls[0]![1]).toMatchObject({ job_id: 'ab12cd34ef56', name: '', no_agent: true, monitor: '' })
    expect(vi.mocked(api.cronAction).mock.calls[0]![1]).not.toHaveProperty('prompt')
  })

  it('refetches the job and its runs once a run leaves the running set', async () => {
    vi.mocked(api.fetchCronStatus).mockResolvedValue({ running: { ab12cd34ef56: 1 } })
    await openJob('Digest')
    await waitFor(() => expect(api.fetchCronHistory).toHaveBeenCalledTimes(1))
    const listCalls = vi.mocked(api.fetchCrons).mock.calls.length
    // The next status poll (every 10s in the app) reports the run finished.
    vi.mocked(api.fetchCronStatus).mockResolvedValue({ running: {} })
    await qc.refetchQueries({ queryKey: keys.crons.status })
    await waitFor(() => expect(api.fetchCronHistory).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.fetchCrons).mock.calls.length).toBeGreaterThan(listCalls)
  })

  it('refetches the runs when a scheduled run bumps last_run_at on the selected job', async () => {
    await openJob('Digest')
    await waitFor(() => expect(api.fetchCronHistory).toHaveBeenCalledTimes(1))
    // The next list poll (every 30s in the app) carries the new last_run_at; the status map never saw this run.
    vi.mocked(api.fetchCrons).mockResolvedValue({ jobs: [{ ...full, last_run_at: '2026-09-18T09:00:00+02:00' }, feed], active_profile: 'work', all_profiles: false, other_profile_count: 0 })
    await qc.refetchQueries({ queryKey: keys.crons.list(false) })
    await waitFor(() => expect(api.fetchCronHistory).toHaveBeenCalledTimes(2))
  })

  it('lets a job whose skills supply the payload be saved without a prompt', async () => {
    const detail = await openJob('Digest')
    await userEvent.click(detail.getByRole('button', { name: /^edit/i }))
    const dialog = await screen.findByRole('form', { name: /edit job/i })
    await userEvent.clear(within(dialog).getByLabelText(/^prompt$/i))
    await userEvent.click(within(dialog).getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(api.cronAction).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.cronAction).mock.calls[0]![1]).toMatchObject({ job_id: 'ab12cd34ef56', prompt: '', script: 'collect.sh' })
  })

  it('duplicates into a new editable copy that never reuses the original id', async () => {
    const detail = await openJob('Digest')
    await userEvent.click(detail.getByRole('button', { name: /duplicate/i }))
    const dialog = await screen.findByRole('form', { name: /duplicate job/i })
    expect(within(dialog).getByLabelText(/^name$/i)).toHaveValue('Digest (copy)')
    expect(within(dialog).getByLabelText(/^prompt$/i)).toHaveValue('Summarise the inbox')
    await userEvent.click(within(dialog).getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(api.cronAction).toHaveBeenCalledTimes(1))
    const [action, body] = vi.mocked(api.cronAction).mock.calls[0]!
    expect(action).toBe('create')
    expect(body).toMatchObject({ name: 'Digest (copy)', schedule: '0 9 * * *', prompt: 'Summarise the inbox', skills: ['inbox', 'summary'], script: 'collect.sh', monitor: 'https://example.com/status', continuity: true, context_from: ['feed0000feed'], reasoning_effort: 'high', model: 'gpt-5.6-sol', provider: 'openai-codex', deliver: 'telegram', profile: 'work', toast_notifications: false })
    expect(body).not.toHaveProperty('job_id')
    expect(JSON.stringify(body)).not.toContain('ab12cd34ef56')
  })

  it('lists the newest 50 runs with the latest preloaded into a collapsed right panel', async () => {
    const detail = await openJob('Digest')
    const history = await detail.findByRole('region', { name: /^runs$/i })
    expect(within(history).getAllByRole('row')).toHaveLength(50)
    expect(history).toHaveTextContent('latest 50 of 73')
    expect(api.fetchCronHistory).toHaveBeenCalledWith('ab12cd34ef56')
    // The panel mounts collapsed with the newest run already fetched.
    const panel = await screen.findByRole('complementary', { name: /^runs$/i })
    await waitFor(() => expect(api.fetchCronRun).toHaveBeenCalledTimes(1))
    expect(api.fetchCronRun).toHaveBeenCalledWith('ab12cd34ef56', runs[0]!.filename)
    expect(document.documentElement.dataset.workspacePanel).toBe('closed')
    // Any cell of a row opens it, not only the date.
    await userEvent.click(within(history).getAllByRole('cell')[4]!)
    expect(document.documentElement.dataset.workspacePanel).toBe('open')
    await waitFor(() => expect(api.fetchCronRun).toHaveBeenCalledWith('ab12cd34ef56', runs[1]!.filename))
    // Agent output renders as markdown: the heading becomes an element, not literal text.
    expect(await within(panel).findByRole('heading', { name: 'Not markdown' })).toBeVisible()
    // Clicking the open row again collapses the panel; the edge tab reopens it.
    await userEvent.click(within(history).getAllByRole('cell')[4]!)
    expect(document.documentElement.dataset.workspacePanel).toBe('closed')
    await userEvent.click(within(panel).getByRole('button', { name: /show workspace panel/i }))
    expect(document.documentElement.dataset.workspacePanel).toBe('open')
  })

  it('shows explicit empty and failed-detail states', async () => {
    vi.mocked(api.fetchCronHistory).mockResolvedValueOnce({ job_id: 'x', runs: [], total: 0, offset: 0 })
    const detail = await openJob('Digest')
    expect(await detail.findByText(/no runs yet/i)).toBeVisible()
    expect(screen.queryByRole('complementary', { name: /^runs$/i })).toBeNull()
    vi.mocked(api.fetchCronRun).mockRejectedValueOnce(new Error('run not found'))
    await selectJob('Feed')
    const panel = await screen.findByRole('complementary', { name: /^runs$/i })
    expect(await within(panel).findByRole('alert')).toHaveTextContent(/could not load this run.*run not found/i)
  })

  it('explains a needs-attention job and offers resume, run once and diagnostics', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve())
    Object.assign(navigator, { clipboard: { writeText } })
    renderPage([attention, feed])
    const sidebar = within(screen.getByTestId('sidebar'))
    expect(await sidebar.findByRole('button', { name: /Stuck/ })).toHaveTextContent(/needs attention/i)
    expect(sidebar.getByRole('button', { name: /Feed/ })).toHaveTextContent(/active/i)
    const detail = await selectJob('Stuck')
    const banner = detail.getByRole('alert')
    expect(banner).toHaveTextContent(/no next run time/i)
    expect(banner).toHaveTextContent(/croniter/i)
    expect(detail.getByText("No module named 'croniter'")).toBeVisible()
    expect(detail.getByText('telegram: 401')).toBeVisible()
    await userEvent.click(within(banner).getByRole('button', { name: /resume and recalculate/i }))
    expect(api.cronAction).toHaveBeenCalledWith('resume', { job_id: 'a77e0000a77e' })
    await userEvent.click(within(banner).getByRole('button', { name: /run once now/i }))
    expect(api.cronAction).toHaveBeenCalledWith('run', { job_id: 'a77e0000a77e' })
    await userEvent.click(within(banner).getByRole('button', { name: /copy diagnostics/i }))
    const copied = JSON.parse(writeText.mock.calls[0]![0]) as Record<string, unknown>
    expect(copied).toMatchObject({ id: 'a77e0000a77e', state: 'completed', enabled: false, last_error: "No module named 'croniter'", last_delivery_error: 'telegram: 401', schedule_display: '0 9 * * *' })
    expect(copied).not.toHaveProperty('prompt')
  })

  it('renders the server state and action: a paused job with a stale error offers Resume', async () => {
    const paused: CronJob = { ...feed, id: 'pa05ed00pa05', name: 'Paused', enabled: false, state: 'paused', next_run_at: null, last_status: 'error', last_error: 'boom', derived_state: 'paused', needs_attention: false, resumable: true }
    const detail = await openJob('Paused', [paused, feed])
    expect(screen.getByTestId('cron-detail')).toHaveAttribute('data-state', 'paused')
    expect(detail.getByRole('button', { name: /^resume/i })).toBeVisible()
    expect(detail.queryByRole('button', { name: /^pause/i })).toBeNull()
    expect(detail.queryByText(/needs attention/i)).toBeNull()
  })

  it('shows a neutral status and no Pause/Resume when the server omits the derived fields', async () => {
    const bare: CronJob = { ...feed, enabled: false, state: 'paused' }
    delete bare.derived_state; delete bare.needs_attention; delete bare.resumable
    const detail = await openJob('Feed', [bare])
    expect(screen.getByTestId('cron-detail')).toHaveAttribute('data-state', 'unknown')
    expect(detail.getByRole('button', { name: /run now/i })).toBeVisible()
    expect(detail.queryByRole('button', { name: /^(pause|resume)/i })).toBeNull()
  })

  it('keeps read-only cross-profile tasks non-mutating and skips their output fetches', async () => {
    const detail = await openJob('Other profile job', [foreign])
    expect(detail.getByRole('note')).toHaveTextContent(/personal/)
    for (const name of [/run/i, /pause|resume/i, /edit/i, /duplicate/i, /delete/i]) expect(detail.queryByRole('button', { name })).toBeNull()
    expect(detail.getByText(/Owner profile: personal/)).toBeVisible()
    expect(api.fetchCronHistory).not.toHaveBeenCalled()
    expect(api.fetchCronRun).not.toHaveBeenCalled()
  })
})
