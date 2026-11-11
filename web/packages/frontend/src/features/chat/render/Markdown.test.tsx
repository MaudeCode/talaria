import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Markdown from './MarkdownRenderer'
import { stubAnimate } from '../../../test/animate'
import { LinkCheckContext, type LinkCheck } from './LinkCheckContext'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const markdown = '[docs](https://Docs.Example.com:8443/guide) and [lookalike](https://docs.example.com.evil.test/)'
const openSpy = () => vi.spyOn(window, 'open').mockImplementation(() => null)

describe('external link confirmation (TAL-279)', () => {
  it('asks in a labelled app dialog; Cancel and Escape dismiss, Open opens a new tab', async () => {
    const open = openSpy()
    render(<Markdown text={markdown} />)
    await userEvent.click(await screen.findByRole('button', { name: 'docs' }))
    const dialog = await screen.findByRole('dialog', { name: 'Open external link?' })
    // Without a server answer (shared transcripts) the dialog names no host it would have to derive.
    expect(dialog).toHaveTextContent('This link opens outside Talaria.')
    expect(dialog).toHaveTextContent('https://docs.example.com:8443/guide')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })

    await userEvent.click(screen.getByRole('button', { name: 'docs' }))
    await screen.findByRole('dialog', { name: 'Open external link?' })
    await userEvent.keyboard('{Escape}')
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(open).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'docs' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Open link' }))
    expect(open).toHaveBeenCalledWith('https://docs.example.com:8443/guide', '_blank', 'noreferrer')
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('opens a link directly only when the server says so, asking with the clicked URL', async () => {
    const open = openSpy()
    const check = vi.fn((url: string) => Promise.resolve(url.includes('evil') ? { opens_directly: false, host: 'server-named.test' } : { opens_directly: true, host: 'docs.example.com' }))
    render(<LinkCheckContext value={check}><Markdown text={markdown} /></LinkCheckContext>)
    await userEvent.click(await screen.findByRole('button', { name: 'docs' }))
    await waitFor(() => { expect(open).toHaveBeenCalledWith('https://docs.example.com:8443/guide', '_blank', 'noreferrer') })
    expect(check).toHaveBeenCalledWith('https://docs.example.com:8443/guide')
    expect(screen.queryByRole('dialog')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'lookalike' }))
    expect(await screen.findByRole('dialog', { name: 'Open external link?' })).toHaveTextContent('This link goes to server-named.test.')
    expect(check).toHaveBeenLastCalledWith('https://docs.example.com.evil.test/')
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('warns when the server check fails or does not answer in time', async () => {
    const open = openSpy()
    const { unmount } = render(<LinkCheckContext value={() => Promise.reject(new Error('offline'))}><Markdown text={markdown} /></LinkCheckContext>)
    await userEvent.click(await screen.findByRole('button', { name: 'docs' }))
    await screen.findByRole('dialog', { name: 'Open external link?' })
    unmount()

    render(<LinkCheckContext value={() => new Promise<LinkCheck>(() => undefined)}><Markdown text={markdown} /></LinkCheckContext>)
    await userEvent.click(await screen.findByRole('button', { name: 'docs' }))
    await screen.findByRole('dialog', { name: 'Open external link?' }, { timeout: 2000 })
    expect(open).not.toHaveBeenCalled()
  })
})

describe('JSON code blocks (TAL-615)', () => {
  it('toggles a parsed JSON block between the raw code and a tree, and leaves other blocks raw', async () => {
    render(<Markdown text={'```json\n{"name": "talaria", "tags": ["web", "app"], "nested": {"deep": {"leaf": null}}}\n```\n\n```json\n{"broken": \n```'} />)
    const toggle = await screen.findByRole('button', { name: 'Tree' })
    expect(screen.getAllByRole('button', { name: 'Tree' })).toHaveLength(1)
    expect(document.querySelector('[data-json-tree]')).toBeNull()
    await userEvent.click(toggle)
    const tree = document.querySelector('[data-json-tree]')!
    expect(tree).toHaveTextContent('"name": "talaria"')
    expect(tree).toHaveTextContent('"web"')
    // Deep levels start folded, as in the legacy tree.
    const deep = [...tree.querySelectorAll('details')].find((node) => node.querySelector(':scope > summary')?.textContent.includes('"deep"'))
    expect(deep).not.toHaveAttribute('open')
    await userEvent.click(screen.getByRole('button', { name: 'Raw' }))
    expect(document.querySelector('[data-json-tree]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Tree' })).toBeInTheDocument()
  })
})

describe('fade text effect (TAL-2148)', () => {
  const text = 'Streamed words arrive\n\n```ts\nconst kept = 1\n```\n'
  const motion = (reduce: boolean) => { vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: reduce, addEventListener: vi.fn(), removeEventListener: vi.fn() }))) }
  const animated = (container: HTMLElement) => container.querySelectorAll('p [data-sd-animate]').length
  afterEach(() => { vi.unstubAllGlobals(); Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo') })

  it('fades streamed words in when on, never inside a code block, and nothing when off or reduced motion is set', () => {
    HTMLElement.prototype.scrollTo = vi.fn()
    motion(false)
    const view = render(<Markdown text={text} streaming fade />)
    expect(animated(view.container)).toBeGreaterThan(0)
    expect(view.container.querySelector('[data-streamdown="code-block"] [data-sd-animate]')).toBeNull()
    view.rerender(<Markdown text={text} streaming />)
    expect(animated(view.container)).toBe(0)
    cleanup()
    motion(true)
    expect(animated(render(<Markdown text={text} streaming fade />).container)).toBe(0)
  })
})

it('follows only the live enabled answer height and releases it immediately on opt-out or settlement', () => {
  const motion = stubAnimate()
  let resized = () => undefined
  const disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => undefined) { resized = callback }
    observe = vi.fn()
    disconnect = disconnect
  })
  let height = 24
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { height: this.hasAttribute('data-stream-height') ? 24 : height } as DOMRect
  })
  try {
    const view = render(<Markdown text="Streaming" streaming fade />)
    height = 72
    act(() => resized())
    expect(motion.reveals()).toHaveLength(1)
    expect(motion.reveals()[0]!.keyframes).toEqual([{ height: '24px' }, { height: '72px' }])
    const instant = render(<Markdown text="Streaming" streaming />).container.innerHTML
    view.rerender(<Markdown text="Streaming" streaming />)
    expect(view.container.innerHTML).toBe(instant)
    expect(disconnect).toHaveBeenCalled()
    expect(motion.reveals()[0]!.cancel).toHaveBeenCalled()
    view.rerender(<Markdown text="Streaming" streaming fade />)
    view.rerender(<Markdown text="Streaming" fade />)
    expect(view.container.querySelector('[data-stream-height]')).toBeNull()
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    view.rerender(<Markdown text="Streaming" streaming fade />)
    expect(view.container.innerHTML).toBe(instant)
  } finally { motion.restore(); vi.unstubAllGlobals() }
})
