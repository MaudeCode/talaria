import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '../../contracts/common'

vi.mock(import('../../api/endpoints'), async (importOriginal) => ({
  ...(await importOriginal()),
  fetchWorkspaces: vi.fn(), saveSettings: vi.fn(),
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
/** Runs one row action from the row's visible actions trigger. */
async function runAction(name: string, action: string) {
  await userEvent.click(within(row(name)).getByRole('button', { name: 'Workspace actions' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: action }))
}

describe('WorkspacesPage', () => {
  beforeEach(() => { toast.mockReset(); vi.mocked(api.fetchWorkspaces).mockResolvedValue({ workspaces: [], last: null }) })

  it('keeps the page explanation behind the title help button', async () => {
    renderPage()
    expect(await screen.findByText('No workspaces yet')).toBeVisible()
    expect(screen.queryByText('Add and switch workspaces for your sessions.')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'About Spaces' }))
    expect(await screen.findByText('Add and switch workspaces for your sessions.')).toBeVisible()
  })

  it('TAL-2141: marks the server\'s default space, not the last-used one, and keeps it from being removed', async () => {
    vi.mocked(api.fetchWorkspaces).mockResolvedValue({ workspaces: [{ path: '/srv/alpha', name: 'Alpha' }, { path: '/srv/beta', name: 'Beta', is_default: true }], last: '/srv/alpha' })
    renderPage()
    await screen.findByText('Beta')
    expect(within(row('Beta')).getByText('Default')).toBeVisible()
    expect(within(row('Alpha')).queryByText('Default')).not.toBeInTheDocument()
    expect(screen.queryByText('Current')).not.toBeInTheDocument()
    await userEvent.click(within(row('Beta')).getByRole('button', { name: 'Workspace actions' }))
    const remove = await screen.findByRole('menuitem', { name: 'Remove' })
    expect(remove).toHaveAttribute('data-disabled')
    expect(remove).toHaveAttribute('title', 'Choose another default space first')
    expect(screen.queryByRole('menuitem', { name: 'Make default' })).toBeNull()
  })

  it('TAL-2141: offers no Make default on a remote terminal profile, whose paths the server cannot resolve locally', async () => {
    vi.mocked(api.fetchWorkspaces).mockResolvedValue({ ...spaces, terminal_remote_backend: true })
    renderPage()
    await screen.findByText('Alpha')
    await userEvent.click(within(row('Alpha')).getByRole('button', { name: 'Workspace actions' }))
    const menu = await screen.findByRole('menu', { name: 'Workspace actions' })
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Move up', 'Move down', 'Rename', 'Remove'])
  })

  it('TAL-2141: flags a space whose folder is gone and shows the path from home', async () => {
    vi.mocked(api.fetchWorkspaces).mockResolvedValue({ workspaces: [{ path: '/home/me/gone', name: 'Gone', exists: false, display_path: '~/gone' }, { path: '/home/me/here', name: 'Here', exists: true, display_path: '~/here', chat_count: 3 }], last: null })
    renderPage()
    await screen.findByText('Gone')
    expect(within(row('Gone')).getByText('Folder not found · ~/gone').closest('[data-status]')).toHaveAttribute('data-status', 'warning')
    expect(within(row('Here')).getByText('~/here').closest('[title]')).toHaveAttribute('title', '/home/me/here')
    expect(within(row('Here')).getByText('3 chats')).toBeInTheDocument()
  })

  it('TAL-2106: keeps a row\'s actions behind its visible trigger, with the same disabled ends', async () => {
    vi.mocked(api.fetchWorkspaces).mockResolvedValue(spaces)
    renderPage()
    await screen.findByText('Alpha')
    expect(within(row('Alpha')).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Workspace actions'])
    await userEvent.click(within(row('Alpha')).getByRole('button', { name: 'Workspace actions' }))
    const menu = await screen.findByRole('menu', { name: 'Workspace actions' })
    expect(within(menu).getAllByRole('menuitem').map((item) => [item.textContent, item.hasAttribute('data-disabled')])).toEqual([['Make default', false], ['Move up', true], ['Move down', false], ['Rename', false], ['Remove', false]])
    expect(row('Alpha').querySelector('.font-mono')).toHaveAttribute('title', '/srv/alpha')
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
    await runAction('Gamma', 'Move up')
    expect(names()).toEqual(['Alpha', 'Gamma', 'Beta'])
    await runAction('Gamma', 'Move up')
    expect(names()).toEqual(['Gamma', 'Alpha', 'Beta'])
    expect(api.reorderWorkspaces).toHaveBeenCalledWith(['/srv/alpha', '/srv/gamma', '/srv/beta'])
  })

  it('restores the confirmed order when a reorder is refused', async () => {
    vi.mocked(api.reorderWorkspaces).mockRejectedValue(new ApiError({ kind: 'http', status: 400, path: '/x', message: 'Unknown space' }))
    renderPage()
    await screen.findByText('Gamma')
    await runAction('Beta', 'Move down')
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Unknown space', 4000, 'error'))
    expect(names()).toEqual(['Alpha', 'Beta', 'Gamma'])
  })

  it('renames and removes at once', async () => {
    vi.mocked(api.renameWorkspace).mockReturnValue(held())
    vi.mocked(api.removeWorkspace).mockReturnValue(held())
    renderPage()
    await screen.findByText('Alpha')
    await runAction('Alpha', 'Rename')
    const input = screen.getByRole('textbox')
    await userEvent.clear(input)
    await userEvent.type(input, 'Primary{Enter}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(names()).toEqual(['Primary', 'Beta', 'Gamma'])
    await runAction('Beta', 'Remove')
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }))
    expect(names()).toEqual(['Primary', 'Gamma'])
  })

  it('adds a space at once and reopens the dialog with the refusal and the typed path', async () => {
    let refuse!: (error: unknown) => void
    vi.mocked(api.addWorkspace).mockReturnValue(new Promise((_, reject) => { refuse = reject }) as never)
    renderPage()
    await screen.findByText('Alpha')
    await userEvent.click(screen.getByRole('button', { name: 'Add space' }))
    await userEvent.type(screen.getByRole('combobox'), '/srv/delta')
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(names()).toEqual(['Alpha', 'Beta', 'Gamma', '/srv/delta'])
    refuse(new ApiError({ kind: 'http', status: 400, path: '/x', message: 'Not a directory' }))
    await waitFor(() => expect(names()).toEqual(['Alpha', 'Beta', 'Gamma']))
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent('Not a directory')
    expect(screen.getByRole('combobox')).toHaveValue('/srv/delta')
    expect(toast).not.toHaveBeenCalled()
  })

  it('moves the default mark at once and puts it back with the error toast on refusal', async () => {
    let refuse!: (error: unknown) => void
    vi.mocked(api.fetchWorkspaces).mockResolvedValue({ workspaces: [{ path: '/srv/alpha', name: 'Alpha', is_default: true }, { path: '/srv/beta', name: 'Beta' }], last: null })
    vi.mocked(api.saveSettings).mockReturnValue(new Promise((_, reject) => { refuse = reject }) as never)
    renderPage()
    await screen.findByText('Beta')
    await runAction('Beta', 'Make default')
    expect(within(row('Beta')).getByText('Default')).toBeVisible()
    expect(within(row('Alpha')).queryByText('Default')).toBeNull()
    expect(api.saveSettings).toHaveBeenCalledWith({ default_workspace: '/srv/beta' })
    refuse(new ApiError({ kind: 'http', status: 400, path: '/x', message: 'Not allowed' }))
    await waitFor(() => expect(within(row('Alpha')).getByText('Default')).toBeVisible())
    expect(within(row('Beta')).queryByText('Default')).toBeNull()
    expect(toast).toHaveBeenCalledWith('Not allowed', 4000, 'error')
  })

})

describe('Add space folder list (TAL-2141)', () => {
  beforeEach(() => {
    vi.mocked(api.fetchWorkspaces).mockResolvedValue(spaces)
    const folder = (path: string) => ({ path, name: path.split('/').pop()!, target: `${path}/` })
    const views: Record<string, { folders: ReturnType<typeof folder>[]; parent: string | null; default_name: string | null }> = {
      '': { folders: [folder('/home/me')], parent: null, default_name: null },
      '/home/me/': { folders: [folder('/home/me/git'), folder('/home/me/notes')], parent: '/home/', default_name: 'me' },
      '/home/me/git/': { folders: [], parent: '/home/me/', default_name: 'git' },
      '/home/me/git': { folders: [], parent: '/home/me/', default_name: 'git' },
    }
    vi.mocked(api.suggestWorkspaces).mockImplementation((prefix) => Promise.resolve({ prefix, suggestions: [], ...(views[prefix] ?? { folders: [], parent: null, default_name: null }) }))
  })

  it('descends from home with the arrow keys and Enter, and submits with Enter when no folder is active', async () => {
    vi.mocked(api.addWorkspace).mockReturnValue(held())
    renderPage()
    await screen.findByText('Alpha')
    await userEvent.click(screen.getByRole('button', { name: 'Add space' }))
    const input = screen.getByRole('combobox')
    const list = screen.getByRole('listbox', { name: 'Folders' })
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
    await within(list).findByRole('option', { name: 'me' })
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(input).toHaveValue('/home/me/')
    await within(list).findByRole('option', { name: 'git' })
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['..', 'git', 'notes'])
    expect(within(list).getByRole('option', { name: 'git' })).toHaveAttribute('title', '/home/me/git')
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    expect(input).toHaveAttribute('aria-activedescendant', within(list).getByRole('option', { name: 'git' }).id)
    await userEvent.keyboard('{Enter}')
    expect(input).toHaveValue('/home/me/git/')
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Optional friendly name' })).toHaveAttribute('placeholder', 'git'))
    await userEvent.keyboard('{Enter}')
    expect(api.addWorkspace).toHaveBeenCalledWith('/home/me/git/', undefined)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('goes up to the server\'s parent from the ".." row, for a path typed without a trailing separator', async () => {
    renderPage()
    await screen.findByText('Alpha')
    await userEvent.click(screen.getByRole('button', { name: 'Add space' }))
    await userEvent.type(screen.getByRole('combobox'), '/home/me/git')
    await userEvent.click(await within(screen.getByRole('listbox')).findByRole('option', { name: '..' }))
    expect(screen.getByRole('combobox')).toHaveValue('/home/me/')
  })
})
