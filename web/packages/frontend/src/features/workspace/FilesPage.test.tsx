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
  vi.mocked(api.listDir).mockResolvedValue(tree)
  vi.mocked(api.fetchGitInfo).mockResolvedValue({ git: null })
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

  it('makes an action on a renamed row wait for its rename instead of racing it', async () => {
    vi.mocked(api.renameEntry).mockReturnValue(held())
    renderFiles()
    await menu('b.txt', 'Rename')
    const input = screen.getByRole('textbox', { name: 'New name:' })
    await userEvent.clear(input)
    await userEvent.type(input, 'aa.txt{Enter}')
    expect(names()).toEqual(['docs', 'a.txt', 'aa.txt'])
    await menu('aa.txt', 'Delete')
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(api.deleteEntry).not.toHaveBeenCalled()
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

describe('file tree writes roll back only themselves on refusal (TAL-1384)', () => {
  const refusal = (message: string) => new ApiError({ kind: 'http', status: 409, path: '/x', message })

  it('restores a refused rename with the error inline', async () => {
    vi.mocked(api.renameEntry).mockRejectedValue(refusal('Name is taken'))
    renderFiles()
    await menu('b.txt', 'Rename')
    const input = screen.getByRole('textbox', { name: 'New name:' })
    await userEvent.clear(input)
    await userEvent.type(input, 'aa.txt{Enter}')
    await waitFor(() => expect(names()).toEqual(['docs', 'a.txt', 'b.txt']))
    expect(screen.getByRole('alert')).toHaveTextContent('Name is taken')
  })

  it('drops a refused new file with the error inline', async () => {
    vi.mocked(api.createFile).mockRejectedValue(refusal('File already exists'))
    renderFiles()
    await screen.findByRole('treeitem', { name: 'a.txt' })
    await userEvent.click(screen.getByRole('button', { name: 'New File' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'New file name (e.g. notes.md):' }), 'notes.md{Enter}')
    await waitFor(() => expect(names()).toEqual(['docs', 'a.txt', 'b.txt']))
    expect(screen.getByRole('alert')).toHaveTextContent('File already exists')
  })

  it('puts a refused move back with the error inline', async () => {
    vi.mocked(api.moveEntry).mockRejectedValue(refusal('Target is read-only'))
    renderFiles()
    const folder = (await screen.findByRole('treeitem', { name: 'docs' })).parentElement!
    const dataTransfer = { types: ['application/x-talaria-workspace-path'], getData: () => 'a.txt', dropEffect: 'move' }
    fireEvent.dragOver(folder, { dataTransfer })
    fireEvent.drop(folder, { dataTransfer })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Target is read-only'))
    expect(names()).toEqual(['docs', 'a.txt', 'b.txt'])
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

  it('keeps the draft and shows the error when the save is refused', async () => {
    vi.mocked(api.saveFile).mockRejectedValue(new ApiError({ kind: 'http', status: 413, path: '/x', message: 'File too large' }))
    renderFiles()
    const editor = await openFile('a.txt')
    await waitFor(() => expect(editor).toHaveValue('Original A'))
    await userEvent.type(editor, ' edited')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('File too large', 4000, 'error'))
    expect(editor).toHaveValue('Original A edited')
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('rereads the saved file, not the one open when the save answers', async () => {
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
    const reads = (path: string) => vi.mocked(api.readFile).mock.calls.filter(([, p]) => p === path).length
    const [readsA, readsB] = [reads('a.txt'), reads('b.txt')]
    await act(async () => { answer({ ok: true }); await Promise.resolve() })
    await waitFor(() => expect(reads('a.txt')).toBeGreaterThan(readsA))
    expect(reads('b.txt')).toBe(readsB)
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

describe('managed source in the existing Files editor (TAL-1367)', () => {
  async function selectManaged() {
    await userEvent.click(screen.getByRole('combobox', { name: 'File source' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Session buffers' }))
  }
  function managedMocks() {
    vi.mocked(api.listDir).mockImplementation((_sid, _path, _hidden, source) => Promise.resolve(source === 'managed' ? { entries: [{ name: 'draft.txt', path: 'buffer-one', size: 8 }], write_semantics: 'unconditional' } : tree))
    vi.mocked(api.readFile).mockResolvedValue({ content: 'original', name: 'draft.txt', size: 8, preview: 'text', read_only: false, write_semantics: 'unconditional' })
  }
  it('opens and edits a managed buffer without a workspace, with no host file actions', async () => {
    managedMocks()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={qc}><FilesPage workspace={null} sessionId="s1" active /></QueryClientProvider>)
    await selectManaged()
    await userEvent.click(await screen.findByRole('treeitem', { name: 'draft.txt' }))
    const editor = await screen.findByRole('textbox', { name: 'Preview' })
    expect(editor).toHaveValue('original')
    await userEvent.type(editor, ' edited')
    vi.mocked(api.saveFile).mockResolvedValue({ ok: true, path: 'buffer-one', size: 15 })
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.saveFile).toHaveBeenCalledWith('s1', 'buffer-one', 'original edited', 'managed'))
    expect(screen.queryByRole('link', { name: 'Download folder' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'About saving session buffers' }))
    expect(await screen.findByText(/without revision checks/)).toBeInTheDocument()
  })
  it.each([409, 503])('retains the draft after a refused or unknown save (%s) and reconciles without replay', async (status) => {
    managedMocks()
    vi.mocked(api.saveFile).mockRejectedValue(new ApiError({ kind: 'http', status, path: '/x', message: 'Save could not be confirmed' }))
    renderFiles()
    await selectManaged()
    await userEvent.click(await screen.findByRole('treeitem', { name: 'draft.txt' }))
    const editor = await screen.findByRole('textbox', { name: 'Preview' })
    await userEvent.type(editor, ' unsaved')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Save could not be confirmed', 4000, 'error'))
    expect(editor).toHaveValue('original unsaved')
    expect(api.saveFile).toHaveBeenCalledTimes(1)
    if (status === 503) await waitFor(() => expect(vi.mocked(api.readFile).mock.calls.length).toBeGreaterThan(1))
  })
  it('renders server read-only and backend unavailable states accurately', async () => {
    managedMocks()
    vi.mocked(api.readFile).mockResolvedValue({ content: 'deleted session', size: 15, preview: 'text', read_only: true, write_semantics: 'unconditional' })
    renderFiles()
    await selectManaged()
    await userEvent.click(await screen.findByRole('treeitem', { name: 'draft.txt' }))
    expect(await screen.findByRole('textbox', { name: 'Preview' })).toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    vi.mocked(api.listDir).mockResolvedValue({ entries: [], unavailable: true })
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText(/Enable and approve the devkit backend/)).toBeInTheDocument()
  })
  it('keeps a new selection and its draft when an older read or save completes', async () => {
    managedMocks()
    let finish!: (value: Awaited<ReturnType<typeof api.readFile>>) => void
    vi.mocked(api.listDir).mockResolvedValue({ entries: [{ name: 'a.txt', path: 'one' }, { name: 'b.txt', path: 'two' }] })
    vi.mocked(api.readFile).mockImplementation((_sid, path) => path === 'one' ? new Promise((resolve) => { finish = resolve }) : Promise.resolve({ content: 'second', size: 6, preview: 'text', read_only: false }))
    renderFiles()
    await selectManaged()
    await userEvent.click(await screen.findByRole('treeitem', { name: 'a.txt' }))
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    await userEvent.click(await screen.findByRole('treeitem', { name: 'b.txt' }))
    const editor = await screen.findByRole('textbox', { name: 'Preview' })
    await userEvent.type(editor, ' draft')
    await act(async () => { finish({ content: 'late first', size: 10, preview: 'text', read_only: false }); await Promise.resolve() })
    expect(editor).toHaveValue('second draft')
  })
})
