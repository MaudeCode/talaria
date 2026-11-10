import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '../../contracts/common'

vi.mock('../../api/endpoints', () => ({ fetchMemory: vi.fn(), writeMemory: vi.fn(), previewMemoryCompaction: vi.fn(), applyMemoryCompaction: vi.fn(), fetchPendingWrites: vi.fn(() => Promise.resolve({ kind: 'memory', visible: false, enabled: false, items: [] })) }))
vi.mock('../../shell/AppShell', () => ({ HubPage: ({ toolbar, children }: { toolbar: React.ReactNode; children: React.ReactNode }) => <div>{toolbar}{children}</div> }))
import * as api from '../../api/endpoints'
import { teardownAll } from '../../stream/connection'
import { MemoryPage } from './MemoryPage'
// Loaded up front, so the read view's lazy renderer chunk resolves within a query's timeout.
import '../chat/render/MarkdownRenderer'

const memory = (text: string, revision: string) => ({ memory: text, user: '', soul: '', memory_path: '/h/memories/MEMORY.md', user_path: '/h/memories/USER.md', soul_path: '/h/SOUL.md', memory_revision: revision, user_revision: 'u1', soul_revision: 's1' })
const CONFLICT = 'MEMORY.md changed after you opened it. Not saved.'

beforeEach(() => {
  vi.mocked(api.fetchMemory).mockReset().mockResolvedValue(memory('Entry A', 'r1'))
  vi.mocked(api.writeMemory).mockReset()
  vi.mocked(api.previewMemoryCompaction).mockReset()
  vi.mocked(api.applyMemoryCompaction).mockReset()
})

const renderPage = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={qc}><MemoryPage /></QueryClientProvider>)
  return qc
}
const edit = async () => { await userEvent.click(await screen.findByRole('button', { name: 'Edit' })); return screen.getByRole('textbox', { name: 'Memory' }) }

describe('Memory page read view (TAL-2091)', () => {
  it('renders the file as Markdown under its name, and Edit opens the editor until Cancel', async () => {
    vi.mocked(api.fetchMemory).mockResolvedValue({ ...memory('# Prefs\n\nUses **tabs**', 'r1'), memory_mtime: 1800000000 })
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Prefs' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
    const name = screen.getByText('MEMORY.md')
    expect(name).toHaveAttribute('title', '/h/memories/MEMORY.md')
    expect(screen.getByText(/^Updated /)).toBeInTheDocument()
    expect(screen.queryByText(/Path:/)).toBeNull()
    fireEvent.contextMenu(name)
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Copy file path' }))
    expect(writeText).toHaveBeenCalledWith('/h/memories/MEMORY.md')
    await userEvent.type(await edit(), '!')
    // A draft keeps its tab in the editor across tab switches.
    await userEvent.click(screen.getByRole('tab', { name: 'Soul' }))
    expect(screen.queryByRole('textbox')).toBeNull()
    await userEvent.click(screen.getByRole('tab', { name: 'Memory' }))
    expect(screen.getByRole('textbox', { name: 'Memory' })).toHaveValue('# Prefs\n\nUses **tabs**!')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Prefs' })).toBeInTheDocument()
    expect(api.writeMemory).not.toHaveBeenCalled()
  })

  it('shows project context read-only and an empty file as an empty state', async () => {
    vi.mocked(api.fetchMemory).mockResolvedValue({ ...memory('', 'r1'), project_context: '## Repo rules', project_context_path: '/w/AGENTS.md', project_context_name: 'AGENTS.md' })
    renderPage()
    expect(await screen.findByText('Empty')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
    await userEvent.click(screen.getByRole('tab', { name: 'Project context' }))
    expect(await screen.findByRole('heading', { name: 'Repo rules' })).toBeInTheDocument()
    expect(screen.getByText('AGENTS.md')).toHaveAttribute('title', '/w/AGENTS.md')
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })
})

describe('Memory page (TAL-784)', () => {
  it('shows a save at once, reopens the editor with a conflict, and reloads the server copy', async () => {
    const qc = renderPage()
    await userEvent.type(await edit(), '\n§\nEntry C')
    // A refetch while the edit is open does not move the edit onto the newer revision.
    vi.mocked(api.fetchMemory).mockResolvedValue(memory('Entry A\n§\nEntry B', 'r2'))
    await qc.refetchQueries()
    let refuse!: (e: unknown) => void
    vi.mocked(api.writeMemory).mockReturnValue(new Promise((_, reject) => { refuse = reject }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.writeMemory).toHaveBeenCalledWith({ section: 'memory', content: 'Entry A\n§\nEntry C', revision: 'r1' })
    // Save returns to the read view showing the saved text before the server answers.
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText(/Entry C/)).toBeInTheDocument()
    refuse(new ApiError({ kind: 'http', status: 409, code: 'memory_conflict', path: '/api/memory/write', message: CONFLICT, retryable: false }))
    expect(await screen.findByRole('alert')).toHaveTextContent(CONFLICT)
    expect(screen.getByRole('textbox', { name: 'Memory' })).toHaveValue('Entry A\n§\nEntry C')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())
    expect(screen.getByText(/Entry B/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('starts an edit reopened during a save from the revision the save produced', async () => {
    renderPage()
    await userEvent.type(await edit(), '!')
    let refetched = (): void => undefined
    vi.mocked(api.fetchMemory).mockReturnValue(new Promise((resolve) => { refetched = () => resolve(memory('Entry A!', 'r2')) }))
    vi.mocked(api.writeMemory).mockResolvedValue({ ok: true, section: 'memory', path: '/h/memories/MEMORY.md' })
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.fetchMemory).toHaveBeenCalledTimes(2))
    await userEvent.type(await edit(), '?')
    refetched()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled())
    expect(screen.getByRole('textbox', { name: 'Memory' })).toHaveValue('Entry A!?')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writeMemory).toHaveBeenLastCalledWith({ section: 'memory', content: 'Entry A!?', revision: 'r2' }))
  })

  it('keeps showing the saved text when the refetch after a save fails', async () => {
    renderPage()
    await userEvent.type(await edit(), '!')
    vi.mocked(api.writeMemory).mockResolvedValue({ ok: true, section: 'memory', path: '/h/memories/MEMORY.md' })
    vi.mocked(api.fetchMemory).mockRejectedValue(new Error('offline'))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.fetchMemory).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled())
    expect(screen.getByText('Entry A!')).toBeInTheDocument()
    expect((await edit())).toHaveValue('Entry A!')
  })

  it('reconciles a missing save response from the server copy without replaying it', async () => {
    renderPage()
    await userEvent.type(await edit(), '!')
    vi.mocked(api.writeMemory).mockRejectedValue(new ApiError({ kind: 'timeout', path: '/api/memory/write', message: 'Response lost', retryable: true }))
    vi.mocked(api.fetchMemory).mockResolvedValue(memory('Entry A!', 'r2'))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    // The read that finds the saved text settles the save; a lost one would reopen the editor.
    await waitFor(() => expect(api.fetchMemory).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled())
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(api.writeMemory).toHaveBeenCalledTimes(1)
  })
})

it('reviews the source and proposal, updates optimistically, and restores the review after refusal', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const p = { section: 'memory' as const, revision: 'r1', proposed_revision: 'r2', source: 'Entry A', proposed: 'A', diff: '-Entry A\n+A', model: 'synthetic', receipt: 'reviewed', expires_at: 1800001800 }
  vi.mocked(api.previewMemoryCompaction).mockResolvedValue(p)
  let refuse!: (e: unknown) => void
  vi.mocked(api.applyMemoryCompaction).mockReturnValue(new Promise((_, reject) => { refuse = reject }))
  render(<QueryClientProvider client={qc}><MemoryPage /></QueryClientProvider>)
  await userEvent.click(await screen.findByRole('button', { name: 'Preview compaction' }))
  expect(api.previewMemoryCompaction).toHaveBeenCalledWith({ section: 'memory', revision: 'r1' })
  expect(await screen.findByRole('region', { name: 'Compaction preview' })).toHaveTextContent('-Entry A')
  expect(api.applyMemoryCompaction).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Apply compaction' }))
  expect(screen.getByText('A', { selector: '[data-memory-view] *' })).toBeInTheDocument()
  refuse(new ApiError({ kind: 'http', status: 409, path: '/api/memory/compaction/apply', message: 'Memory changed. Review a new preview.', retryable: false }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Memory changed')
  expect(screen.getByRole('region', { name: 'Compaction preview' })).toHaveTextContent('-Entry A')
  await waitFor(() => expect(screen.getByText('Entry A', { selector: '[data-memory-view] *' })).toBeInTheDocument())
})


it('discards an auxiliary preview that finishes after the profile context changes', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  let finish!: (p: Awaited<ReturnType<typeof api.previewMemoryCompaction>>) => void
  vi.mocked(api.previewMemoryCompaction).mockReturnValue(new Promise((resolve) => { finish = resolve }))
  render(<QueryClientProvider client={qc}><MemoryPage /></QueryClientProvider>)
  await userEvent.click(await screen.findByRole('button', { name: 'Preview compaction' }))
  act(() => teardownAll())
  await act(async () => { finish({ section: 'memory', revision: 'r1', proposed_revision: 'r2', source: 'Private old profile', proposed: 'Old', diff: '-Private old profile\n+Old', model: 'fake', receipt: 'old-profile', expires_at: 1800001800 }); await Promise.resolve() })
  expect(screen.queryByRole('region', { name: 'Compaction preview' })).toBeNull()
})


it('reconciles a missing apply response from the server revision without replaying it', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  vi.mocked(api.previewMemoryCompaction).mockResolvedValue({ section: 'memory', revision: 'r1', proposed_revision: 'r2', source: 'Entry A', proposed: 'A', diff: '-Entry A\n+A', model: 'fake', receipt: 'reviewed', expires_at: 1800001800 })
  vi.mocked(api.applyMemoryCompaction).mockReset().mockRejectedValue(new ApiError({ kind: 'timeout', path: '/api/memory/compaction/apply', message: 'Response lost', retryable: true }))
  render(<QueryClientProvider client={qc}><MemoryPage /></QueryClientProvider>)
  await userEvent.click(await screen.findByRole('button', { name: 'Preview compaction' }))
  await screen.findByRole('region', { name: 'Compaction preview' })
  vi.mocked(api.fetchMemory).mockResolvedValue(memory('A', 'r2'))
  await userEvent.click(screen.getByRole('button', { name: 'Apply compaction' }))
  await waitFor(() => expect(screen.getByText('A', { selector: '[data-memory-view] *' })).toBeInTheDocument())
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Compaction preview' })).toBeNull())
  expect(api.applyMemoryCompaction).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('alert')).toBeNull()
})
