import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '../../contracts/common'

vi.mock(import('../../api/endpoints'), async (importOriginal) => ({
  ...(await importOriginal()),
  fetchWorkspaces: vi.fn(),
  removeWorkspace: vi.fn(), renameWorkspace: vi.fn(), reorderWorkspaces: vi.fn(), addWorkspace: vi.fn(), suggestWorkspaces: vi.fn(),
}))
const toast = vi.hoisted(() => vi.fn())
vi.mock('../toast/toast', () => ({ showToast: toast }))
import * as api from '../../api/endpoints'
import { WorkspacesPage } from './WorkspacesPage'

const spaces = { workspaces: [{ path: '/srv/alpha', name: 'Alpha' }, { path: '/srv/beta', name: 'Beta' }, { path: '/srv/gamma', name: 'Gamma' }], last: null }
const held = () => new Promise<never>(() => undefined)
const names = () => [...document.querySelectorAll('#workspacesPanel li')].map((li) => li.querySelector('.truncate')?.textContent)
function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={qc}><WorkspacesPage /></QueryClientProvider>)
}
const row = (name: string) => screen.getByText(name, { selector: '.truncate' }).closest('li')!

describe('WorkspacesPage', () => {
  beforeEach(() => { toast.mockReset(); vi.mocked(api.fetchWorkspaces).mockResolvedValue({ workspaces: [], last: null }) })

  it('keeps the page explanation behind the title help button', async () => {
    renderPage()
    expect(await screen.findByText('No workspaces yet')).toBeVisible()
    expect(screen.queryByText('Add and switch workspaces for your sessions.')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'About Spaces' }))
    expect(await screen.findByText('Add and switch workspaces for your sessions.')).toBeVisible()
  })
})

describe('space writes show their result while the server is held (TAL-1179)', () => {
  beforeEach(() => {
    toast.mockReset()
    vi.mocked(api.fetchWorkspaces).mockResolvedValue(spaces)
    vi.mocked(api.suggestWorkspaces).mockResolvedValue({ suggestions: [], prefix: '' })
  })

  it('moves a space at once and keeps moving from the shown order', async () => {
    vi.mocked(api.reorderWorkspaces).mockReturnValue(held())
    renderPage()
    await screen.findByText('Gamma')
    await userEvent.click(within(row('Gamma')).getByRole('button', { name: 'Move up' }))
    expect(names()).toEqual(['Alpha', 'Gamma', 'Beta'])
    await userEvent.click(within(row('Gamma')).getByRole('button', { name: 'Move up' }))
    expect(names()).toEqual(['Gamma', 'Alpha', 'Beta'])
    expect(api.reorderWorkspaces).toHaveBeenCalledWith(['/srv/alpha', '/srv/gamma', '/srv/beta'])
  })

  it('restores the confirmed order when a reorder is refused', async () => {
    vi.mocked(api.reorderWorkspaces).mockRejectedValue(new ApiError({ kind: 'http', status: 400, path: '/x', message: 'Unknown space' }))
    renderPage()
    await screen.findByText('Gamma')
    await userEvent.click(within(row('Beta')).getByRole('button', { name: 'Move down' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Unknown space', 4000, 'error'))
    expect(names()).toEqual(['Alpha', 'Beta', 'Gamma'])
  })

  it('renames and removes at once', async () => {
    vi.mocked(api.renameWorkspace).mockReturnValue(held())
    vi.mocked(api.removeWorkspace).mockReturnValue(held())
    renderPage()
    await screen.findByText('Alpha')
    await userEvent.click(within(row('Alpha')).getByRole('button', { name: 'Rename' }))
    const input = screen.getByRole('textbox')
    await userEvent.clear(input)
    await userEvent.type(input, 'Primary{Enter}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(names()).toEqual(['Primary', 'Beta', 'Gamma'])
    await userEvent.click(within(row('Beta')).getByRole('button', { name: 'Remove' }))
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }))
    expect(names()).toEqual(['Primary', 'Gamma'])
  })

  it('adds a space at once and drops it when the server refuses', async () => {
    let refuse!: (error: unknown) => void
    vi.mocked(api.addWorkspace).mockReturnValue(new Promise((_, reject) => { refuse = reject }) as never)
    renderPage()
    await screen.findByText('Alpha')
    await userEvent.click(screen.getByRole('button', { name: 'Add workspace' }))
    await userEvent.type(screen.getByRole('combobox'), '/srv/delta')
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(names()).toEqual(['Alpha', 'Beta', 'Gamma', '/srv/delta'])
    refuse(new ApiError({ kind: 'http', status: 400, path: '/x', message: 'Not a directory' }))
    await waitFor(() => expect(names()).toEqual(['Alpha', 'Beta', 'Gamma']))
    expect(toast).toHaveBeenCalledWith('Not a directory', 4000, 'error')
  })
})
