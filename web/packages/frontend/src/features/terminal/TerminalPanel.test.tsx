import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, fireEvent } from '@testing-library/react'

const noop = () => undefined
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    clear = noop
    options = {}
    cols = 80
    rows = 24
    loadAddon = noop
    open = noop
    write = noop
    writeln = noop
    onData = () => ({ dispose: noop })
    onResize = () => ({ dispose: noop })
    dispose = noop
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = noop } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class { dispose = noop } }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('../../api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('../../api/client')>(), post: vi.fn() }))
import { post } from '../../api/client'
import { TerminalPanel } from './TerminalPanel'

const opened: string[] = []

beforeEach(() => {
  opened.length = 0
  vi.stubGlobal('EventSource', class {
    readyState = 0
    constructor(url: string) { opened.push(url) }
    addEventListener = noop
    close = noop
  })
  vi.stubGlobal('ResizeObserver', class { observe = noop; disconnect = noop })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('TerminalPanel', () => {
  it('opens no terminal stream when it unmounts while start is pending', async () => {
    let resolveStart!: (value: unknown) => void
    vi.mocked(post).mockImplementation((path: string) => path === 'api/terminal/start' ? new Promise((resolve) => { resolveStart = resolve }) : Promise.resolve({}))
    const { unmount } = render(<TerminalPanel sessionId="s1" workspace="/w" onClose={noop} />)
    unmount()
    await act(async () => { resolveStart({ ok: true, running: true }); await new Promise((r) => setTimeout(r, 0)) })
    expect(opened).toEqual([])
  })

  it('opens the terminal stream once start succeeds', async () => {
    vi.mocked(post).mockResolvedValue({ ok: true, running: true })
    render(<TerminalPanel sessionId="s1" workspace="/w" onClose={noop} />)
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(opened).toHaveLength(1)
    expect(opened[0]).toContain('api/terminal/output?session_id=s1')
  })
})

it('closes the panel at once, before the server stops the shell (TAL-1179)', async () => {
  vi.mocked(post).mockImplementation((path: string) => path === 'api/terminal/close' ? new Promise(() => undefined) : Promise.resolve({ ok: true, running: true }))
  const onClose = vi.fn()
  const view = render(<TerminalPanel sessionId="s1" workspace="/w" onClose={onClose} />)
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  await act(async () => { view.getByRole('button', { name: 'Close' }).click(); await Promise.resolve() })
  expect(onClose).toHaveBeenCalledOnce()
  expect(post).toHaveBeenCalledWith('api/terminal/close', { session_id: 's1' }, expect.anything(), { retries: 0 })
})

it('reopens the panel with the error when closing is refused, and asks again after an unknown outcome (TAL-1383)', async () => {
  const { ApiError } = await import('../../contracts/common')
  const onClose = vi.fn(), onReopen = vi.fn()
  vi.mocked(post).mockImplementation((path: string) => path === 'api/terminal/close' ? Promise.reject(new ApiError({ kind: 'http', status: 403, path, message: 'Sign in again' })) : Promise.resolve({ ok: true, running: true }))
  const view = render(<TerminalPanel sessionId="s1" workspace="/w" onClose={onClose} onReopen={onReopen} />)
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  await act(async () => { view.getByRole('button', { name: 'Close' }).click(); await new Promise((r) => setTimeout(r, 0)) })
  expect(onClose).toHaveBeenCalledOnce()
  expect(onReopen).toHaveBeenCalledOnce()
  view.unmount()
  vi.mocked(post).mockReset()
  let closes = 0
  vi.mocked(post).mockImplementation((path: string) => path === 'api/terminal/close' ? (++closes === 1 ? Promise.reject(new ApiError({ kind: 'network', path, message: 'lost' })) : Promise.resolve({ ok: true, closed: true })) : Promise.resolve({ ok: true, running: true }))
  const again = render(<TerminalPanel sessionId="s1" workspace="/w" onClose={onClose} onReopen={onReopen} />)
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  await act(async () => { again.getByRole('button', { name: 'Close' }).click(); await new Promise((r) => setTimeout(r, 0)) })
  expect(closes).toBe(2)
  expect(onReopen).toHaveBeenCalledOnce()
})

it('requires an explicit captured command, never opens a PTY stream and never retries a lost ACK', async () => {
  vi.mocked(post).mockImplementation((path: string) => path === 'api/terminal/start'
    ? Promise.resolve({ ok: true, running: false, mode: 'owner_command', workspace: '/frozen/native', target_key: 'owner-key' })
    : Promise.reject(new Error('Connection lost. Outcome unknown.')))
  const view = render(<TerminalPanel sessionId="native" workspace="/w" onClose={noop} />)
  const input = await view.findByRole('textbox', { name: 'Captured command' })
  expect(opened).toEqual([])
  expect(post).toHaveBeenCalledTimes(1)
  fireEvent.change(input, { target: { value: 'pwd' } })
  fireEvent.submit(input.closest('form')!)
  await act(async () => { await Promise.resolve() })
  expect(post).toHaveBeenCalledTimes(2)
  expect(post).toHaveBeenLastCalledWith('api/terminal/exec', { session_id: 'native', mode: 'owner_command', target_key: 'owner-key', command: 'pwd' }, expect.anything(), { retries: 0, timeoutMs: 50_000 })
  expect(opened).toEqual([])
})

it('uses the server-selected mode on restart without reconnecting a former host PTY', async () => {
  let starts = 0
  vi.mocked(post).mockImplementation((path: string) => Promise.resolve(path === 'api/terminal/start' && ++starts === 2
    ? { ok: true, running: false, mode: 'owner_command', workspace: '/frozen/native', target_key: 'new-owner' }
    : { ok: true, running: true }))
  const view = render(<TerminalPanel sessionId="s1" workspace="/w" onClose={noop} />)
  await act(async () => { await Promise.resolve() })
  expect(opened).toHaveLength(1)
  await act(async () => { view.getByRole('button', { name: 'Restart' }).click(); await Promise.resolve() })
  expect(await view.findByRole('textbox', { name: 'Captured command' })).toBeVisible()
  expect(opened).toHaveLength(1)
})
