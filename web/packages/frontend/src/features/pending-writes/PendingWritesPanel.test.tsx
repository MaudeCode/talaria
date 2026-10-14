import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('../../api/endpoints', () => ({ fetchPendingWrites: vi.fn(), reviewPendingWrites: vi.fn() }))
import * as api from '../../api/endpoints'
import { PendingWritesPanel } from './PendingWritesPanel'

const item = { id: 'abcd1234', kind: 'skills' as const, target: 'demo-skill', op: 'create', summary: "create 'demo-skill'", origin: 'foreground', created_at: 1, diff: '---\nname: demo-skill\n---\n' }
const view = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PendingWritesPanel kind="skills" /></QueryClientProvider>)

beforeEach(() => {
  vi.mocked(api.fetchPendingWrites).mockReset()
  vi.mocked(api.reviewPendingWrites).mockReset().mockResolvedValue({ results: [{ id: item.id, done: true, message: 'Approved 1 skills write(s).' }] })
})

describe('PendingWritesPanel (TAL-819)', () => {
  it('lists each staged write with its diff and approves or rejects it by id', async () => {
    vi.mocked(api.fetchPendingWrites).mockResolvedValue({ kind: 'skills', visible: true, enabled: true, items: [item] })
    view()
    expect(await screen.findByText("create 'demo-skill'")).toBeInTheDocument()
    expect(screen.getByText(/name: demo-skill/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(api.reviewPendingWrites).toHaveBeenCalledWith('approve', 'skills', [item.id])
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(api.reviewPendingWrites).toHaveBeenLastCalledWith('reject', 'skills', [item.id])
  })

  it('renders nothing when the server hides the panel', async () => {
    vi.mocked(api.fetchPendingWrites).mockResolvedValue({ kind: 'skills', visible: false, enabled: false, items: [] })
    const { container } = view()
    await waitFor(() => expect(api.fetchPendingWrites).toHaveBeenCalledWith('skills'))
    expect(container).toBeEmptyDOMElement()
  })
})
