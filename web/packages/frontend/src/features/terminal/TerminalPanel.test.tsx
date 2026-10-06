import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'

const noop = () => undefined
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
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
