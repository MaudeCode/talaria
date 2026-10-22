import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '../../contracts/common'

vi.mock('../../api/endpoints', () => ({
  listDir: vi.fn(), fetchGitInfo: vi.fn(), readFile: vi.fn(), saveFile: vi.fn(), createFile: vi.fn(), createDir: vi.fn(), renameEntry: vi.fn(),
  deleteEntry: vi.fn(), moveEntry: vi.fn(), revealEntry: vi.fn(), openInVsCode: vi.fn(), rawFileUrl: vi.fn(() => '/raw'), folderDownloadUrl: vi.fn(() => '/zip'),
}))
const toast = vi.hoisted(() => vi.fn())
vi.mock('../toast/toast', () => ({ showToast: toast }))
import * as api from '../../api/endpoints'
import { FilesPage } from './FilesPage'

const tree = { entries: [{ name: 'docs', path: 'docs', is_dir: true }, { name: 'a.txt', path: 'a.txt', is_dir: false, size: 3 }, { name: 'b.txt', path: 'b.txt', is_dir: false, size: 3 }] }
const held = () => new Promise<never>(() => undefined)
const names = () => screen.getAllByRole('treeitem').map((item) => item.getAttribute('aria-label'))
function renderFiles() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={qc}><FilesPage workspace="/w" sessionId="s1" active /></QueryClientProvider>)
  return qc
}
async function menu(name: string, item: string) {
  const row = (await screen.findByRole('treeitem', { name })).parentElement!
  await userEvent.click(within(row).getByRole('button', { name: 'More actions' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: item }))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.listDir).mockResolvedValue(tree as never)
  vi.mocked(api.fetchGitInfo).mockResolvedValue({ git: null } as never)
  vi.mocked(api.readFile).mockImplementation((_sid, path) => Promise.resolve({ content: path === 'a.txt' ? 'Original A' : 'Original B', size: 10, preview: 'text' } as never))
})

describe('file tree writes show their result at once (TAL-1384)', () => {
  it('deletes an entry at once and restores it with the server refusal inline', async () => {
    let refuse!: (error: unknown) => void
    vi.mocked(api.deleteEntry).mockReturnValue(new Promise((_, reject) => { refuse = reject }) as never)
    renderFiles()
    await menu('a.txt', 'Delete')
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    expect(names()).toEqual(['docs', 'b.txt'])
    refuse(new ApiError({ kind: 'http', status: 409, path: '/x', message: 'File is locked' }))
    await waitFor(() => expect(names()).toEqual(['docs', 'a.txt', 'b.txt']))
    expect(screen.getByRole('alert')).toHaveTextContent('File is locked')
  })

  it('renames at once, closing the dialog on submit', async () => {
    vi.mocked(api.renameEntry).mockReturnValue(held())
    renderFiles()
    await menu('b.txt', 'Rename')
    const input = screen.getByRole('textbox', { name: 'New name:' })
    await userEvent.clear(input)
    await userEvent.type(input, 'aa.txt{Enter}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.renameEntry).toHaveBeenCalledWith('s1', 'b.txt', 'aa.txt')
    expect(names()).toEqual(['docs', 'a.txt', 'aa.txt'])
  })

  it('shows a new file at once', async () => {
    vi.mocked(api.createFile).mockReturnValue(held())
    renderFiles()
    await screen.findByRole('treeitem', { name: 'a.txt' })
    await userEvent.click(screen.getByRole('button', { name: 'New File' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'New file name (e.g. notes.md):' }), 'notes.md{Enter}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.createFile).toHaveBeenCalledWith('s1', 'notes.md')
    expect(names()).toEqual(['docs', 'a.txt', 'b.txt', 'notes.md'])
  })

  it('moves a dropped entry out of the folder at once', async () => {
    vi.mocked(api.moveEntry).mockReturnValue(held())
    renderFiles()
    const folder = (await screen.findByRole('treeitem', { name: 'docs' })).parentElement!
    const dataTransfer = { types: ['application/x-talaria-workspace-path'], getData: () => 'a.txt', dropEffect: 'move' }
    fireEvent.dragOver(folder, { dataTransfer })
    fireEvent.drop(folder, { dataTransfer })
    await waitFor(() => expect(names()).toEqual(['docs', 'b.txt']))
    expect(api.moveEntry).toHaveBeenCalledWith('s1', 'a.txt', 'docs')
  })
})

describe('file save keeps the user\'s edits (TAL-1384)', () => {
  async function openFile(name: string) {
    await userEvent.click(await screen.findByRole('treeitem', { name }))
    return screen.findByRole('textbox', { name: 'Preview' })
  }

  it('keeps edits typed while the save is held, showing the saved text meanwhile', async () => {
    let answer!: (value: unknown) => void
    vi.mocked(api.saveFile).mockReturnValue(new Promise((resolve) => { answer = resolve }) as never)
    renderFiles()
    const editor = await openFile('a.txt')
    await waitFor(() => expect(editor).toHaveValue('Original A'))
    await userEvent.clear(editor)
    await userEvent.type(editor, 'Submitted A')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.saveFile).toHaveBeenCalledWith('s1', 'a.txt', 'Submitted A')
    await userEvent.type(editor, ' and newer')
    vi.mocked(api.readFile).mockResolvedValue({ content: 'Submitted A', size: 11, preview: 'text' } as never)
    await act(async () => { answer({ ok: true }); await Promise.resolve() })
    await waitFor(() => expect(toast).toHaveBeenCalledWith('File saved'))
    expect(editor).toHaveValue('Submitted A and newer')
  })

  it('never clears another file\'s draft when an earlier save finishes', async () => {
    let answer!: (value: unknown) => void
    vi.mocked(api.saveFile).mockReturnValue(new Promise((resolve) => { answer = resolve }) as never)
    renderFiles()
    const first = await openFile('a.txt')
    await waitFor(() => expect(first).toHaveValue('Original A'))
    await userEvent.type(first, '!')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    const second = await openFile('b.txt')
    await waitFor(() => expect(second).toHaveValue('Original B'))
    await userEvent.clear(second)
    await userEvent.type(second, 'New unsaved B')
    await act(async () => { answer({ ok: true }); await Promise.resolve() })
    await waitFor(() => expect(toast).toHaveBeenCalledWith('File saved'))
    expect(second).toHaveValue('New unsaved B')
  })
})
