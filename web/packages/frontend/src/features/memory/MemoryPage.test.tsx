import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '../../contracts/common'

vi.mock('../../api/endpoints', () => ({ fetchMemory: vi.fn(), writeMemory: vi.fn(), previewMemoryCompaction: vi.fn(), applyMemoryCompaction: vi.fn(), fetchPendingWrites: vi.fn(() => Promise.resolve({ kind: 'memory', visible: false, enabled: false, items: [] })) }))
vi.mock('../../shell/AppShell', () => ({ HubPage: ({ toolbar, children }: { toolbar: React.ReactNode; children: React.ReactNode }) => <div>{toolbar}{children}</div> }))
import * as api from '../../api/endpoints'
import { teardownAll } from '../../stream/connection'
import { MemoryPage } from './MemoryPage'

const memory = (text: string, revision: string) => ({ memory: text, user: '', soul: '', memory_path: '/h/memories/MEMORY.md', user_path: '/h/memories/USER.md', soul_path: '/h/SOUL.md', memory_revision: revision, user_revision: 'u1', soul_revision: 's1' })
const CONFLICT = 'MEMORY.md changed after you opened it. Not saved.'

beforeEach(() => {
  vi.mocked(api.fetchMemory).mockReset().mockResolvedValue(memory('Entry A', 'r1'))
  vi.mocked(api.writeMemory).mockReset()
  vi.mocked(api.previewMemoryCompaction).mockReset()
  vi.mocked(api.applyMemoryCompaction).mockReset()
})

describe('Memory page (TAL-784)', () => {
  it('saves with the revision the edit started from, shows a conflict, and reloads the server copy', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(<QueryClientProvider client={qc}><MemoryPage /></QueryClientProvider>)
    const editor = await screen.findByRole('textbox', { name: 'Memory' })
    await userEvent.type(editor, '\n§\nEntry C')
    // A refetch while the edit is open does not move the edit onto the newer revision.
    vi.mocked(api.fetchMemory).mockResolvedValue(memory('Entry A\n§\nEntry B', 'r2'))
    await qc.refetchQueries()
    vi.mocked(api.writeMemory).mockRejectedValue(new ApiError({ kind: 'http', status: 409, code: 'memory_conflict', path: '/api/memory/write', message: CONFLICT, retryable: false }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.writeMemory).toHaveBeenCalledWith({ section: 'memory', content: 'Entry A\n§\nEntry C', revision: 'r1' })
    expect(await screen.findByRole('alert')).toHaveTextContent(CONFLICT)
    expect(screen.getByRole('textbox', { name: 'Memory' })).toHaveValue('Entry A\n§\nEntry C')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Memory' })).toHaveValue('Entry A\n§\nEntry B'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the editor editable during a save and starts later edits from the revision it produced', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(<QueryClientProvider client={qc}><MemoryPage /></QueryClientProvider>)
    await userEvent.type(await screen.findByRole('textbox', { name: 'Memory' }), '!')
    let refetched = (): void => undefined
    vi.mocked(api.fetchMemory).mockReturnValue(new Promise((resolve) => { refetched = () => resolve(memory('Entry A!', 'r2')) }))
    vi.mocked(api.writeMemory).mockResolvedValue({ ok: true, section: 'memory', path: '/h/memories/MEMORY.md' })
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    // The editor stays editable while the save runs; an edit typed meanwhile moves onto the revision the save produced.
    await waitFor(() => expect(api.fetchMemory).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('textbox', { name: 'Memory' })).not.toHaveAttribute('readonly')
    await userEvent.type(screen.getByRole('textbox', { name: 'Memory' }), '?')
    refetched()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled())
    expect(screen.getByRole('textbox', { name: 'Memory' })).toHaveValue('Entry A!?')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writeMemory).toHaveBeenLastCalledWith({ section: 'memory', content: 'Entry A!?', revision: 'r2' }))
  })

  it('keeps the saved text in the editor when the refetch after a save fails', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(<QueryClientProvider client={qc}><MemoryPage /></QueryClientProvider>)
    await userEvent.type(await screen.findByRole('textbox', { name: 'Memory' }), '!')
    vi.mocked(api.writeMemory).mockResolvedValue({ ok: true, section: 'memory', path: '/h/memories/MEMORY.md' })
    vi.mocked(api.fetchMemory).mockRejectedValue(new Error('offline'))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.fetchMemory).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Memory' })).not.toHaveAttribute('readonly'))
    expect(screen.getByRole('textbox', { name: 'Memory' })).toHaveValue('Entry A!')
  })
})


it('reviews the source and proposal, updates optimistically, and restores the review after refusal', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const p = { section: 'memory' as const, revision: 'r1', proposed_revision: 'r2', source: 'Entry A', proposed: 'A', diff: '-Entry A\n+A', model: 'synthetic', receipt: 'reviewed', expires_at: 1800001800 }
  vi.mocked(api.previewMemoryCompaction).mockResolvedValue(p)
  let refuse!: (e: unknown) => void
  vi.mocked(api.applyMemoryCompaction).mockReturnValue(new Promise((_, reject) => { refuse = reject }))
  render(<QueryClientProvider client={qc}><MemoryPage /></QueryClientProvider>)
  await screen.findByRole('textbox', { name: 'Memory' })
  await userEvent.click(screen.getByRole('button', { name: 'Preview compaction' }))
  expect(api.previewMemoryCompaction).toHaveBeenCalledWith({ section: 'memory', revision: 'r1' })
  expect(await screen.findByRole('region', { name: 'Compaction preview' })).toHaveTextContent('-Entry A')
  expect(api.applyMemoryCompaction).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Apply compaction' }))
  expect(screen.getByRole('textbox', { name: 'Memory' })).toHaveValue('A')
  refuse(new ApiError({ kind: 'http', status: 409, path: '/api/memory/compaction/apply', message: 'Memory changed. Review a new preview.', retryable: false }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Memory changed')
  expect(screen.getByRole('region', { name: 'Compaction preview' })).toHaveTextContent('-Entry A')
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Memory' })).toHaveValue('Entry A'))
})


it('discards an auxiliary preview that finishes after the profile context changes', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  let finish!: (p: Awaited<ReturnType<typeof api.previewMemoryCompaction>>) => void
  vi.mocked(api.previewMemoryCompaction).mockReturnValue(new Promise((resolve) => { finish = resolve }))
  render(<QueryClientProvider client={qc}><MemoryPage /></QueryClientProvider>)
  await screen.findByRole('textbox', { name: 'Memory' })
  await userEvent.click(screen.getByRole('button', { name: 'Preview compaction' }))
  act(() => teardownAll())
  await act(async () => { finish({ section: 'memory', revision: 'r1', proposed_revision: 'r2', source: 'Private old profile', proposed: 'Old', diff: '-Private old profile\n+Old', model: 'fake', receipt: 'old-profile', expires_at: 1800001800 }); await Promise.resolve() })
  expect(screen.queryByRole('region', { name: 'Compaction preview' })).toBeNull()
})


it('reconciles a missing apply response from the server revision without replaying it', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  vi.mocked(api.previewMemoryCompaction).mockResolvedValue({ section: 'memory', revision: 'r1', proposed_revision: 'r2', source: 'Entry A', proposed: 'A', diff: '-Entry A\n+A', model: 'fake', receipt: 'reviewed', expires_at: 1800001800 })
  vi.mocked(api.applyMemoryCompaction).mockReset().mockRejectedValue(new ApiError({ kind: 'timeout', path: '/api/memory/compaction/apply', message: 'Response lost', retryable: true }))
  render(<QueryClientProvider client={qc}><MemoryPage /></QueryClientProvider>)
  await screen.findByRole('textbox', { name: 'Memory' })
  await userEvent.click(screen.getByRole('button', { name: 'Preview compaction' }))
  await screen.findByRole('region', { name: 'Compaction preview' })
  vi.mocked(api.fetchMemory).mockResolvedValue(memory('A', 'r2'))
  await userEvent.click(screen.getByRole('button', { name: 'Apply compaction' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Memory' })).toHaveValue('A'))
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Compaction preview' })).toBeNull())
  expect(api.applyMemoryCompaction).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('alert')).toBeNull()
})
