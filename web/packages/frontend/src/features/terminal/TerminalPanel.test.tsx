import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, fireEvent } from '@testing-library/react'
import terminalFixture from '../../../../../../contracts/fixtures/native-captured-command.json'

const webStart = { ...terminalFixture.web_target, session_id: 's1', workspace: '/w' }
const noop = () => undefined
const xterm: { type: (data: string) => void } = vi.hoisted(() => ({ type: () => undefined }))
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
    onData = (listener: (data: string) => void) => { xterm.type = listener; return { dispose: noop } }
    onResize = () => ({ dispose: noop })
    dispose = noop
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = noop } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class { dispose = noop } }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
vi.mock('../../api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('../../api/client')>(), post: vi.fn() }))
import { post } from '../../api/client'
import { showToast } from '../toast/toast'
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
    await act(async () => { resolveStart(webStart); await new Promise((r) => setTimeout(r, 0)) })
    expect(opened).toEqual([])
  })

  it('opens the terminal stream once start succeeds', async () => {
    vi.mocked(post).mockResolvedValue(webStart)
    render(<TerminalPanel sessionId="s1" workspace="/w" onClose={noop} />)
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(opened).toHaveLength(1)
    expect(opened[0]).toContain('api/terminal/output?session_id=s1')
  })
})

it('closes the panel at once, before the server stops the shell (TAL-1179)', async () => {
  vi.mocked(post).mockImplementation((path: string) => path === 'api/terminal/close' ? new Promise(() => undefined) : Promise.resolve(webStart))
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
  vi.mocked(post).mockImplementation((path: string) => path === 'api/terminal/close' ? Promise.reject(new ApiError({ kind: 'http', status: 403, path, message: 'Sign in again' })) : Promise.resolve(webStart))
  const view = render(<TerminalPanel sessionId="s1" workspace="/w" onClose={onClose} onReopen={onReopen} />)
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  await act(async () => { view.getByRole('button', { name: 'Close' }).click(); await new Promise((r) => setTimeout(r, 0)) })
  expect(onClose).toHaveBeenCalledOnce()
  expect(onReopen).toHaveBeenCalledOnce()
  view.unmount()
  vi.mocked(post).mockReset()
  let closes = 0
  vi.mocked(post).mockImplementation((path: string) => path === 'api/terminal/close' ? (++closes === 1 ? Promise.reject(new ApiError({ kind: 'network', path, message: 'lost' })) : Promise.resolve({ ok: true, closed: true })) : Promise.resolve(webStart))
  const again = render(<TerminalPanel sessionId="s1" workspace="/w" onClose={onClose} onReopen={onReopen} />)
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  await act(async () => { again.getByRole('button', { name: 'Close' }).click(); await new Promise((r) => setTimeout(r, 0)) })
  expect(closes).toBe(2)
  expect(onReopen).toHaveBeenCalledOnce()
})

it('requires an explicit captured command, never opens a PTY stream and never retries a lost ACK', async () => {
  vi.mocked(post).mockImplementation((path: string) => path === 'api/terminal/start'
    ? Promise.resolve({ ...terminalFixture.target, session_id: 'native', workspace: '/frozen/native', target_key: 'owner-key' })
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
    ? { ...terminalFixture.target, session_id: 's1', workspace: '/frozen/native', target_key: 'new-owner' }
    : webStart))
  const view = render(<TerminalPanel sessionId="s1" workspace="/w" onClose={noop} />)
  await act(async () => { await Promise.resolve() })
  expect(opened).toHaveLength(1)
  await act(async () => { view.getByRole('button', { name: 'Restart' }).click(); await Promise.resolve() })
  expect(await view.findByRole('textbox', { name: 'Captured command' })).toBeVisible()
  expect(opened).toHaveLength(1)
})

it('refuses startup without a server-declared terminal mode instead of opening a host stream', async () => {
  const client = await vi.importActual<typeof import('../../api/client')>('../../api/client')
  client.configureClient({ transport: () => Promise.resolve(new Response(JSON.stringify({ ok: true, running: true }), { headers: { 'content-type': 'application/json' } })) })
  vi.mocked(post).mockImplementation(client.post)
  try {
    const view = render(<TerminalPanel sessionId="s1" workspace="/w" onClose={noop} />)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(opened).toEqual([])
    expect(view.container.querySelector('#composerTerminalPanel')).toHaveAttribute('data-status', 'error')
  } finally { client.resetClientForTests() }
})

describe('terminal input (TAL-1146)', () => {
  let inputs: { data: string; resolve: () => void; reject: (error: unknown) => void }[]
  const sent = () => inputs.map((input) => input.data)
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  const type = async (...keys: string[]) => { for (const key of keys) xterm.type(key); await settle() }
  const open = async () => {
    const view = render(<TerminalPanel sessionId="s1" workspace="/w" onClose={noop} />)
    await settle()
    return view
  }
  beforeEach(() => {
    inputs = []
    vi.mocked(showToast).mockClear()
    vi.mocked(post).mockReset()
    vi.mocked(post).mockImplementation((path: string, body?: unknown) => {
      if (path !== 'api/terminal/input') return Promise.resolve(path === 'api/terminal/start' ? webStart : { ok: true })
      return new Promise((resolve, reject) => { inputs.push({ data: (body as { data: string }).data, resolve: () => resolve({ ok: true }), reject }) })
    })
  })

  it('posts no key queued behind a failed one and shows one error toast', async () => {
    await open()
    await type('a', 'b', '\r')
    await act(async () => { inputs[0]!.reject(new Error('lost')); await Promise.resolve() })
    await settle()
    expect(sent()).toEqual(['a'])
    expect(showToast).toHaveBeenCalledOnce()
    expect(showToast).toHaveBeenCalledWith('Terminal input failed: lost', 4000, 'error')
  })

  it('sends keys typed during a request in one following request, in order', async () => {
    await open()
    await type('e', 'c', 'h', 'o')
    await act(async () => { inputs[0]!.resolve(); await Promise.resolve() })
    await settle()
    expect(sent()).toEqual(['e', 'cho'])
  })

  it('sends an oversized paste as one request and reports its refusal', async () => {
    const { ApiError } = await import('../../contracts/common')
    await open()
    const paste = 'y'.repeat(9000)
    await type('x', paste, 'z')
    await act(async () => { inputs[0]!.resolve(); await Promise.resolve() })
    await settle()
    expect(sent()).toEqual(['x', paste])
    await act(async () => { inputs[1]!.reject(new ApiError({ kind: 'http', status: 413, path: 'api/terminal/input', message: 'input too large' })); await Promise.resolve() })
    await settle()
    expect(sent()).toEqual(['x', paste])
    expect(showToast).toHaveBeenCalledWith('Terminal input failed: input too large', 4000, 'error')
  })

  it('splits a joined batch at the server limit', async () => {
    await open()
    const half = 'q'.repeat(5000)
    await type('x', half, half)
    await act(async () => { inputs[0]!.resolve(); await Promise.resolve() })
    await settle()
    await act(async () => { inputs[1]!.resolve(); await Promise.resolve() })
    await settle()
    expect(sent()).toEqual(['x', half, half])
  })

  it.each(['Restart', 'Close'])('never posts keys still queued when %s is clicked', async (button) => {
    const view = await open()
    await type('a', 'b', '\r')
    await act(async () => { view.getByRole('button', { name: button }).click(); await Promise.resolve() })
    await act(async () => { inputs[0]!.resolve(); await Promise.resolve() })
    await settle()
    expect(sent()).toEqual(['a'])
    expect(showToast).not.toHaveBeenCalled()
  })

  it('keeps one input request in flight across Restart', async () => {
    const view = await open()
    await type('a')
    await act(async () => { view.getByRole('button', { name: 'Restart' }).click(); await Promise.resolve() })
    await settle()
    await type('b')
    expect(sent()).toEqual(['a'])
    await act(async () => { inputs[0]!.resolve(); await Promise.resolve() })
    await settle()
    expect(sent()).toEqual(['a', 'b'])
  })

  it('posts nothing queued after the panel unmounts', async () => {
    const view = await open()
    await type('a', 'b')
    view.unmount()
    await act(async () => { inputs[0]!.resolve(); await Promise.resolve() })
    await settle()
    expect(sent()).toEqual(['a'])
  })
})
