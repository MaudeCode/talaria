import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '../../contracts/common'

vi.mock('../../api/endpoints', () => ({ fetchMemory: vi.fn(), writeMemory: vi.fn(), fetchPendingWrites: vi.fn(() => Promise.resolve({ kind: 'memory', visible: false, enabled: false, items: [] })) }))
vi.mock('../../shell/AppShell', () => ({ HubPage: ({ toolbar, children }: { toolbar: React.ReactNode; children: React.ReactNode }) => <div>{toolbar}{children}</div> }))
import * as api from '../../api/endpoints'
import { MemoryPage } from './MemoryPage'

const memory = (text: string, revision: string) => ({ memory: text, user: '', soul: '', memory_path: '/h/memories/MEMORY.md', user_path: '/h/memories/USER.md', soul_path: '/h/SOUL.md', memory_revision: revision, user_revision: 'u1', soul_revision: 's1' })
const CONFLICT = 'MEMORY.md changed after you opened it. Not saved.'

beforeEach(() => {
  vi.mocked(api.fetchMemory).mockReset().mockResolvedValue(memory('Entry A', 'r1'))
  vi.mocked(api.writeMemory).mockReset()
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
